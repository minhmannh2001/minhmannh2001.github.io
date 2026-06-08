---
layout: post
title: "Building circle-db — Phase 7: Query Planning"
subtitle: "Every where-clause encodes a 'what I know vs. what I want' structure, and the indexes exist precisely to exploit it."
tags: [database, clojure, python, learning]
readtime: true
gh-repo: minhmannh2001/circle-db
gh-badge: [star, fork]
---

## Choosing the Right Card Catalog

Imagine you have a library with millions of books, and you want to find "all books written by Alice." You could walk every shelf and check each book's author — that works, but it's slow. A smarter approach: use the card catalog sorted by author. You jump straight to "Alice" and get a list.

Query planning is the database's equivalent of choosing which card catalog to open. Before executing any search, the planner looks at your question and asks: "which piece of information do I know, and which am I trying to find?" Depending on the answer, it picks the index that makes the lookup direct rather than a full scan.

In this database, every fact is stored as a triple: `(entity, attribute, value)`. Say we have three people:

```python
# Entity 1: Alice, age 30
# Entity 2: Bob, age 25
# Entity 3: Alice, age 28
```

Those facts live in the storage layer, but they're also indexed four different ways. Each index leads with a different field so lookups from any direction are fast. Here's what two of those indexes look like with the data above:

```python
# EAVT — keyed by entity → attribute → value
# "what are all the facts about entity 1?"
eavt = {
    1: {"name": "Alice", "age": 30},
    2: {"name": "Bob",   "age": 25},
    3: {"name": "Alice", "age": 28},
}

# AVET — keyed by attribute → value → set of entity IDs
# "which entities have name = Alice?"
avet = {
    "name": {"Alice": {1, 3}, "Bob": {2}},
    "age":  {30: {1}, 25: {2}, 28: {3}},
}
```

The plan phase picks the right door before anyone turns a handle. When the entity is unknown, use AVET (you know the attribute and value). When the value is unknown, use EAVT (you know the entity and attribute). When the attribute is unknown, use VEAT (you know the value and entity).

**Expressing a query as a clause**

To query the database, you describe what you're looking for as a 3-element list — one slot for each position in a Datom: `[entity_id, attr_name, value]`. Slots you already know get a concrete value. Slots you're trying to find get a variable — any string starting with `?`.

So if you want to find all entities named Alice, you know the attribute (`"name"`) and the value (`"Alice"`), but not the entity. You write:

```python
["?e", "name", "Alice"]
# slot 0 — unknown entity, call it ?e
# slot 1 — attribute is "name" (known)
# slot 2 — value is "Alice" (known)
```

This is called a **where-clause**. It mirrors the Datom structure exactly — the only difference is that unknown positions hold a variable instead of a real value.

**What `transform` does**

`transform` reads that clause and builds a test function — a predicate that, given any single Datom, answers "does this fact match?". Known slots become equality checks; unknown slots are ignored (anything passes).

```python
predicate = transform(["?e", "name", "Alice"])

# Entity 1 has name=Alice → passes (entity_id is ignored because ?e is a variable)
predicate(Datom(entity_id=1, attr_name="name", value="Alice"))  # True

# Entity 2 has name=Bob → fails on the value slot
predicate(Datom(entity_id=2, attr_name="name", value="Bob"))    # False

# Entity 3 also has name=Alice → passes
predicate(Datom(entity_id=3, attr_name="name", value="Alice"))  # True
```

That's it. `transform` doesn't know about indexes, doesn't do any lookups — it just converts a clause into a callable yes/no test. The index selection is entirely `plan`'s job.

## Three Queries, Three Indexes

Given the three entities above (Alice age 30, Bob age 25, Alice age 28), here are three different questions — each one pointing to a different index:

```python
layer = db.layers[-1]

# Q1: "Which entities are named Alice?" — entity is unknown (?e)
# plan sees: ?e is a variable → use AVET
plan_fn = plan([["?e", "name", "Alice"]], layer)
plan_fn()  # → {1, 3}   (AVET["name"]["Alice"])

# Q2: "What is entity 1's name?" — value is unknown (?v)
# plan sees: ?v is a variable → use EAVT
plan_fn = plan([[1, "name", "?v"]], layer)
plan_fn()  # → "Alice"  (EAVT[1]["name"])

# Q3: "Which attributes of entity 1 equal 'Alice'?" — attr is unknown (?a)
# plan sees: ?a is a variable → use VEAT
plan_fn = plan([[1, "?a", "Alice"]], layer)
plan_fn()  # → {"name"} (VEAT["Alice"][1])
```

