---
layout: post
title: "Build DBDB from scratch — Part 9: The last translation"
date: '2026-04-30 12:00'
excerpt: >-
  `tool.py` is 62 lines that translate dict syntax into shell commands. Three decisions worth examining: why `finally` handles `close()` rather than each branch, why `set` auto-commits while the Python API doesn't, and why values go to stdout while errors go to stderr — the conventions that make a tool composable.
comments: false
---

*Building DBDB from Scratch — Part 9*

---

Every layer in DBDB is a translation.

`Storage` translates bytes into addresses. `ValueRef` translates addresses into
values. `BinaryTree` translates values into keys. `LogicalBase` translates
operations into tree algorithms. `DBDB` translates tree algorithms into dict
syntax. Each layer absorbs the representation below it and offers a cleaner one
above.

`tool.py` is the last one. It translates dict syntax into shell commands.

```
$ python -m dbdb.tool mydb.db set city "Hanoi"
$ python -m dbdb.tool mydb.db get city
Hanoi
```

The file is 62 lines. It adds no new logic. But it's not nothing — the decisions
in those 62 lines say something about what this tool is for.

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
| **9** (this post) | `tool.py`: `finally` for cleanup, per-invocation transactions, stdout vs stderr |
| **10** | [What immutability costs: compaction](https://minhmannh2001.github.io/2026/05/01/build-dbdb-from-scratch-part-10-compaction-en.html) |
| **Retrospective** | [What a database actually is](https://minhmannh2001.github.io/2026/05/02/build-dbdb-from-scratch-part-11-retrospective-en.html) |

---

## The `finally` Block That Does All the Work

```python
db = dbdb.connect(dbname)
try:
    if command == "get":
        ...
    elif command == "set":
        ...
    elif command == "delete":
        ...
finally:
    db.close()
```

The `finally` block is the first thing I noticed. `db.close()` lives there, not
at the end of each branch. That means no matter what command runs, no matter
whether it succeeds or returns early with `return 1`, the database closes.

In Python application code, you'd reach for a context manager — `with dbdb.connect(...) as db:`. The CLI doesn't have one (yet), so `try/finally` is the manual version of the same guarantee: acquire the resource, do the work, release it — even if the work fails.

The file handle underneath `db` carries an OS-level lock. Failing to close it
means that lock stays held. Another process trying to write would block
indefinitely. `finally` ensures that can't happen, whatever path the code takes.

---

## Each Invocation Is Its Own Transaction

In the Python API, `set` and `commit` are separate:

```python
db["a"] = "1"
db["b"] = "2"
db.commit()   # one atomic write for both
```

That separation exists so callers can batch writes. In the CLI, `set` collapses
them:

```python
elif command == "set":
    key, value = args
    db[key] = value
    db.commit()   # immediate
```

`set` commits before returning. Why?

Because a shell invocation has no memory. When you run
`python -m dbdb.tool mydb.db set a 1`, that process starts, sets `a`, commits,
closes, and exits. The next invocation starts fresh — a new process, a new
`connect()`, a new `BinaryTree` loaded from disk. There is no session to carry
uncommitted state across commands.

The Python API lets you accumulate writes because Python keeps objects alive.
The CLI can't. Each command is a transaction of exactly one write.

The `commit` command exists too, as a standalone:

```python
elif command == "commit":
    db.commit()
```

With `set` auto-committing, this is mostly a no-op — committing a database you
just opened is committing an empty transaction. Its real value is as an explicit
flush: if some future command accumulates writes without committing, `commit`
gives you a way to persist them without exiting. It costs nothing to keep it
available.

---

## `stdout` and `stderr` Are Not the Same Channel

```python
if command == "get":
    sys.stdout.write(db[key])
```

```python
except KeyError:
    sys.stderr.write("Key not found\n")
    return 1
```

`get` writes the value to stdout. `delete` writes its error to stderr.
The usage message also goes to stderr. This split is Unix convention — and
it matters for the same reason exit codes matter.

A program that writes values to stdout can be composed:

```
python -m dbdb.tool mydb.db get city | tr '[:lower:]' '[:upper:]'
```

If errors also went to stdout, they'd appear in the pipeline as if they were
data. Separating them means the next command in the pipeline only sees actual
output. `stderr` goes to the terminal — visible to the person running the
command — while `stdout` continues through the pipe.

Exit codes carry the same idea. Return `0` on success, non-zero on failure.
A calling script can check `$?` and branch. The database doesn't need to explain
itself in prose; the exit code is enough.

```
$ python -m dbdb.tool mydb.db delete ghost
Key not found
$ echo $?
1
```

These conventions aren't enforced by Python. Nothing stops you from writing
errors to stdout and always returning 0. But following them is what makes the
tool behave like a citizen of the shell, composable with `grep`, `xargs`,
`if`, and the rest.

---

## What the Architecture Made Easy

`tool.py` imports two things: `sys` and `dbdb`. It never touches `Storage`,
`BinaryTree`, `LogicalBase`, or `BinaryNodeRef`. It doesn't know that a write
acquires a lock. It doesn't know that commit triggers a bottom-up cascade. It
doesn't know that the root address lives in the first 8 bytes of the file.

It knows one thing: `dbdb.connect(dbname)` gives you a thing that supports
`db[key]`, `db[key] = value`, `del db[key]`, and `db.commit()`.

The eight posts before this one built up layers specifically so the top layer
could ignore everything below it. The CLI is thin because the facade is good.
If `DBDB` had leaked implementation details — if the caller had to pass a
`Storage` manually, or had to know that `commit()` must follow `set()` — the
CLI would carry that complexity too.

Instead, `tool.py` is just argument parsing and delegation.

---

## The Full Stack, Finally

From a raw byte in a file to a shell command:

```
$ python -m dbdb.tool mydb.db set fruit mango
```

1. `tool.py` parses `argv`, calls `dbdb.connect("mydb.db")`
2. `connect()` opens the file, constructs `Storage` and `BinaryTree`
3. `db["fruit"] = "mango"` calls `DBDB.__setitem__`
4. `__setitem__` calls `BinaryTree.set`
5. `BinaryTree.set` calls `Storage.lock()` — lock acquired — then refreshes
   the root if needed
6. A new `BinaryNode` is created in RAM; `_tree_ref` is updated
7. `db.commit()` fires: `_tree_ref.store(storage)` cascades bottom-up, writing
   every dirty node to disk; then `commit_root_address` writes the new root
   address to bytes 0–7
8. `db.close()` runs in `finally`, releasing the OS lock and closing the file

One command. Nine steps. All of it behind `db["fruit"] = "mango"`.

That compression — from one shell command to the full machinery of an
append-only, lock-based, immutable-tree key-value store — is what the whole
project was building toward.
