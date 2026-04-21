---
layout: post
title: 'Build DBDB from scratch — Part 4: The part that holds it all together'
date: '2026-04-25 12:00'
excerpt: >-
  How `LogicalBase` manages lifecycle while `BinaryTree` owns algorithms: root refresh policy, `_follow` as the indirection boundary, immutable insert/delete path copying, in-order predecessor deletion, and why the storage contract stays duck-typed for clean tests.
comments: false
---

*Building DBDB from Scratch — Part 4*

---

Three posts in, and we have some impressive components:

- A file that only ever appends, with an atomic pointer at the front
- A lazy reference that loads data from disk exactly once and caches it
- An immutable tree node that creates new nodes instead of modifying old ones

What we can't do yet is anything useful. We can't look up a key. We can't insert one.
We can't even tell you whether the database is empty.

The pieces are right. What's missing is coordination.

When someone says `db["apple"]`, several things need to happen in the right order:
read the current root from storage, follow that root ref to get the root node,
traverse the tree node by node until we find `"apple"`, follow the value ref to
decode the bytes. Each step is a reference-follow, each follow is a potential disk
read, and all of it needs to happen in the context of the right storage object.

Something needs to manage that flow. That something is `LogicalBase`.

And the *algorithm* — how to actually search a binary search tree, how to create
new nodes on insert, how to handle the case where a deleted node has two children —
lives one level down, in `BinaryTree`.

---

## About this series

