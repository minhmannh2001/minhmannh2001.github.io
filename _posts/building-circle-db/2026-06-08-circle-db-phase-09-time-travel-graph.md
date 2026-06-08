---
layout: post
title: "Building circle-db — Phase 9: Time-travel + Graph Traversal"
subtitle: "The data model already encoded history and the graph. This phase just reads what was always there."
tags: [database, clojure, python, learning]
readtime: true
gh-repo: minhmannh2001/circle-db
gh-badge: [star, fork]
---

## Two Capabilities, Zero New Data Structures

Think of a database like a series of photographs taken over time. Every time you update something, you don't throw away the old photo — you take a new one and keep all the old ones in an album. Each photo has a timestamp printed on it.

If you want to know what the database looked like last Tuesday, you just find the photo from that day. If you want to know the full history of one specific detail — say, Alice's phone number — you flip through all the photos and collect every version of that phone number you see. This is time-travel: no separate audit log, no event sourcing infrastructure. The album is your history, and it was already there.

Graph traversal is a different capability enabled by a different design decision. Because facts are stored as `(entity, attribute, value)` triples, and because some values are themselves entity IDs (references), the database is already a directed graph. Outgoing references are stored in the entity's own attributes; incoming references are pre-indexed in the VAET index — the only index built specifically for `:db/ref` attributes. "Who does Alice know?" and "Who knows Alice?" are both O(1) lookups, no graph library required.

The striking thing about this phase: both capabilities were already baked into the data model from earlier phases. This phase just adds the functions to read what was always there.

---

## What We Built

Five functions, two files:

**`time_travel.py`:**
- `advance_time(db) → db` — increment `curr_time` so subsequent updates get a new timestamp
- `evolution_of(db, entity_id, attr_name) → [(ts, value)]` — walk the `prev_ts` chain to collect every historical value of an attribute, in chronological order
- `db_at(db, t) → db` — return a database snapshot at timestamp `t`, usable directly with `q()`

**`graph.py`:**
- `outgoing_refs(db, entity_id) → [entity_id]` — entity IDs this entity references via `:db/ref` attrs
- `incoming_refs(db, entity_id) → [entity_id]` — entity IDs that reference this entity, via the VAET index

---

## Time Travel: The `prev_ts` Chain

Every `Attribute` in the database has two timestamp fields that have been there since Phase 5:

```python
@dataclass
class Attribute:
    name: str
    value: Any
    type: str
    cardinality: str
    ts: int = -1       # when this version was written
    prev_ts: int = -1  # the ts of the version that came before
```

When you update an attribute, the new version captures the old one's `ts` as its own `prev_ts`:

```python
new_attr = replace(old_attr, value=new_value, ts=curr_time, prev_ts=old_attr.ts)
```

This creates a linked list pointing backward through time. The current attr has `ts=3, prev_ts=2`. The version with `ts=2` lives in an earlier layer; it has `prev_ts=1`. And so on back to the first update.

`evolution_of` follows this chain:

1. Start at the current attr in `db.layers[-1].storage`
2. Collect `(ts, value)`, then look at `prev_ts`
3. Scan layers backward to find the attr version with that `ts`
4. Repeat until `prev_ts == -1` (no more history)
5. Reverse to get chronological order

A concrete example:

```python
db = make_db()
db = add_entity(db, Entity(id=":db/no-id-yet", attrs={"name": make_attr("Alice")}))

db = advance_time(db)                       # curr_time = 1
db = update_entity(db, 1, "name", "Bob")    # attr: ts=1, prev_ts=-1

db = advance_time(db)                       # curr_time = 2
db = update_entity(db, 1, "name", "Charlie") # attr: ts=2, prev_ts=1

db = advance_time(db)                       # curr_time = 3
db = update_entity(db, 1, "name", "Dave")  # attr: ts=3, prev_ts=2

evolution_of(db, 1, "name")
# → [(1, "Bob"), (2, "Charlie"), (3, "Dave")]
```

The initial value `"Alice"` is absent — it was never written with a real timestamp (`ts=-1`), so it's treated as the pre-history baseline.

---

## The `advance_time` Problem

The first thing that tripped me up: `curr_time` never changes on its own.

Looking at `db.py`, `update_entity` passes `db.curr_time` to the layer update but doesn't increment it:

```python
def update_entity(db, ent_id, attr_name, new_val, op="reset"):
    new_layer = update_entity_in_layer(db.layers[-1], ent_id, attr_name, new_val, op, db.curr_time)
    return replace(db, layers=db.layers + [new_layer])
```

So without any help, every update gets `ts=0`. Three updates → three attrs all with `ts=0`. The `prev_ts` chain becomes `0 → 0 → 0 → ...`, which loops forever.

The fix is `advance_time` — a one-liner that increments `curr_time`:

```python
def advance_time(db):
    return replace(db, curr_time=db.curr_time + 1)
```

Call it before each update when you want a distinct timestamp. This keeps time explicit rather than auto-advancing — the database doesn't assume anything about how time flows in your application.

---

## How `db_at` Finds the Right Layer

`db_at(db, t)` returns a `Database` where `layers[-1]` holds the state at timestamp `t`. Since `q()` always reads from `db.layers[-1]`, this is all you need for historical queries.

The challenge: layers don't carry their own timestamp. A layer is just a snapshot of all the indexes. There's no field saying "this layer was written at t=2."

The solution: infer the time from the data inside the layer. The most recent update in a layer is the one with the highest `attr.ts`. If that max `ts` is ≤ `t`, the layer is part of the historical snapshot we want.

