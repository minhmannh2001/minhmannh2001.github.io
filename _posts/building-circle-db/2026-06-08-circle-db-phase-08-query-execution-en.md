---
layout: post
title: "Building circle-db — Phase 8: Query Execution"
subtitle: "AND semantics across where-clauses is just set intersection — no cartesian product, no nested loop join."
tags: [database, clojure, python, learning]
readtime: true
gh-repo: minhmannh2001/circle-db
---

## What Does a Query Look Like?

Before anything else, let's establish what the query language looks like in this database. A query is just a Python dict with two keys:

```python
{
    "find":  ["?e", "?name"],   # what you want back
    "where": [
        ["?e", "name", "Alice"],   # condition 1
        ["?e", "age",  30],        # condition 2
    ]
}
```

**`where`** is a list of conditions. Each condition is a 3-element list that mirrors how facts are stored: `[entity_id, attribute_name, value]`. Any slot you don't know yet gets a **variable** — a string starting with `?`. In the first condition above, `?e` means "I don't know the entity ID yet — that's what I'm looking for."

**`find`** tells the database which variables you actually care about in the output. The database might compute more variables along the way, but only the ones listed in `find` end up in the result rows.

So the query above means: *"find me the entity ID and name of every entity that is named Alice AND is 30 years old."*

---

## What We Had vs. What We Need

Phase 7 built two pieces. **Transform** takes one where-clause and builds a predicate — a yes/no function that tests whether a single fact matches. **Plan** inspects the same clause, figures out which index to use (e.g., AVET when the entity is the unknown), and wraps the lookup in a zero-argument closure:

```python
# Plan for ["?e", "name", "Alice"]: entity is unknown → use AVET
plan_fn = plan([["?e", "name", "Alice"]], layer)
plan_fn()  # → {1, 3}   (the set of entity IDs named Alice)
```

That's useful for a single clause. But a query can have several conditions — and all of them must be true at the same time. Calling `plan_fn()` for each clause gives us separate candidate sets. We still need to:

1. **Combine** those sets — keep only entities that satisfy every condition
2. **Name the results** — map surviving entity IDs back to the variable names the query used (`?e`, `?name`, ...)
3. **Shape the output** — extract only the variables listed in `find`, in the right order

This phase adds two functions that handle steps 1–3:

- **Execute** — runs a plan for each where-clause, combines the candidate sets with AND logic, and returns a list of dicts mapping variable names to their values (e.g. `[{"?e": 1, "?name": "Alice"}]`)
- **Unify** — takes those dicts and trims them to only the `find` variables in the right order, producing the final rows (e.g. `[[1, "Alice"]]`)

Put it all together and we get `q(query, db)` — the single function that answers any query end-to-end.

---

## The Full Picture: Four Steps, One Function

Before diving in, here's how the four stages connect when you call `q`:

```
Input query
    │
    ▼
Transform  →  for each where-clause, build a predicate (does datom X match?)
    │
    ▼
Plan       →  for each where-clause, pick the fastest index and wrap it in a closure
    │
    ▼
Execute    →  run each closure, combine results with AND logic, collect variable bindings
    │
    ▼
Unify      →  keep only the variables the caller asked for, in the right order
    │
    ▼
[[row1], [row2], ...]
```

Phases 1 and 2 (Transform and Plan) were built in Phase 7. This phase builds 3 and 4.

---

## A Concrete Example to Follow

Let's say we have three people in the database:

| Entity ID | name  | age |
|-----------|-------|-----|
| 1         | Alice | 30  |
| 2         | Bob   | 25  |
| 3         | Alice | 25  |

We want to ask: **"give me all entities that are named Alice AND are 30 years old."**

In query form:

```python
q(
    {
        "find":  ["?e"],
        "where": [
            ["?e", "name", "Alice"],   # clause 1: ?e must be named Alice
            ["?e", "age",  30],        # clause 2: ?e must be aged 30
        ]
    },
    db
)
# Expected result: [[1]]
# Entity 1 is the only Alice who is 30. Entity 3 is Alice but age 25.
```

We'll trace exactly what happens inside `q` to produce `[[1]]`.

---

## Step 1 — Execute: Run Each Clause, Collect Candidates

For each where-clause, execute calls `plan` internally to get the index lookup closure, then runs it:

**Clause 1**: `["?e", "name", "Alice"]` — entity is the unknown, so use AVET (attribute → value → entity IDs):

