---
layout: post
title: "Build DBDB from scratch — Part 8: The thinnest layer"
date: '2026-04-29 12:00'
excerpt: >-
  55 lines of facade code that hide an entire architecture. `DBDB.__init__` wires Storage into BinaryTree so the caller never sees either. The dictionary protocol, `_assert_not_closed`, `__contains__` via try/except, and an EAFP `connect()` that absorbs the new-vs-existing branch — thin by design.
comments: false
---

*Building DBDB from Scratch — Part 8*

---

After seven posts of internals, I finally had something correct. What I didn't
have was something usable.

To read a key, you had to construct a `Storage`, pass it to a `BinaryTree`,
and call `.get()`. To write, you had to know that `set()` acquires a lock.
To persist, you had to remember to call `commit()` before the file closed.
The database worked, but only if you knew how it worked.

That gap — between correct and usable — is what the facade closes. The `DBDB`
class and the `connect()` function are 55 lines of code combined. They don't
implement any new logic. Every method in `DBDB` delegates to something that
already existed. But when you're done, the entire architecture disappears, and
what's left is this:

```python
import dbdb

db = dbdb.connect("mydb.db")
db["apple"] = "red"
db.commit()
db.close()
```

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
| **8** (this post) | The `DBDB` facade: dictionary protocol, `connect()`, `_assert_not_closed` |
| **9** | [The last translation: the CLI tool](https://minhmannh2001.github.io/2026/04/30/build-dbdb-from-scratch-part-9-cli-en.html) |
| **10** | [What immutability costs: compaction](https://minhmannh2001.github.io/2026/05/01/build-dbdb-from-scratch-part-10-compaction-en.html) |
| **Retrospective** | [What a database actually is](https://minhmannh2001.github.io/2026/05/02/build-dbdb-from-scratch-part-11-retrospective-en.html) |

---

## `__init__`: Two Lines That Hide an Architecture

```python
def __init__(self, f):
    self._storage = Storage(f)
    self._tree = BinaryTree(self._storage)
```

Post 7 opened with "two lines that do everything." Here's another pair —
but where commit's two lines trigger a cascade, these two lines *hide* one.

A file object goes in. What comes out knows how to lock, how to refresh the root
on first write, how to cascade stores bottom-up before moving the root pointer.
The `DBDB` instance holds references to `_storage` and `_tree`, but from the
outside, those names start with an underscore for a reason. The user doesn't
touch them. They exist so the public methods have something to delegate to.

The relationship between `Storage` and `BinaryTree` — the fact that `BinaryTree`
takes a `Storage`, not a file; the fact that `Storage` owns the lock — all of
that is now an implementation detail. The caller passes a file and gets a
database. The wiring is invisible.

---

## The Dictionary Protocol

```python
def __getitem__(self, key):
    self._assert_not_closed()
    return self._tree.get(key)

def __setitem__(self, key, value):
    self._assert_not_closed()
    return self._tree.set(key, value)

def __delitem__(self, key):
    self._assert_not_closed()
    return self._tree.pop(key)
```

Each method is a guard plus a delegation. That's it.

`DBDB` doesn't inherit from `dict`. It doesn't call `super().__init__()` or
maintain any internal mapping. It just implements `__getitem__`, `__setitem__`,
and `__delitem__` — enough to satisfy Python's expectation of something that
behaves like a dictionary. When you write `db["apple"] = "red"`, Python calls
`db.__setitem__("apple", "red")`, which calls `self._tree.set("apple", "red")`,
which acquires a lock if needed, refreshes the root, and returns a new in-memory
node tree. None of that is visible. The bracket syntax is the only surface.

This is the practical meaning of duck typing: you don't need to *be* a dict.
You need to *respond* like one.

---

## `_assert_not_closed`: A State Machine as a One-Liner

```python
def _assert_not_closed(self):
    if self._storage.closed:
        raise ValueError("Database closed.")
```

Every public method calls this first. It looks trivial, but it encodes something
real: a database connection has states. Open — operations are valid. Closed —
they're not. Once you call `close()`, the storage flushes and releases the OS-level
file handle. Any subsequent read or write is meaningless.

Without the guard, calling `db["apple"]` after `db.close()` would silently fail
or raise an obscure IO error somewhere deep in `Storage`. The guard surfaces the
mistake at the right level. `ValueError("Database closed.")` tells you exactly
what's wrong and where the problem actually is.

Real database clients enforce this contract too. SQLite raises
`ProgrammingError: Cannot operate on a closed database`. The pattern is identical
— a state check at the boundary, before any internal work begins.

---

## `__contains__`: Reusing Instead of Duplicating

```python
def __contains__(self, key):
    self._assert_not_closed()
    try:
        self._tree.get(key)
        return True
    except KeyError:
        return False
```

There's no `contains()` method on `BinaryTree`. There's no `exists` flag stored
anywhere. `__contains__` calls `get()` and interprets what happens.

This matters because `get` already does the traversal — it walks the tree from
root to leaf looking for the key. A separate `contains` implementation would
do the exact same walk. Reusing `get` and catching `KeyError` isn't lazy — it's
the right choice. The failure mode of "not found" is already expressed as an
exception, so `__contains__` just converts that exception into a boolean.

Python's `in` operator calls `__contains__`, which means `"apple" in db` works
exactly as you'd expect. The user doesn't need to know that internally it's a
try/except around a tree traversal.

---

## `connect()`: Absorbing the Branch

```python
def connect(dbname):
    try:
        f = open(dbname, "r+b")
    except IOError:
        f = open(dbname, "w+b")
    return DBDB(f)
```

The alternative would be:

```python
if os.path.exists(dbname):
    f = open(dbname, "r+b")
else:
    f = open(dbname, "w+b")
```

Both work. The difference is philosophical. The `os.path.exists` version
*checks before acting* — the LBYL (Look Before You Leap) pattern. The
`try/except` version *acts and handles failure* — EAFP (Easier to Ask
Forgiveness than Permission). Python idioms favor EAFP: the check-then-act
pattern introduces a race condition (the file could be created or deleted between
the check and the open), while the try/except handles the actual error at the
point it occurs.

But the deeper point is what `connect()` means to the caller. Connecting to a
database that doesn't exist yet and connecting to one that already has data are
the same operation. `connect("mydb.db")` does the right thing either way.
The branching is internal. The caller never sees it.

This is what a good entry point does: it absorbs the variability so the caller
doesn't have to make decisions they shouldn't need to make.

---

## What Disappeared

Before the facade, using the database looked like this:

```python
import io
from dbdb.physical import Storage
from dbdb.binary_tree import BinaryTree

f = io.BytesIO()
storage = Storage(f)
tree = BinaryTree(storage)

tree.set("apple", "red")
tree.commit()

value = tree.get("apple")
```

After:

```python
import dbdb

db = dbdb.connect("mydb.db")
db["apple"] = "red"
db.commit()

value = db["apple"]
```

The knowledge that disappeared: that `Storage` takes a file. That `BinaryTree`
takes a `Storage`, not a file directly. That `set` doesn't write to disk —
`commit` does. That you need to manage a file handle. That the lock is on
`Storage`, not on `BinaryTree`.

All of it is still there. The code didn't change. But the user doesn't need to
carry it anymore.

---

## What We Built

Seven posts of internals — append-only storage, lazy references, immutable
binary tree nodes, a logical base that coordinates them, locking, and a
two-line commit — and it all compresses into a class that fits on one screen.

The facade doesn't add power. It removes friction. Every method in `DBDB`
exists to translate what the user naturally wants to say (`db["key"] = "value"`)
into what the system knows how to do (`_tree.set(key, value)` under a held lock).
The translation is thin. That's the point.

Good interfaces are thin. They expose decisions the user should make (what key,
what value, when to commit) and hide decisions they shouldn't have to make
(how locking works, what a cascade is, why the root address matters).

DBDB is done. Small, complete, and persistent.
