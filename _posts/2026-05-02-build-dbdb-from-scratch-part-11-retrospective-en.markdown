---
layout: post
title: "Build DBDB from scratch — Retrospective: What a database actually is"
date: '2026-05-02 12:00'
excerpt: >-
  Eleven posts, six layers, one guarantee. This retrospective traces the design thread that ran from append-only storage through compaction — why each decision followed from the last, what each layer was actually hiding, and which small choices (lock() return value, rename-before-close, fstat vs stat, double check in _prepare_write) turned out to be the most consequential.
comments: false
---

*Building DBDB from Scratch — Retrospective*

---

The first post opened with a question: what actually happens when the power goes out?

It seemed like a narrow question about one edge case. It wasn't. It turned out to be
the question that the entire project was secretly answering, one layer at a time.
Every design decision from post 1 to post 10 was, in some form, an answer to that
question. What do you preserve? What do you give up? What can you promise?

Eleven posts, six layers, and one guarantee: if you called
`commit()`, your data survived. If you didn't, it didn't. That's the whole thing.

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
| **Retrospective** (this post) | The design thread end-to-end: six layers, one guarantee |

---

## The Thread That Ran Through Everything

The central decision was made in post 1, before any tree logic existed: the file
is append-only. Old data is never overwritten. New writes go to the end.

That one decision created a cascade.

Because old data is never overwritten, readers following an old root always see a
complete and consistent tree. There's no state where half a node has been updated
and the other half hasn't. The tree is always whole at every snapshot the root
pointer has ever been committed to. Concurrent readers need no lock.

Because old data is never overwritten, commit reduces to a single pointer write.
All the new nodes are on disk, but unreachable. The commit is the moment the root
pointer moves — 8 bytes at offset 0 — and that write is as atomic as a single
disk write can be. Either it happens or it doesn't. There's no partial commit.

Because old data is never overwritten, the file grows forever. Every set, every
delete, every overwrite leaves bytes behind that no pointer leads to. Append-only
was a gift that came with an invoice: eventually, you have to compact.

That thread — immutability, then atomicity, then garbage — connects posts 1
through 10. The rest was building the machinery to support each consequence
in turn.

---

## What Each Layer Was Actually Hiding

Six files. Each one a translation.

**`physical.py`** hid the file. After post 1, the rest of the codebase never
thought about `seek`, `read`, or `write`. It thought about addresses — integer
offsets into the file — and the storage layer converted those integers to bytes
on a disk. The superblock and root address lived here too, which is why `commit()`
could eventually be two lines: the storage layer already knew how to do the hard
part.

**`logical.py`** hid the storage. `ValueRef` held the contract between in-memory
objects and disk addresses: you either have the data in RAM or you have an address
to retrieve it. You don't need both at once. Load lazily. Store only when
committing. The `LogicalBase` class held the template for every write session:
lock, refresh, insert, commit, unlock. The tree algorithm was a plug-in.

**`binary_tree.py`** hid the tree. `BinaryNode` was immutable. Every insert and
delete returned a new node instead of mutating an existing one. That immutability
was what made the lazy references safe: a node written to disk never changed, so
an address was forever valid. `BinaryNodeRef` encoded and decoded nodes using
msgpack — a format with no execution model, no Python coupling, no pickle hazard.

**`interface.py`** hid everything above. `DBDB.__init__` took a file and wired
Storage into BinaryTree. Eight public methods delegated to the tree or the
storage. Nothing leaked. The caller wrote `db["city"] = "Hanoi"` and had no idea
that behind it, a lock was acquired, a root was refreshed, an immutable node was
created in RAM, and nothing touched disk until `commit()`.

**`__init__.py`** hid the file handle. `connect("mydb.db")` opened or created the
file, constructed the stack, and handed back a `DBDB`. The try/except IOError
was the entire connection logic: attempt to open for reading and writing, fall
back to create. Two lines. One entry point.

**`tool.py`** hid the Python API. `python -m dbdb.tool mydb.db get city` parsed
argv, called `connect`, delegated, closed in `finally`. Each CLI invocation was
a transaction. `stdout` carried values. `stderr` carried errors. Exit codes
carried success or failure. The shell could compose the tool; the tool didn't
have to know what composed it.

Each layer knew one thing about the layer below it. Nothing more.

---

## The Decisions That Looked Small

Some of the most consequential design choices fit in a single line.

**`lock()` returning `True` or `False`** — not void, not a bool flag to check
separately, but the return value of the lock call itself, loaded with meaning.
`True` means: I just waited, and while I waited the world may have changed.
Refresh. `False` means: I already own this, my snapshot is current. Don't refresh
— that would discard uncommitted work. One boolean, doing the work of a version
conflict detector.

