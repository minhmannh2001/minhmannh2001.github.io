---
layout: post
title: "Build DBDB from scratch — Part 7: Two lines that hold everything"
date: '2026-04-28 12:00'
excerpt: >-
  `commit()` is two lines — a bottom-up cascade that writes every dirty node, then an 8-byte root pointer flip. This post wires `get`, `set`, `pop`, and `commit` into `LogicalBase`, closes the locking story from Part 6, and runs four tests that make the durability guarantee precise and verifiable.
comments: false
---

*Building DBDB from Scratch — Part 7*

---

I kept looking for where the magic happens.

Every post so far described a piece: append-only storage, lazy references,
immutable nodes, the template that coordinates them. Each piece had a clear job.
But the job they were all *building toward* — the actual act of committing
a change to the database — was never spelled out in full.

Four methods land in `LogicalBase` to complete it. Three are short bridges
to the algorithm hooks we already built. The fourth is the one I kept looking for.

```python
def commit(self):
    self._tree_ref.store(self._storage)
    self._storage.commit_root_address(self._tree_ref.address)
```

Two lines. That's the commit.

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
| **7** (this post) | `commit`, `get`, `set`, `pop`: the write session completed |
| **8** | [The thinnest layer: the `DBDB` facade](https://minhmannh2001.github.io/2026/04/29/build-dbdb-from-scratch-part-8-interface-en.html) |
| **9** | [The last translation: the CLI tool](https://minhmannh2001.github.io/2026/04/30/build-dbdb-from-scratch-part-9-cli-en.html) |
| **10** | [What immutability costs: compaction](https://minhmannh2001.github.io/2026/05/01/build-dbdb-from-scratch-part-10-compaction-en.html) |
| **Retrospective** | [What a database actually is](https://minhmannh2001.github.io/2026/05/02/build-dbdb-from-scratch-part-11-retrospective-en.html) |

---

## What Those Two Lines Actually Do

Line 1 looks like it stores a single reference. It doesn't. It fires a cascade.

`self._tree_ref` is a `BinaryNodeRef` wrapping the new root node. Calling
`.store(storage)` on it triggers `BinaryNodeRef.store`, which calls
`prepare_to_store`, which calls `node.store_refs`, which calls `.store()` on
each child ref — and each of *those* is also a `BinaryNodeRef`, which does
the same thing for its children, all the way down to the leaves.

The cascade is bottom-up. A leaf's value gets written first. Then the leaf node.
Then its parent. Then the grandparent. All the way up to the root. By the time
line 1 returns, every dirty node has a disk address.

Line 2 writes that root address — 8 bytes — to the very beginning of the file.

```
Line 1 (cascade):                         Line 2 (flip):
  write "red" → address 4096               write 4107 to bytes 0–7
  write leaf node → address 4107     ───►  root is now 4107
  write parent → address 4220              done.
  write root → address 4350
  ...
  (all bottom-up, post-order)
```

Between line 1 and line 2: the data is on disk, but unreachable. The root
pointer still points to the old tree. Any reader who opens the file right now
sees the old database, intact.

After line 2: the root pointer moves. The new tree becomes the database.
The old tree's nodes remain on disk as unreachable blobs.

There's no state in between. That's the whole game.

---

## `get`: Reading Without a Lock

```python
def get(self, key):
    if not self._storage.locked:
        self._refresh_tree_ref()
    return self._get(self._follow(self._tree_ref), key)
```

Readers don't call `lock()`. They refresh the root if they're not mid-write,
then delegate straight to `BinaryTree._get`. That's it.

The absence of locking here is deliberate. In DBDB's model, reading from a
snapshot is always safe — the snapshot is immutable by construction. Old nodes
on disk are never overwritten. A reader following the old root will always
find a complete, consistent tree, even while a writer is appending new nodes
to the end of the file.

What `get` does instead of locking is refresh: read the latest root address
from the superblock before each read call (when not locked). If a writer
committed between two reads, the second read will see the new tree. If a writer
is mid-commit right now, the reader sees the old tree — also fine, because the
old tree is still valid.

---

## `set` and `pop`: Where the Locking Story Closes

Post 6 described a problem and left it open. Here's the code that closes it.

```python
def set(self, key, value):
    if self._storage.lock():
        self._refresh_tree_ref()
    self._tree_ref = self._insert(
        self._follow(self._tree_ref), key, self.value_ref_class(value)
    )

def pop(self, key):
    if self._storage.lock():
        self._refresh_tree_ref()
    self._tree_ref = self._delete(self._follow(self._tree_ref), key)
```

`self._storage.lock()` returns `True` exactly once per write session — the
first call, when the OS lock is actually acquired. Every subsequent call
(from `_write_integer`, from a second `set` before `commit`) returns `False`
because the flag is already set.

That `True`/`False` is load-bearing. `True` means: "I just waited for this lock,
and while I was waiting, another process may have committed." Refresh.
`False` means: "I already own this lock, I'm mid-session, my in-RAM tree is
the authoritative snapshot." Don't refresh — that would discard uncommitted work.

The scenario from post 6, now resolved:

```
Process A commits "apple" → root moves from 4107 to 5200

Process B was waiting for the lock.
B acquires it. lock() returns True.
B refreshes → sees root = 5200.
B inserts "banana" into the tree rooted at 5200.
B commits → root = 5350, containing both "apple" and "banana".
```

Without the refresh, B would have inserted "banana" into the tree rooted at 4107
and committed a root that doesn't include A's "apple". The `True` return value
is the only mechanism preventing that. A boolean, doing the work of a version
conflict detector.

One more thing: `set` and `pop` update `self._tree_ref` but do *not* commit.
The caller decides when to call `commit()`. This separation is intentional —
it means you can call `set` ten times and then `commit` once, writing a single
atomic batch. The lock is held across all ten sets and released only by `commit`.

---

## The Full Write Session, Finally Complete

```python
tree = BinaryTree(storage)

tree.set("apple", "red")    # lock acquired (True), refresh, insert, tree_ref updated
tree.set("cherry", "dark")  # lock() → False (already held), insert again
tree.set("lemon", "yellow") # same

tree.commit()
# cascade: stores all three values, all three nodes, root
# then commits root address
# then releases lock
```

During those three `set` calls, the lock is held. The in-RAM tree grows with each
insert. No bytes hit disk until `commit()` fires.

After `commit()`, the lock is released. Another process can acquire it, refresh,
and see all three keys in the tree.

---

## What We Have Now

With `get/set/pop/commit` in place, `LogicalBase` + `BinaryTree` is a working
key-value store — as long as you're willing to build `Storage` and wire it
together yourself:

```python
import io
from dbdb.physical import Storage
from dbdb.binary_tree import BinaryTree

f = io.BytesIO()
storage = Storage(f)
tree = BinaryTree(storage)

tree.set("apple", "red")
tree.commit()

tree.get("apple")   # → "red"
len(tree)           # → 1
```

It works. It's just not convenient. You have to construct `Storage`, pass it to
`BinaryTree`, remember to call `commit()`, and manage the file yourself.

What's still missing is the wrapper that makes this feel like a dictionary —
`db["apple"] = "red"`, `db.commit()`, `with connect("mydb.db") as db:`.
That's the public `DBDB` class and the `connect()` function.

---

## Proving the Guarantee

Before building the facade, I wanted to verify that `commit()` actually means
what I claimed. So I wrote four tests — not to explore behavior, but to document
a contract.

```python
def test_set_commit_get_reopen(self, db_file):
    with open(db_file, "r+b") as f:
        tree = BinaryTree(Storage(f))
        tree.set("my_key", "my_value")
        tree.commit()

    with open(db_file, "r+b") as f:
        tree = BinaryTree(Storage(f))
        assert tree.get("my_key") == "my_value"
```

That's the happy path: set, commit, close, reopen, get. It passes. Good, but not
interesting.

The test I kept thinking about was this one:

```python
def test_uncommitted_changes_are_lost(self, db_file):
    with open(db_file, "r+b") as f:
        tree = BinaryTree(Storage(f))
        tree.set("lost_key", "lost_value")
        # no commit

    with open(db_file, "r+b") as f:
        tree = BinaryTree(Storage(f))
        with pytest.raises(KeyError):
            tree.get("lost_key")
```

The name says it directly: *uncommitted changes are lost*. Not "may be lost."
Not "might be lost under certain conditions." Lost. Guaranteed.

This is exactly what the two-line commit was designed to enforce. `set` writes
nothing to disk — it only updates the in-RAM tree. `commit` fires the cascade
and then moves the root pointer. If the process exits between those two events,
the root pointer never moves. The next reader opens the file and follows the
old root, which points to a complete and consistent tree that predates the `set`.
The new data exists on disk as unreachable bytes, orphaned without a pointer
to them.

The last test makes the guarantee precise:

```python
def test_only_committed_keys_are_persisted(self, db_file):
    with open(db_file, "r+b") as f:
        tree = BinaryTree(Storage(f))
        tree.set("a", "1")
        tree.set("b", "2")
        tree.commit()       # a and b are committed
        tree.set("c", "3")  # c is not

    with open(db_file, "r+b") as f:
        tree = BinaryTree(Storage(f))
        assert tree.get("a") == "1"
        assert tree.get("b") == "2"
        with pytest.raises(KeyError):
            tree.get("c")   # lost, as expected
```

`a` and `b` survive. `c` doesn't. Not because of anything special about `c` —
because `commit()` was not called after setting it. The boundary is that sharp.

In database terms, this is durability: committed data survives failure.
In implementation terms, it reduces to a single write — the 8-byte root address
update at the end of `commit()`. Everything before that write is provisional.
Everything after is permanent.

---

## What's Next

The next post builds the facade: `interface.py`, `__init__.py`, and a `connect()`
function that opens a real file on disk, wires up `Storage` and `BinaryTree`,
and hands you back something that behaves like a persistent dict.

The database is already correct. What's left is making it convenient.
