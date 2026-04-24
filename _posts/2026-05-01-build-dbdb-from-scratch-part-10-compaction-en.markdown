---
layout: post
title: "Build DBDB from scratch — Part 10: What immutability costs"
date: '2026-05-01 12:00'
excerpt: >-
  Append-only storage never reclaims space — every overwrite leaves orphaned bytes. Compaction fixes this by copying the live dataset to a fresh file and atomically swapping it in. The hard part is the TOCTOU race: a writer that checks for file replacement before acquiring the lock, but not after, can silently write to the orphaned inode. `_prepare_write()` closes that window with a second check post-lock.
comments: false
---

*Building DBDB from Scratch — Part 10*

---

Immutability was the design that made everything else possible.

Old nodes are never modified. Every write creates new nodes and leaves the old
ones in place. The commit is a single pointer move. Readers following the old
pointer always find a complete, consistent tree — even while a writer is
appending to the end of the file. No corruption. No partial reads.

But there's a cost that's been accumulating since post 2, and this is the post
where we pay it.

Every `set` call that overwrites an existing key leaves the old value on disk.
Every `delete` leaves the old node. Every commit adds a new root. None of those
bytes are ever reclaimed. The file only grows. After enough writes, most of what's
in the file is unreachable garbage — bytes that no pointer leads to, data that
no reader will ever see again.

```python
db["a"] = "1" * 1000
db.commit()
db["a"] = "2" * 1000   # old value is now garbage
db.commit()
```

After those four lines, the file contains roughly 2000 bytes of value data. Only
1000 of them are reachable. The other 1000 — the first version of `"a"` — are
still sitting on disk, unreferenced, behind a root pointer that no longer includes
them.

