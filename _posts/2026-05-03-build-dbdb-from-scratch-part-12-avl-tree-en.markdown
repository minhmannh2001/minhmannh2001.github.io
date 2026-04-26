---
layout: post
title: "Build DBDB from scratch — Part 12: Replacing BST with AVL"
date: '2026-05-03 12:00'
excerpt: >-
  The benchmark was supposed to find a known limitation, but it found two other bugs first: an N+1 query problem and a recursion depth error from inserting sorted keys. Both were symptoms of the same core issue — a tree with no opinion about its own shape. This post replaces the BST with a self-balancing AVL tree, adding a height field to every node, implementing immutable rotations, and introducing a tree type flag to keep old databases working.
comments: false
---

*Building DBDB from Scratch — Part 12: Replacing BST with AVL*

---

The retrospective had listed it as a known limitation:

> *The tree doesn't rebalance. Compaction inserts keys in sorted order,
> producing a skewed BST with O(n) lookup.*

Known limitation is a polite way of saying "we know this is broken and
haven't fixed it yet." The benchmark was supposed to put a number on how
broken. It did — just not in the way expected.

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
| **12** | **Replacing the BST with an AVL tree** (this post) |

---

## The Benchmark Runs. Things Break.

The first run didn't get far.

`compact()` was reading all key-value pairs from the old file to copy into
a new one. It got them through `self.items()`, which at the time looked like
this:

```python
def items(self):
    self._assert_not_closed()
    for key in self:
        yield (key, self[key])
```

`for key in self` walks the tree in-order — one full traversal to get every
key. Then `self[key]` for each key climbs back down the tree from the root
to find the value. For a database with 1,000 keys, that's 1,001 tree walks.
Every disk read, every pointer follow, done a thousand times over.

This was the N+1 problem hiding in plain sight. No one had noticed because
`items()` was only ever called from `compact()`, and `compact()` had never
been called on a real database until now.

The fix was straightforward: add a traversal to `BinaryTree` that yields
both key and value in one pass, without ever going back to the root.

```python
def _iter_items(self, node):
    if node:
        yield from self._iter_items(self._follow(node.left_ref))
        yield (node.key, self._follow(node.value_ref))
        yield from self._iter_items(self._follow(node.right_ref))

def items(self):
    root = self._follow(self._tree_ref)
    yield from self._iter_items(root)
```

One traversal. Every node visited once, key and value resolved together.
`DBDB.items()` was updated to just delegate down:

```python
def items(self):
    self._assert_not_closed()
    self._reopen_if_replaced()
    return self._tree.items()
```

With that fixed, the benchmark ran again.

And crashed with a different error.

---

## RecursionError

```
RecursionError: maximum recursion depth exceeded
```

`items()` yields keys in sorted order — that's what in-order traversal
produces. `compact()` was taking those sorted keys and inserting them one
by one into the new BST:

```python
for key, value in self.items():
    new_db[key] = value
```

Inserting sorted keys into a BST is the worst possible input. Every new
key is larger than everything already in the tree, so every insert goes to
the rightmost child. After 1,000 inserts, the "tree" is a chain 1,000 nodes
long. `_insert` is recursive. Inserting the 1,001st key requires a call
stack 1,000 frames deep. Python's default limit is 1,000.

The fix was to break the sorted order before inserting: load all items into
memory, shuffle them, then insert in random order.

```python
items = list(self.items())
random.shuffle(items)
for key, value in items:
    new_db[key] = value
new_db.commit()
```

Random insertion gives a BST an expected height of about 2 ln N — around
14 levels for 1,000 keys. That's well within the recursion limit, and the
tree ends up reasonably balanced.

The benchmark finally ran to completion.

---

## The Shuffle Isn't Enough

The shuffle fixed the crash. It didn't fix the tree.

"Reasonably balanced" is not the same as "balanced." A randomly ordered
BST has an expected height of 2 ln N, but that's an average — a particular
insertion order might still produce a lopsided tree. And loading the entire
database into memory to shuffle it is a trade-off: it works for a prototype,
but a database too large to fit in RAM has nowhere to go with this approach.

The right answer was already obvious: use a self-balancing tree. One that
keeps itself balanced automatically, regardless of insertion order, without
needing the shuffle workaround at all.

The BST had done its job as a starting point. It was time to replace it.

---

## Adding Height to Every Node

An AVL tree keeps itself balanced by enforcing one rule: at every node,
the height of the left subtree and the height of the right subtree can
differ by at most one. To enforce that rule, every node has to know its
own height.