Each call to `plan` returns a zero-argument closure — a ready-made lookup that captures the index and the known constants. Nothing is executed yet; `plan_fn()` is the moment the index is actually queried.

## When Two Positions Are Unknown: Range Scans

The three cases above each have **one** unknown variable — so `plan` knows both keys needed for a direct point lookup into the index. But what if two positions are unknown?

Say you want to know "what are all the names in the database?" — you know the attribute (`"name"`) but neither the entity nor the value:

```python
["?e", "name", "?v"]   # entity AND value are unknown
```

A point lookup `avet["name"]["?v"]` would search for the literal string `"?v"` in the index — returning an empty set. The correct move is to stop one level higher and return the entire sub-dict:

```python
# Instead of avet["name"]["?v"]  ← wrong, treats "?v" as a real key
# Do:
avet["name"]           # → {"Alice": {1, 3}, "Bob": {2}}
```

This is called a **range scan** — you know one key, so you get back everything under it. The same logic applies to the other two cases:

```python
# Only entity known → EAVT range
plan_fn = plan([[1, "?a", "?v"]], layer)
plan_fn()  # → {"name": "Alice", "age": 30}   (eavt[1])

# Only attr known → AVET range
plan_fn = plan([["?e", "name", "?v"]], layer)
plan_fn()  # → {"Alice": {1, 3}, "Bob": {2}}  (avet["name"])

# Only value known → VEAT range
plan_fn = plan([["?e", "?a", "Alice"]], layer)
plan_fn()  # → {1: {"name"}, 3: {"name"}}     (veat["Alice"])
```

The number of unknown variables determines the depth of the index lookup:
- **1 unknown** → go to the leaf → single value or set
- **2 unknowns** → stop one level up → return the whole sub-dict

## What Exists by the End of This Phase

- `transform(clause)`: converts a 3-element where-clause into a callable predicate over a Datom
- `plan(clauses, layer)`: inspects which position in the clause is a variable and returns a closure that queries the correct index
- Predicate logic: variable slots match any value; constant slots require an exact equality match
- Index selection rules: entity unknown → AVET; value unknown → EAVT; attribute unknown → VEAT
- Tests in Python and Clojure confirming that transform predicates accept matching datoms and reject non-matching ones, and that plan closures pull from the right index

## The Hard Parts

### Clojure's Indexes Use Keywords, Not Strings

In Clojure, there are two distinct types that look similar but are not interchangeable: strings (`"name"`) and keywords (`:name`). Keywords are Clojure's native identifiers — they're used as map keys everywhere in idiomatic Clojure, the way Python uses strings.

When an entity is stored with `{:attrs {:name (make-attr "Alice")}}`, the key in the attrs map is `:name` (a keyword). That keyword flows through `add-entity-to-layer` and ends up as the attr-name in every datom written to the indexes. So the AVET index in Clojure looks like this:

```clojure
;; Clojure AVET — attr keys are keywords
{:name {"Alice" #{1 3}, "Bob" #{2}}
 :age  {30 #{1}, 25 #{2}, 28 #{3}}}
```

Not like this:

```clojure
;; Wrong expectation — string keys don't exist here
{"name" {"Alice" #{1 3}}}  ; this key is never in the index
```

So when I wrote the first test:

```clojure
(q/plan [["?e" "name" "Alice"]] layer)  ; "name" is a string
```

The plan closure tried to do `(get-in layer [:avet "name" "Alice"])` — looked up a string key in a map that only has keyword keys. Result: `#{}` (empty set). No exception, no warning about the mismatch. Just silence.

The fix is to use a keyword in the clause:

```clojure
(q/plan [["?e" :name "Alice"]] layer)   ; :name is a keyword ✓
```

The lesson: when debugging "returned nothing" in Clojure, the first thing to check is whether your map keys are strings or keywords. They look almost identical, but `(= "name" :name)` is `false`.

### Don't Name Your Function `var?` in Clojure

`var?` is already a built-in Clojure function — it's part of `clojure.core` and does something completely unrelated to query variables. Defining your own `var?` doesn't crash anything, but Clojure does warn you:

```
WARNING: var? already refers to: #'clojure.core/var? in namespace: circle-db.query,
being replaced by: #'circle-db.query/var?
```

