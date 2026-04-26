---
layout: post
title: "Build DBDB from scratch — Part 13: Adding a B-Tree"
date: '2026-05-04 12:00'
excerpt: >-
  Binary trees are tall and thin, leading to many disk reads. B-trees are short and fat, promising faster queries. This post adds a B-tree implementation to DBDB, with nodes that hold multiple keys. It covers top-down splitting for insertion, and the three cases for deletion (borrow from left, borrow from right, merge). The benchmark results show the B-tree winning on every dimension: faster writes, faster reads, smaller files, and faster compaction.
comments: false
---

*Building DBDB from Scratch — Part 13: Adding a B-Tree*

---

Binary trees have a fundamental problem: one child per key, which means one
level per factor of two. Ten levels gives you a thousand keys. Twenty levels
gives you a million. Every level is a disk read.

Production databases figured this out decades ago. SQLite doesn't use a binary
tree. PostgreSQL doesn't use one. Neither does MySQL, or RocksDB, or any other
storage engine you would trust with real data. They all use B-trees — or close
variants of them. The reason is simple: a node that holds ten keys means ten
times fewer levels for the same number of keys. Fewer levels means fewer disk
reads. Fewer disk reads means faster queries.

DBDB had an AVL tree. It was balanced, it was correct, and compared to the
unbalanced BST it replaced, it was meaningfully better. But it was still binary.
The question was whether a B-tree would actually improve things — or just be
more complex for complexity's sake.

This is what happened when we found out.

---

## About this series

