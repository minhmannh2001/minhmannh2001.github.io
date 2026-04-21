---
layout: post
title: "Build DBDB from scratch — Interlude: One key's journey through all four layers"
date: '2026-04-26 12:00'
excerpt: >-
  A full write-then-read trace for `apple -> red` across Storage, ValueRef, BinaryNode, and LogicalBase. See exactly when bytes hit disk, when refs stay lazy, and why the root-pointer flip is the atomic hinge between old and new database states.
comments: false
---

*Building DBDB from Scratch — Interlude*

---

You've read about the four pieces. You understand each one in isolation.
But when you try to hold them all in your head at once — Storage, ValueRef,
BinaryNode, LogicalBase — they turn into a blur.

That's normal. Pieces are always easier to understand than how they connect.

This post traces a single key-value pair — `"apple" → "red"` — from the
moment it's written to the moment it's read back. Every layer will appear.
Every design choice will have a job to do. By the end, the blur should have
edges.

---

## About this series

**Build DBDB from scratch** is a walkthrough of rebuilding **DBDB, the Dog Bed Database** from [*500 Lines or Less*](https://github.com/aosabook/500lines). This interlude connects the previous layers into one execution trace.

| Part | Core idea |
|------|------------|
| **0** | [Project setup](https://minhmannh2001.github.io/2026/04/21/build-dbdb-from-scratch-part-0-project-setup-en.html) |
| **1** | [Append-only storage](https://minhmannh2001.github.io/2026/04/22/build-dbdb-from-scratch-part-1-append-only-storage-en.html) |
| **2** | [`ValueRef` and lazy loading](https://minhmannh2001.github.io/2026/04/23/build-dbdb-from-scratch-part-2-valueref-en.html) |
| **3** | [Immutable tree and `BinaryNodeRef`](https://minhmannh2001.github.io/2026/04/24/build-dbdb-from-scratch-part-3-binarynode-en.html) |
| **4** | [Logical layer: `LogicalBase` + `BinaryTree`](https://minhmannh2001.github.io/2026/04/25/build-dbdb-from-scratch-part-4-logical-layer-en.html) |
| **Interlude** (this post) | End-to-end write/read trace for one key |

---

## The Cast: One Analogy to Rule Them All

Before the trace, here's one analogy that threads through all four layers.

Imagine a **library that never erases anything**. New books are only ever
added to the end of the shelves — nothing is moved, nothing is removed.
Every book has a permanent location: a shelf number.

The library has a bulletin board at the entrance with a single card:

> *"The current catalog starts at shelf 4107."*

This card is the one thing that ever gets overwritten. And it's small enough
that updating it is essentially instant — one atomic flip.

Inside the library:

- **A value blob** (like `"red"`) is just a book on a shelf.
  It has a shelf number. That's all.

- **An index card** (a `BinaryNode`) is a card that says:
  *"Keys smaller than 'apple': look at shelf 0. The value for 'apple': look at
  shelf 4096. Keys larger than 'apple': look at shelf 0. Total cards in this
  section: 1."*
  It's not a book. It's directions to books.

- **A claim ticket** (a `ValueRef` or `BinaryNodeRef`) is what you carry around
  in your hand. It's either:
  - The actual book, held in your hands right now (referent in RAM), or
  - A slip of paper with a shelf number on it (address on disk), waiting to be redeemed.

- **The librarian** (`LogicalBase`) knows one rule: *"Before looking anything up,
  read the bulletin board to find the current catalog."* And another: *"Don't
  update the bulletin board until every new book is already on its shelf."*

That's DBDB. Now let's watch it work.

---

## Act One: Writing `"apple" → "red"`

```python
# Somewhere in the future public API (not yet wired up):
db["apple"] = "red"
db.commit()
```

### The moment of `set`

`BinaryTree._insert` is called with `("apple", ValueRef("red"))`.

The tree is empty, so the insertion creates a new leaf node in RAM:

```
In RAM:

  value_ref = ValueRef(referent="red", address=0)
  ┌──────────────────────────────────────────────────────┐
  │ BinaryNode                                           │
  │   left_ref:  BinaryNodeRef(referent=None, address=0) │  ← empty left branch
  │   key:       "apple"                                 │
  │   value_ref: ValueRef(referent="red", address=0)    │  ← "red" is here, in RAM
  │   right_ref: BinaryNodeRef(referent=None, address=0) │  ← empty right branch
  │   length:    1                                       │
  └──────────────────────────────────────────────────────┘

  root_ref = BinaryNodeRef(referent=<the BinaryNode above>, address=0)
```

Notice: **address=0 everywhere**. Zero means "not yet written to disk."
The entire tree exists only in RAM. The file hasn't been touched.

### The moment of `commit`

`commit()` calls `root_ref.store(storage)`.

`BinaryNodeRef.store` can't serialize a node until it knows the addresses of
everything the node points to. So before pickling anything, it calls `store_refs` —
which flushes the children first.

**Step 1: write `"red"` to disk.**

`value_ref.store(storage)` encodes `"red"` as UTF-8 bytes and appends to the file:

```
Disk (before commit):
┌──────────────────────────────────────────────────────────────────────┐
│  SUPERBLOCK  (bytes 0–4095)                                          │
│  root_address = 0                (0 = no committed tree yet)        │
├──────────────────────────────────────────────────────────────────────┤
│  (nothing else yet)                                                  │
└──────────────────────────────────────────────────────────────────────┘

After step 1:
┌──────────────────────────────────────────────────────────────────────┐
│  SUPERBLOCK  (bytes 0–4095)                                          │
│  root_address = 0                (still not committed)              │
├──────────────────────────────────────────────────────────────────────┤
│  offset 4096: [length=3][b"red"]                                    │
│               └─ 8 bytes ─┘└─ 3 bytes ─┘ = 11 bytes total          │
└──────────────────────────────────────────────────────────────────────┘
```

`value_ref._address` is now 4096. The claim ticket has been stamped.

**Step 2: write the node to disk.**

Now that `value_ref` has an address, the `BinaryNode` can be serialized. `BinaryNodeRef.referent_to_bytes` pickles a small dictionary — just integers and the key string, no nested objects:

```python
{
    "left":   0,        # left branch: empty (address 0)
    "key":    "apple",
    "value":  4096,     # the shelf where "red" lives
    "right":  0,        # right branch: empty
    "length": 1,
}
```

This pickle blob is appended to the file:

```
┌──────────────────────────────────────────────────────────────────────┐
│  SUPERBLOCK  (bytes 0–4095)                                          │
│  root_address = 0                (still not committed)              │
├──────────────────────────────────────────────────────────────────────┤
│  offset 4096: [length=3][b"red"]                                    │
├──────────────────────────────────────────────────────────────────────┤
│  offset 4107: [length=N][pickle({"left":0,"key":"apple",            │
│                                  "value":4096,"right":0,"length":1})]│
└──────────────────────────────────────────────────────────────────────┘
```

`root_ref._address` is now 4107.

**Step 3: flip the bulletin board.**

`storage.commit_root_address(4107)` does one thing: overwrites bytes 0–7 of the file with the integer 4107.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SUPERBLOCK  (bytes 0–4095)                                          │
│  root_address = 4107             ← THE ATOMIC FLIP                  │
├──────────────────────────────────────────────────────────────────────┤
│  offset 4096: [length=3][b"red"]                                    │
├──────────────────────────────────────────────────────────────────────┤
│  offset 4107: [length=N][pickle of the root node]                   │
└──────────────────────────────────────────────────────────────────────┘
```

Before this flip, any reader opening the file saw `root_address=0` — an empty
database. After this flip, any reader sees `root_address=4107` — a tree with
one key. There is no intermediate state. The data was already on disk before
the flip; the flip just made it reachable.

---

## Act Two: Reading `"apple"`

Now close the database and reopen it. The file is the same. RAM is empty.

```python
db.get("apple")  # What happens?
```

### The librarian checks the bulletin board

`_refresh_tree_ref()` reads the first 8 bytes of the file. It gets 4107.
It creates:

```
root_ref = BinaryNodeRef(referent=None, address=4107)
```

No data loaded yet. Just a claim ticket with a shelf number.

### The first disk read: loading the root node

`tree._get(root, "apple")` calls `_follow(tree_ref)`, which calls `tree_ref.get(storage)`.

Since `referent is None` and `address=4107`, it reads the file at offset 4107,
unpickles the dict, and reconstructs a `BinaryNode`:

```
Loaded into RAM:

  BinaryNode:
    left_ref:  BinaryNodeRef(referent=None, address=0)   ← not loaded, address=0 means empty
    key:       "apple"
    value_ref: ValueRef(referent=None, address=4096)      ← not loaded yet
    right_ref: BinaryNodeRef(referent=None, address=0)    ← empty
    length:    1
```

Notice: the value is **not here**. We loaded the index card, not the book.
The index card tells us: the value for "apple" is at shelf 4096.

### The second disk read: loading the value

`"apple" == "apple"` — we found the key. Now `_follow(node.value_ref)` reads
the file at offset 4096, decodes UTF-8, and returns the string `"red"`.

That's the answer.

### Counting the disk reads

Start to finish, a single `get` on a one-key database read:
1. Bytes 0–7: the root address (8 bytes)
2. The pickle blob at offset 4107: the root node
3. The UTF-8 blob at offset 4096: the value

Three reads. In a tree with 10,000 keys, the root node and value are still two
reads. Only the number of *index card* reads changes — one per level of the tree,
about 14 for a balanced tree with 10,000 nodes. The value itself is always one
read. This is what "lazy loading" buys you.

---

## The State Diagram: Memory vs. Disk

Here's the full picture after the commit, and what "loading" means at each step:

```
                    DISK                                RAM (after fresh open)
┌────────────────────────────────────┐   ┌──────────────────────────────────────┐
│ offset 0:                          │   │                                      │
│   root_address = 4107  ────────────┼──►│ root_ref = BinaryNodeRef(addr=4107)  │
│                                    │   │   [referent = None]    ← not loaded  │
│ offset 4096:                       │   │                                      │
│   b"red"   ◄───────────────────────┼───┤ (will be loaded when we follow       │
│                                    │   │  root_ref → then follow value_ref)   │
│ offset 4107:                       │   │                                      │
│   pickle{                          │   │                                      │
│     left:   0,    ─────────────────┼──►│ BinaryNodeRef(addr=0) ← empty        │
│     key:    "apple",               │   │ loaded into BinaryNode.key           │
│     value:  4096, ─────────────────┼──►│ ValueRef(addr=4096)   ← not loaded  │
│     right:  0,    ─────────────────┼──►│ BinaryNodeRef(addr=0) ← empty        │
│     length: 1,                     │   │                                      │
│   }                                │   │                                      │
└────────────────────────────────────┘   └──────────────────────────────────────┘
                                                          │
                                              after get("apple"):
                                                          ▼
                                         ValueRef(addr=4096, referent="red")
                                              [now cached in RAM]
```

The crucial insight: **a freshly loaded tree is mostly claim tickets**.
The nodes you haven't traversed yet are just integers in RAM — addresses that
haven't been redeemed. They look like "real" tree nodes, but they're empty husks
waiting to be filled. Only the path you actually walk becomes real Python objects.

---

## Why Four Layers?

Looking at the whole flow, each layer has a single, non-negotiable job:

| Layer | Its one job | What it doesn't know |
|-------|-------------|----------------------|
| `Storage` | Append blobs; read blobs by address; atomically flip root | What's in the blobs |
| `ValueRef` | Hold either a Python value or a disk address, never both empty | What kind of tree uses it |
| `BinaryNode` | Store 5 fields; recompute length incrementally; serialize addresses not objects | How files work |
| `LogicalBase` | Refresh root when safe; pass storage everywhere; enforce the _follow bottleneck | What BST algorithm is used |

Each layer knows exactly one level of the stack. `Storage` doesn't know about
trees. `BinaryNode` doesn't know about files. `ValueRef` doesn't know what
structure contains it. When one thing breaks, you know exactly which layer to look at.

This is why, when I was debugging a test failure in the length tracking, I didn't
have to think about file I/O at all. When I was getting the `fsync` order wrong
in `commit_root_address`, I didn't have to think about tree algorithms. The layers
*insulate* each other from complexity.

---

## The One Sequence That Makes Everything Click

If you want one diagram to commit to memory, make it this:

```
  commit("apple" → "red")                  read("apple")
  ─────────────────────────                ─────────────────────
  1. Write "red" blob       → disk         1. Read root address  ← disk
  2. Write node pickle      → disk         2. Read node pickle   ← disk
  3. Flip root address      → disk         3. Read "red" blob    ← disk
     (overwrite 8 bytes)
```

Left column: bottom-up (value before node, node before root).
Right column: top-down (root first, then navigate, then value).

Write pushes leaves to disk before the root. Read pulls the root first, then follows
down to the leaf. They're mirror images of each other. And the root flip is the
hinge — the one moment that separates "uncommitted state" from "committed state."

Everything else in DBDB is in service of making that hinge safe.

---

## What Comes Next

The pieces fit. The flow is clear. But we still can't use this as a real database.

There's no `db["apple"] = "red"`. No `db.commit()`. No `with connect("mydb.db") as db:`.

The next post wires all of this behind a clean Python interface — the part you'd
actually use — and traces what happens when you close the database and reopen it
from scratch to prove that the data survived.
