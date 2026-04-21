---
layout: post
title: 'Build DBDB from scratch — Part 0: Before writing a single line of database logic'
date: '2026-04-21 12:00'
excerpt: >-
  Why the first commit was a smoke test, not storage code. Setting up pyproject.toml (PEP 621), pytest with pythonpath, pytest-bdd Gherkin smoke, conftest plugin loading, and a tiny Makefile so every clone gets a green test loop from day one.
comments: false
---

*Building DBDB from Scratch — Part 0*

I have a confession: the first thing I did when starting this project was *not* write a database.

I wrote a test that checks whether I can import an empty Python package. Then I made it pass. Then I committed.

That sounds absurd. But by the end of this post, I hope you'll see why it's the most important thing I did.

---

## About this series

**Build DBDB from scratch** is a walkthrough of rebuilding **DBDB, the Dog Bed Database** from [*500 Lines or Less*](https://github.com/aosabook/500lines) — a small key-value store where data survives process restarts. Each post focuses on one layer: packaging and tests first, then file storage, trees, and durability.

Inspired by the book chapter, this series is my own rebuild: I get stuck, fix the environment, and explain the decisions as I go.

| Part | Core idea |
|------|------------|
| **0** (this post) | `pyproject.toml`, smoke import test, pytest + BDD, Makefile |
| **1** | [Append-only storage and an atomic root pointer]({% post_url build-dbdb-from-scratch-part-1-append-only-storage-en %}) |
| **2** | [`ValueRef` and lazy loading]({% post_url build-dbdb-from-scratch-part-2-valueref-en %}) |

---

## Why Bother Rebuilding DBDB?

A few weeks ago, I was reading *500 Lines or Less* — a book where experienced engineers implement real software systems in under 500 lines of Python. One chapter caught my attention: **DBDB, the Dog Bed Database**.

It's a key-value store. You give it a key, it gives you a value back — even after you restart your program. Simple idea. But the implementation reveals something fascinating: how do you actually make data *survive* a program restart? How does a database talk to a file? What happens when the power goes out mid-write?

I could have just read the chapter. But I've found that truly understanding something means building it yourself, getting stuck, figuring out why it works the way it does. So I decided to rebuild DBDB from scratch, one layer at a time, explaining each decision along the way.

This blog is that journey.

---

## The Stage Before the Play

Every project has a moment where you have to decide: *do I start building, or do I set up the infrastructure first?*

The temptation is always to start building. You have the idea. You're excited. The infrastructure feels like bureaucracy.

Here's the thing though: when you're building something you've never built before — a database, a compiler, a network protocol — you're going to be wrong about things. A lot. The question isn't *will* you be wrong, it's *how quickly* will you find out.

A working test suite is an early-warning system. When you make a mistake, it tells you immediately. When you change something and everything still passes, you can move forward with confidence.

So before writing a single line of `Storage` or `BinaryTree`, I spent a session just getting the scaffolding right.

---

## Packaging: One File to Rule Them All

Modern Python packaging is... complicated. There's `setup.py`, `setup.cfg`, `MANIFEST.in`, `pyproject.toml`... and they all do overlapping things.

I chose `pyproject.toml` with PEP 621 — the current standard that unifies package metadata into a single file:

```toml
[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "dbdb"
version = "0.1.0"
description = "Rebuild of the DBDB Dog Bed Database from '500 Lines or Less'"
requires-python = ">=3.10"
dependencies = []

[tool.setuptools.packages.find]
where = ["."]
include = ["dbdb*"]
```

Nothing surprising here, except maybe `include = ["dbdb*"]`. That pattern tells setuptools: *only package the `dbdb/` directory, not `tests/` or anything else*. With a flat layout (no `src/` folder), you need to be explicit about this — otherwise you might accidentally ship your test suite to PyPI.

The `dependencies = []` is intentionally empty. `portalocker` (which we'll need for file locking) goes in `requirements.txt` for now — it's a development dependency, and I want to keep the runtime package lean.

---

## The First Test: Proving the Package Exists

Here's the first test I wrote:

```python
# tests/test_smoke.py

def test_import_dbdb_package():
    import dbdb
    assert dbdb.__file__
```

Two lines. It imports the package and checks that Python found a real file (not a namespace package, which would have `__file__ == None`).

This test fails if:

- `pip install -e .` wasn't run (no editable install)
- `pythonpath = .` is missing from `pytest.ini` (can't find the package)
- The `dbdb/` directory doesn't exist or is missing `__init__.py`

In other words, it fails whenever the environment is broken — which is exactly when you need a test to fail. Once this is green, you know your foundation is solid.

```ini
# pytest.ini
[pytest]
testpaths = tests
pythonpath = .
bdd_features_base_dir = features
```

`pythonpath = .` is the key line: it adds the repo root to Python's module search path, so `import dbdb` works even before `pip install -e .`. I run both because they solve slightly different problems — the editable install registers the package globally, while `pythonpath` handles running tests directly from the repo without installing.

---

## BDD: Tests That Read Like Requirements

Alongside the regular pytest test, I added a BDD (Behavior-Driven Development) scenario:

```gherkin
# features/smoke.feature
Feature: DBDB package availability

  Scenario: dbdb package is importable
    Given the Python environment is set up
    When I import the dbdb package
    Then the package should be available with a file path
```

If you've never seen Gherkin before: this is a way of writing tests that reads like natural language. The "Given / When / Then" structure forces you to think about preconditions, actions, and outcomes — separately.

The same test, expressed two ways, tests the same thing. But the `.feature` file serves a different audience: it's readable by anyone, not just developers. When a non-developer asks "what does this system guarantee?", you can hand them the `.feature` files.

One gotcha I ran into: `pytest-bdd` step definitions need to be loaded in `conftest.py`, not declared in `pytest.ini`:

```python
# tests/conftest.py
pytest_plugins = ["step_defs.smoke_steps", "step_defs.storage_steps"]
# WHY here and not pytest.ini? pytest.ini doesn't support pytest_plugins —
# it will warn "Unknown config option" and silently ignore it.
# conftest.py is the right hook point for loading plugins and fixtures.
```

---

## The Makefile: Not Because It's Clever, But Because I'm Lazy

```makefile
venv:
	python3 -m venv .venv

install: venv
	.venv/bin/pip install -r requirements.txt
	.venv/bin/pip install -e .

test:
	.venv/bin/pytest -q
```

`make install && make test`. That's it. One command to set up, one command to verify.

The detail worth noting: I use `python3 -m venv .venv` (system Python) to create the virtual environment, not `.venv/bin/python`. Because the `.venv` directory doesn't exist yet — you can't use a Python that doesn't exist yet to create itself.

---

## A Green Pipeline from Day One

When `pytest -q` outputs `2 passed` on a brand new clone of the repo, something important has happened: the feedback loop is alive.

From here on, every change I make will be immediately testable. I'll know within seconds whether I broke something. I can experiment aggressively because the net is there.

The database itself is still entirely missing. `dbdb/__init__.py` is empty. There's no storage, no tree, no key-value logic whatsoever.

But the foundation is set. Let's build on it.

---

## What's Next

In the next post, we get to the first real question: *how does a database actually store data in a file?*

The answer is not what I expected. It's not about tables or indexes or anything fancy. It starts with a simple, almost brutal idea: **never overwrite anything**. Just keep appending. And keep a pointer at the front of the file that says "here's where the latest version of your data starts."

That idea — append-only storage with an atomic root pointer — turns out to solve a surprisingly large number of hard problems all at once.