That meant adding a field to `BinaryNode`:

```python
# Before
@dataclass
class BinaryNode:
    left_ref: BinaryNodeRef
    key: str
    value_ref: ValueRef
    right_ref: BinaryNodeRef
    length: int

# After
@dataclass
class BinaryNode:
    left_ref: BinaryNodeRef
    key: str
    value_ref: ValueRef
    right_ref: BinaryNodeRef
    length: int
    height: int
```

One field. The ripple effects were wider than expected.

Every place that constructed a `BinaryNode` now needed a `height`. New leaf
nodes get height 0. And `from_node` — the copy-with-overrides constructor
used all through the insert/delete path — had to learn to accept an explicit
height, because rotations recalculate heights and need to write the new value
back in:

```python
@classmethod
def from_node(cls, node: BinaryNode, **kwargs: Any) -> BinaryNode:
    length = node.length
    if "left_ref" in kwargs:
        length += kwargs["left_ref"].length - node.left_ref.length
    if "right_ref" in kwargs:
        length += kwargs["right_ref"].length - node.right_ref.length
    return cls(
        left_ref=kwargs.get("left_ref", node.left_ref),
        key=kwargs.get("key", node.key),
        value_ref=kwargs.get("value_ref", node.value_ref),
        right_ref=kwargs.get("right_ref", node.right_ref),
        length=length,
        height=kwargs.get("height", node.height),   # new
    )
```

Without that last line, `from_node` copies the old height into the new node
even after its subtree has structurally changed. The rotation runs, the
pointers move, and the height stays stale. That bug survived several
test iterations before the root cause became clear.

The serialization layer needed updating too. `BinaryNodeRef` packs nodes
into msgpack dicts. `height` had to go in both directions:

```python
@staticmethod
def referent_to_bytes(referent: BinaryNode) -> bytes:
    return msgpack.packb({
        "left":   referent.left_ref.address,
        "key":    referent.key,
        "value":  referent.value_ref.address,
        "right":  referent.right_ref.address,
        "length": referent.length,
        "height": referent.height,     # new
    })

@staticmethod
def bytes_to_referent(data: bytes) -> BinaryNode:
    d = msgpack.unpackb(data, raw=False)
    return BinaryNode(
        BinaryNodeRef(address=d["left"]),
        d["key"],
        ValueRef(address=d["value"]),
        BinaryNodeRef(address=d["right"]),
        d["length"],
        d["height"],                   # new
    )
```

Adding `height` to the serialization format is a breaking change. Any database
written before this point can't be read by the new code — the old msgpack dicts
don't have a `"height"` key. That's the reason for the tree type flag introduced
later: it marks which format a file was written in.

---

## Two Helper Functions and a New File

With the node foundation ready, `avl_tree.py` started from scratch. The first
two things it needed were `_get_height` and `_get_balance_factor`:

```python
class AVLTree(LogicalBase):
    node_ref_class = BinaryNodeRef
    value_ref_class = ValueRef

    def _get_height(self, node: Optional[BinaryNode]) -> int:
        if node is None:
            return -1      # null pointer → height -1 by convention
        return node.height

    def _get_balance_factor(self, node: Optional[BinaryNode]) -> int:
        if node is None:
            return 0
        return (
            self._get_height(self._follow(node.left_ref))
            - self._get_height(self._follow(node.right_ref))
        )
```

`height(None) = -1` is the convention that makes the arithmetic clean.
A leaf node has two null children, so `height = max(-1, -1) + 1 = 0`.
The balance factor at every non-null node is just `left height - right height`.
If it goes above 1 or below -1, the tree needs a rotation.

---

## Rotations Without Mutation

AVL rotations are usually explained with diagrams of pointers being redirected.
Right-rotate Y: make Y's left child X the new root, move X's right subtree to
become Y's new left child, update heights. Three pointer rewrites and done.

DBDB's nodes are immutable. Nothing on disk ever gets rewritten. So instead
of redirecting pointers, you create new nodes that point differently.

A right rotation produces two new nodes: a new version of Y (now demoted, with
a different left child) and a new version of X (now the root, with new-Y as
its right child). The old X and Y sit untouched on disk. Eventually compaction
cleans them up.

The ordering matters: you have to compute new-Y's height before computing
new-X's height, because new-X depends on new-Y. Getting this backwards
produces a stale height that propagates silently through subsequent operations.

