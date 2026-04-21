---
layout: post
title: 'Build DBDB from scratch — Part 2: The lazy pointer — loading only what you need'
date: '2026-04-23 12:00'
excerpt: >-
  Why `ValueRef` separates “where on disk” from “what’s in RAM”: lazy `get()`, idempotent `store()`, `prepare_to_store` for subclasses, UTF-8 vs Python 3 strings, and `BytesValueRef` for pickled nodes without touching the inherited load/save logic.
comments: false
---

*Building DBDB from Scratch — Part 2*

Here's a thought experiment.

Imagine a database with a million key-value pairs. You want to look up a single key. In a balanced binary tree, that requires traversing about 20 nodes — log₂(1,000,000).

Now imagine loading the entire tree into memory first, then doing the search. A million nodes, each with a key, a value, left and right pointers, and some bookkeeping — easily gigabytes of data, for a single lookup.

No real database does this. Instead, they use a principle so fundamental it shows up everywhere: **don't load what you don't need, until you need it**.

In DBDB, this principle lives in a class called `ValueRef`.

---

## About this series

**Build DBDB from scratch** is a walkthrough of rebuilding **DBDB, the Dog Bed Database** from [*500 Lines or Less*](https://github.com/aosabook/500lines). Each post focuses on one layer of the implementation.

| Part | Core idea |
|------|------------|
| **0** | [Project setup]({% post_url 2026-04-21-build-dbdb-from-scratch-part-0-project-setup-en %}): `pyproject.toml`, smoke tests, pytest + BDD, Makefile |
| **1** | [Append-only storage]({% post_url 2026-04-22-build-dbdb-from-scratch-part-1-append-only-storage-en %}): superblock, `write`/`read`, root commit, `flush`/`fsync`, locking |
| **2** (this post) | `ValueRef`: lazy `get`, idempotent `store`, `BytesValueRef`, UTF-8 on disk |
| **3** (next) | Immutable binary search tree; `BinaryNodeRef` |

---

## What `ValueRef` Really Is

A `ValueRef` is a pointer with two possible states:

```
State A: "I have the data in memory, but haven't saved it yet"
         _referent = "hello"   (Python str in RAM)
         _address  = 0         (0 means: not yet on disk)

State B: "I know where the data is on disk, but haven't loaded it yet"
         _referent = None      (not in RAM)
         _address  = 4096      (byte offset in the database file)
```

And a third state, after you've called `get()`:

```
State C: "I've loaded it and cached it"
         _referent = "hello"   (loaded from disk, now in RAM)
         _address  = 4096      (still points to where it lives on disk)
```

The key behavior: `get()` only reads from disk when `_referent` is `None`. Once loaded, it's cached — the same `ValueRef` will never read the disk again.

```
                         ┌─────────────────┐
                         │    ValueRef     │
                         │                 │
                         │ _referent: ?    │──── in RAM (Python object)
                         │ _address:  ?    │──── on disk (byte offset)
                         └────────┬────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
            address=0       address=4096    address=4096
            referent="hi"   referent=None   referent="hi"
                │                │               │
             store()          get(s)          get(s)
                │                │               │
                ▼                ▼               ▼
           write to disk    read from disk   return cached
```

---

## Building It

### The Constructor

```python
class ValueRef:
    def __init__(self, referent=None, address=0):
        self._referent = referent
        self._address  = address

    @property
    def address(self):
        return self._address
    # Read-only on purpose. Once a ValueRef has an address on disk,
    # that address should never change — append-only means immutable records.

    @property
    def length(self):
        return 0
    # This will make sense in the next post. BinaryNode needs to know
    # the size of each child subtree. For a plain value (not a subtree),
    # that size is always 0.
```

### Serialization: Teaching a `ValueRef` How to Encode Itself

The data in `_referent` is a Python object (a string, in the default case). The data in the database file is bytes. Someone has to convert between them.

`ValueRef` defines two static methods for this:

```python
@staticmethod
def referent_to_bytes(referent):
    return referent.encode("utf-8")

@staticmethod
def bytes_to_referent(data):
    return data.decode("utf-8")
```

Why static? Because subclasses can override them without needing an instance. This is the key extensibility point: `BytesValueRef` (which we'll meet shortly) overrides both to store raw bytes instead of UTF-8 strings. Same `get()`/`store()` logic, different encoding.

A small historical note: the original DBDB chapter was written for Python 2, where `str` and `bytes` were essentially the same thing. In Python 2 the method was called `referent_to_string` but returned bytes. That name makes no sense in Python 3 — so in this rebuild, it's `referent_to_bytes`, because that's what it does. *Keep the intent, fix the name.*

### `get()`: The Lazy Load

```python
def get(self, storage):
    if self._referent is None and self._address:
        # Two conditions must both be true to trigger a disk read:
        # 1. We don't have the data in memory yet
        # 2. We know where to find it on disk (address != 0)
        self._referent = self.bytes_to_referent(storage.read(self._address))
    return self._referent
    # After the first call: _referent is cached. Every subsequent call returns
    # immediately from memory, no disk access.
```

The condition `self._address` (not `self._address is not None`) is intentional: address `0` is falsy, which we use as the sentinel for "not yet on disk." This means you can write `if self._address:` instead of `if self._address != 0:` — more Pythonic, and avoids a magic number comparison.

Let's trace through a concrete example:

```python
f = io.BytesIO()
s = Storage(f)

# Write "hello" to the storage directly
addr = s.write("hello".encode("utf-8"))  # returns e.g. 4096

# Now create a ValueRef that only knows the address
ref = ValueRef(address=addr)
print(ref._referent)   # None — nothing in RAM yet
print(ref.address)     # 4096

# First call to get() — reads from disk
value = ref.get(s)
print(value)           # "hello"
print(ref._referent)   # "hello" — now cached

# Second call to get() — no disk access
value = ref.get(s)
print(value)           # "hello" — from cache
```

### `store()`: Writing to Disk, Exactly Once

```python
def store(self, storage):
    if self._referent is not None and not self._address:
        # Only write if:
        # 1. There's something to write (_referent is not None)
        # 2. We haven't written it yet (address is 0)
        self.prepare_to_store(storage)  # hook for subclasses
        self._address = storage.write(self.referent_to_bytes(self._referent))
```

The most important word here is **idempotent**. Call `store()` once: writes to disk, sets `_address`. Call `store()` again: does nothing.

Why does idempotency matter so much? Because when you commit a tree to disk, you'll recursively call `store()` on every node. Some nodes might be shared between the old tree and the new tree — you don't want to write them twice. With append-only storage, double-writing doesn't corrupt data, but it wastes space and creates orphaned records.

The `prepare_to_store` hook is a template method for subclasses. For plain `ValueRef`, it does nothing. For `BinaryNodeRef` (next post), it recursively stores all child references before pickling the current node. The hook fires *before* the actual write — so by the time we call `storage.write(...)`, every piece of data this node depends on already has an address.

---

## An Unexpected Complication: Python 2's Legacy

I mentioned the `referent_to_string` naming. There's a deeper legacy issue here.

The original DBDB uses `ValueRef` to store string values. In Python 2, `str` was bytes. In Python 3, `str` is Unicode. The encoding step (`str.encode("utf-8")`) that's explicit in our rebuild was implicit in the original.

This matters because it changes the API contract: if you give DBDB a key like `"café"`, it gets stored as 5 bytes (the UTF-8 encoding of é is two bytes: `\xc3\xa9`). When you read it back, you get `"café"` again. The round-trip is correct. But the bytes on disk look different from the Python string. Understanding this is important when you're debugging binary files.

```python
# These are not the same
"café".encode("utf-8")   # b'caf\xc3\xa9'  — 5 bytes
"café".encode("latin-1") # b'caf\xe9'       — 4 bytes

# ValueRef uses UTF-8 → portable, handles all Unicode
```

---

## `BytesValueRef`: When You Need Raw Bytes

Not everything is a human-readable string. When we serialize a `BinaryNode` to disk, we'll use `pickle.dumps(...)` which produces raw bytes — not a UTF-8 string.

`BytesValueRef` handles this:

```python
class BytesValueRef(ValueRef):
    def __init__(self, referent=None, address=0):
        if referent is not None and not isinstance(referent, (bytes, bytearray)):
            raise TypeError("BytesValueRef referent must be bytes, bytearray, or None")
            # Fail fast: if you accidentally pass a str here, you'll get
            # an error immediately — not a confusing encoding error later.
        normalized = None if referent is None else bytes(referent)
        # Normalize bytearray → bytes. bytearray is mutable; once stored,
        # _referent should be immutable so the cache stays trustworthy.
        super().__init__(referent=normalized, address=address)

    @staticmethod
    def referent_to_bytes(referent):
        return bytes(referent)   # no encoding needed; already bytes

    @staticmethod
    def bytes_to_referent(data):
        return bytes(data)       # no decoding needed; return as bytes
```

The `get()` and `store()` methods are inherited unchanged. Only the serialization strategy differs. This is the Open/Closed principle in action: the base class is open for extension (override the static methods), closed for modification (you don't need to touch `get()` or `store()`).

---

## What This Abstraction Buys You

Looking at the `ValueRef` interface:

```python
ref.get(storage)    # "give me the value" — loads from disk if needed
ref.store(storage)  # "save this value" — writes to disk if not already saved
ref.address         # "where is this on disk" — 0 if not saved yet
```

Three methods. That's the entire contract. And because of this clean interface, the `BinaryNode` class (coming up next) can hold references to its children without knowing or caring whether those children are currently in memory or on disk.

When the tree traversal reaches a node, it calls `ref.get(storage)`. If the node is cached: instant return. If not: one disk read. The traversal code doesn't need to know which case it's in.

This is what **indirection** buys you in database design: you decouple "knowing where something is" from "actually going and getting it."

---

## What's Next

We have a way to store arbitrary values on disk with lazy loading. Now we need a data structure to organize those values — a way to say: the key `apple` maps to a value at address 4096, and keys less than `apple` are in the subtree at address 5200.

That structure is a binary search tree. But not a mutable one.

Every database textbook teaches you mutable BSTs: insert a node, update a pointer. DBDB takes a different approach that makes crash recovery trivial and readers never need a lock: **an immutable tree, where every "update" creates new nodes instead of modifying existing ones**.