**Build DBDB from scratch** is a walkthrough of rebuilding **DBDB, the Dog Bed Database** from [*500 Lines or Less*](https://github.com/aosabook/500lines). Each post focuses on one layer of the implementation.

| Part | Core idea |
|------|------------|
| **0** | [Project setup](https://minhmannh2001.github.io/2026/04/21/build-dbdb-from-scratch-part-0-project-setup-en.html): `pyproject.toml`, smoke tests, pytest + BDD, Makefile |
| **1** | [Append-only storage](https://minhmannh2001.github.io/2026/04/22/build-dbdb-from-scratch-part-1-append-only-storage-en.html): superblock, `write`/`read`, root commit, `flush`/`fsync`, locking |
| **2** | [`ValueRef` and lazy loading](https://minhmannh2001.github.io/2026/04/23/build-dbdb-from-scratch-part-2-valueref-en.html): `get`/`store`, `BytesValueRef`, UTF-8 on disk |
| **3** | [Immutable tree and `BinaryNodeRef`](https://minhmannh2001.github.io/2026/04/24/build-dbdb-from-scratch-part-3-binarynode-en.html): copy-on-write, node serialization, lazy children |
| **4** (this post) | `LogicalBase` lifecycle + `BinaryTree` algorithms (`_get`, `_insert`, `_delete`) |
| **5** (next) | End-to-end flow: how all layers work together |

---

## One Class Knows Lifecycle, the Other Knows the Tree

A database operation has two completely different concerns.

**Lifecycle**: When do you read the root? What does "follow a reference" mean in this
context? What storage object do you pass down? These questions have the same answer
regardless of whether the underlying structure is a binary tree or a B-tree.

**Algorithm**: How do you find a key? How do you insert without mutating? How do you
delete a node that has two children? These questions depend entirely on the data structure.

DBDB separates these concerns using the template method pattern:

```
              LogicalBase  (lifecycle)
              ┌───────────────────────────────────────┐
              │  _storage: Storage                    │
              │  _tree_ref: NodeRef                   │
              │                                       │
              │  _refresh_tree_ref()  ← reads root   │
              │  _follow(ref) → node  ← indirection  │
              │  __len__() → int      ← O(1)         │
              │                                       │
              │  _get(node, key)  ─┐                 │
              │  _insert(...)      ├ NotImplemented  │
              │  _delete(...)     ─┘                 │
              └───────────────────────────────────────┘
                              ▲
                              │ subclass
              ┌───────────────────────────────────────┐
              │  BinaryTree  (algorithm)              │
              │                                       │
              │  node_ref_class  = BinaryNodeRef      │
              │  value_ref_class = ValueRef           │
              │                                       │
              │  _get    → iterative BST search       │
              │  _insert → recursive, path copying    │
              │  _delete → recursive, path copying    │
              └───────────────────────────────────────┘
```

If you wanted to swap the binary tree for a B-tree, you'd write a new subclass
with different `_get/_insert/_delete`. `LogicalBase` wouldn't need to change.
Same lifecycle, different algorithm.

---

## LogicalBase: Three Methods That Define the Contract

### The root refresh question

When do you re-read the root from disk?

If you refresh on every single call, you always see the latest committed state —
but you risk seeing someone else's commit *while you're in the middle of writing*.
If you never refresh, you might work from a stale snapshot forever.

The answer: refresh when you're *not* locked. Before any write, you've acquired
the lock, so the snapshot is stable. For reads, refresh each time.

```python
def __init__(self, storage):
    self._storage = storage
    self._refresh_tree_ref()

def _refresh_tree_ref(self):
    self._tree_ref = self.node_ref_class(address=self._storage.get_root_address())
    # Creates a NodeRef that knows WHERE the root is — but hasn't loaded it.
    # The actual disk read is deferred until someone calls _follow(self._tree_ref).

def __len__(self):
    if not self._storage.locked:
        self._refresh_tree_ref()
        # Unlocked = safe to see the latest committed root.
        # Locked = we're in a write session; hold the current snapshot.
    root = self._follow(self._tree_ref)
    if root:
        return root.length  # O(1) — tracked in the node, not computed by traversal
    return 0
```

That `root.length` is O(1) because of work we did in Phase 3: every node tracks
the size of its own subtree through `from_node`'s length accounting. The payoff
arrives here.

### `_follow`: one method, every traversal

```python
def _follow(self, ref):
    return ref.get(self._storage)
```

Four words. But this is the only place in the codebase where a ref's address
gets resolved to a Python object. Every tree traversal — search, insert, delete —
passes through here.

That's intentional. By routing everything through a single method, you have one
place to add caching, one place to add metrics, one place to inject fakes in tests.
You also ensure that storage is always passed consistently — it's impossible to
accidentally resolve a ref without a storage context.

### The algorithm hooks

```python
def _get(self, node, key):
    raise NotImplementedError()

def _insert(self, node, key, value_ref):
    raise NotImplementedError()

def _delete(self, node, key):
    raise NotImplementedError()
```

Abstract stubs. `LogicalBase` promises that *something* will search, insert, and
delete — but defers the *how* to whoever subclasses it. This is the seam where
you'd plug in a different data structure.

---

## BinaryTree: The Algorithm

### Search: iterative

`_get` walks down the tree until it finds the key or falls off the edge:

```python
def _get(self, node, key):
    while node is not None:
        if key < node.key:
            node = self._follow(node.left_ref)
        elif node.key < key:
            node = self._follow(node.right_ref)
        else:
            return self._follow(node.value_ref)
    raise KeyError
```

`self._follow(node.left_ref)` on every step means each level of the tree is a
potential disk read. In a tree with a million nodes, a lookup touches about 20 nodes.
The `ValueRef` caching from Phase 2 means a node visited twice in the same session
only hits disk once — but for a lookup, you visit each node exactly once.

### Insert: recursive, always returns a new ref

```python
def _insert(self, node, key, value_ref):
    if node is None:
        new_node = BinaryNode(self.node_ref_class(), key, value_ref, self.node_ref_class(), 1)
    elif key < node.key:
        new_node = BinaryNode.from_node(
            node,
            left_ref=self._insert(self._follow(node.left_ref), key, value_ref),
        )
    elif node.key < key:
        new_node = BinaryNode.from_node(
            node,
            right_ref=self._insert(self._follow(node.right_ref), key, value_ref),
        )
    else:
        new_node = BinaryNode.from_node(node, value_ref=value_ref)
        # Duplicate key: swap the value, keep the same structure and length.
    return self.node_ref_class(referent=new_node)
    # Always returns a new ref — the caller's tree is never touched.
```

The last line is the invariant enforced at the algorithm level: `_insert` *always*
returns a new `BinaryNodeRef`. No matter what path the recursion takes, the caller
gets a fresh ref pointing to a fresh node. The original tree is untouched.

Path copying in code: only the nodes along the insertion path get recreated.
Everything else is shared through unchanged refs.

### Delete: the interesting case

Deleting a leaf or a node with one child is mechanical — return the surviving child,
or an empty ref if both are absent:

```python
elif left:
    return node.left_ref
else:
    return node.right_ref
```

But deleting a node with *two* children is trickier. You can't just splice it out
because two things were pointing at it. The solution: find the *in-order predecessor*
(the rightmost node in the left subtree), promote it to take the deleted node's position,
and remove the original predecessor from the left subtree.

```
       B  ← delete this
      / \
     A   C
```

"A" is the max of the left subtree. It becomes the new root:

```
       A
        \
         C
```

In code:

```python
if left and right:
    replacement = self._find_max(left)
    left_ref = self._delete(self._follow(node.left_ref), replacement.key)
    new_node = BinaryNode(
        left_ref,
        replacement.key,
        replacement.value_ref,
        node.right_ref,     # right subtree is shared — no copy needed
        left_ref.length + node.right_ref.length + 1,
    )
```

Two things worth pausing on.

`node.right_ref` is reused directly. The entire right subtree is shared between the
old tree and the new one. Path copying only recreates nodes along the deletion path.

And reducing "delete with two children" to "delete with one or zero" is elegant:
the in-order predecessor is always the rightmost node in the left subtree.
By definition, the rightmost node has no right child — so deleting it from the
left subtree always hits the simple case.

```python
def _find_max(self, node):
    while True:
        next_node = self._follow(node.right_ref)
        if next_node is None:
            return node
        node = next_node
    # Iterative, not recursive — just walk right until there's nothing more.
```

---

## Testing the Algorithm Without a Real File

All tree algorithm tests use `StubStorage` — a fake that holds data in a Python
list instead of a file:

```python
class StubStorage:
    def __init__(self):
        self.d = [0]   # index 0 is the root address slot (starts at 0 = empty)
        self.locked = False

    def write(self, data):
        address = len(self.d)  # address = list index
        self.d.append(data)
        return address

    def read(self, address):
        return self.d[address]

    def get_root_address(self):
        return 0
```

The tree algorithms are testable completely independently of the file layer.
`test_delete_root_with_two_children` doesn't know or care that the real storage
uses `struct.pack` and `os.fsync`. The only contract it needs is `read(address)`
and `write(data)` — and any object that provides those two methods is a valid
`Storage` from the tree's perspective.

This is why `LogicalBase` never imports `Storage`. It relies only on the duck-typed
interface. Swapping the real storage for a test double is not a workaround;
it's exactly the design.

---

## What This Teaches You About Databases

The separation between `LogicalBase` and `BinaryTree` is a small example of
something that shows up across every serious database engine.

SQLite separates its B-tree module from its storage (page cache) layer. PostgreSQL's
table access method API lets you write different storage backends (heap, TOAST, zedstore)
behind the same query executor. In both cases, the "when do I lock, when do I refresh,
what does a read look like" questions are answered once, at the lifecycle layer —
and the data structure algorithm answers only "how do I find or modify a key."

The refresh-on-read / hold-during-write pattern is a simplified form of
**snapshot isolation**: you read from a consistent point in time, and only at
commit time do you establish an exclusive claim. DBDB's version is naive (it
doesn't detect write conflicts), but the shape of the idea is the same.

One other thing this phase reveals: the database engine is now a *system*, not
just a pile of components. `LogicalBase._follow` is the boundary between "I have
an address" and "I have data." Every operation in the database crosses that boundary
by going through the same method. That's the kind of single-responsibility design
that makes a codebase navigable six months after you wrote it.

---

## What's Next

The tree can search, insert, and delete. But there's still no external face.
No one can say `db["apple"] = "red"`. There's no `set()`, no `get()`, no `commit()`,
no way to open a database file by name.

The next post wraps everything we've built — storage, references, tree —
behind a Python dictionary that actually survives a restart.