```python
def _right_rotate(self, old_root: BinaryNode) -> BinaryNodeRef:
    new_root = self._follow(old_root.left_ref)
    moved_subtree_ref = new_root.right_ref

    # First: rebuild old_root with its new left child, then recalculate its height
    old_root_updated = BinaryNode.from_node(old_root, left_ref=moved_subtree_ref)
    old_root_updated = BinaryNode.from_node(
        old_root_updated,
        height=max(
            self._get_height(self._follow(old_root_updated.left_ref)),
            self._get_height(self._follow(old_root_updated.right_ref)),
        ) + 1,
    )

    # Then: rebuild new_root with old_root_updated as its right child
    new_root_updated = BinaryNode.from_node(
        new_root, right_ref=self.node_ref_class(referent=old_root_updated)
    )
    new_root_updated = BinaryNode.from_node(
        new_root_updated,
        height=max(
            self._get_height(self._follow(new_root_updated.left_ref)),
            self._get_height(self._follow(new_root_updated.right_ref)),
        ) + 1,
    )
    return self.node_ref_class(referent=new_root_updated)
```

`_left_rotate` is the mirror: the right child becomes the new root, its left
subtree moves to become the old root's right child.

---

## Balancing After Every Insert

The `_insert` logic in `AVLTree` starts the same as in `BinaryTree` — walk
down, place the key in the right spot. The difference is what happens on the
way back up.

After each recursive call returns, the current node's height gets updated,
the balance factor gets checked, and if the tree is out of balance, one of
four rotation cases fires:

```python
def _insert(self, node, key, value_ref):
    # Walk down — same as BST
    if node is None:
        return self.node_ref_class(referent=BinaryNode(
            self.node_ref_class(), key, value_ref,
            self.node_ref_class(), 1, 0,
        ))
    if key < node.key:
        node_updated = BinaryNode.from_node(
            node, left_ref=self._insert(self._follow(node.left_ref), key, value_ref)
        )
    elif node.key < key:
        node_updated = BinaryNode.from_node(
            node, right_ref=self._insert(self._follow(node.right_ref), key, value_ref)
        )
    else:
        node_updated = BinaryNode.from_node(node, value_ref=value_ref)

    # On the way back up — update height, then rebalance if needed
    node_updated = BinaryNode.from_node(
        node_updated,
        height=max(
            self._get_height(self._follow(node_updated.left_ref)),
            self._get_height(self._follow(node_updated.right_ref)),
        ) + 1,
    )

    balance = self._get_balance_factor(node_updated)

    if balance > 1 and key < self._follow(node_updated.left_ref).key:
        return self._right_rotate(node_updated)                         # Left-Left

    if balance < -1 and key > self._follow(node_updated.right_ref).key:
        return self._left_rotate(node_updated)                          # Right-Right

    if balance > 1 and key > self._follow(node_updated.left_ref).key:
        node_updated = BinaryNode.from_node(                            # Left-Right
            node_updated,
            left_ref=self._left_rotate(self._follow(node_updated.left_ref))
        )
        return self._right_rotate(node_updated)

    if balance < -1 and key < self._follow(node_updated.right_ref).key:
        node_updated = BinaryNode.from_node(                            # Right-Left
            node_updated,
            right_ref=self._right_rotate(self._follow(node_updated.right_ref))
        )
        return self._left_rotate(node_updated)

    return self.node_ref_class(referent=node_updated)
```

The four cases cover every way a tree can go out of balance after an insert.
Left-Left and Right-Right need one rotation each. Left-Right and Right-Left
need two. Deletion uses the same four cases, but triggered by the child's
balance factor rather than the inserted key — because there's no key to
compare against when removing.

---

## Keeping Old Databases Working

`AVLTree` was ready. The next question was: what happens to databases that
were written with the old BST code?

Old databases have nodes serialized without a `height` field. Reading them
with the new `bytes_to_referent` would crash on `d["height"]`. And even if
that were handled, an old BST database can't just be silently read as an AVL
tree — the height values would be wrong or missing.

The cleanest solution was to record which format a database was written in.
The superblock was the natural place: it's 4096 bytes, only the first 8 were
in use. Byte 8 — right after the root address — became a tree type flag.

```python
def get_tree_type(self) -> int:
    self._seek_superblock()
    self._f.seek(self.INTEGER_LENGTH, os.SEEK_CUR)  # skip root address
    data = self._f.read(1)
    if not data:
        return 0
    return struct.unpack("!B", data)[0]

def set_tree_type(self, tree_type: int) -> None:
    self.lock()
    self._seek_superblock()
    self._f.seek(self.INTEGER_LENGTH, os.SEEK_CUR)
    self._f.write(struct.pack("!B", tree_type))
    self._f.flush()
    self._fsync_if_possible()
    self.unlock()
```

