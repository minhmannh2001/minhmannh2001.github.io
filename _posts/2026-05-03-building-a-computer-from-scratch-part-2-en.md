---
layout: post
title: "Building a Computer from Scratch — Part 2: Multi-Input Gates"
date: 2026-05-03 09:15:00 +0700
excerpt: >
  Extending the gate layer to handle three, four, five, and eight inputs at once — and why the struct fields matter more than the truth table.
comments: true
---

Part 1 gave us six gate types, each taking exactly two inputs. That's the right foundation, but the layers above need gates that can AND or OR three, four, five, eight signals at once. Before showing how, it's worth asking: *why not just chain the two-input gates wherever you need them?*

```
  Part  1 → Gates & Wires
  Part  2 → Multi-Input Gates          ← you are here
  Part  3 → Storage Primitives
  Part  4 → The Bus
  Part  5 → Enabler & Bitwise Ops
  Part  6 → Comparison & BusOne
  Part  7 → Decoders
  Part  8 → The Adder
  Part  9 → Registers
  Part 10 → The Stepper
  Part 11 → The ALU
  Part 12 → Memory (64K RAM)
  Part 13 → I/O Bus & Keyboard
  Part 14 → Display
  Part 15 → The CPU
  Part 16 → The Complete Computer
  Part 17 → Assembler & Running It
```

> **Reading along with the book?** This phase covers the first part of "More Gate Combinations" from _But How Do It Know?_ by J. Clark Scott. Stop when you reach the Decoder — that's Phase 7.

---

## Where This Fits

```
[ Gates & Wires ]  ← Parts 1–2
      ↓
[ Storage ]        ← next
      ↓
[ ALU ]
      ↓
[ CPU ]
      ↓
[ Computer ]
```

We're still at the bottom of the stack, extending the gate layer before anything can be built on top of it.

---

## The Problem: More Than Two Conditions at Once

A bank vault doesn't open when you turn a key. It opens when the right key is turned **and** the handle is pulled **and** the manager is present. Three simultaneous conditions — and if any one of them is false, the vault stays locked.

With only 2-input AND gates, expressing this in hardware takes two gates wired in sequence:

```go
// Without named chains: manual wiring at every call site
and1.Update(keyInserted, handlePulled)
and2.Update(and1.Output(), managerPresent) // connect result of and1 to and2
open := and2.Output()
```

That's two gate objects, one intermediate connection, and a specific wiring order — all just to express one 3-way condition. Now imagine needing this same check in five different parts of the circuit. You'd instantiate and wire 10 AND gates manually, and the intent — "all three must be true" — is completely buried in plumbing.

The further problem is that the downstream layers aren't just using 3-input checks. Phase 7 (Decoders) needs AND gates that check all 4 input bits simultaneously, once per output — 16 outputs × 4-input AND = 64 two-input AND gates, manually chained, if you don't have named types. Phase 13 (Keyboard) uses an 8-input AND gate to detect a specific 8-bit address pattern. Both of those would be unreadable inline.

The solution is to give the patterns names: `ANDGate3`, `ANDGate4`, up to `ANDGate8`. Same for OR. Each type wraps the chaining internally. The caller says what it means rather than how to plumb it.

---

## Naming the Chains

Every type follows the same structure: a fixed set of 2-input gates wired in sequence, stored as struct fields.

```go
type ANDGate3 struct {
    and1, and2 circuit.ANDGate
}

func (g *ANDGate3) Update(a, b, c bool) {
    g.and1.Update(a, b)
    g.and2.Update(g.and1.Output(), c)
}
```

Two gates. The first AND combines `a` and `b`; the second AND takes that result and `c`. Output is true only when all three are true. `ANDGate4` adds one more gate in the chain. `ANDGate5` one more after that.

---

## Why Not a Variadic Function?

The most tempting shortcut is a function like `func ANDMany(inputs ...bool) bool`. It produces the same truth table with a quarter of the code. So why not?

Two reasons.

First, **hardware discipline**: in real CMOS circuits, there is no physical component called "an n-input AND gate." What exists on silicon is always a tree of 2-input gates. A variadic function doesn't model that structure — it's just arithmetic on booleans.

Second, **the committed-output property**: each `circuit.ANDGate` stores its last computed result and returns it when you ask for `Output()`. This is what allows feedback loops in storage cells (Phase 3) to settle instead of spinning. A variadic function has no internal state to commit — it computes and discards. Every chain of 2-input `ANDGate` objects keeps each intermediate value latched, which the feedback-loop correctness depends on.

So the struct-of-gates approach isn't pedantry. It's the structure that makes the rest of the computer possible.

---

## The Balanced Tree

For eight inputs, a linear chain works but creates seven sequential gate stages — every gate in the chain must wait for the one before it. `ANDGate8` uses a balanced binary tree instead: combine inputs in parallel pairs first, then merge the pairs.

```go
func (g *ANDGate8) Update(a, b, c, d, e, f, h, i bool) {
    g.and1.Update(a, b)   // pair 1
    g.and2.Update(c, d)   // pair 2
    g.and3.Update(e, f)   // pair 3
    g.and4.Update(h, i)   // pair 4
    g.and5.Update(g.and1.Output(), g.and2.Output()) // merge 1+2
    g.and6.Update(g.and3.Output(), g.and4.Output()) // merge 3+4
    g.and7.Update(g.and5.Output(), g.and6.Output()) // final
}
```

Seven gates, three stages of depth instead of seven. Think of it like tallying votes: you could count all 8 ballots one at a time (seven sequential comparisons), or split the pile into two groups of four, count each group in parallel, then compare the two subtotals — which takes half the time.

Both produce the correct truth table. The tree structure mirrors how hardware designers actually lay out gates on silicon — minimizing propagation depth is a real constraint when signals travel at finite speed through physical material. This simulation keeps that discipline even though we're not running on silicon.

The OR variants follow the identical pattern: `ORGate3` through `ORGate6`, using `circuit.ORGate` in place of `circuit.ANDGate`.

---

## Where These Gates Show Up Next

These aren't abstract primitives that sit idle. Within the next few phases:

- **Phase 7 (Decoders):** `Decoder3x8` uses `ANDGate3` for each of its 8 output gates — checking all 3 input bits simultaneously. `Decoder4x16` uses `ANDGate4` for each of its 16 outputs.
- **Phase 13 (Keyboard):** The keyboard detects address `0x000F` using `ANDGate8` — checking all 8 relevant bus wires at once to recognize the specific address pattern.

Both of these would be dramatically harder to read without named gate types. The naming is doing real work.

---

## What I Took Away

- The instinct to inline gate chains everywhere is technically correct but unscalable. When Phase 7 needs 16 four-input AND gates and Phase 13 needs an eight-input AND gate for address detection, having named types turns 64+ individually wired gate objects into 17 clearly named instantiations.
- A variadic function produces the right truth table but breaks two things: it doesn't model real hardware topology, and it has no internal state to commit — which the feedback loops in Phase 3 depend on.
- The struct fields (`and1`, `and2`, ...) are not just implementation detail. Reading the struct tells you exactly how many intermediate stages exist and in what order signals combine. A variadic slice hides that topology.
- `ANDGate8`'s balanced tree reduces gate depth from 7 to 3. Both are correct. The tree is how real hardware does it, and it matters when signals propagate through physical material at finite speed.

---

## What's Next

Phase 3 builds the first component that can remember — a 4-NAND feedback loop that locks a single bit in place even after the input signal disappears. This is where the committed-output property of every gate from Parts 1–2 stops being a subtle design detail and becomes the entire mechanism.
