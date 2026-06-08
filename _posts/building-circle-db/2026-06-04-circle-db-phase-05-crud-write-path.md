---
layout: post
title: "Building circle-db — Phase 5: CRUD Write Path"
subtitle: "Every write must update storage and all four indexes atomically — not just the data, but every path into the data."
tags: [database, clojure, python, learning]
readtime: true
gh-repo: minhmannh2001/circle-db
gh-badge: [star, fork]
---

## A History Book That Can Never Be Erased

Think of a database as a history book that can never be erased. When you want to change some information — say, updating a customer's address — instead of erasing and rewriting, you add a new page recording the latest state. The old page stays exactly as it was.

That is how the CRUD write path works here. Every write operation — adding an entity, updating an attribute, or removing an entity — produces a new `Layer` appended to the database's layer list. The original database is never touched. This is immutability at the database level.

The critical constraint: every write must update **all four indexes at once**. If any index drifts out of sync with storage, every query that relies on that index will silently return wrong results. "Consistency" here means: after any write, storage and all four indexes reflect the same truth at the same time.

## What Exists by the End of This Phase

- `add_entity(db, entity) → new_db`: accepts an entity with `id=":db/no-id-yet"`, auto-assigns an incrementing ID, writes to storage and all 4 indexes, returns a new Database
- `update_entity(db, ent_id, attr_name, new_val, op="reset") → new_db`: updates an attribute's value and timestamps; `op="reset"` replaces, `op="add"/"remove"` for multi-valued attributes
- `remove_entity(db, ent_id) → new_db`: removes entity from storage and all indexes; raises `ValueError` if any other entity still references it

## The Hard Parts

### `:db/multiple` and the Unhashable Dict Key

My first instinct was to treat multi-valued attributes the same way as single-valued ones — just pass the value directly as a key into AVET and VEAT. For `:db/single` this works fine: the value is a string or number, perfectly hashable. But for `:db/multiple`, the value is a Python `set`, and Python does not allow sets as dict keys.

The error appeared the moment I wrote the first `:db/multiple` test:

```
TypeError: unhashable type: 'set'
```

To see why, consider entity 1 with a `tags` attribute of cardinality `:db/multiple`:

```python
attr = Attribute(name="tags", value={"python", "clojure"}, cardinality=":db/multiple")
entity = Entity(id=1, attrs={"tags": attr})
```

With the naive approach — one datom for the whole value — `add_entity_to_layer` would try to index into AVET like this:

```python
# AVET structure: attr → value → set(entity_ids)
avet["tags"][{"python", "clojure"}] = {1}   # ❌ set is not hashable
```

The fix: expand each element into a separate datom. Instead of one datom with `value={"python", "clojure"}`, produce two datoms — one with `value="python"`, one with `value="clojure"`:

```python
# EAVT: stores the full set (never used as a dict key)
eavt[1]["tags"] = {"python", "clojure"}      # ✓

# AVET: each element indexed individually
avet["tags"]["python"]   = {1}               # ✓
avet["tags"]["clojure"]  = {1}               # ✓

# VEAT: same
veat["python"][1]  = {"tags"}               # ✓
veat["clojure"][1] = {"tags"}               # ✓
```

The one-liner that makes this work:

```python
def _iter_values(value):
    return value if isinstance(value, set) else [value]
```

This is exactly what the reference Clojure does via `collify` — but in Clojure, sets are persistent and immutable and therefore hashable, so the bug never surfaces. The indexing strategy is identical; the language hides the constraint.

### Two Separate VAET Cleanup Passes, Two Different Directions

VAET answers: **"which entities reference entity X?"** Its structure is `vaet[target_id][attr_name] = set(referencing_ids)`.

Because `remove_entity` enforces referential integrity (raises if any entity still references the target), by the time cleanup runs, **all referencing entities have already been deleted**. That means `vaet[entity_id]` at deletion time only contains empty sets — the references were drained by earlier deletes.

Start with this setup:

```python
# entity 1: no ref attrs
# entity 2: friend → 1,  knows → 3
# entity 3: mentor → 1

vaet = {
    1: {"friend": {2}, "mentor": {3}},   # entities 2 and 3 point at entity 1
    3: {"knows":  {2}},                  # entity 2 points at entity 3
}
```

To delete entity 1, the caller must first delete 2 and 3 (in valid order). Each deletion drains the sets:

```python
# delete entity 2 (has friend→1, knows→3):
vaet[1]["friend"] = {2} - {2} = set()
vaet[3]["knows"]  = {2} - {2} = set()

# delete entity 3 (has mentor→1):
vaet[1]["mentor"] = {3} - {3} = set()

# vaet now — all sets empty, entity 1 has no incoming refs:
vaet = {
    1: {"friend": set(), "mentor": set()},   # empty shell
    3: {"knows": set()},
}
```

