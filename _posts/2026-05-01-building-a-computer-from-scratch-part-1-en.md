---
layout: post
title: "Building a Computer from Scratch — Part 1: Wires and Logic Gates"
date: 2026-05-01 08:30:00 +0700
excerpt: >
  Every computer is built from wires and gates. This post starts from scratch — what is a wire, what is a gate, and why one small design decision here is what makes memory possible three phases later.
comments: true
---

Most explanations of how computers work stop at "transistors flip bits." That's technically true but completely unhelpful. What's a bit? How does a wire carry one? How does flipping wires produce arithmetic, storage, or a running program?

This series builds a complete 16-bit computer from first principles, in Go, based on the book _But How Do It Know?_ by J. Clark Scott. We start with the smallest possible thing — a single wire — and build upward until we have a CPU that runs real programs. Seventeen phases, one layer at a time.

Here's the full roadmap:

```
  Part  1 → Gates & Wires          ← you are here
  Part  2 → Multi-Input Gates
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

This is Part 1. By the end, we'll have the two primitives everything else depends on: a `Wire` and a `Gate`.

> **Reading along with the book?** This phase covers chapters "Just a Little Bit", "What The...?", "Simple Variations", and "Diagrams" from _But How Do It Know?_ by J. Clark Scott.

---

## The Starting Question

Before you can simulate any computer, you need to answer a deceptively simple question: **how do you represent the state of a wire?**

A real wire is either carrying voltage (on) or not (off). That's one bit. Think of it like a light switch: the switch is either up or down, on or off — there's no "sort of on." Everything a computer does — storing a number, comparing two values, jumping to a different instruction — is ultimately just a massive pile of these binary switches being turned on and off in the right sequence.

In this simulation, a `Wire` is a named holder for a single boolean value: `true` for on, `false` for off. The name matters for debugging — when a simulation has thousands of signals, "wire IAR-bit-7" is more useful than "some anonymous bool."

Phase 1 builds two things:

- **Wire** — a named holder for a single on/off state
- **Six gate types** — components that take one or two wire states and produce a new state

That's it for the implementation. But one design decision here — how gates store their output — turns out to be what makes memory possible in Part 3.

---

## NAND: The One Gate You Need

The book _But How Do It Know?_ makes a surprising claim: **every logical operation a computer ever performs is derivable from a single gate type — NAND.**

A NAND gate takes two inputs and produces one output. The output is off only when both inputs are on:

| A | B | NAND output |
|---|---|-------------|
| 0 | 0 | 1           |
| 1 | 0 | 1           |
| 0 | 1 | 1           |
| 1 | 1 | 0           |

It's easier to remember NAND as "NOT AND" — it outputs the opposite of what AND would. AND is true only when both inputs are true; NAND is false only when both inputs are true.

From this single truth table, you can derive every other gate:

**NOT from NAND:** feed the same wire into both inputs.

| A | NAND(A, A) |
|---|------------|
| 0 | 1 |
| 1 | 0 |

When A=0: NAND(0,0)=1. When A=1: NAND(1,1)=0. The output is always the opposite of the input. That's NOT.

**AND from NAND:** NOT the output of NAND — which means feed the NAND result into another NAND-as-NOT:

```
AND(A,B) = NOT(NAND(A,B)) = NAND(NAND(A,B), NAND(A,B))
```

Check: NAND(1,1)=0, then NOT(0)=1. AND(1,1)=1. Correct.

**OR from NAND:** apply De Morgan's law — OR(A,B) = NAND(NOT(A), NOT(B)):

```
OR(A,B) = NAND(NOT(A), NOT(B))
```

**XOR** ("are the two inputs different?") and **NOR** follow from similar combinations.

Real silicon chips are built almost entirely from NAND gates because of this universality — it's cheaper to manufacture one type of gate in vast quantities than to build a factory for each type separately.

Phase 1 implements all six upfront even though only NAND is strictly necessary. The reason is downstream dependencies: Part 3 (storage) specifically needs NOR, and nearly everything after that needs OR and XOR. Building them all now avoids retrofitting a fundamental interface later, when other things already depend on it.

---

## The Design Decision That Makes Memory Possible

Here's the part that looks like a minor implementation detail but isn't.

Each gate stores its result in an internal wire. When you ask for a gate's output, it returns the **last computed value** — not a live formula that recomputes from current inputs every time you ask.

Why does this matter? Because storage cells work by feeding their own output back into their own input:

```
Q = NAND(S, Q_previous)
```

If `Output()` recomputed from current inputs on the fly, this becomes circular: to compute Q you need Q's current output, which needs Q again, forever. The simulation hangs.

With internal state, `Output()` returns "what was my result the last time I ran?" The feedback reads a committed snapshot, not a live expression. The circuit settles:

```go
// Stable — Output() returns the last committed value, not a live recompute
or.Update(s, or.Output())
```

Think of it like a security guard writing a log entry before handing off to the next shift. The next guard reads the log (the committed value), not the previous guard's live decision-making process. The handoff is stable because it's based on a written record, not an in-progress thought.

This is invisible in Part 1. It matters enormously in Part 3 when we build the first storage cell.

---

## Why Build All Six Gates Now?

The temptation is to implement only NAND in Part 1 and derive the others on demand — why build things you don't yet need?

Two reasons.

First, the downstream dependency isn't obvious from here. NOR is needed for the SR latch in Part 3, but you can't tell that until you're building Part 3. If you defer NOR, you'll be adding a new gate type while other code already depends on the gate abstraction — a riskier change than adding it when the layer is fresh.

Second, the six gates form a complete vocabulary. NAND, NOT, AND, OR, XOR, NOR cover every two-input boolean operation that matters in practice. Having them all available from the start means the layers above can use whichever is clearest without worrying about availability.

The cost of building all six now is small: six structs, each with one to three NAND gates inside. The cost of not building them and needing to retrofit later is higher.

---

## What I Took Away

- **NAND is the universal primitive.** NOT, AND, OR, XOR, NOR — all derived from it in two to four gate stages. Real silicon chips are built almost entirely from NAND gates for exactly this reason: one gate type, infinitely composable.
- **A Wire is not just a bool.** It's a named, mutable holder. The name makes debugging readable across a simulation with thousands of signals. The mutability is what lets feedback loops in storage cells settle instead of spinning.
- **Internal state is an architectural decision, not an implementation detail.** Choosing to have each gate commit its output — rather than recomputing on demand — is the single design decision that makes the rest of the computer possible. The storage cell in Part 3 depends on it entirely.
- **Build all six gate types now, even if you only need two today.** Part 3's NOR dependency isn't obvious from Part 1. Deferring it would mean changing a fundamental interface later, when other things already depend on it.

---

## What's Next

Part 2 is a short bridge. AND and OR each take exactly two inputs. But storage cells need an AND that checks eight wires at once, and decoders (Part 7) need one that checks sixteen. Part 2 chains the two-input gates from Part 1 into larger variants — `ANDGate3`, `ANDGate4`, `ANDGate5`, `ANDGate8`, and their OR counterparts. It sets up the raw material Part 3 needs to build the first thing that can remember.