```python
# AVET stores: attr → value → set of entity IDs
avet["name"]["Alice"]   # → {1, 3}
```

Both entity 1 and entity 3 are named Alice. Both are candidates.

**Clause 2**: `["?e", "age", 30]` — same pattern, entity is unknown, use AVET:

```python
avet["age"][30]   # → {1}
```

Only entity 1 has age 30.

Now we have two sets of candidates, one per clause:

```
Clause 1 gave us: {1, 3}   — "these entities are named Alice"
Clause 2 gave us: {1}      — "these entities are 30 years old"
```

**The AND logic is just set intersection** — keep only the entity IDs that appear in ALL sets:

```python
{1, 3} ∩ {1}   →   {1}
```

Entity 1 is the only survivor. It satisfies both clauses.

Finally, execute wraps each surviving entity ID in a dictionary — a **binding map** — that names which variable holds that value:

```python
# surviving_ids = {1}
# entity_var = "?e"

result = [{"?e": 1}]
```

A binding map is just a dict from variable name to its current bound value. Think of it as one row of partial results, still in "named columns" form.

---

## Step 2 — Unify: Trim to the Find Variables

The caller asked for `"find": ["?e"]`. Unify goes through each binding map and extracts only the requested variables, in the listed order:

```python
bindings = [{"?e": 1}]
find_vars = ["?e"]

# For each binding map, pick out the find vars in order:
[[1]]   # ← final result
```

The result is a list of rows, where each row is a list of values. This matches what most query APIs return — column-ordered rows.

**Order matters.** If the find clause had `["?name", "?e"]`, unify would return `[["Alice", 1]]` — name first, entity second — regardless of the order inside the binding map.

---

## What Happens When a Value Is Also a Variable?

So far, clause 1 had a constant value (`"Alice"`). What if the value is also a variable?

```python
["?e", "name", "?name"]   # both entity and name are unknown
```

Here, the plan returns a **range scan** — the entire sub-dict for `"name"` in AVET:

```python
avet["name"]
# → {"Alice": {1, 3}, "Bob": {2}}
```

This dict is not a flat set of entity IDs — it's a nested structure mapping each value to the set of entities that have that value. Execute has to peel through both levels:

```python
# For val="Alice", eids={1, 3}:
#   entity 1 → bind "?name" = "Alice"
#   entity 3 → bind "?name" = "Alice"
# For val="Bob", eids={2}:
#   entity 2 → bind "?name" = "Bob"
```

At the end, execute has:
- Entity ID set: `{1, 2, 3}` (for the AND intersection with other clauses)
- Binding side-table: `{1: {"?name": "Alice"}, 2: {"?name": "Bob"}, 3: {"?name": "Alice"}}`

After the intersection (say this is the only clause), all three survive. Their binding maps are:

```python
[
    {"?e": 1, "?name": "Alice"},
    {"?e": 2, "?name": "Bob"},
    {"?e": 3, "?name": "Alice"},
]
```

The key insight: **the range scan that found entity IDs simultaneously produced the value binding.** No second index lookup needed — both `?e` and `?name` were resolved in one sweep of AVET.

---

## What If the Attribute Is Also Unknown?

So far the `?` was always in the entity or value slot. What about a query where the attribute is also unknown?

```python
["?e", "?a", "Alice"]   # entity unknown, attribute unknown, value known
```

This means: *"find all entities that have any attribute with value Alice — and tell me which attribute it is."* Plan routes this to the VEAT index (value → entity → attr names):

```python
veat["Alice"]
# → {1: {"name"}}     entity 1 has an attribute "name" = "Alice"
```

The raw result is a dict from entity ID to a **set of attribute names** — the third distinct shape that execute has to handle.

The complication: one entity can have multiple attributes with the same value. Say entity 1 has both `name = "Alice"` and `nickname = "Alice"`:

```python
veat["Alice"]
# → {1: {"name", "nickname"}}
```

We need to produce **two rows** from entity 1 — `[1, "name"]` and `[1, "nickname"]`. That means `var_bindings` can't be a simple `{eid: {var: val}}` dict — one entity needs to map to multiple partial rows.

The solution: `var_bindings` stores a **list** of partial binding dicts per entity:

```python
var_bindings = {}  # entity_id → [{var_name: value}, ...]
```

For entity 1 with attrs `{"name", "nickname"}`:

```python
attr = "?a"                      # the variable name from the clause
attrs = {"name", "nickname"}     # attrs that entity 1 has with value "Alice"

new_partials = [{"?a": "name"}, {"?a": "nickname"}]
var_bindings[1] = new_partials   # two rows, not one
```

