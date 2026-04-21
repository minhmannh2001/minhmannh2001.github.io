---
layout: post
title: 'Build DBDB from scratch — Part 1: What happens when the power goes out?'
date: '2026-04-22 12:00'
excerpt: >-
  Append-only records, a 4096-byte superblock, big-endian length prefixes, flush vs fsync ordering for durable commits, advisory file locks with portalocker, and why DBDB trades disk space for a simple atomic story.
comments: false
---

*Building DBDB from Scratch — Part 1*

Imagine you're halfway through writing a key-value pair to disk. You've written the key. You haven't written the value yet. The power goes out.

When the machine comes back up, what state is your database in?

This is not a hypothetical. Disks are not atomic. Writing 100 bytes to a file is not guaranteed to happen all-at-once. If your program crashes or loses power mid-write, you can end up with a file that's half-updated — and no clear way to know which half you can trust.

Most databases spend enormous effort solving this problem. DBDB solves it with a surprisingly simple idea.

---

## About this series

**Build DBDB from scratch** is a walkthrough of rebuilding **DBDB, the Dog Bed Database** from [*500 Lines or Less*](https://github.com/aosabook/500lines). Each post focuses on one layer of the implementation.

| Part | Core idea |
|------|------------|
| **0** | [Project setup]({% post_url build-dbdb-from-scratch-part-0-project-setup-en %}): `pyproject.toml`, smoke tests, pytest + BDD, Makefile |
| **1** (this post) | Superblock, append-only `write`/`read`, root commit, `flush`/`fsync`, file locking |
| **2** | [`ValueRef` and lazy loading]({% post_url build-dbdb-from-scratch-part-2-valueref-en %}): `get`/`store`, `BytesValueRef`, UTF-8 |
| **3** (next) | Immutable binary search tree; `BinaryNodeRef` |

---

## The Idea: Never Overwrite Anything

What if, instead of updating data in-place, you always *append* new data to the end of a file? And instead of tracking "where the latest version of each record is" through a complex index, you keep a single pointer — at the very start of the file — that says: *this is where the current version of your database begins*.

To commit a change:

1. Write all the new data at the end of the file
2. Update the pointer at the front

Step 2 is just writing 8 bytes to a fixed location. On modern hardware and filesystems, that's as close to atomic as you can get without a transaction log.

If the power goes out after step 1 but before step 2: the pointer still points to the old data. The new data is on disk but unreachable — effectively garbage. The database is in the exact same state it was before you started.

If the power goes out after step 2: the pointer points to complete, valid data. You're fine.

There's no state where the database is "half-updated." That's the magic of **append-only storage with an atomic root pointer**.

---

## What the File Actually Looks Like

Before writing a single line of code, I needed to understand the layout of the database file itself:

```
File: db.dbdb
┌─────────────────────────────────────────────────────────────┐
│  SUPERBLOCK  (exactly 4096 bytes)                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  root_address  (bytes 0–7, big-endian uint64)        │    │
│  │  → the offset in this file where the current         │    │
│  │    version of the database tree begins               │    │
│  │                                                       │    │
│  │  [bytes 8–4095: padding, all zeros]                  │    │
│  └─────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│  RECORD at offset 4096                                      │
│  ┌──────────────────┬──────────────────────────────────┐    │
│  │  length (8 bytes)│  payload (N bytes)               │    │
│  │  big-endian u64  │  whatever bytes you stored       │    │
│  └──────────────────┴──────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│  RECORD at offset 4096 + 8 + N                              │
│  ┌──────────────────┬──────────────────────────────────┐    │
│  │  length (8 bytes)│  payload                         │    │
│  └──────────────────┴──────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│  ...more records, growing toward the end of the file...     │
└─────────────────────────────────────────────────────────────┘
```

Two zones:

- **Superblock**: fixed-size, fixed-location metadata. Contains the root pointer.
- **Append zone**: all actual data, growing toward end-of-file.

Every record is self-describing: it starts with its own length. This means you can read any record from the file if you know its offset — just read 8 bytes (the length), then read that many bytes (the payload). No separate index, no record size table. Just `[length][data]` repeated.

---

## Three Constants That Define the Layout

```python
class Storage:
    SUPERBLOCK_SIZE = 4096
    # Why 4096? A traditional disk sector is 512 bytes; 4096 = 8 sectors.
    # Writing 8 bytes to a sector-aligned address is treated as nearly atomic
    # by many filesystems. More importantly: reserving a large fixed area
    # at the front leaves room to add more metadata later without breaking
    # existing database files.

    INTEGER_FORMAT = "!Q"
    # The struct module's format string for: big-endian ("!") unsigned 64-bit ("Q").
    # Big-endian means the most significant byte comes first — the same byte
    # order used by network protocols and most file formats.
    # This makes the database file portable across CPU architectures
    # (x86 is little-endian; a file written on x86 should be readable on ARM).

    INTEGER_LENGTH = 8
    # Always equals struct.calcsize("!Q").
    # Declared as a constant to avoid magic numbers scattered throughout read/write.
```

Let me make that concrete:

```python
import struct
struct.pack("!Q", 257)
# → b'\x00\x00\x00\x00\x00\x00\x01\x01'
#    ↑─────── 6 zero bytes ──────↑ 1 ↑ 1
# 257 = 256 + 1 = 0x0101 → byte 6 is 0x01, byte 7 is 0x01
# The most significant byte (0x00) comes first — big-endian.
```

---

## Building Storage, Step by Step

### Starting With Almost Nothing

The first test just checks that `Storage` wraps a file object without doing anything unexpected:

```python
def test_storage_keeps_file_object():
    f = io.BytesIO()
    s = Storage(f)
    assert s._f is f  # same object, not a copy
```

```python
def __init__(self, f):
    self._f = f
    # Why accept any file-like object?
    # Tests use BytesIO (in-memory, no disk). Production uses a real file.
    # As long as it supports read/write/seek/tell/flush, Storage doesn't care.
    self.locked = False
    self._ensure_superblock()
```

### Ensuring the Superblock Exists

When you open a new (empty) database file, there's no superblock yet. `_ensure_superblock` zero-fills the first 4096 bytes:

```python
def _ensure_superblock(self):
    self.lock()
    self._f.seek(0, os.SEEK_END)
    end_address = self._f.tell()
    if end_address < self.SUPERBLOCK_SIZE:
        self._f.write(b"\x00" * (self.SUPERBLOCK_SIZE - end_address))
    self.unlock()
    # Why zero-fill? Because root_address is at bytes 0–7.
    # Zero means "no root yet" — an empty database.
    # We need those bytes to exist and be readable before any other operation.
```

### Appending a Record

`write` is where the "append-only" principle lives:

```python
def write(self, data: bytes) -> int:
    self.lock()
    self._f.seek(0, os.SEEK_END)       # always go to the end
    object_address = self._f.tell()    # remember where we are
    self._write_integer(len(data))     # write 8-byte length prefix
    self._f.write(data)                # write payload
    return object_address
    # Why return the address of the length prefix, not the payload?
    # Because read() will seek to this address, read 8 bytes to get N,
    # then read N bytes for the payload. The address IS the length prefix.
```

`read` is the symmetric counterpart:

```python
def read(self, address: int) -> bytes:
    self._f.seek(address)
    length = self._read_integer()   # read 8 bytes → integer N
    return self._f.read(length)     # read N bytes → payload
    # The file cursor lands right after the length prefix, so
    # read(length) picks up the payload automatically.
```

The beauty of this: **you can read any record if you know its address**. No index. No bookkeeping. Just seek and read.

```python
def test_write_read_roundtrip():
    f = io.BytesIO()
    s = Storage(f)

    addr1 = s.write(b"hello")
    addr2 = s.write(b"world")

    assert s.read(addr1) == b"hello"
    assert s.read(addr2) == b"world"
    # Both records are still there — append-only never overwrites.
    # If you wrote "world" after "hello", "hello" doesn't disappear.
```

---

## The Root Pointer: Making Changes Visible

We can write records. But how do we say "this is the current version of the database"?

```python
def get_root_address(self) -> int:
    self._f.seek(0)
    return self._read_integer()
    # The first 8 bytes of the file are always the root address.
    # A new database returns 0 — meaning "no tree yet."

def commit_root_address(self, root_address: int) -> None:
    self.lock()
    self._f.flush()
    self._fsync_if_possible()   # push payload bytes to the device
    self._f.seek(0)
    self._write_integer(root_address)
    self._f.flush()
    self._fsync_if_possible()   # push the root pointer to the device
    self.unlock()
```

That comment about `fsync` deserves more attention.

---

## The Difference Between `flush` and `fsync`

This is one of those details that sounds boring until you lose data.

When you call `self._f.write(data)`, Python buffers those bytes in memory. `flush()` pushes them from Python's buffer to the operating system. But the OS also has its own buffer — the page cache. `fsync()` tells the OS: *please, I don't care if it's inconvenient, push those bytes all the way to the physical device*.

```
data lives here → is pushed by → to here
─────────────────────────────────────────────────────
Python buffer       flush()         OS page cache
OS page cache       fsync()         Physical disk
```

Why does this matter? Because `commit_root_address` needs to happen in a specific order:

1. All the new data records must reach the disk *before* we update the root pointer.
2. The new root pointer must reach the disk before we consider the commit done.

Without the first `fsync`, you could update the root pointer successfully, but the data it points to might still be in the OS buffer. If the machine crashes at that moment: the root points to data that doesn't exist on disk yet. Database corrupt.

The two-`fsync` pattern in `commit_root_address` is a deliberate tradeoff: it adds latency (fsync is slow) but gives you durability. Real databases make this tradeoff explicit — PostgreSQL, for example, has `fsync = on/off` as a configuration option, with explicit warnings about what happens when you turn it off.

---

## File Locking: Queuing Up Writers

What if two processes try to write to the same database file at the same time?

DBDB uses `portalocker` — a cross-platform Python library for advisory file locking:

```python
def lock(self) -> bool:
    if not self.locked:
        try:
            portalocker.lock(self._f, portalocker.LOCK_EX)
            # LOCK_EX = exclusive lock. Any other process that calls lock()
            # on the same file will block here until we unlock.
        except io.UnsupportedOperation:
            pass  # BytesIO has no file descriptor — skip the OS call,
                  # but maintain the self.locked semantics for in-process logic
        self.locked = True
        return True
    return False   # already locked — second call is a no-op
    # Why return False instead of raising? Because write() calls lock(),
    # and _write_integer() also calls lock(). Without this re-entrancy guard,
    # the second lock() call would deadlock waiting for itself.
```

"Advisory" is the key word here. The lock is a gentleman's agreement: it only protects against processes that *also* call `lock()` before writing. A process that ignores the locking protocol can still corrupt the file. DBDB assumes all writers go through `Storage` — that's the contract.

One more important design choice: `write()` acquires the lock but *doesn't release it*. The lock is held across multiple `write()` calls and only released by `commit_root_address()`. This means an entire "transaction" — all the new records plus the root update — happens under one exclusive lock.

---

## Putting It All Together

```python
# A complete write cycle:

with open("db.dbdb", "r+b") as f:
    s = Storage(f)

    # Step 1: Write new data records (lock is acquired and held)
    addr_value = s.write(b"hello")
    addr_node  = s.write(some_pickled_node_bytes)

    # Step 2: Publish the root pointer (flush, fsync, write, fsync, unlock)
    s.commit_root_address(addr_node)

# Between step 1 and step 2, any reader sees the OLD root.
# After step 2 completes, any reader sees the NEW root.
# There is no state where a reader sees a "partial" update.
```

This is the whole game. Everything else in DBDB — the value references, the binary tree, the public API — is built on top of this guarantee: *writes are atomic from the reader's perspective*.

---

## What I Didn't Expect

When I first read the DBDB source code, I assumed the database would have a sophisticated "free list" — a table tracking which parts of the file contain live data vs. deleted data, so it could reuse space.

There's nothing like that. Every `write` just adds to the end. Old records are never reclaimed. The file only grows.

This is a real tradeoff: **space amplification**. Update the same key 1000 times, and you have 1000 copies of that key's data on disk. Only the latest is reachable via the root pointer; the rest are orphaned garbage.

DBDB is explicitly educational — it doesn't implement compaction. But real databases do: PostgreSQL has VACUUM, CouchDB has compaction, RocksDB has compaction policies. Understanding DBDB's "keep everything" approach makes those systems' designs immediately more legible.

---

## What's Next

We have a file that can store byte records and atomically flip between versions. But the tree of nodes we want to store in that file can be enormous — far too large to load into memory all at once.

The next question: **how do you read part of a tree without reading all of it?**

The answer requires a new abstraction: a reference that knows *where* something is on disk but doesn't actually load it until you ask. A lazy pointer.
