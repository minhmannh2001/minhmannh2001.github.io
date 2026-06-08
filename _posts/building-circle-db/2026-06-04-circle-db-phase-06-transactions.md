---
layout: post
title: "Building circle-db — Phase 6: Transactions & Layered History"
subtitle: "Immutability makes 'what-if' free — no rollback, no savepoints, just values."
tags: [database, clojure, python, learning]
readtime: true
gh-repo: minhmannh2001/circle-db
gh-badge: [star, fork]
---

## Atomic Writes, Layered History

Think of a transaction like writing a cheque. When you write a cheque, you don't immediately update the bank's ledger for each item — you hand over the whole cheque, and the bank either processes all of it or none of it. No half-applied cheques.

Our database worked similarly before this phase, but only one operation at a time. Each call to `add_entity` or `update_entity` immediately appended a new snapshot layer. That's fine for a single operation — but what if you need to add two related entities together? Say, a "person" and their "address", where both should appear as one atomic change. Without transactions, you'd get two intermediate layers, and anyone reading in between would see a half-written state.

`transact` solves this by applying all operations against a private working copy of the database, then taking only the *final resulting layer* and attaching it to the original. Ten operations, one new layer. Either all succeed and one layer appears, or nothing changes.

`what_if` is where immutability earns its keep. Because our database is a plain value — not a mutable object — you can freely simulate a transaction without ever risking the original. No "dry-run" flag, no rollback mechanism, no cleanup. You just don't store the result. The original database is untouched because values don't mutate.

## What Exists by the End of This Phase

- `transact(db, ops) → new_db`: applies a list of operations atomically and returns a new db with exactly one new layer, regardless of how many ops ran
- `what_if(db, ops) → result_db`: runs the same logic and returns the result, leaving the original db unchanged
- In Clojure: `transact` wraps the db in an `atom` and uses `swap!`; `what-if` runs the same reduce without `swap!`
- Historical queries: after N transactions, the db has N layers — reading `db.layers[T]` gives the snapshot at time T

## The Hard Parts

### The Squashing Mechanic

The core challenge is non-obvious. Each individual op — `add_entity`, `update_entity` — already appends its own layer when called. So if you naively apply two ops against a working copy of the database, you get two intermediate layers. But `transact` should produce exactly one.

The trick is to let the ops run freely against the working copy (accumulating intermediate layers), then discard every intermediate layer and graft only the *final layer* onto the original:

```python
def transact(db, ops):
    working = db
    for op in ops:
        working = op(working)
    final_layer = working.layers[-1]
    return replace(db, layers=db.layers + [final_layer],
                   top_id=working.top_id, curr_time=db.curr_time + 1)
```

This works because each layer is a complete snapshot — the final layer already carries the cumulative state of all ops. The intermediate layers were only ever scaffolding; the final one is all we need. Throwing them away is safe and intentional.

### `what_if` Is Almost Identical in Python

My first instinct was that `what_if` would need special treatment — maybe it needs to snapshot the state, run, then restore. But that's the mutable mindset.

In Python, `what_if` and `transact` are structurally the same. Both take `db`, run the ops, attach the final layer, and return a new value. The original `db` is unchanged in both cases — not because we protected it, but because Python never mutated it to begin with. The caller gets a new db value; whether they store it or discard it is entirely up to them.

The only mechanical difference is that `transact` increments `curr_time` (marking this as an official transaction timestamp), while `what_if` does not.

### The Atom Makes the Difference in Clojure

In Clojure, the distinction becomes concrete. The `atom` is a mutable reference to an immutable value. `swap!` atomically replaces what the atom points to; without it, the computation runs but the atom stays unchanged.

```clojure
(defn transact [db-atom ops]
  (swap! db-atom
         (fn [db]
           (let [working (reduce (fn [d op] (op d)) db ops)
                 final-layer (last (:layers working))]
             (assoc db
                    :layers (conj (:layers db) final-layer)
                    :top-id (:top-id working)
                    :curr-time (inc (:curr-time db)))))))

(defn what-if [db ops]
  (let [working (reduce (fn [d op] (op d)) db ops)
        final-layer (last (:layers working))]
    (assoc db
           :layers (conj (:layers db) final-layer)
           :top-id (:top-id working))))
```

`transact` takes a `db-atom`; `what-if` takes a plain `db`. That difference in the argument type is the entire mechanism. The logic inside is the same reduce.

## Key Insight

> Immutability makes "what-if" free. In a mutable system, speculative execution requires transaction savepoints, rollback logs, or copy-on-write machinery. Here, a "what-if" query is just a function call that returns a value — the original database is unchanged not because we protected it, but because values never change. This is how Datomic implements speculative queries with `with` — the database is a value, so branching from it costs nothing.

## Python vs Clojure

In Python, `transact` and `what_if` look nearly identical — both return a new db value, and the original is safe by default. The distinction is purely semantic: you use `transact` when you mean "persist this", and `what_if` when you mean "explore this". Neither the language nor the runtime enforces the difference.

In Clojure, the atom gives the distinction a concrete mechanism. `transact` takes a `db-atom` and calls `swap!`, atomically updating the shared reference. `what-if` takes a plain `db` value and returns a new one without touching any atom. The type signature itself tells you which operation you're doing — `db-atom` vs `db`. Python can't express this without extra convention; Clojure's model makes it structurally impossible to confuse the two.

## The Snippet

```python
def transact(db, ops):
    working = db
    for op in ops:
        working = op(working)
    final_layer = working.layers[-1]
    return replace(db, layers=db.layers + [final_layer],
                   top_id=working.top_id, curr_time=db.curr_time + 1)

def what_if(db, ops):
    working = db
    for op in ops:
        working = op(working)
    final_layer = working.layers[-1]
    return replace(db, layers=db.layers + [final_layer], top_id=working.top_id)
```

`transact` runs all ops against a private working copy, then grafts only the final layer onto the original db — N ops, one new layer. `what_if` is identical except it doesn't increment `curr_time`, signalling that this result is not an official transaction. The original `db` is unchanged in both cases.

## What's Next

With atomic, layered transactions in place, we can now ask the database questions — Phase 7 introduces query planning: how to choose which index to use given what you know and what you're looking for.


---

*The source code for this series is on GitHub: [minhmannh2001/circle-db](https://github.com/minhmannh2001/circle-db)*