Each attribute name becomes its own partial binding dict — one per future output row.

**Case 1 — entity seen for the first time (`else` branch):**

```python
# Entity 1 not yet in var_bindings → just store the list
var_bindings[1] = [{"?a": "name"}, {"?a": "nickname"}]
```

**Case 2 — entity already has bindings from a prior clause (`if` branch):**

Say a previous clause already produced:

```python
var_bindings[1] = [{"?name": "Alice"}]   # one existing row
```

Now this clause adds two possible attrs. We need to combine them — every existing row paired with every new attr:

```python
if eid in var_bindings:
    var_bindings[eid] = [
        {**existing, **new_p}
        for existing in var_bindings[eid]   # [{"?name": "Alice"}]
        for new_p in new_partials            # [{"?a": "name"}, {"?a": "nickname"}]
    ]
# → [
#     {"?name": "Alice", "?a": "name"},
#     {"?name": "Alice", "?a": "nickname"},
#   ]
```

This is a cross-product of two lists. In general: `len(existing rows) × len(new_partials)` rows come out.

| existing rows | new_partials | output rows |
|---|---|---|
| `[{"?name": "Alice"}]` | `[{"?a": "name"}, {"?a": "nick"}]` | 2 rows |
| `[{"?x": "v1"}, {"?x": "v2"}]` | `[{"?a": "name"}, {"?a": "nick"}]` | 4 rows |
| (none — first clause) | `[{"?a": "name"}]` | 1 row |

The final assembly iterates this list — each partial becomes a separate output row:

```python
for eid in surviving_ids:
    base = {entity_var: eid}
    for partial in var_bindings.get(eid, [{}]):
        result.append({**base, **partial})

# For eid=1 with var_bindings[1] = [{"?a": "name"}, {"?a": "nickname"}]:
# → {"?e": 1, "?a": "name"}
# → {"?e": 1, "?a": "nickname"}
```

The `[{}]` fallback handles entities that only appeared in point-lookup clauses — they have no extra variables, so they contribute exactly one row with just the entity ID.

---

## Combining Both: A Two-Variable Query

Now let's combine everything. We want names and entity IDs for all Alice-aged-30 entities:

```python
q(
    {
        "find":  ["?e", "?name"],
        "where": [
            ["?e", "name", "?name"],   # clause 1: range scan, binds both ?e and ?name
            ["?e", "age",  30],        # clause 2: point lookup, restricts ?e to {1}
        ]
    },
    db
)
```

Execute processes each clause:

| Clause | Raw result | Entity IDs | Value bindings |
|--------|-----------|------------|----------------|
| `["?e", "name", "?name"]` | `{"Alice": {1,3}, "Bob": {2}}` | `{1, 2, 3}` | `{1: {"?name":"Alice"}, 2: {"?name":"Bob"}, 3: {"?name":"Alice"}}` |
| `["?e", "age", 30]` | `{1}` | `{1}` | (none — value is a constant) |

Intersection: `{1, 2, 3} ∩ {1}` = `{1}`

Surviving binding maps (merged for entity 1):

```python
[{"?e": 1, "?name": "Alice"}]
```

Unify with `find = ["?e", "?name"]`:

```python
[[1, "Alice"]]
```

---

## Time Travel for Free

Every time you call `add_entity`, the database grows a new **immutable layer**. The latest state is always at `db.layers[-1]`. The old layers stay unchanged.

`q` uses `db.layers[-1]` as the snapshot to query against. That one line is all the time-travel machinery you need — if you save a reference to an older database value and pass it to `q`, it queries the state at that moment:

```python
db = make_db()
db = add_entity(db, ...)  # Entity 1 added — Alice

old_db = db               # ← capture the state right here

db = add_entity(db, ...)  # Entity 2 added — Bob

# Current state has both Alice and Bob
q({"find": ["?e", "?name"], "where": [["?e", "name", "?name"]]}, db)
# → [[1, "Alice"], [2, "Bob"]]

# old_db's layers[-1] only knows about Alice
q({"find": ["?e", "?name"], "where": [["?e", "name", "?name"]]}, old_db)
# → [[1, "Alice"]]
```

`old_db` is not a snapshot we manually created — it's just the value that `db` held at the moment we assigned it. Because the database is immutable, that value is frozen forever. No `copy()`, no serialisation, no explicit versioning API.