The function still runs correctly. The problem is the name: anyone reading the code later would see `var?` and assume it means what it normally means in Clojure — not "is this a query variable starting with `?`". Renaming to `qvar?` costs one extra character and removes the confusion entirely:

```clojure
;; Before — name collides with a built-in
(defn- var? [x]
  (and (string? x) (.startsWith x "?")))

;; After — intent is clear
(defn- qvar? [x]
  (and (string? x) (.startsWith x "?")))
```

### Transform and Plan Are Deliberately Separate

A real query rarely has just one clause. Say you want "all entities named Alice who are 30 years old":

```python
clauses = [
    ["?e", "name", "Alice"],   # clause 1
    ["?e", "age",  30],        # clause 2 — same ?e
]
```

Here's how the two steps work together to answer that:

**Step 1** — use `plan` on clause 1 to fetch initial candidates from AVET:
```python
plan_fn = plan([["?e", "name", "Alice"]], layer)
candidates = plan_fn()   # → {1, 3}  (both Alices)
```

**Step 2** — for each candidate, use the predicate from `transform` on clause 2 to keep only the ones that also satisfy the age condition:
```python
predicate = transform(["?e", "age", 30])
survivors = {e for e in candidates
             if predicate(Datom(entity_id=e, attr_name="age", value=layer.eavt[e]["age"]))}
# entity 1: age=30 → True  ✓
# entity 3: age=28 → False ✗
# survivors = {1}
```

This works because `plan` returns a raw set and `transform` returns a standalone test — they're two separate tools that the executor can combine however it wants. If `plan` had already baked the filtering in and returned only `{1}` directly, there would be no way to apply the second clause's logic — it would all have to be inside one sealed function.

## Key Insight

> The planner's job is to eliminate the full scan before it happens. Given `["?e", "name", "Alice"]`, a naive engine would scan every datom and apply the predicate. The planner notices that entity is the unknown — so it knows both the attribute and the value — and routes directly to AVET, which is keyed by attribute then value. The result is the exact set of entity IDs with `name=Alice`, retrieved in two dictionary lookups instead of a full scan:
>
> ```python
> avet["name"]["Alice"]  # → {1, 3}
> ```
>
> The insight is that every where-clause encodes a "what I know vs. what I want to find" structure, and the indexes exist precisely to exploit it.

## Python vs Clojure

The logic is identical in both languages. The difference shows up in how `plan` is written.

**Python:**

```python
def plan(clauses, layer):
    clause = clauses[0]          # manually pull the first clause
    entity, attr, value = clause

    if _is_var(entity):
        def plan_fn():           # three separate inner functions
            return layer.avet.get(attr, {}).get(value, set())
    elif _is_var(value):
        def plan_fn():
            return layer.eavt.get(entity, {}).get(attr)
    else:
        def plan_fn():
            return layer.veat.get(value, {}).get(entity, set())

    return plan_fn
```

**Clojure:**

```clojure
(defn plan [[clause & _] layer]   ; destructure: clause = first, _ = rest (ignored)
  (let [[entity attr value] clause]
    (cond
      (qvar? entity) (fn [] (get-in layer [:avet attr value] #{}))
      (qvar? value)  (fn [] (get-in layer [:eavt entity attr]))
      :else          (fn [] (get-in layer [:veat value entity] #{})))))
```

Two things are noticeably different:

- **Destructuring in the signature** — `[clause & _]` pulls the first clause off the list directly in the function signature. Python has to do it manually with `clause = clauses[0]` inside the body.
- **`cond` vs if/elif** — in Python, each branch needs its own `def plan_fn():` block. In Clojure, each `cond` branch is just an inline expression `(fn [] ...)` sitting right next to its condition — less ceremony, same result.

## The Snippet

```python
def transform(clause):
    entity, attr, value = clause

    def predicate(datom):
        if not _is_var(entity) and datom.entity_id != entity:
            return False
        if not _is_var(attr) and datom.attr_name != attr:
            return False
        if not _is_var(value) and datom.value != value:
            return False
        return True

    return predicate
```

`transform` converts a clause into a yes/no function over a single Datom. Constants become equality guards that short-circuit on mismatch; variables are skipped entirely. The predicate knows nothing about indexes — it's just a filter, and keeping it separate from `plan` is the point.

## What's Next

Phase 8 takes the plan closures and predicates built here and wires them together into a full query executor — running the index lookup, filtering results, and joining multiple clauses into a final answer set.


---

*The source code for this series is on GitHub: [minhmannh2001/circle-db](https://github.com/minhmannh2001/circle-db)*