There's no mechanism to remove them. That's what compaction is for.

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
| **10** (this post) | Compaction: atomic swap, TOCTOU race, `is_file_replaced()`, `_prepare_write()` |
| **Retrospective** | [What a database actually is](https://minhmannh2001.github.io/2026/05/02/build-dbdb-from-scratch-part-11-retrospective-en.html) |

---

## What Compaction Does

The idea is simple: read the current live data, write it to a fresh file, replace
the old file with the new one.

No old nodes. No superseded values. No unreachable roots. Just the state the
database is in right now, packed as tightly as the format allows.

Before `compact()` can do that, though, it needs a way to walk the entire current
tree and read every live key-value pair. That's what `__iter__` and `items()` are
for.

```python
def _iter_nodes(self, node):
    if node:
        yield from self._iter_nodes(self._follow(node.left_ref))
        yield node
        yield from self._iter_nodes(self._follow(node.right_ref))

def __iter__(self):
    root = self._follow(self._tree_ref)
    for node in self._iter_nodes(root):
        yield node.key
```

`_iter_nodes` is an in-order traversal of the binary search tree: visit the left
subtree, yield the current node, visit the right subtree. Because the BST
invariant keeps smaller keys to the left and larger to the right, in-order
traversal yields keys in ascending sorted order. It reads every node that's
reachable from the current root — exactly the live set.

`items()` builds on top of `__iter__`:

```python
def items(self):
    self._assert_not_closed()
    for key in self:
        yield (key, self[key])
```

For each key in the traversal, it does a `get` to retrieve the value. Each `get`
follows the `value_ref` address from the node and reads the raw bytes from disk.
This is the read side of lazy references: the value has been on disk since the
original `set`, and we're reading it now for the first time in compaction.

---

## The Algorithm

With `items()` in place, `compact()` has everything it needs.

```python
def compact(self) -> None:
    self._assert_not_closed()
    self._storage.lock()
    try:
        db_dir = os.path.dirname(self._storage._f.name)
        with tempfile.NamedTemporaryFile(dir=db_dir, delete=False) as f:
            temp_path = f.name

        new_db = dbdb.connect(temp_path)
        try:
            for key, value in self.items():
                new_db[key] = value
            new_db.commit()
        finally:
            new_db.close()

        original_path = self._storage._f.name

        os.rename(temp_path, original_path)  # rename while lock is still held
        self._storage.close()               # close (and unlock) after rename

        new_f = open(original_path, "r+b")
        self._storage = Storage(new_f)
        self._tree = BinaryTree(self._storage)

    except Exception:
        if "temp_path" in locals() and os.path.exists(temp_path):
            os.remove(temp_path)
        raise
    finally:
        if self._storage.locked:
            self._storage.unlock()
```

There are five distinct steps. Each one solves a specific problem.

**Step 0: acquire the exclusive write lock.**

```python
self._storage.lock()
```

Compaction reads the entire live dataset, copies it to a new file, and replaces
the original. That sequence has to be consistent. Without the lock, another
process could acquire the write lock between two `items()` yields, commit a new
key, and finish — before compaction's rename runs. The new key would be on the
old file. After the rename, it's gone.

`self._storage.lock()` acquires the same OS-level exclusive lock that `set()` and
`pop()` acquire. Any process trying to write while compaction is running blocks
on `portalocker.lock()` and waits. Compaction reads a stable snapshot of the
database from start to finish.

The lock is released in the outer `finally`:

```python
finally:
    if self._storage.locked:
        self._storage.unlock()
```

Whatever happens — success, failure, exception mid-copy — the lock is released.
The check exists because `self._storage.close()` (step 4) already calls
`unlock()` internally; without it, the `finally` would try to unlock an already-
unlocked storage and double-release.

**Step 1: create the temp file in the same directory.**

```python
db_dir = os.path.dirname(self._storage._f.name)
with tempfile.NamedTemporaryFile(dir=db_dir, delete=False) as f:
    temp_path = f.name
```

The temp file has to be in the same directory as the database. Not `/tmp`. Not
some arbitrary location. The same directory, which means the same filesystem.

The reason is `os.rename`. On POSIX systems, `os.rename` is atomic — but only
when the source and destination are on the same filesystem. If they're on
different filesystems, the OS falls back to a copy-and-delete sequence, which is
not atomic. Halfway through, neither the complete old file nor the complete new
file exists at the target path. A reader opening the database at that moment
would find garbage.

Putting the temp file in the same directory as the database guarantees they're
on the same filesystem, which guarantees `os.rename` is atomic.

**Step 2: copy the live data.**

```python
new_db = dbdb.connect(temp_path)
try:
    for key, value in self.items():
        new_db[key] = value
    new_db.commit()
finally:
    new_db.close()
```

Open a fresh DBDB on the temp file, write every key-value pair from the current
database into it, commit, close. The new file now contains exactly the live state
— no garbage, no old versions, no superseded roots.

`new_db.close()` lives in `finally`, not after `commit()`. If copying fails
halfway — a disk error, a corrupted value — the temp database is still closed
cleanly. The outer exception handler then removes the temp file. The original
database is untouched.

**Step 3: the atomic swap — while the lock is still held.**

```python
original_path = self._storage._f.name
os.rename(temp_path, original_path)  # rename while lock is still held
self._storage.close()               # close (and unlock) after rename
```

The order here is deliberate. An earlier version of this code called `close()`
first, then `rename()`. That created a window: between releasing the lock and
completing the rename, another writer could acquire the lock, write, and commit
— and then the rename would overwrite the file with the compacted version that
doesn't include the new write. Silent data loss.

The fix is to rename first, then close. On POSIX, you can rename an open file.
The lock is held through the rename. Any writer blocked on `portalocker.lock()`
stays blocked until `close()` releases it — at which point the writer opens
`original_path` and gets the already-compacted file.

`original_path` must be captured before `close()`. After the file handle is
closed, `self._storage._f.name` technically still holds the string, but it's
relying on a CPython implementation detail about closed file objects. Saving the
path first is the safe choice.

**What happens to processes already connected to the old file?**

This is the harder question. While compaction runs, another process might have
already opened the database and be mid-read — or worse, mid-write. When
`os.rename` fires, that process still holds a file handle to the old inode.

On POSIX, `os.rename` updates only the directory entry. The old inode is not
touched. Any process with an open handle to the old inode continues reading from
it as before. The OS uses reference counting: the old inode stays alive until
every handle pointing to it is closed.

```
Before rename:                    After rename:
  original_path → inode_A           original_path → inode_B (compacted)

Process B has fd → inode_A         Process B still reads inode_A — no crash
Compactor has fd → inode_A         Compactor closes → inode_A ref drops
                                    inode_A freed when Process B also closes
```

A mid-read does not break. But there is a deeper problem: after `os.rename`,
Process B is reading stale data. If Process B calls `set()` and commits, it
commits to inode_A — the orphaned file that `mydb.db` no longer points to. That
write is permanently lost.

The fix is for Process B to detect that the file was replaced and reopen. The
mechanism: compare the inode number of the open file handle against the inode of
the file currently at the path. If they differ, the file was replaced.

```python
def is_file_replaced(self) -> bool:
    try:
        return os.fstat(self._f.fileno()).st_ino != os.stat(self._f.name).st_ino
    except (OSError, io.UnsupportedOperation):
        return False
```

`os.fstat` reads the inode of the already-open file descriptor. `os.stat` reads
the inode of whatever is currently at the path. If they differ, the path now
points to a different file.

`DBDB` checks this before every read operation and reopens transparently if needed:

```python
def _reopen_if_replaced(self) -> None:
    if self._storage.is_file_replaced():
        path = self._storage._f.name
        self._storage.close()
        self._storage = Storage(open(path, "r+b"))
        self._tree = BinaryTree(self._storage)

def __getitem__(self, key: str) -> str:
    self._assert_not_closed()
    self._reopen_if_replaced()
    return self._tree.get(key)
```

For read-only operations this is sufficient: a read that sees the old file returns
stale-but-consistent data; the next read detects the swap and picks up the new
file. Stale reads are acceptable under snapshot isolation.

Write operations have a harder problem. `__setitem__` used to look like this:

```python
def __setitem__(self, key, value):
    self._reopen_if_replaced()   # 1. check — file not replaced yet
    #
    # [compact runs here: lock → copy → rename → unlock]
    #
    self._tree.set(key, value)   # 2. lock acquired, but on orphaned inode
                                 #    _refresh_tree_ref reads from orphaned file
                                 #    write goes to orphaned inode → lost
```

This is a TOCTOU race (Time-of-Check to Time-of-Use). The check at step 1 passes,
but by step 2 the file has been replaced. The write goes to the orphaned inode —
the file that `mydb.db` no longer points to. The data is permanently lost.

The fix is a second check *after* acquiring the lock. Once the lock is held, no
compact can run (compact also requires the exclusive lock). A `True` result from
`is_file_replaced()` at that point is conclusive.

```python
def _prepare_write(self) -> None:
    self._reopen_if_replaced()        # pre-lock check (narrows the window)
    if self._storage.lock():          # acquire exclusive lock
        if self._storage.is_file_replaced():
            # Compact ran between the pre-lock check and lock acquisition.
            # Reopen: self._tree.set/pop will lock + refresh on the new storage.
            path = self._storage._f.name
            self._storage.close()
            self._storage = Storage(open(path, "r+b"))
            self._tree = BinaryTree(self._storage)
        else:
            # First lock, no replacement. Refresh now; set/pop will skip it
            # (lock() returns False when already held).
            self._tree._refresh_tree_ref()

def __setitem__(self, key, value):
    self._assert_not_closed()
    self._prepare_write()
    return self._tree.set(key, value)
```

After `_prepare_write()` returns, one of two states holds:

- **No replacement**: lock is held, tree ref is current. `self._tree.set()` sees
  `locked=True`, skips its own lock and refresh, does the insert.
- **Replacement detected post-lock**: old storage closed and unlocked, new
  storage and tree created. `self._tree.set()` acquires the lock on the new
  storage (first lock, returns `True`), refreshes from the new file, inserts.

For mid-session writes (second `set()` before `commit()`), `self._storage.lock()`
returns `False` (already held) and `_prepare_write()` does nothing — no reopen,
no refresh. The in-memory tree built up during the session is preserved.

For read-only processes, the next operation after compaction transparently picks
up the new file. There is no API change. The caller never knows a swap happened.

**Step 4: reconnect.**

```python
new_f = open(original_path, "r+b")
self._storage = Storage(new_f)
self._tree = BinaryTree(self._storage)
```

The compaction instance itself was one of those readers holding a handle to the
old inode. After `close()`, that handle is released. We open `original_path`
fresh — now pointing to the compacted file — and rebuild `Storage` and
`BinaryTree` around it. The caller sees nothing change.

If anything in steps 1–4 fails, the `except` block removes the temp file, and the
outer `finally` releases the lock if it's still held.

---

## A Tradeoff the Algorithm Doesn't Mention

`__iter__` yields keys in sorted order. That means `compact()` inserts them into
the new database in sorted order: `"a"`, `"b"`, `"c"`, `"d"`, ...

Inserting keys in ascending order into an unbalanced BST is the worst case. Each
key is larger than all previous keys, so each insertion goes to the rightmost
position. After inserting `n` keys in order, the tree is a straight line leaning
right. Every lookup has to traverse all `n` nodes — O(n) instead of O(log n).

The compaction makes the file smaller. It may also make lookups slower, depending
on what the original insertion order was. If the database was built with random
keys, the original tree was reasonably balanced. After compaction, it's skewed.

Real databases solve this with self-balancing tree structures — B-trees and their
variants ensure that inserts at any order produce a tree with bounded height.
DBDB's binary search tree doesn't rebalance. This is a known limitation, and it's
the kind of thing you'd fix before production use.

---

## How Real Databases Handle This

DBDB's compaction is a manual, blocking operation. You call `db.compact()`, it
rewrites the file, you continue. The database is effectively locked for the
duration.

Real systems do this differently.

SQLite has `VACUUM`, which does exactly what DBDB's `compact()` does: creates a
new database file with only live data, then renames it over the old one. It's
also a manual operation, and it locks the database for the duration.

RocksDB and LevelDB use LSM trees, where compaction is a continuous background
process. Writes go into an in-memory buffer (memtable), which is flushed to disk
as immutable sorted files (SSTables). Background threads merge and compact those
files over time, discarding deleted and overwritten keys. The database never
stops serving reads or writes while compaction runs — it runs in parallel.

PostgreSQL uses MVCC (multi-version concurrency control) and has a `VACUUM`
process that reclaims space from dead row versions. It can run in the background
without blocking. A more aggressive `VACUUM FULL` rewrites the entire table —
the blocking version, equivalent to what DBDB does.

The deeper pattern is always the same: append-only or multi-version storage
creates garbage over time. Something has to collect it. The tradeoffs are in when
that collection happens, who triggers it, and whether it blocks ongoing work.

---

## What Phase 9 Also Changed

Two other things landed in this phase.

**Type annotations.** Every function signature across every module now has type
hints. `def get(self, key: str) -> str`. `def commit(self) -> None`. Nothing
about the runtime behavior changed — types in Python are advisory, not enforced.
But they make the code readable in a different way: you can look at a function
signature and know what it expects and returns without reading the body.

**msgpack instead of pickle.** `BinaryNodeRef` serializes nodes to bytes when
storing them to disk. Originally that used `pickle`. Now it uses `msgpack`.

```python
# before
return pickle.dumps({...})

# after
return msgpack.packb({...})
```

The difference matters: pickle is Python-specific and can execute arbitrary code
when deserializing (a security hazard if you don't control the data). msgpack is
a compact binary format with no execution model — it's pure data. It's also
readable from any language that has a msgpack library.

The tradeoff is compatibility: existing databases serialized with pickle cannot
be read by the msgpack code. That's a breaking change. Any real deployment would
need a migration — read with the old code, write with the new. It's a small
example of a problem every production database eventually faces: format changes
and the data that predates them.

---

## What's Left

DBDB is complete in all the ways that matter. Storage, logical layer, binary
tree, public interface, CLI tool. Compaction. Type-safe, msgpack-serialized,
file-locked, append-only, commit-or-lose-it.

The tree doesn't rebalance. The compaction blocks. The serialization format has
no versioning. For a learning project, these are the right tradeoffs — they keep
the code small enough to hold in your head.

For production, they're the starting list.