---

## The Hard Parts

### The Plan Closure Doesn't Know Its Variable Names

My first instinct was to write execute as `execute(plan_fn, layer)` — take the closure from Phase 7, call it, get a set, wrap in binding maps.

The problem showed up immediately: `plan_fn()` for `["?e", "name", "Alice"]` returns `{1, 3}`. That's just a set of integers. Nothing in that set says "this is the value of a variable called `?e`."

The plan closure captured `attr="name"` and `value="Alice"` — the constants it needs for the index lookup. But `"?e"` is the *variable name*, and the index lookup doesn't need it at all. So it was never captured.

To build `{"?e": 1}`, execute has to look back at the original clause. That's why it takes the full `clauses` list, not just a plan_fn. Each clause is paired with its raw result so the variable names can be recovered:

```python
for clause in clauses:
    e, attr, v = clause   # e might be "?e" — that's the variable name we need
    plan_fn = plan([clause], layer)
    raw = plan_fn()
    # now we know: entity_var = "?e", and raw = {1, 3}
    # we can build: [{"?e": 1}, {"?e": 3}]
```

### Range Scans: Flattening Too Early Loses the Value Binding

For `["?e", "name", "?name"]`, the plan returns:

```python
{"Alice": {1, 3}, "Bob": {2}}
```

I briefly considered just flattening it to get all entity IDs:

```python
# WRONG approach:
ids = set()
for val, eids in raw.items():
    ids.update(eids)
# ids = {1, 2, 3} ← correct entity IDs, but we lost "?name"
```

This gives the right entity IDs for the intersection — but `?name` is now gone. The binding map for entity 1 would be `{"?e": 1}` with no `?name` at all.

The fix: collect entity IDs and save the value in a side table at the same time, then merge the side table into the final binding maps after intersection.

### One Entity, Multiple Rows

A trickier problem appeared when adding attr-unknown queries like `["?e", "?a", "Alice"]`. The VEAT index can return:

```python
{1: {"name", "nickname"}}   # entity 1 has two attributes both equal to "Alice"
```

A single dict-per-entity binding (`{1: {"?a": "name"}}`) would silently drop `"nickname"`. The fix: `var_bindings` stores a **list** of partial dicts per entity — one entry per possible row:

```python
var_bindings = {}  # entity_id → [{var_name: value}, ...]
```

When a later clause adds more bindings to an entity that already has rows, the new partials are cross-producted in rather than merged flat:

```python
if eid in var_bindings:
    var_bindings[eid] = [
        {**existing, **new_p}
        for existing in var_bindings[eid]
        for new_p in new_partials
    ]
else:
    var_bindings[eid] = new_partials
```

The AVET range-scan branch uses the same list shape — it just always produces exactly one partial per entity (one value per attr name), so the list has length 1.

---

## Key Insight

> AND semantics across where-clauses is just set intersection. Each clause independently maps to a set of entity IDs. The answer is the intersection of all those sets. There is no cartesian product, no nested loop join — just `set.intersection(*entity_sets)`. This is both the power and the limitation of the EAV model: simple AND queries are O(smallest clause result), but OR and negation require different machinery not present here.

This is meaningfully different from SQL. In SQL, joining two tables on a shared key produces a cartesian product first, then filters. In an EAV database with good indexes, each clause independently narrows the candidate set — and you combine with intersection, never with a product.

---

## Python vs Clojure

The core logic is identical in both languages. The difference is in how state is accumulated across the clause loop.

Execute now has three clause branches instead of two — point lookup, AVET range scan, and VEAT range scan. The shape of the logic is the same in both languages; the difference is in how state is accumulated across the clause loop.

**Python** mutates two local variables inside a `for` loop:

```python
entity_sets = []
var_bindings = {}  # entity_id → [{var_name: value}, ...]

for clause in clauses:
    e, attr, v = clause
    raw = plan([clause], layer)()

    if not _is_var(v) and not _is_var(attr):
        entity_sets.append(raw or set())                  # point lookup
    elif _is_var(v) and not _is_var(attr):
        # AVET range scan: {val: {entity_ids}}
        ids = set()
        for val, eids in raw.items():
            for eid in eids:
                if eid in var_bindings:
                    var_bindings[eid] = [{**b, v: val} for b in var_bindings[eid]]
                else:
                    var_bindings[eid] = [{v: val}]
                ids.add(eid)
        entity_sets.append(ids)
    else:
        # VEAT range scan: {entity_id: {attr_names}}
        ids = set()
        for eid, attrs in raw.items():
            new_partials = [{attr: a} for a in attrs]
            if eid in var_bindings:
                var_bindings[eid] = [{**ex, **np} for ex in var_bindings[eid] for np in new_partials]
            else:
                var_bindings[eid] = new_partials
            ids.add(eid)
        entity_sets.append(ids)
```

