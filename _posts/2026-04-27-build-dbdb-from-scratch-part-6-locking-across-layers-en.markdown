---
layout: post
title: "Build DBDB from scratch — Part 6: The race between two writers"
date: '2026-04-27 12:00'
excerpt: >-
  The OS lock queues writers correctly but doesn't tell them what they missed. Trace the two-writer race that silently drops commits, then see how `lock()` returning `True` vs `False` carries the semantic signal that triggers a root refresh — and how `storage.locked` bridges Storage and LogicalBase without coupling them.
comments: false
---

*Building DBDB from Scratch — Part 6*

---

Post 1 told you that `write()` acquires a lock and holds it until
`commit_root_address()` releases it. That one-lock-per-session design
keeps a writer's blobs exclusive until the root is flipped.

But I glossed over something. The lock keeps other writers *waiting*.
It doesn't tell them anything about what they missed while they waited.

Imagine Process B has been sitting at the door while Process A committed.
The door opens. B walks in and starts writing its new tree.
But B's mental model of the database is from *before* A's commit.
B thinks the root is at offset 4107. A moved it to 5200.

If B commits without checking, it overwrites A's work. Silently.
A's key-value pairs vanish.

This is the race that the lock alone doesn't solve. Let's trace it.

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
| **6** (this post) | Locking across layers: the two-writer race, `storage.locked`, and why `lock()` returns `True` once |
| **7** | [Two lines that hold everything: `commit`, `get`, `set`, `pop`](https://minhmannh2001.github.io/2026/04/28/build-dbdb-from-scratch-part-7-commit-en.html) |
| **8** | [The thinnest layer: the `DBDB` facade](https://minhmannh2001.github.io/2026/04/29/build-dbdb-from-scratch-part-8-interface-en.html) |
| **9** | [The last translation: the CLI tool](https://minhmannh2001.github.io/2026/04/30/build-dbdb-from-scratch-part-9-cli-en.html) |
| **10** | [What immutability costs: compaction](https://minhmannh2001.github.io/2026/05/01/build-dbdb-from-scratch-part-10-compaction-en.html) |
| **Retrospective** | [What a database actually is](https://minhmannh2001.github.io/2026/05/02/build-dbdb-from-scratch-part-11-retrospective-en.html) |

---

## Three Ways Processes Can Interact

### Readers and writers don't block each other

This one is by design. Readers never call `lock()`. They refresh the root
from the superblock, follow refs down the tree, and return values. The whole
time, a writer might be appending blobs to the end of the file — and that's fine,
because readers only follow the old root, which points to an old but complete tree.

```
Process A (reader)              Process B (writer)
──────────────────              ─────────────────────────────────────
open DB → root = 4107
get("apple")                    write(blob_value)  ─── lock acquired
  read node at 4107                                    (B holds lock)
  read value at 4096            write(blob_node)
  return "red"                  commit_root(5200)  ─── lock released,
                                                       root flipped to 5200
get("apple")  ← again
  unlocked → refresh
  root = 5200  ← sees B's commit
  read node at 5200
  ...
```

Between A's two reads, B committed a new tree. A's first read came from the
old snapshot — perfectly valid, because the old tree wasn't modified. A's
second read comes from the new snapshot. Both are consistent views.

This is intentional. DBDB trades strict read isolation for simplicity: a reader
might see data that's one commit behind if it doesn't refresh. The cost is
acceptable for a single-file educational database. PostgreSQL calls a stronger
version of this "repeatable read isolation"; DBDB offers something closer to
"read committed on refresh."

### Two writers: the dangerous case

```
Process A (writer)                  Process B (writer)
──────────────────────────          ─────────────────────────────────
open DB → root = 4107
_insert("apple", "red")             open DB → root = 4107
  → new tree built in RAM           _insert("banana", "yellow")
                                      → new tree built in RAM
write(blob_value)  ── lock acquired
write(blob_node)
                                    write(blob_value)  ── BLOCKS here
                                    (B is waiting for A's lock)

commit_root(5200)  ── lock released, root = 5200

                                    ← B acquires lock now
                                    ⚠ B still thinks root = 4107
                                    write(blob_node)
                                    commit_root(5350)
                                    → root = 5350, based on 4107
                                    → "apple" is gone
```

Process B's new tree was built on root 4107 — a snapshot that didn't include A's
"apple". B commits that tree and becomes the new root. A's entire commit is now
unreachable. Not corrupted — it's still on disk as orphaned blobs — but effectively
deleted from the database's perspective.

The lock queued the writers correctly. It failed to tell B what it missed.

### The fix: refresh when you first acquire the lock

When `lock()` returns `True`, it means "I just grabbed this for the first time"
(as opposed to returning `False`, which means "I already had it"). That `True`
is the signal: **someone else might have committed while I was waiting**.

```python
# set() — the next post will fill this in with real code:
def set(self, key, value):
    if self._storage.lock():       # True = just acquired, not "already had it"
        self._refresh_tree_ref()   # read the current root — A may have committed
    # Now build the new tree on top of the latest committed state
    new_value_ref = self.value_ref_class(referent=value)
    self._tree_ref = self._insert(
        self._follow(self._tree_ref), key, new_value_ref
    )
```

After refresh, B reads root = 5200 (A's committed tree), inserts "banana" into
*that* tree, and commits a tree containing both "apple" and "banana".

The key insight: `lock()` returning `True` vs `False` isn't just a re-entrancy
guard (though that too — see the deadlock note below). It's a semantic signal
carrying the question "did you wait for this, or did you already own it?" Only
in the former case do you need to refresh.

---

## The Flag That Connects Two Layers

`LogicalBase` doesn't import `Storage`. `Storage` doesn't know about trees.
Yet they need to coordinate on one question: *is there a write session in progress?*

The answer lives in `storage.locked` — a single boolean that `Storage` sets
and `LogicalBase` reads:

```
Storage                             LogicalBase
───────────────────────             ──────────────────────────────
self.locked = False  (init)
                                    if not self._storage.locked:     ← reads it here
lock() → self.locked = True             self._refresh_tree_ref()
write()  ← uses flag                    (safe to see latest root)
write()
commit_root()
unlock() → self.locked = False
                                    if self._storage.lock():         ← True = just acquired
                                        self._refresh_tree_ref()     ← refresh now
```

`Storage` owns the flag. `LogicalBase` observes it. Neither layer knows the
other's internals — `storage.locked` is the only shared signal between them.

This is why `__len__` checks `self._storage.locked` before refreshing:

```python
def __len__(self):
    if not self._storage.locked:
        self._refresh_tree_ref()
    # If we're locked, we're mid-write. Refreshing would discard
    # the in-RAM tree we've been building. Hold the snapshot.
    root = self._follow(self._tree_ref)
    return root.length if root else 0
```

"Am I in a write session right now?" — answered by one boolean, shared across layers.

---

## The Nested Lock Problem (and Why It's Already Solved)

One trap with advisory locks: if your own code calls `lock()` twice on the same
file descriptor, you can deadlock waiting for yourself.

DBDB avoids this by the design of `lock()` itself:

```python
def lock(self) -> bool:
    if not self.locked:
        portalocker.lock(self._f, portalocker.LOCK_EX)
        self.locked = True
        return True
    return False   # already locked — skip the OS call entirely
```

When `write()` calls `lock()`, it gets `True` and acquires the OS lock.
When `_write_integer()` (called inside `write()`) also calls `lock()`,
it gets `False` — the flag is already set, so `portalocker` is never called again.
No second lock, no deadlock.

```
write()          → lock() → portalocker.lock() → locked=True → returns True
  _write_integer() → lock() →                  → locked=True → returns False (no-op)
  _write_integer() → lock() →                  → locked=True → returns False
commit_root()    → lock() →                    → locked=True → returns False
  _write_integer() → lock() →                  → locked=True → returns False
  → portalocker.unlock() → locked=False
```

The flag does double duty: it prevents nested OS lock calls, and it signals
to `LogicalBase` whether a write session is in progress.

---

## Crash in the Middle: Why Append-Only Saves You

What happens if a process crashes between `write()` and `commit_root_address()`?

```
Process A crashes here:
  write(blob_value)   ← blob at offset 4096
  write(blob_node)    ← blob at offset 4107
  💥 crash — commit_root never called

File on disk afterward:
  superblock: root = 4107_OLD   ← was never overwritten
  offset 4096: orphaned blob
  offset 4107: orphaned blob
```

The root was never flipped. Any process that opens the file afterward reads
the old root — a complete, consistent tree from before the crash. The two orphaned
blobs are stranded on disk with no pointers to them. They waste space, but they
don't corrupt anything.

This is append-only paying its rent. In an in-place update database, a crash
mid-write can leave a data structure in an inconsistent state — half of a node
updated, the other half not. That's why those systems need write-ahead logs and
crash recovery procedures.

DBDB doesn't need any of that. The old tree is always intact. "Recovery" is just
"open the file and read the root" — which is what you do anyway.

The cost: the orphaned blobs are never reclaimed. Every crashed write leaks
a little space. Every successful write also leaves old blobs behind (the old version
of the tree). This is the space amplification tradeoff that real databases address
with compaction — DBDB doesn't implement it, but the shape of the problem is clear.

---

## What This Post Leaves Open

The two-writer scenario is described, but the fix — refreshing on lock acquisition —
lives in `set()` and `pop()`, which haven't been built yet. The current `LogicalBase`
has the mechanism (`storage.locked`, `_refresh_tree_ref`) but not the wiring.

The next post closes the loop: `get`, `set`, `pop`, and `commit` land in `LogicalBase`,
and the locking story told here finally has its last piece in place — a real
`set()` that acquires the lock, refreshes when needed, and defers commit to the caller.