**Build DBDB from scratch** is a walkthrough of rebuilding **DBDB, the Dog Bed Database** from [*500 Lines or Less*](https://github.com/aosabook/500lines). Each post focuses on one layer of the implementation.

| Part | Core idea |
|------|------------|
| **0** | [Project setup](https://minhmannh2001.github.io/2026/04/21/build-dbdb-from-scratch-part-0-project-setup-en.html): `pyproject.toml`, smoke tests, pytest + BDD, Makefile |
| **1** | [Append-only storage](https://minhmannh2001.github.io/2026/04/22/build-dbdb-from-scratch-part-1-append-only-storage-en.html): superblock, `write`/`read`, root commit, `flush`/`fsync`, locking |
| **2** | [`ValueRef` and lazy loading](https://minhmannh2001.github.io/2026/04/23/build-dbdb-from-scratch-part-2-valueref-en.html): `get`/`store`, `BytesValueRef`, UTF-8 on disk |
| **3** | [Immutable tree and `BinaryNodeRef`](https://minhmannh2001.github.io/2026/04/24/build-dbdb-from-scratch-part-3-binarynode-en.html): copy-on-write, node serialization, lazy children |
| **4** | [Logical layer: `LogicalBase` + `BinaryTree`](https://minhmannh2001.github.io/2026/04/25/build-dbdb-from-scratch-part-4-logical-layer-en.html): lifecycle vs. algorithms |
| **Interlude** | [End-to-end flow: one key through all layers](https://minhmannh2001.github.io/2026/04/26/build-dbdb-from-scratch-part-5-how-it-all-fits-en.html) |
| **6** | [Locking across layers: the two-writer race](https://minhmannh2001.github.io/2026/04/27/build-dbdb-from-scratch-part-6-locking-across-layers-en.html) |
| **7** | [Two lines that hold everything: `commit`, `get`, `set`, `pop`](https://minhmannh2001.github.io/2026/04/28/build-dbdb-from-scratch-part-7-commit-en.html) |
| **8** | [The thinnest layer: the `DBDB` facade](https://minhmannh2001.github.io/2026/04/29/build-dbdb-from-scratch-part-8-interface-en.html) |
| **9** | [The last translation: the CLI tool](https://minhmannh2001.github.io/2026/04/30/build-dbdb-from-scratch-part-9-cli-en.html) |
| **10** | [What immutability costs: compaction](https://minhmannh2001.github.io/2026/05/01/build-dbdb-from-scratch-part-10-compaction-en.html) |
| **11** | [Retrospective](https://minhmannh2001.github.io/2026/05/02/build-dbdb-from-scratch-part-11-retrospective-en.html): The design thread end-to-end: six layers, one guarantee |
| **12** | [Replacing the BST with an AVL tree](https://minhmannh2001.github.io/2026/05/03/build-dbdb-from-scratch-part-12-avl-tree-en.html) |
| **13** | **Adding a B-Tree** (this post) |

---

## Why Binary Trees Aren't Enough

AVL and BST are both binary trees. Each node holds exactly one key and has at
most two children. The shape is elegant, and the algorithms are clean.

But binary means logarithm base two. A balanced binary tree with a million keys
has height log₂(1,000,000) ≈ 20. That's 20 disk reads to find a key in a
million-key database. Each read is a seek, a wait, a transfer.

A B-tree generalizes this. Given a minimum degree `t`, each internal node holds
between `t-1` and `2t-1` keys, and has between `t` and `2t` children. The
height is now log_t(n). With `t=50`, a million-key database has height at most
4. Four disk reads instead of twenty.

The tradeoff is complexity. Nodes aren't single keys anymore — they're arrays.
Insertion can't just walk down one path; it might split a full node and promote
a key to the parent. Deletion has three distinct cases depending on whether you
can borrow from a sibling or need to merge two nodes together. The invariants
are harder to maintain and harder to verify.

For this implementation, the minimum degree is `t=3`. That gives nodes 2 to 5
keys, and 3 to 6 children. Small enough that all the split and merge cases
fire with just a handful of keys, large enough to be non-trivial. The goal is
to understand the mechanics, not to build a storage engine.

---

## A Node That Holds More Than One Key

The first thing to build was the node. `BinaryNode` was simple: one key,
one value reference, two child pointers, and a length. `BTreeNode` is different
in kind, not just degree.

```python
@dataclass
class BTreeNode:
    keys:       list[str]
    value_refs: list[ValueRef]
    child_refs: list[BTreeNodeRef]
    length:     int
    is_leaf:    bool
```

The constraint that makes this a B-tree rather than just a node with arrays:
if the node is a leaf, `child_refs` must be empty. If it's internal, it must
have exactly `len(keys) + 1` children. A node with two keys has three children:
one to the left of the first key, one between the two keys, one to the right of
the second. The `__post_init__` check enforces this at construction time, so a
malformed node cannot be created.

`length` counts total keys in the subtree rooted here — not just the keys in
this node. A node with 2 keys and 3 children, where each child is a leaf with
2 keys, has length 2 + 2 + 2 + 2 = 8. `LogicalBase.__len__` relies on this
to return the total size of the tree without a traversal.

Serialization follows the same pattern as `BinaryNodeRef`, but the msgpack dict
carries arrays instead of scalars:

```python
{
    "keys":     ["key1", "key2"],
    "values":   [addr1, addr2],
    "children": [addr1, addr2, addr3],
    "length":   8,
    "is_leaf":  False,
}
```

`prepare_to_store` has to flush all value refs and all child refs to disk before
encoding the node itself. Nested refs must have addresses before the parent can
encode them. The same invariant that applied to `BinaryNodeRef` applies here,
just with more refs to flush.

---

## Search: Walking Down, Not Just Left or Right

B-tree search is recognizable from the binary case, but the branching is wider.

At each node, find where the key fits among the node's keys. If the key matches
one exactly, return its value. If the key is less than `keys[i]` for some `i`,
descend into `child_refs[i]`. If the key is greater than all keys in the node,
descend into the last child. If you reach a leaf without finding the key, it
doesn't exist.

```python
def _get(self, node, key):
    for i, k in enumerate(node.keys):
        if k == key:
            return self._follow(node.value_refs[i])
        elif k > key:
            if node.is_leaf:
                raise KeyError(key)
            return self._get(self._follow(node.child_refs[i]), key)
    if node.is_leaf:
        raise KeyError(key)
    return self._get(self._follow(node.child_refs[-1]), key)
```

A concrete trace helps. Given this tree with `t=3`:

```
              [G     M]
            /    |    \
       [B E]  [H K]   [N R]
```

Search for `"K"`: at `[G M]`, K > G and K < M → middle child. At `[H K]`,
K > H, K == K → found in one additional read.

Search for `"F"`: at `[G M]`, F < G → left child. At `[B E]`, F > B, F > E,
no match left and node is a leaf → `KeyError`.

The number of nodes visited is bounded by the tree height. At `t=3` and 10,000
keys, that ceiling is 9 — regardless of which key you look up.

In-order traversal — needed for iteration — follows the same structure. For an
internal node: recurse into child 0, yield key 0, recurse into child 1, yield
key 1, ..., yield key k-1, recurse into the last child. For a leaf: yield each
key in order. The result is always sorted, regardless of what order the keys
were inserted.

Applied to the same tree, iteration yields: B, E, G, H, K, M, N, R.

---

## Insertion: Splitting on the Way Down

Insertion is where B-trees diverge from everything that came before.

Binary trees insert by walking down until they find an empty slot. The structure
never changes until you hit the bottom. B-trees can't do this: if you insert
into a full node, you need to split it and promote a key to the parent. But if
the parent is also full, you need to split that too. In the worst case, splits
cascade from leaf to root.

There are two ways to handle this. The first — bottom-up splitting — descends
to the leaf, then handles splits on the way back up. The information about
whether a split happened propagates upward through the return values. It works,
but every level of recursion has to be prepared to handle a split from below.

The second — top-down splitting — checks each node before descending into it.
If the child you're about to enter is full, split it first, then descend. This
guarantees that when you arrive at any node, it already has room. No cascading
needed, no information to pass upward. The implementation is simpler to reason
about.

DBDB uses top-down splitting.

`_split_child(parent, child_index)` splits the full child at that index into
two nodes: `left` gets the first `t-1` keys, `right` gets the last `t-1` keys,
and the median key at index `t-1` gets promoted to the parent. The parent gains
one key and one child pointer. Everything produces new nodes — nothing is
mutated in place.

With `t=3`, a full node has 5 keys. The median index is `t-1 = 2` (zero-indexed),
so the median key is the third one. Splitting `[A B C D E]` yields two nodes
of `t-1 = 2` keys each, with `C` promoted to the parent:

```
    before: parent [...  P  ...]
                         |
                   [A  B  C  D  E]   ← full (5 keys)

    after:  parent [...  C  P  ...]   ← C (median) promoted
                        / \
                    [A B]  [D E]      ← 2 keys each (t-1)
```

There's one extra case: when the root itself is full. You can't promote to the
root's parent because the root has no parent. The solution is to create a new
root that initially has no keys and just one child (the old root), then split
that child. The tree grows upward.

```
    before:    [A  B  C  D  E]   ← root, full

    step 1:         []            ← new empty root
                    |
               [A B C D E]

    step 2:        [C]            ← C promoted, tree grows up
                  /   \
              [A B]   [D E]
```

```python
def _insert(self, node, key, value_ref):
    if node is None:
        return BTreeNodeRef(referent=BTreeNode([key], [value_ref], [], 1, True))

    if self._is_full(node):
        new_root = BTreeNode([], [], [BTreeNodeRef(referent=node)], node.length, False)
        new_root = self._split_child(new_root, 0)
        return self._insert_non_full(new_root, key, value_ref)
    else:
        return self._insert_non_full(node, key, value_ref)
```

`_insert_non_full` handles the descent. Before entering any child, it checks
whether that child is full. If so, it splits it first — guaranteeing there is
always room when the recursion actually arrives:

```python
def _insert_non_full(self, node, key, value_ref):
    if node.is_leaf:
        # find position and insert
        i = 0
        while i < len(node.keys) and node.keys[i] < key:
            i += 1
        # ... insert at position i
    else:
        i = 0
        while i < len(node.keys) and node.keys[i] < key:
            i += 1
        child = node.child_refs[i].get(self._storage)
        if self._is_full(child):
            node = self._split_child(node, i)   # split before descending
            if node.keys[i] < key:
                i += 1
        child = node.child_refs[i].get(self._storage)
        new_child_ref = self._insert_non_full(child, key, value_ref)
        # ... rebuild node with updated child
```

After `N` insertions in any order — sorted, reverse, random — all leaves sit
at the same depth. This is the B-tree's core guarantee. It doesn't maintain
balance by rotating; it maintains balance by ensuring every split happens
symmetrically, always at the median.

---

## Deletion: Three Cases and One Invariant

Every non-root B-tree node must have at least `t-1` keys. Insertion never
violates this because we only insert into nodes that aren't full. Deletion can
violate it if you remove from a node that's already at the minimum.

The fix is the same discipline as insertion: handle the problem before descending.
Before entering any child, ensure it has at least `t` keys — one above the
minimum, so that if we delete from it, it won't underflow.

If the child has exactly `t-1` keys, there are three options.

**Borrow from left sibling** — the left sibling has ≥ `t` keys. Rotate one
key clockwise: the separator between the two siblings descends into the child,
the sibling's rightmost key ascends to take its place in the parent.

```
    before:      [E     M]          want to descend into [H K],
                /   |    \          but [H K] is at minimum (t-1=2 keys)
          [B D F]  [H K]  [N R]    ← left sibling has 3 ≥ t=3 keys → can lend

    after:       [F     M]
                /   |    \
          [B D]  [E H K]  [N R]    ← F up, E down; [H K] now has 3 keys
```

**Borrow from right sibling** — mirrored: the separator descends into the
child from the right, the sibling's leftmost key ascends.

```
    before:      [E     M]          want to descend into [H K],
                /   |    \          left sibling [B C] also at minimum
           [B C]  [H K]  [N R S]   ← right sibling has 3 ≥ t=3 keys → can lend

    after:       [E     N]
                /   |    \
           [B C]  [H K M]  [R S]   ← M down, N up; [H K] now has 3 keys
```

**Merge** — both siblings are at the minimum. Pull the separator key down
from the parent and merge the child with one sibling into a single node.

```
    before:      [E     M]          want to descend into [H K],
                /   |    \          both siblings at minimum t-1=2 keys
          [B D]  [H K]  [N R]      ← neither sibling can lend → merge

    after:         [M]              E pulled down, [B D] and [H K] merged
                  /   \
          [B D E H K]  [N R]       ← parent loses one key and one child
```

The `_ensure_min_keys` method encodes this logic before every descent:

```python
def _ensure_min_keys(self, parent, child_index):
    child = parent.child_refs[child_index].get(self._storage)
    if len(child.keys) >= self.T:
        return parent, child_index          # already has room

    if child_index > 0:
        left = parent.child_refs[child_index - 1].get(self._storage)
        if len(left.keys) >= self.T:
            return self._borrow_from_left(parent, child_index), child_index

    if child_index < len(parent.child_refs) - 1:
        right = parent.child_refs[child_index + 1].get(self._storage)
        if len(right.keys) >= self.T:
            return self._borrow_from_right(parent, child_index), child_index

    if child_index > 0:
        return self._merge_with_left(parent, child_index), child_index - 1
    else:
        return self._merge_with_right(parent, child_index), child_index
```

When a key lives in an internal node rather than a leaf, you can't just remove
it — it's also serving as the separator between two subtrees. The solution is to
replace it with its in-order predecessor (the rightmost key in the left child's
subtree) or successor (the leftmost key in the right child's subtree), then
delete that key from the child it came from.

```
    delete "E" from internal node:

         [E     M]
        /   |    \
   [B D]  [H K]  [N R]

    step 1: find predecessor of E = D (rightmost key of left child)
    step 2: replace E with D in parent
    step 3: delete D from left child (a leaf — straightforward)

         [D     M]
        /   |    \
     [B]  [H K]  [N R]
```

If both children of the separator are at the minimum, borrowing isn't possible.
Merge the two children with the separator key pulled down into the merged node,
then delete the key from that merged node:

```
    delete "E", but both children at minimum (t-1=2 keys):

         [E     M]
        /   |    \
     [B C]  [H K]  [N R]

    step 1: merge [B C], E, [H K] into one node → [B C E H K]
    step 2: delete E from the merged leaf

         [M]
        /   \
  [B C H K]  [N R]
```

All of this produces trees where every non-root node has between `t-1` and
`2t-1` keys after any sequence of operations. The guarantee holds by induction:
we ensure it before every descent.

---

## Wiring Into DBDB

The integration was mechanical. Byte 8 of the superblock already stored 0 for
BST and 1 for AVL; 2 went to B-tree.

`_init_tree` gained a new branch:

```python
def _init_tree(self) -> None:
    if self._tree_type_flag == 2:
        from dbdb.btree import BTree
        self._tree = BTree(self._storage)
    elif self._tree_type_flag == 1:
        from dbdb.avl_tree import AVLTree
        self._tree = AVLTree(self._storage)
    else:
        from dbdb.binary_tree import BinaryTree
        self._tree = BinaryTree(self._storage)
```

`connect()` learned one new keyword:

```python
db = dbdb.connect("mydb.db", tree_type="btree")
```

There was one bug hiding in `compact()`. The method needed to create a new
database with the same tree type as the original:

```python
tree_type_str = "avl" if self._tree_type_flag == 1 else "bst"
```

That line predated B-tree support. A flag of 2 silently fell through to `"bst"`,
so compacting a B-tree database would produce a BST database. Opening it again
as a B-tree would fail trying to read BST-formatted nodes. The fix was trivial —
add the missing case — but the failure was quiet until the benchmark hit
compaction.

---

## What the Numbers Showed

The benchmark ran 10,000 random key insertions followed by random reads on a
fresh database, then a separate compaction test with 1,000 keys overwritten
ten times each. All figures are averages over five runs.

**General performance (10,000 random keys):**

| Operation         | BST           | AVL           | B-tree        |
|-------------------|---------------|---------------|---------------|
| Sequential writes | 5,230 ops/s   | 4,675 ops/s   | 7,473 ops/s   |
| Random reads      | 21,276 ops/s  | 25,987 ops/s  | 32,543 ops/s  |

The B-tree won both. Writes were 60% faster than AVL; reads were 25% faster.
Both were the opposite of what the plan predicted.

The write result makes sense once you think about what's actually happening on
disk per insert. AVL creates a new node at every level of the tree on the way
back up — up to two per insert in double-rotation cases. B-tree splits are
rare: with `t=3`, a leaf holds up to 5 keys before splitting, so most insertions
just extend an existing leaf node and write nothing more. The total disk
footprint per insert is lower.

The read result is the tree height story in actual numbers. With `t=3` and
10,000 keys, a B-tree reaches height at most log₃(10,000) ≈ 8.4. An AVL tree
stays at log₂(10,000) ≈ 13.3. Each lookup touches fewer nodes. In DBDB, each
node visit means a disk read; scanning up to 5 keys within one node is cheaper
than paying for an additional read at the next level.

**Compaction impact (1,000 keys, 10 overwrites each):**

| Metric                | BST before | BST after | AVL before | AVL after | B-tree before | B-tree after |
|-----------------------|------------|-----------|------------|-----------|---------------|--------------|
| File size (bytes)     | 1,822,926  | 184,735   | 1,822,830  | 184,729   | 1,600,547     | 163,277      |
| Random reads (ops/s)  | 26,535     | 27,761    | 33,662     | 35,300    | 38,381        | 41,043       |
| Compaction time (s)   | —          | 0.028     | —          | 0.030     | —             | 0.019        |

File size was the clearest structural difference. Before compaction, the bloated
B-tree file sat at 1.6 MB versus 1.8 MB for BST and AVL — about 12% smaller,
because B-tree nodes pack multiple keys per block. After compaction, 163 KB
versus 184 KB — about 11% smaller, for the same reason.

Compaction time was the surprise: B-tree was the fastest at 0.019 s, beating
both BST (0.028 s) and AVL (0.030 s). The reason is the same as the write
story — fewer nodes written during the rebuild. Re-inserting 1,000 keys into a
fresh B-tree produces far fewer nodes than inserting the same 1,000 keys into a
BST or AVL tree, because each B-tree leaf absorbs up to 5 keys before a split.
Less to write means faster compaction.

After compaction, all three trees improved their read throughput by 5–7%. A
compacted database has no stale data — the file is 90% smaller, the live nodes
are tightly packed, and the OS has less to cache. The B-tree went from 38,381
to 41,043 ops/s, the largest absolute gain, which is consistent with it
starting from the highest baseline.

---

## The Summary

Three tree types now live in DBDB. All 216 tests pass across all of them.

| Tree   | Write (ops/s) | Read (ops/s) | File size (1K keys, 10×) | Compaction (s) |
|--------|---------------|--------------|--------------------------|----------------|
| BST    | 5,230         | 21,276       | 1,822,926 bytes          | 0.028          |
| AVL    | 4,675         | 25,987       | 1,822,830 bytes          | 0.030          |
| B-tree | 7,473         | 32,543       | 1,600,547 bytes          | 0.019          |

B-tree wins on every dimension. It's faster to write, faster to read, produces
smaller files, and compacts faster. The complexity of multi-key nodes and
proactive splitting pays for itself at 10,000 keys, and the advantage only
grows as the database does — log base 3 scales much better than log base 2.

The BST is still there, still reachable. Old databases still work. The AVL tree
is still a reasonable middle ground. And now there's a B-tree for anyone who
wants to understand why every serious storage engine ultimately converges on
this shape.

The implementation was the hard part. The benchmark was just confirmation.