Short and readable. The accumulation happens as a side effect of each iteration.

**Clojure** passes the same two pieces of state through a `reduce` accumulator — a single map that grows immutably with each clause:

```clojure
(reduce
  (fn [{:keys [entity-sets var-bindings]} clause]
    (let [raw ((plan [clause] layer))]
      (cond
        (and (qvar? v) (not (qvar? attr)))
        ;; AVET range scan
        {:entity-sets  (conj entity-sets (reduce #(into %1 (val %2)) #{} raw))
         :var-bindings (merge-avet-bindings var-bindings raw v)}
        (and (qvar? attr) (not (qvar? v)))
        ;; VEAT range scan
        {:entity-sets  (conj entity-sets (set (keys raw)))
         :var-bindings (merge-veat-bindings var-bindings raw attr)}
        :else
        ;; point lookup
        {:entity-sets  (conj entity-sets (or raw #{}))
         :var-bindings var-bindings})))
  {:entity-sets [] :var-bindings {}}
  clauses)
```

Every step makes explicit what state changed: the return value always contains both `:entity-sets` and `:var-bindings`. Nothing is hidden in a mutable side effect. It's more verbose, but there's nowhere for accumulated state to surprise you — you can see exactly what each clause contributes.

This is where Clojure's design really shines for data-pipeline code: when you model accumulation as a `reduce` over an immutable value, the entire state at each step is visible in the return value. In Python, the same logic lives in mutations to `entity_sets` and `var_bindings` — correct, but the state lives in variables you have to track mentally.

---

## The Snippet

```python
def execute(clauses, layer):
    entity_var = None
    entity_sets = []
    var_bindings = {}  # entity_id → [{var_name: value}, ...]

    for clause in clauses:
        e, attr, v = clause
        if not _is_var(e):
            continue
        entity_var = e
        raw = plan([clause], layer)()

        if not _is_var(v) and not _is_var(attr):
            # point lookup → raw is a set of entity IDs
            entity_sets.append(raw if raw else set())

        elif _is_var(v) and not _is_var(attr):
            # AVET range scan → raw is {val: {entity_ids}}
            ids = set()
            for val, eids in raw.items():
                for eid in eids:
                    if eid in var_bindings:
                        var_bindings[eid] = [{**b, v: val} for b in var_bindings[eid]]
                    else:
                        var_bindings[eid] = [{v: val}]
                    ids.add(eid)
            entity_sets.append(ids)

        elif _is_var(attr) and not _is_var(v):
            # VEAT range scan → raw is {entity_id: {attr_names}}
            ids = set()
            for eid, attrs in raw.items():
                new_partials = [{attr: a} for a in attrs]
                if eid in var_bindings:
                    var_bindings[eid] = [
                        {**existing, **new_p}
                        for existing in var_bindings[eid]
                        for new_p in new_partials
                    ]
                else:
                    var_bindings[eid] = new_partials
                ids.add(eid)
            entity_sets.append(ids)

    if not entity_sets:
        return []
    surviving_ids = set.intersection(*entity_sets)
    result = []
    for eid in surviving_ids:
        base = {entity_var: eid}
        for partial in var_bindings.get(eid, [{}]):
            result.append({**base, **partial})
    return result
```

Read it in three parts:

1. **The loop** — for each clause, run the plan and dispatch on which slots are variables: point lookup returns a flat entity ID set; AVET range scan returns `{val: {eids}}` and binds the value variable; VEAT range scan returns `{eid: {attr_names}}` and expands into one row per attribute.
2. **The intersection** — one line, any number of clauses. `set.intersection(*entity_sets)` is the entire AND logic.
3. **The assembly** — for each surviving entity ID, iterate its list of partial binding dicts (one per row) and merge with the entity variable. The `[{}]` fallback means point-lookup-only entities emit exactly one row.

---

## What's Next

Phase 9 adds time-travel queries and graph traversal — navigating entity references across historical layers without any changes to the query engine itself.


---

*The source code for this series is on GitHub: [minhmannh2001/circle-db](https://github.com/minhmannh2001/circle-db)*
