---
layout: post
title: "Build DBDB from scratch — Part 14: Atomic, thread-safe updates"
date: '2026-05-05 12:00'
excerpt: >-
  A fifty-thread benchmark test reveals a lost update problem. This post adds a pessimistic `DBDB.update()` to provide atomic read-modify-write, then debugs three concurrency bugs that only appear with threads: fcntl locks being per-process, Python's I/O buffer hiding external writes, and overlapping object IDs in tests. It finishes by implementing and benchmarking an optimistic locking alternative that uses the root address as a version number.
comments: false
---

*Building DBDB from Scratch — Part 14: Atomic, thread-safe updates*

---

I wanted to know if DBDB could handle concurrent writes correctly. Not
theoretically — concretely. So I wrote a test: fifty threads, each opening the
same database file, each incrementing the same counter, each closing when done.
When all fifty finished, the counter should be fifty.

Here is the test:

```python
def increment(path):
    db = dbdb.connect(path, tree_type="avl")
    try:
        try:
            val = db["counter"]
        except KeyError:
            val = "0"
        db["counter"] = str(int(val) + 1)
        db.commit()
    finally:
        db.close()

def test_lost_update(tmp_path):
    path = str(tmp_path / "test.db")
    N = 50
    threads = [threading.Thread(target=increment, args=(path,)) for _ in range(N)]
    for t in threads: t.start()
    for t in threads: t.join()

    db = dbdb.connect(path)
    assert db["counter"] == str(N)   # expects "50"
    db.close()
```