**`os.rename` before `close()`** — in compaction, the order of these two calls
determines whether there's a window where another writer can commit to the orphaned
inode. The first version had it backwards. Closing before renaming released the
lock, then renamed. Any writer that acquired the lock in that gap would write to
the old file — permanently lost after the rename. Reversing the order: rename
while holding the lock, then close. POSIX allows renaming open files. The lock
covers the rename. No window.

**`fstat` vs `stat`** — two syscalls that together answer the question "is the
file I have open the same file that's at this path?" `os.fstat(fd)` reads the
inode of the open descriptor. `os.stat(path)` reads the inode of whatever is
currently at the path. If they differ, the file was replaced. This is how any
connection — reader or writer — detects that compaction happened while it was
connected, and transparently reopens onto the new file.

**`_prepare_write()` checking twice** — once before acquiring the lock (narrows
the window), once after (closes it). The second check is conclusive: once the
exclusive lock is held, no compaction can run. If `is_file_replaced()` returns
`True` at that point, the replacement happened in the exact gap between the first
check and the lock. Without the second check, writes would silently target the
orphaned inode.

None of these decisions look important until you trace what breaks when you get
them wrong.

---

## The Stack, in Full

```
physical.py     bytes ↔ addresses
logical.py      addresses ↔ values
binary_tree.py  values ↔ keys
interface.py    keys ↔ dict syntax
__init__.py     dict syntax ↔ file path
tool.py         file path ↔ shell command
```

Six layers. Each one a translation. Each layer does exactly one thing and
trusts the layer below it to do its one thing correctly. The whole stack
small enough to hold in your head — that was always the goal.

---

## What It Doesn't Do

The gaps are not oversights. They're the next conversation.

**The tree doesn't rebalance.** A binary search tree with random insertion order
has expected O(log n) height. After compaction — which inserts keys in sorted
order from the in-order traversal — the tree is maximally skewed: a right-leaning
chain with O(n) lookup. Production databases use B-trees, B+-trees, or LSM trees,
all of which maintain bounded height regardless of insertion order. Fixing DBDB
here means replacing the tree entirely.

**Compaction is blocking and manual.** While `compact()` runs, no other writer
can proceed. On a large database, this is minutes of downtime. RocksDB runs
compaction continuously in background threads. DBDB would need a separate process
or thread, a way to coordinate handoff, and a way to signal other connections
that the file changed — which `is_file_replaced()` already partially provides.

**The serialization format has no version.** msgpack replaced pickle as a breaking
change. Any database written with the old code cannot be read by the new code.
A production system needs a format version in the superblock: read the version
first, dispatch to the correct deserializer. Migrations become explicit. DBDB
has no version field.

**There is no transaction log.** If the process crashes between the cascade write
and the root pointer flip, the new nodes exist on disk but the root pointer still
points to the old tree. On the next open, the new nodes are invisible — garbage
that will be cleaned up by the next compaction. This is acceptable for DBDB's
durability model but means that partially-committed writes consume space silently.

**Reads are not isolated across sessions.** A reader that opens the file sees
whatever root was committed at that moment. If a writer commits between two of
the reader's `get()` calls, the second call may see a different tree than the
first. DBDB has no snapshot isolation across multiple reads in a session. SQLite
and PostgreSQL solve this with MVCC; DBDB has no equivalent.

---

## What Building It Taught

There's a specific kind of understanding that comes from building something
yourself, even when a finished version already exists. Reading how commit works is
not the same as watching `_storage.commit_root_address` move eight bytes and
knowing — not abstractly but concretely — that those eight bytes are the entire
boundary between provisional and permanent.

The original motivation was this: databases are treated as black boxes. You learn
their APIs, their query languages, their configuration knobs. But the interior —
why append-only, why a superblock, why the root pointer flip, why locking works
the way it does — that stays opaque.

DBDB made the interior visible. Not because it's a production system (it isn't),
but because it's small enough that you can follow every call, understand every
decision, and trace the reason for every tradeoff back to first principles.

When you understand why DBDB's commit is two lines, you understand why any
database's commit is what it is. When you understand why compaction creates a
skewed tree, you understand why production databases use B-trees. When you
understand the TOCTOU race in `_prepare_write`, you understand why database
concurrency control is an entire research field.

The question — what happens when the power goes out? — turned out to have a
longer answer than expected. It took eleven posts to get there. The answer is:
it depends on exactly which line was executing, and whether the person who wrote
that line thought carefully about the order of operations.

DBDB thought carefully.