```python
def db_at(db, t):
    result_idx = 0
    for i, layer in enumerate(db.layers):
        layer_max_ts = max(
            (a.ts for e in layer.storage.values() for a in e.attrs.values() if a.ts >= 0),
            default=-1,
        )
        if layer_max_ts <= t:
            result_idx = i
    return replace(db, layers=db.layers[:result_idx + 1])
```

Layers from `add_entity` have all attrs at `ts=-1` (no real timestamp), so `max(..., default=-1)` returns `-1` — which satisfies `<= t` for any `t >= 0`. Those layers are always included. Layers from later updates get excluded once their max `ts` exceeds `t`.

Once you have the historical db, you query it exactly like the present:

```python
q({"find": ["?e", "?v"], "where": [["?e", "name", "?v"]]}, db_at(db, 1))
# → [[1, "Bob"]]    ← the state at t=1, before "Charlie" and "Dave" were written
```

---

## Graph Traversal: Already Indexed

The two graph functions barely do anything — the work was already done by the indexes.

**Outgoing refs** — "what does this entity point to?" — comes from `storage`. Every entity's attrs are stored there with their types. Filter for `attr.type == ":db/ref"` and collect the values:

```python
def outgoing_refs(db, entity_id):
    entity = db.layers[-1].storage.get(entity_id)
    if not entity:
        return []
    refs = []
    for attr in entity.attrs.values():
        if attr.type == ":db/ref":
            if isinstance(attr.value, set):
                refs.extend(attr.value)
            else:
                refs.append(attr.value)
    return refs
```

**Incoming refs** — "what points to this entity?" — comes from VAET, the one index built exclusively for `:db/ref` attributes. VAET is structured as `vaet[referenced_entity_id][attr_name] = {referencing_entity_ids}`. Looking up who references entity 1 is a single dict lookup:

```python
def incoming_refs(db, entity_id):
    back_refs = db.layers[-1].vaet.get(entity_id, {})
    return list({e for eids in back_refs.values() for e in eids})
```

The same pattern appears in `remove_entity` from Phase 5 — that function already used VAET to check for back-references before allowing deletion. `incoming_refs` is just that same lookup, surfaced as a proper API.

---

## The Hard Part: What Isn't New

The hardest thing about this phase wasn't any single function — it was realizing that both features were already built. I expected to add new data structures for history (an audit table, a version list), and new storage for the graph (an adjacency list). Neither was needed.

The `prev_ts` chain in `Attribute` was planted in Phase 5's update path. The VAET index was built in Phase 3 specifically for `:db/ref` values. The layered immutable storage was the whole point of Phase 6.

This is what database design looks like when the data model is right: new capabilities require almost no new code. They're already latent in the structure. `evolution_of` is 20 lines of loop logic. `incoming_refs` is 2 lines. The rest is reading what was already indexed.

---

## Key Insight

> The `prev_ts` chain achieves time-travel with no extra storage — it's not a separate audit log, it's the write path itself. Every update already records where it came from. Combine that with immutable layers and you get a database that is, by construction, a complete history. Similarly, the VAET index turns a document store into a bidirectional graph database: incoming edges are pre-computed at write time, so graph traversal is no more expensive than any other index lookup. Both of these were design decisions made phases earlier, paying dividends now.

---

## Python vs Clojure

The Python `evolution_of` uses a `while` loop with mutable local state — `attr` gets reassigned each iteration as the chain is followed backward. Simple and readable. The Clojure version uses `loop`/`recur`, which makes the same logic purely functional: instead of mutating `attr`, each iteration passes the next attr as the loop binding. The accumulator `history'` is built up via `conj` rather than `append`. Both versions scan layers backward using the same idea — Python with `reversed()`, Clojure with `(reverse (:layers db))` inside `some`. Neither implementation is shorter; the Clojure version is slightly more verbose because `some` with an anonymous function is less terse than a `for` loop. The real difference is that `loop`/`recur` is explicitly tail-recursive and won't blow the stack on long histories — Python's `while` loop has the same property but for a different reason (it's iterative by nature, not recursive).

---

## The Snippet

```python
def evolution_of(db, entity_id, attr_name):
    entity = db.layers[-1].storage.get(entity_id)
    if not entity:
        return []
    attr = entity.attrs.get(attr_name)
    if not attr or attr.ts == -1:
        return []

    history = []
    while attr and attr.ts != -1:
        history.append((attr.ts, attr.value))
        prev_ts = attr.prev_ts
        if prev_ts == -1:
            break
        attr = None
        for layer in reversed(db.layers):
            candidate = layer.storage.get(entity_id)
            if candidate:
                a = candidate.attrs.get(attr_name)
                if a and a.ts == prev_ts:
                    attr = a
                    break

    history.reverse()
    return history
```

The loop has two jobs: collect the current value, then find the previous version by scanning layers backward for the attr with `ts == prev_ts`. The inner `for layer in reversed(db.layers)` is the key — it uses the `prev_ts` pointer as a key to find the matching historical snapshot. Because layers are immutable and each update creates a new one, the old version of the attr is always still there in an earlier layer, waiting to be found.

---

## What's Next

This is the final phase of circle-db — the project now has a complete EAV database with four indexes, full CRUD, transactions, query planning, query execution, time-travel, and bidirectional graph traversal, all from scratch in both Python and Clojure.


---

*The source code for this series is on GitHub: [minhmannh2001/circle-db](https://github.com/minhmannh2001/circle-db)*