It failed. The counter was somewhere between three and eight, different every
run. The same program, the same input, a different wrong answer each time.

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
| **13** | [Adding a B-Tree](https://minhmannh2001.github.io/2026/05/04/build-dbdb-from-scratch-part-13-btree-en.html) |
| **14** | **Atomic, thread-safe updates** (this post) |

---

## The Race Nobody Told Me About

The question was why. The code looks right: read the value, add one, write it
back. DBDB's writers already acquire an exclusive lock before committing. What
is missing?

The lock is the clue. DBDB's write lock covers the *commit*, not the *read*.
A thread can read the counter, spend arbitrarily long computing a new value,
and then acquire the lock and write. Between the read and the lock, any number
of other threads can commit.

Thread A reads the counter: it is 5. Thread B also reads the counter: it is 5.
Thread A locks, writes 6, commits, unlocks. Thread B locks, writes 6, commits,
unlocks. The counter is 6. Two threads ran. One increment happened. Thread B
did not know Thread A had already committed 6 by the time it wrote its own 6.
Thread A's update was lost.

With fifty threads all doing this simultaneously, the expected value of fifty
collapses to however many threads managed to read before anyone else committed.
Hence: three to eight.

DBDB's Python threads add another wrinkle. Python's GIL prevents two threads
from executing bytecode simultaneously — but I/O operations release the GIL.
When a thread blocks on a file read or write, the GIL is released and another
thread runs. Concurrency happens at the I/O boundary, not in Python arithmetic.
The lock covers the I/O at commit time. The I/O at *read* time is wide open.

---

## The Fix Is Obvious. The Implementation Is Not.

The solution is conceptually simple: don't separate the read from the lock.
Lock first, then read, then compute, then write, then unlock. No other writer
can commit between your read and your write if you're holding the lock the
entire time.

This becomes `DBDB.update(key, fn)`:

```python
def update(self, key: str, fn) -> str:
    self._assert_not_closed()
    self._prepare_write()          # acquires LOCK_EX before reading
    try:
        try:
            current = self._tree.get(key)
        except KeyError:
            current = None
        new_value = fn(current)
        self._tree.set(key, new_value)
        self._tree.commit()
        return new_value
    finally:
        if self._storage.locked:
            self._storage.unlock()
```

`fn` receives `None` if the key does not exist, so incrementing a new counter
looks like:

```python
db.update("counter", lambda v: str(int(v or "0") + 1))
```

The tradeoffs are explicit. While `fn` runs, every other writer waits. Readers
still see the last committed state — DBDB readers never acquire a lock — but
nothing can commit between the read and the write that `update()` orchestrates.
If `fn` is slow, all writers queue behind it for the full duration.

With `update()` in place, the tests to write were clear:
- **Correctness**: ten threads each call `update("counter", increment)`, the
  final value must equal ten.
- **Missing key**: `fn` receives `None` when the key has never been written.
- **Exception in fn**: if `fn` raises, the lock is released and the database
  is unchanged.
- **Return value**: `update()` returns the new value so callers don't need a
  second read.

The tests were written and run.

The counter read two.

---

## Bug 1: fcntl Doesn't Know About Threads

Two — not ten, not fifty, not even a consistent wrong number. Just two, every
time. Something was serializing the threads slightly but not correctly.

DBDB uses `portalocker` to acquire exclusive file locks. On Linux and macOS,
`portalocker` wraps `fcntl`. The assumption was that `fcntl` would serialize
threads the same way it serializes processes.

That assumption is wrong. `fcntl` locks are per-process. The kernel identifies
lock holders by process ID. All threads in a process share the same PID. When
Thread A holds an `fcntl` lock and Thread B tries to acquire it, the kernel
looks up the PID, sees the process already holds the lock, and grants it
immediately. Thread B does not wait. Thread B walks into the critical section
alongside Thread A.

The fix is a layer above `fcntl`: a `threading.Lock` that serializes threads
before they even reach the file lock. One lock per canonical file path, shared
across all `Storage` instances that point to the same file:

```python
class Storage:
    _thread_locks: dict[str, threading.Lock] = {}
    _thread_locks_guard = threading.Lock()

    @classmethod
    def _get_thread_lock(cls, key: str) -> threading.Lock:
        with cls._thread_locks_guard:
            if key not in cls._thread_locks:
                cls._thread_locks[key] = threading.Lock()
            return cls._thread_locks[key]
```

In `lock()` and `unlock()`, the thread gate goes first, the OS lock goes
second, and they are released in the opposite order:

```python
def lock(self) -> bool:
    if not self.locked:
        self._thread_lock.acquire()
        portalocker.lock(self._f, portalocker.LOCK_EX)
        self.locked = True
        return True
    return False

def unlock(self) -> None:
    if self.locked:
        self._f.flush()
        portalocker.unlock(self._f)
        self.locked = False
        self._thread_lock.release()
```

With the thread lock in place, threads are now truly serialized — only one can
hold both locks at a time. The test ran again.

The counter still read two.

---

## Bug 2: The Read Buffer That Didn't Know the File Changed

Two was no longer the right answer. Adding trace output to the `update()` path
made the new failure obvious:

```
T0: committed result=1
T1: committed result=1
T2: committed result=1
...
Final counter: 1
```

Not two — one. Every single thread committed the value `"1"`. The thread lock
was working: commits were strictly sequential, no overlap. But each thread was
reading the counter as if the database were empty, computing `"1"`, and writing
it over whatever the previous thread had written.

A trace on `get_root_address()` pinpointed where the read went wrong:

```
[T0] commit_root_address(4105)
[T0] commit_root_address done
T0: update result=1
[T1] get_root_address() -> 0      ← wrong; T0 just committed 4105
[T1] commit_root_address(4173)
T1: update result=1
```

Thread T0 committed root address 4105. Thread T1 acquired the lock next,
called `get_root_address()`, and received zero. Zero means an empty tree.
Empty tree means the key does not exist. So T1 started from scratch and
computed `"1"` again.

T0 had flushed and fsynced before releasing the lock. T1 was reading the file
*after* T0 had finished writing to it. And it was still reading zero.

The culprit is `open(path, "r+b")`, which returns a `BufferedRandom`. Python's
buffered I/O reads a large chunk into memory on the first access — the entire
4096-byte superblock in DBDB's case — and serves subsequent reads from that
in-memory cache. The key detail is what *subsequent* means: if a new seek
position falls within the already-cached range, Python updates its cursor but
returns bytes from the cache, not from the file.

When T1 was first constructed, it read the superblock and cached it. The cache
held all zeros — the file was brand new at that point. T0 then wrote root
address 4105 to offset 0 *via its own file handle*. T1's cache still held its
original zeros. When T1 seeked to offset 0 and read 8 bytes, Python found offset
0 within the cached range and returned the cached zeros. It never consulted the
OS. The OS page cache had 4105. Python's buffer, one layer above the OS, did not.

Five lines confirm it:

```python
f1 = open(path, "r+b")
f2 = open(path, "r+b")
f2.seek(0); f2.read(8)            # warm f2's cache with zeros

f1.seek(0)
f1.write(struct.pack("!Q", 4105))
f1.flush()

f2.seek(0)
print(struct.unpack("!Q", f2.read(8))[0])  # prints 0, not 4105
```

`os.pread()` is the fix. Unlike `seek() + read()`, `os.pread()` bypasses
Python's buffer entirely and reads directly from the OS page cache, which
reflects every flushed write regardless of which file handle wrote it:

```python
def _pread_superblock(self, offset: int, n: int) -> bytes:
    try:
        return os.pread(self._f.fileno(), n, offset)
    except (AttributeError, io.UnsupportedOperation, OSError):
        self._f.seek(offset)
        return self._f.read(n)

def get_root_address(self) -> int:
    return self._bytes_to_integer(
        self._pread_superblock(0, self.INTEGER_LENGTH)
    )
```

Only superblock reads need this treatment. Node data lives above offset 4096 —
outside the range the initial read-ahead cached. The superblock is the only
region that is both cached on startup and overwritten by a different file handle
during operation.

Ten threads. Final counter: ten. The correctness test passed.

---

## Bug 3: The Lock That Outlived Its Owner

With the counter test green, the next step was the full test suite: 222 tests.
`make test` ran, output appeared for about thirty tests, then stopped. No
failure. No error. Just silence.

Running the test files one by one narrowed it to `test_binary_node_ref.py`,
and within that file to a single test:

```python
def test_binary_node_ref_prepare_to_store_persists_leaf_value_and_children():
    buf = io.BytesIO()
    storage = Storage(buf)
    node = BinaryNode(left_ref=left, key="k", value_ref=value, right_ref=right)
    root = BinaryNodeRef(referent=node)
    root.prepare_to_store(storage)  # ← hangs here, never returns
```

This test uses a `BytesIO` — an in-memory file, no disk. It calls
`prepare_to_store`, which walks the node tree and calls `storage.write()` for
each ref. `write()` acquires the thread lock and never releases it; releasing
the lock is the *commit* path's responsibility, and this test calls `write()`
directly without committing.

The test finishes with the thread lock acquired and unreleased. The `Storage`
object goes out of scope. But the lock does not get garbage collected — it lives
inside the class-level `_thread_locks` dictionary, keyed by `str(id(buf))`.

`id()` in Python is the object's memory address. Memory addresses get reused.
After `buf` is garbage collected, its address becomes available again for the
next allocation. The next `io.BytesIO()` call can land at the same address.
When the next test creates a `Storage` with that new `BytesIO`, it calls
`_get_thread_lock(str(id(new_buf)))`, finds the old entry in the dictionary —
the lock that is still acquired — and tries to `acquire()` it. `threading.Lock`
is not reentrant. The same thread blocks on itself. It hangs forever.

```python
ids = []
for _ in range(5):
    buf = io.BytesIO()
    ids.append(id(buf))
    del buf
print(ids)
# [4421788624, 4421788624, 4421788624, ...]  — same address, every time
```

The fix is to stop keying in-memory file-likes by `id()`. Real files need a
shared lock across all `Storage` instances pointing to the same path. In-memory
file-likes are always private to one call site and need no such sharing:

```python
def __init__(self, f: IO):
    self._f = f
    self.locked = False
    try:
        self._lock_key = os.path.realpath(f.name)
        self._thread_lock = self._get_thread_lock(self._lock_key)
    except AttributeError:
        # BytesIO has no name. Give it a fresh per-instance lock, not stored
        # in the class dict — avoids the id() reuse deadlock entirely.
        self._lock_key = None
        self._thread_lock = threading.Lock()
    self._ensure_superblock()
```

A `BytesIO`-backed `Storage` now always gets a fresh `threading.Lock`. When
the instance is garbage collected, the lock goes with it. No class-level entry,
no stale acquired state carried forward to the next test.

222 passed in 0.64 seconds.

---

## What These Three Bugs Have in Common

None of them are bugs in the database logic. The tree operations are correct.
The commit sequence is correct. The lock protocol is correct. All three bugs
live one layer below where the database code operates.

The first is about POSIX: `fcntl` identifies lock holders by process ID, which
means threads share their process's lock identity. A database engineer who knows
this adjusts immediately. A programmer who assumes "exclusive lock" means
exclusive to threads as well as processes walks into it.

The second is about Python's I/O stack: `BufferedRandom` inserts a layer between
your code and the OS that the OS cannot reach from the outside. The kernel can
update its page cache all it wants — Python's buffer is a private copy that no
external write can invalidate. Real storage engines (`sqlite`, `PostgreSQL`,
`RocksDB`) call `pread()` and `pwrite()` directly for exactly this reason: they
cannot afford a layer that lies.

The third is about Python's object model: `id()` is a memory address, not a
stable identity. Memory addresses are reused as objects are collected. Any system
that stores state keyed by `id()` across object lifetimes will eventually mistake
a new object for an old one.

None of these appear in single-threaded tests. All three appear when you add a
second thread and force two execution contexts to share state that was designed
for one. That is, as it turns out, where database engineering lives.

---

## A Different Question

With `update()` working, a different question surfaced: does it need to hold the
lock for the entire duration of `fn`?

In `update()`, the lock is held from before the read until after the commit. If
`fn` runs in a microsecond, this is fine. But `fn` could call an external API,
parse a large document, or wait on a network request. While it does, every other
writer in the system — not just writers to this key, but all writers to this
database — is queued behind it.

The lock covers more than it needs to. What it actually needs to guarantee is
that no other writer commits *between our read and our write*. If we could
detect that condition without holding the lock the entire time, we could let
other writers proceed during `fn` and only block during the commit itself.

DBDB's storage already provides what this requires.

---

## The Root Address Is a Version Number

Every commit in DBDB does two things: it appends new tree nodes to the end of
the file, then it overwrites exactly eight bytes at offset zero — the root
address, a pointer to the current root of the tree.

That root address changes if and only if a writer commits. It starts at zero for
an empty database, advances to some large integer on the first commit, then to a
larger one on the second, and so on. Two reads separated by no commit see the
same root address. Two reads separated by any commit see different addresses.

This makes conflict detection possible without a lock held during `fn`:

1. **Read phase** — no lock. Snapshot the root address. Read the value at that
   snapshot.
2. **Compute phase** — apply `fn`. No lock. Other writers may commit during
   this time.
3. **Validate + write phase** — acquire the lock. Read the root address again.
   If it matches the snapshot, no one committed between our read and now — safe
   to write and commit. If it changed, another writer committed in between —
   discard the computed value and retry from step 1.

The implementation:

```python
def update_optimistic(self, key: str, fn, max_retries=10) -> str:
    for _ in range(max_retries):
        # Read phase: snapshot root address as version, no lock held
        self._reopen_if_replaced()
        snapshot_root = self._storage.get_root_address()
        self._tree._tree_ref = self._tree.node_ref_class(address=snapshot_root)
        try:
            current = self._tree.get(key)
        except KeyError:
            current = None
        new_value = fn(current)

        # Validate + write: acquire lock, re-check version
        self._storage.lock()
        try:
            current_root = self._storage.get_root_address()
            if current_root != snapshot_root:
                continue            # conflict — retry
            self._tree.set(key, new_value)
            self._tree.commit()
            return new_value
        finally:
            if self._storage.locked:
                self._storage.unlock()

    raise RuntimeError(f"Max retries ({max_retries}) exceeded")
```

One detail: `_tree_ref` is set directly from `snapshot_root` instead of calling
`_refresh_tree_ref()`. The reason is that `_refresh_tree_ref()` calls
`get_root_address()` internally, creating a small window between two calls where
another thread could commit — making `_tree_ref` point to a newer root than
`snapshot_root`. If they diverge, the read and the snapshot are inconsistent.
Setting `_tree_ref` from `snapshot_root` directly closes that window.

---

## The Test That Passed by Accepting Failure

Before writing the correct implementation, I wrote an incorrect one. It looked
like this:

```python
def update_optimistic(self, key: str, fn, max_retries=10) -> str:
    for attempt in range(max_retries):
        try:
            current = self[key]
        except KeyError:
            current = None
        new_value = fn(current)
        self[key] = new_value
        self.commit()
        if self[key] == new_value:   # supposedly: check for conflict
            return new_value
```

The idea was to read the value back after committing and see if it matched.
If another thread had overwritten it, the check would fail and we would retry.

The problem is that `self[key]` does not read from disk. `__getitem__` calls
`self._tree.get(key)`, which traverses the tree starting from
`self._tree._tree_ref` — the in-memory tree reference. After `self.commit()`,
`_tree_ref` still points to the in-memory node that contains `new_value`.
`__getitem__` also calls `self._reopen_if_replaced()` first, but that function
only refreshes the storage when compaction replaces the underlying file — not on
every call, and not in response to concurrent commits from other threads. Under
normal operation, it is a no-op.

So when this thread reads `self[key]` two lines after `self.commit()`, it is
walking its own stale in-memory tree, finding `new_value` there, and returning
it. Even if another thread had committed a completely different value to disk
between the commit and the read, this thread's `_tree_ref` would not reflect
that. `self[key]` returns `new_value` regardless. `self[key] == new_value` is
always true. It is not a conflict check. It is a tautology.

There was no retry logic at all. `fn` ran once, the result committed regardless
of concurrent writes, and the method returned. Lost updates still happened.

The correct assertion:

```python
assert counter == N - len(failed_retries)
```

Every thread either succeeds — and the counter goes up by one — or exhausts its
retry budget and raises `RuntimeError`. The two outcomes cover every thread
exactly once. With `max_retries=10` and ten threads, exhausting retries is
extremely unlikely, so in practice `counter == N`. But the assertion stays honest
about the edge case.

---

## The Benchmark

Two implementations. Both correct. Which one to use?

The benchmark: 30 threads competing to increment the same key, five averaged
runs, two workloads.

```
Strategy       Workload      Avg time   Avg retries
---------------------------------------------------
pessimistic    write-heavy     0.008s             -
optimistic     write-heavy     0.019s         330.0
pessimistic    mixed           0.010s             -
optimistic     mixed           0.013s          85.0
```

**Write-heavy**: pessimistic wins by more than 2×. The optimistic variant
generated 330 total retries across 30 writers — about 11 per writer. The retry
distribution in a single run:

```
min=0, median=9, max=24, avg=9.7
```

The shape is nearly linear. Thread 1 commits on the first attempt. Thread 2
retries once — it was reading while Thread 1 committed. Thread 3 retries twice.
Thread k retries k−1 times in the worst case.

Worst-case total retries: 0 + 1 + 2 + ... + (N−1) = N(N−1)/2 = 435 for N=30.
The actual ~330 is lower because threads do not all start at exactly the same
moment. But the growth is **O(N²)**, not O(N). Every new writer adds not one
unit of work but roughly N units.

Pessimistic has O(N) total work: each thread acquires the lock once, reads
once, writes once, commits once. Zero wasted computation. Under high write
contention, waiting your turn is cheaper than competing and retrying.

**Mixed workload**: the gap narrows to 30%, but pessimistic still wins. The
expectation going in was that optimistic would outperform here because fewer
readers would be blocked during `fn`. That expectation did not hold — and the
reason reveals something about DBDB specifically.

DBDB readers have never acquired a lock. `__getitem__` calls `_tree.get()`
with no locking at all. The exclusive lock that `update()` holds during `fn`
is invisible to readers. They never contended with it in the first place. Switching
to optimistic gives readers nothing they did not already have, while still
paying the retry cost for writers.

In a database where readers hold shared locks, optimistic writes can improve
reader throughput meaningfully by shortening the window during which a shared
lock must wait for an exclusive one. DBDB is not that database. There is no
shared lock to shorten.

**The side-effect implication**: 11 retries per writer means `fn` is called
twelve times on average. If `fn` is a pure function — no observable effects
beyond its return value — this is wasteful but correct: twelve computations,
one commit, eleven discarded. If `fn` sends a request, writes a log, fires a
metric, or has any other side effect, the optimistic variant multiplies those
effects by the retry count. One commit lands. Twelve external effects fire.
The pessimistic `update()` calls `fn` exactly once, always.

---

## The Decision

`update()` — pessimistic — is the default.

Faster under both workloads. Correct for any `fn`, including ones with side
effects. Simpler to reason about: `fn` runs exactly once, the lock is held for
a bounded, predictable period, and there are no retries to account for.

The scenario where optimistic would win — long-running `fn`, many readers
blocked by the write lock, low retry overhead — does not exist in DBDB. DBDB
readers bypass the lock entirely, so the write lock only affects other writers,
and under write-heavy contention optimistic generates O(N²) work.

`update_optimistic()` exists as an alternative for callers who can guarantee
that `fn` is a pure function and who know that write contention on their
specific key will be low. It is the right tool in those conditions. It is the
wrong default.

The property that made optimistic concurrency possible in DBDB — the root
address as a free version number — is a consequence of the same append-only
design that makes pessimistic locking cheap. Nothing is ever modified in place,
so the version number comes for free and the commit is a bounded append plus
an eight-byte superblock write. The same architecture that enables one strategy
makes the other one fast enough that you do not need it.