Now `remove_entity(db, 1)` passes the constraint check (no live references). The cleanup then drops the empty shell:

```python
new_vaet = {k: v for k, v in new_vaet.items() if k != entity_id}
# removes vaet[1] = {"friend": set(), "mentor": set()}

# result:
vaet = {3: {"knows": set()}}
```

The cleanup is not removing live data — it's dropping a key whose sets are already empty. Without it, `vaet[1]` would linger as a ghost entry even after the entity is gone.

In code, the EAVT cleanup line does the same thing — `eavt_remove` leaves `{entity_id: {}}` behind after all attrs are removed, and the cleanup drops it:

```python
new_eavt = {k: v for k, v in new_eavt.items() if k != entity_id}
new_vaet = {k: v for k, v in new_vaet.items() if k != entity_id}
```

### Referential Integrity: Raise Instead of Silently Cascade

The reference Clojure implementation silently cascades deletes — when you delete entity 1, it finds all entities referencing it via VAET and removes those ref values automatically. Convenient, but invisible.

I chose a stricter approach: **treat it like a foreign key constraint**. If you try to delete an entity that is still referenced by another, `remove_entity` raises immediately:

```python
def remove_entity(db, ent_id):
    back_refs = db.layers[-1].vaet.get(ent_id, {})
    referencing = {e for entities in back_refs.values() for e in entities}
    if referencing:
        raise ValueError(f"Entity {ent_id} still referenced by entities {referencing}")
    ...
```

The caller must delete or update the referencing entities first. This forces the dependency order to be explicit — no side effects hidden inside a single call.

### New Layer Must Inherit from the Previous One

In my first implementation of `add_entity`, I built from a fresh empty `Layer()` instead of starting from `db.layers[-1]`. The first test passed — it only added one entity. The two-entity test exposed the bug: the first entity had vanished from the new layer's storage.

```python
# WRONG
new_layer = add_entity_to_layer(Layer(), fixed_entity)

# RIGHT
new_layer = add_entity_to_layer(db.layers[-1], fixed_entity)
```

The fix is one word. The lesson is why you need a test that adds two entities sequentially and checks both exist — not just one.

## Key Insight

> Every write must update storage and all four indexes atomically, and must do so on top of the current layer — not on a blank layer, not directly on the existing one. This is what "consistency" actually means: not just that the data is correct, but that *every path into the data* is correct at the same time. If AVET says entity 1 has `name="Alice"` but storage says entity 1 was deleted, the database is inconsistent — and there is no way to detect that from the outside until a query returns a wrong answer.

## Python vs Clojure

Clojure felt more natural at two points. First, the threading macros `->` and `as->` let you chain layer transformations into a single top-to-bottom flow without intermediate variable names like `new_eavt`, `new_avet`. Second, `cond->` applies a step conditionally without breaking the chain — replacing the `if` block in Python that forces you to exit the flow.

In Python, `layer_update.py` needs two separate `for` loops (remove old values from indexes, then add new values). The Clojure version folds both into `reduce` calls inside `as->`, which is more compact — but requires comfort with the threading idiom to read at a glance.

## The Snippet

```python
def _iter_values(value):
    return value if isinstance(value, set) else [value]

def add_entity_to_layer(layer, entity):
    new_storage = add_entity(layer.storage, entity)
    new_eavt, new_avet, new_veat, new_vaet = layer.eavt, layer.avet, layer.veat, layer.vaet
    for attr_name, attr in entity.attrs.items():
        new_eavt = eavt_add(new_eavt, Datom(entity_id=entity.id, attr_name=attr_name, value=attr.value))
        for v in _iter_values(attr.value):
            datom = Datom(entity_id=entity.id, attr_name=attr_name, value=v)
            new_avet = avet_add(new_avet, datom)
            new_veat = veat_add(new_veat, datom)
            if attr.type == ":db/ref":
                new_vaet = vaet_add(new_vaet, datom)
    return replace(layer, storage=new_storage, eavt=new_eavt, avet=new_avet, veat=new_veat, vaet=new_vaet)
```

EAVT receives the full set as the value because it answers "what is the value of this attribute?" — and for `:db/multiple`, the answer is the whole set. But AVET and VEAT need to hash each value as a dict key, so each element must be indexed individually. `_iter_values` is the hinge: one line that separates the two indexing strategies.

## What's Next

Phase 6 introduces transactions and layered history — instead of each write immediately producing a layer, multiple operations are grouped into a single transaction and only commit one layer when all succeed.


---

*The source code for this series is on GitHub: [minhmannh2001/circle-db](https://github.com/minhmannh2001/circle-db)*