`0` = BST. `1` = AVL. Old databases have a zero there because the superblock
was initialized to all zeros when first created. That zero reads as BST, which
is exactly right — no migration needed.

`DBDB.__init__` reads the flag on open and uses it to pick the right tree:

```python
def __init__(self, f: IO, tree_type: str = "bst"):
    self._storage = Storage(f)

    root_addr = self._storage.get_root_address()
    if root_addr == 0:
        # New file — write the caller's choice into the superblock
        type_flag = 1 if tree_type == "avl" else 0
        self._storage.set_tree_type(type_flag)
    else:
        # Existing file — ignore the caller, use what the file says
        type_flag = self._storage.get_tree_type()

    self._tree_type_flag = type_flag
    self._init_tree()

def _init_tree(self) -> None:
    if self._tree_type_flag == 1:
        from dbdb.avl_tree import AVLTree
        self._tree = AVLTree(self._storage)
    else:
        from dbdb.binary_tree import BinaryTree
        self._tree = BinaryTree(self._storage)
```

The rule: a new file follows the caller's request. An existing file ignores
it. The file always wins. Compaction carries the flag forward when it creates
the replacement file, so the tree type survives a compact.

The `connect()` call got one optional argument:

```python
db = dbdb.connect("mydb.db")                        # BST (default)
db = dbdb.connect("mydb.db", tree_type="avl")       # AVL, new file
db = dbdb.connect("existing.db", tree_type="avl")   # AVL ignored — file says BST
```

---

## What the Numbers Looked Like

The benchmark ran both trees side by side: 10,000 random keys for general
performance, and 1,000 keys overwritten ten times each to test compaction.

**General performance:**

| Operation         | BST          | AVL          |
|-------------------|--------------|--------------|
| Sequential writes | 5,028 ops/s  | 4,794 ops/s  |
| Random reads      | 20,549 ops/s | 21,875 ops/s |

Writes dropped about 5%. That's the cost of checking the balance factor
and potentially running a rotation on every insert. Reads improved about
6.5% — smaller than expected. With 10,000 randomly inserted keys, the BST
ends up reasonably balanced on its own (expected height around 2 ln 10,000
≈ 18 levels), while the AVL tree stays closer to log₂ 10,000 ≈ 13 levels.
The gap exists, but random insertion is already a fairly kind workload for
a BST.

**Compaction impact:**

| Metric               | BST before | BST after | AVL before | AVL after |
|----------------------|------------|-----------|------------|-----------|
| File size (bytes)    | 1,822,832  | 184,740   | 1,822,828  | 184,730   |
| Random reads (ops/s) | 25,514     | 26,522    | 33,521     | 34,443    |
| Compaction time (s)  | —          | 0.023     | —          | 0.030     |

Here the gap is harder to ignore. Even before compaction, the AVL tree is
reading at 33,521 ops/s while the BST sits at 25,514 — about 31% faster.
With 1,000 keys, the BST's expected height is around 14 levels; the AVL
tree stays around 10. Fewer levels, fewer disk reads per lookup.

File sizes are nearly identical — the `height` field adds a small constant
per node, but most of the file is key and value bytes. Both trees shrank
about 90% after compaction. AVL compaction took 30ms vs the BST's 23ms,
because every re-insert during the rebuild triggers balance checks. At
that scale the difference doesn't matter.

---

## What Actually Changed

Four files. `avl_tree.py` was new. `binary_tree.py` got `height` on
`BinaryNode` and the `from_node` update. `physical.py` got `get_tree_type`
and `set_tree_type`. `interface.py` got `_init_tree` and the flag-reading
logic in `__init__`.

The CLI didn't change. The compaction logic didn't change in structure.
The storage layer's read/write/lock API didn't change. `AVLTree` extended
`LogicalBase` and slotted into the same position `BinaryTree` had occupied
— same interface, same contract, different internals.

The 165 tests that existed before passed without modification. Only the
handful of assertions that specifically checked `isinstance(..., BinaryTree)`
needed updating to `isinstance(..., AVLTree)`.

The BST is still there, still reachable via `tree_type="bst"`. Old databases
keep working exactly as before. The AVL tree is now the default for new ones
— and the shuffle in `compact()` that was keeping things from crashing is
still there too, as a belt-and-suspenders measure even for a balanced tree.

The two bugs from the first benchmark run turned out to be symptoms of the
same underlying problem: a tree with no opinion about its own shape. The AVL
tree has an opinion, and it enforces it.
