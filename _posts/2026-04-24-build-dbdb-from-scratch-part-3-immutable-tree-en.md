---
layout: post
title: 'Build DBDB from scratch — Part 3: A tree that never changes'
date: '2026-04-24 12:00'
excerpt: >-
  How immutable binary search tree nodes, copy-on-write path updates, and address-only node serialization give DBDB atomic reads with minimal locking. Includes `from_node` length deltas, post-order persistence, and lazy child loading through `BinaryNodeRef`.
comments: false
---

*Building DBDB from Scratch — Part 3*

---

There's a version of this where I build a normal binary search tree.
You know the kind: insert a node, update its parent's `left` or `right` pointer.
Delete a node, reconnect its children. Standard stuff.

And then I think about what happens when two threads both try to insert at the same time.
Or when the program crashes mid-insert, leaving a pointer dangling.
Or when a reader is traversing a path that a writer is actively modifying.

These aren't edge cases. They're the reason database concurrency control is hard.
They're why people spend careers working on MVCC, write-ahead logs, and lock managers.

DBDB sidesteps most of this complexity with one radical constraint: **tree nodes are never modified after creation**.

---

## About this series

**Build DBDB from scratch** is a walkthrough of rebuilding **DBDB, the Dog Bed Database** from [*500 Lines or Less*](https://github.com/aosabook/500lines). Each post focuses on one layer of the implementation.

| Part | Core idea |
|------|------------|
| **0** | [Project setup]({% post_url 2026-04-21-build-dbdb-from-scratch-part-0-project-setup-en %}): `pyproject.toml`, smoke tests, pytest + BDD, Makefile |
| **1** | [Append-only storage]({% post_url 2026-04-22-build-dbdb-from-scratch-part-1-append-only-storage-en %}): superblock, `write`/`read`, root commit, `flush`/`fsync`, locking |
| **2** | [`ValueRef` and lazy loading]({% post_url 2026-04-23-build-dbdb-from-scratch-part-2-valueref-en %}): `get`/`store`, `BytesValueRef`, UTF-8 on disk |
| **3** (this post) | Immutable tree, copy-on-write, `BinaryNodeRef`, address-only serialization |
| **4** (next) | [Logical layer: `LogicalBase` + `BinaryTree`]({% post_url 2026-04-25-build-dbdb-from-scratch-part-4-logical-layer-en %}): search, insert, delete, commit |
| **Interlude** | [How all layers fit together]({% post_url 2026-04-26-build-dbdb-from-scratch-part-5-how-it-all-fits-en %}): one key write/read trace |

---

## What "Immutable Tree" Actually Means

In a mutable tree, inserting `"D"` into this tree:

```
        B
       / \
      A   C
```

might modify node `C` in-place: `C.right = D`. Simple. Fast. Easy to corrupt.

In an immutable tree, you can't modify `C`. Instead, you create a new `C'`
that's identical to `C` except its right pointer points to the new `D`.
Then you create a new `B'` identical to `B` except its right pointer points to `C'`.

```
Old tree (still intact):    New tree (newly created):
        B                           B'
       / \                         / \
      A   C                       A   C'
                                       \
                                        D
```

`A` is shared between both trees — you don't copy it.
`B` and `C` still exist, still pointed to by the old root.
`B'` and `C'` are new, pointed to by the new root.

The old tree doesn't go away. It lives on disk until compaction (which DBDB
doesn't implement, but the slots for it are obvious). Any reader holding the
old root sees a complete, consistent tree. Any reader after the commit sees
the new complete tree. There's no moment where the tree is "in between."

This is **copy-on-write**, or **path copying**: only the nodes along the
modified path get recreated. Untouched subtrees are shared.

---

## BinaryNode: Five Fields, No Setters

```python
from dataclasses import dataclass

@dataclass
class BinaryNode:
    left_ref:  Any   # reference to left subtree (BinaryNodeRef or empty ref)
    key:       Any   # this node's key in the BST ordering
    value_ref: Any   # reference to this key's value
    right_ref: Any   # reference to right subtree
    length:    int   # number of nodes in this subtree (including this node)
```

Notice what's absent: no `__setattr__`, no `update()`, no mutation methods.
The only way to "change" a `BinaryNode` is to create a new one.

The `length` field is worth pausing on. In a mutable BST, you often compute
`len(tree)` by traversing every node — O(n). In DBDB, each node tracks
the size of its own subtree. To get the tree's length, you just read `root.length`.
O(1).

But how do you keep `length` accurate when you create new nodes?

---

## `from_node`: Copy-on-Write with Local Length Updates

```python
@classmethod
def from_node(cls, node: "BinaryNode", **kwargs) -> "BinaryNode":
    length = node.length

    if "left_ref" in kwargs:
        # The new left child might be bigger or smaller than the old one.
        # Instead of recomputing the whole subtree, just add the difference.
        length += kwargs["left_ref"].length - node.left_ref.length

    if "right_ref" in kwargs:
        length += kwargs["right_ref"].length - node.right_ref.length

    # Note: value_ref is intentionally excluded from the length calculation.
    # Length counts nodes, not values. Changing a value doesn't add or remove a node.

    return cls(
        left_ref=  kwargs.get("left_ref",  node.left_ref),
        key=       kwargs.get("key",        node.key),
        value_ref= kwargs.get("value_ref",  node.value_ref),
        right_ref= kwargs.get("right_ref",  node.right_ref),
        length=    length,
    )
```

Let's trace through a concrete insert. Say we're inserting `"D"` with value `"delta"`:

```
Initial state:
    B (length=2)
   / \
  A   C (length=1)
  (length=1)

Insert D (goes right of C):
    new_d = BinaryNode(empty, "D", ValueRef("delta"), empty, length=1)
    new_d_ref = BinaryNodeRef(new_d)

    new_c = BinaryNode.from_node(c, right_ref=new_d_ref)
    # new_c.length = c.length + (new_d_ref.length - c.right_ref.length)
    #              = 1 + (1 - 0)
    #              = 2  ✓

    new_b = BinaryNode.from_node(b, right_ref=BinaryNodeRef(new_c))
    # new_b.length = b.length + (new_c.length - c.length)
    #              = 2 + (2 - 1)
    #              = 3  ✓

Result:
    B' (length=3)
   /  \
  A    C' (length=2)
         \
          D (length=1)
```

No traversal, no counting. Each node's length is updated in O(1)
based on the delta from its changed child.

---

## Committing to Disk: The Order Matters

Here's where it gets interesting. The tree exists in memory as Python objects.
When we commit, we need to serialize it to the database file. But we can't
serialize a node until we know the disk addresses of everything it points to.

```
❌ Wrong order:
Serialize B' → pickle includes "left: ???, right: ???" (addresses unknown)

✅ Right order (post-order):
1. Serialize A → gets address 4096
2. Serialize D → gets address 4200
3. Serialize C' → pickle includes "right: 4200" → gets address 4350
4. Serialize B' → pickle includes "left: 4096, right: 4350" → gets address 4500
```

This is implemented through two cooperating methods:

```python
def store_refs(self, storage) -> None:
    self.value_ref.store(storage)
    self.left_ref.store(storage)
    self.right_ref.store(storage)
    # The three calls are nearly independent of each other — data correctness
    # doesn't require this particular order. What's required is simply that
    # all three refs have addresses *before the node is pickled*. The ordering
    # mirrors the reference chapter's, which keeps the on-disk layout stable
    # and the code easy to compare when debugging.
```

The guarantee doesn't come from the order of those three lines. It comes from when
`store_refs` is called at all — which is in `prepare_to_store`, *before*
`referent_to_bytes` ever runs. By the time any pickling happens, `store_refs` has
already returned and every pointer has a home on disk.

And in `BinaryNodeRef`:

```python
def prepare_to_store(self, storage) -> None:
    if self._referent:
        self._referent.store_refs(storage)
    # This is called by ValueRef.store() before writing bytes.
    # The chain: BinaryNodeRef.store() → prepare_to_store() → store_refs()
    #            → value_ref.store(), left_ref.store(), right_ref.store()
    #            → [each child's prepare_to_store() if it's also a BinaryNodeRef]
    #            → ... eventually reaches leaf nodes with no children
    # Then unwinds, serializing from leaves up to root.
```

It's a tree traversal disguised as a chain of method calls.

---

## The Serialization Question: Why Not Just Pickle the Whole Node?

When it's time to actually write bytes, `BinaryNodeRef` uses pickle:

```python
@staticmethod
def referent_to_bytes(referent: BinaryNode) -> bytes:
    return pickle.dumps({
        "left":   referent.left_ref.address,   # integer
        "key":    referent.key,                 # the actual key string
        "value":  referent.value_ref.address,  # integer
        "right":  referent.right_ref.address,  # integer
        "length": referent.length,             # integer
    })
```

Notice what's *not* here: the actual subtrees. We're pickling **addresses**,
not objects. Five fields, all of them small.

Why not `pickle.dumps(referent)` — serialize the whole `BinaryNode`?

Because that would recursively serialize the entire subtree rooted at this node.
Insert one key into a tree with 10,000 nodes: path copying creates maybe 14 new nodes.
But if you pickle the root node, you'd serialize all 10,000 nodes every time.
The file would grow by `O(n)` per update instead of `O(log n)`.

By serializing only addresses, each node's record is constant size — 
independent of the tree's depth or breadth. The tree remains navigable
because reading a node gives you the addresses of its children,
and you can follow those addresses on demand. This is the same idea as
a B-tree page in a real database: a page contains keys and child page IDs,
not the children themselves.

---

## Loading It Back: Lazy by Default

```python
@staticmethod
def bytes_to_referent(data: bytes) -> BinaryNode:
    d = pickle.loads(data)
    return BinaryNode(
        BinaryNodeRef(address=d["left"]),   # knows WHERE, not WHAT
        d["key"],
        ValueRef(address=d["value"]),       # knows WHERE, not WHAT
        BinaryNodeRef(address=d["right"]),  # knows WHERE, not WHAT
        d["length"],
    )
    # This reconstructs a BinaryNode where all the refs have addresses
    # but no loaded referents. They're all in "State B" from the ValueRef post:
    # pointer-only, not loaded.
    #
    # When the tree traversal needs to go left, it calls:
    #   node.left_ref.get(storage)
    # That triggers one disk read — just for that one node.
    # The right subtree, the value, the cousins, the aunts — none of them
    # are loaded until explicitly needed.
```

---

## The Length Edge Case: Knowing Without Loading

One subtle issue: `BinaryNodeRef.length` needs to return the subtree size
so that `from_node` can update lengths correctly. But what if the node
isn't loaded yet?

```python
@property
def length(self) -> int:
    if self._referent is None and self._address:
        raise RuntimeError("Asking for BinaryNodeRef length of unloaded node")
        # This is a programming error, not a user error.
        # If you're calling from_node, you should already have the old node's
        # referent loaded. If you don't, you've misused the API.
    if self._referent:
        return self._referent.length
    return 0  # empty ref (address=0, referent=None) → empty subtree
```

The `RuntimeError` might seem aggressive. But it surfaces a real mistake:
if you try to compute a new node's length based on an unloaded child,
you'll get silent wrong answers (0 instead of the real size). Better to
crash loudly and tell you exactly where you went wrong.

---

## Stepping Back: What Have We Built?

Three layers, each with a clear responsibility:

```
┌─────────────────────────────────────────────────────────┐
│  BinaryNode + BinaryNodeRef                             │
│  • Immutable nodes (copy-on-write updates)              │
│  • Address-only serialization (constant-size records)   │
│  • Post-order store (children before parents)           │
│  • Lazy loading (load only when traversed)              │
└───────────────────────┬─────────────────────────────────┘
                        │ uses
┌───────────────────────▼─────────────────────────────────┐
│  ValueRef + BytesValueRef                               │
│  • Lazy pointer: disk address or in-memory object       │
│  • Idempotent store (write-once)                        │
│  • Extensible serialization (override two static methods)│
└───────────────────────┬─────────────────────────────────┘
                        │ uses
┌───────────────────────▼─────────────────────────────────┐
│  Storage                                                │
│  • Append-only: never overwrite                         │
│  • Atomic root pointer in superblock                    │
│  • fsync for durability                                 │
│  • Advisory file locking                                │
└─────────────────────────────────────────────────────────┘
```

Each layer knows nothing about the layers above it.
`Storage` doesn't know about trees. `ValueRef` doesn't know about binary nodes.
`BinaryNode` doesn't know about the physical layout of the file.

This separation isn't just clean code — it's how you can understand a piece of
the system without holding the whole thing in your head. It's also why the 500 Lines
authors say you could swap out the binary tree for a B-tree
without touching `Storage` at all.

---

## The Principle That Generalizes

Immutable data structures show up everywhere in modern systems:

- **Git** uses immutable content-addressed objects. A commit is a snapshot
  of the entire tree, not a diff. Sound familiar?
- **CouchDB** was an explicit inspiration for DBDB — same append-only,
  same "flip the root" commit semantics.
- **Persistent data structures** in Clojure, Haskell, Elm, React (via Redux state)
  all use path copying as their core update mechanism.
- **LMDB** (used in many production databases) uses a copy-on-write B-tree
  with memory-mapped files instead of explicit I/O.

The thread connecting all of them: when data doesn't change, you can share it safely
between readers and writers. You don't need locks for reading. You don't need to
worry about readers seeing half-written state. The complexity budget spent
on mutability is redirected to other things.

---

## What's Next

The tree can store and load nodes. But there's no `get` or `set` operation yet —
no way to search for a key, no way to insert or delete.

The next layer — `BinaryTree` and `LogicalBase` — implements the BST algorithm:
navigating the tree to find a key, creating new nodes along the path for an insert,
finding the in-order predecessor for a delete. And then wrapping it all in
a `commit()` that ties together everything we've built: serialize the new tree,
then flip the root pointer.

That's when the whole thing starts to feel like a real database.
