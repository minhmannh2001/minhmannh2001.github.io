---
layout: post
title: "Building a Computer from Scratch — Part 10: The Stepper"
date: 2026-05-17 10:00:00 +0700
excerpt: >
  Building a six-position shift register that gives the machine a shared sense of time.
comments: true
---

Parts 1–9 gave us storage, arithmetic, bus routing, and registers. Every component does its job correctly — but there is no concept of order. The adder adds whenever it's called. The register latches whenever SET is high. Nothing says "do this first, then do that." This phase builds the `Stepper`: a six-position shift register that cycles through steps 0–5, activating exactly one at a time, and giving every other component a shared answer to "what time is it?"

```
  Part  1 → Gates & Wires
  Part  2 → Multi-Input Gates
  Part  3 → Storage Primitives
  Part  4 → The Bus
  Part  5 → Enabler & Bitwise Ops
  Part  6 → Comparison & BusOne
  Part  7 → Decoders
  Part  8 → The Adder
  Part  9 → Registers
  Part 10 → The Stepper               ← you are here
  Part 11 → The ALU
  Part 12 → Memory (64K RAM)
  Part 13 → I/O Bus & Keyboard
  Part 14 → Display
  Part 15 → The CPU
  Part 16 → The Complete Computer
  Part 17 → Assembler & Running It
```

> **Reading along with the book?** This phase covers the "The Clock", "Step by Step", and "Doing Something Useful" chapters from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage: Bit → Word ]
      ↓
[ Bus + Enabler + Ops ]
      ↓
[ Comparison + Decoders + Adder ]
      ↓
[ Register ]
      ↓
[ Stepper ]    ← Part 10
      ↓
[ ALU ]        ← next
      ↓
[ CPU ]
      ↓
[ Computer ]
```

---

## Why the Machine Needs a Clock

Without a stepper, every component fires whenever its inputs are ready. That's exactly how all the gates from Parts 1–9 work — combinational logic, no timing, just cause and effect. But a CPU can't work that way.

Consider a simple operation: fetch an instruction from RAM, then increment the program counter. Both of those need the bus. If they both try to happen "whenever they're ready," they'll race. Whichever one wins puts its value on the bus first; the other one sees that value and latches it — wrong data, wrong behavior.

The stepper solves this by giving every component a shared timeline. There are six numbered positions. Exactly one position is active at any moment. Components that should fire in step 1 AND their control signals with the step-1 wire. Components that should fire in step 3 AND with the step-3 wire. "Whenever ready" becomes "when my step is active."

Think of a stage lighting system. Six performers are ready to act. But only one spotlight is on at a time, and it cycles through positions 0–5. Performer 2 doesn't start their scene when they feel like it — they start when the spotlight hits position 2. Every other performer stays frozen. The stepper is that spotlight.

---

## Step 0 Is the Natural Resting State

The Stepper holds six master-slave pairs of `Bit` latches — twelve latches total. A "token" (a single true value) travels through them, one position per clock cycle. The step outputs are derived from the slave values, not the raw latch values, which is what allows mutual exclusivity.

Steps 1–5 use `AND(slave[N], NOT(slave[N+1]))`: step N is active when its slave is true and the next slave is not yet true. The moment the token advances to N+1, step N is ANDed with false and goes dark immediately — in the same call that lights up N+1. There is no window where two outputs are simultaneously active.

Step 0 is different. It uses `OR(reset, NOT(slave[0]))`: active when reset is firing, or when slave[0] hasn't been claimed yet. At power-on, all slaves are false, so `NOT(slave[0]) = true` and step 0 is immediately active — no initialization sequence, no special startup code. Step 0 is the default resting state, not the exception.

---

## The Master-Slave Arrangement Prevents Race Conditions

Here is the problem without master-slave. Imagine a naive shift register where every latch updates simultaneously on each clock edge. When the token moves from position N to N+1:

- The latch at N reads "I should now be false"
- The latch at N+1 reads "I should now be true" — but its input comes from N's *current* value, which is still true as both latches evaluate simultaneously

For one brief moment, both N and N+1 can appear true at the same time. Every component watching the step wires — every AND gate in the CPU that says "fire on step N" — would fire. Two steps firing at once means two conflicting bus operations happening simultaneously. The bus sees garbage.

The master-slave arrangement eliminates this by splitting each latch into two halves that update at different clock phases:

```go
s.inputOrGates[0].Update(s.reset.Get(), s.clockInNotGate.Output()) // enables masters: clock LOW or reset
s.inputOrGates[1].Update(s.reset.Get(), s.clockIn.Get())           // enables slaves:  clock HIGH or reset
```

When the clock is LOW, only masters latch new values — they read "the token is coming to me." When the clock goes HIGH, only slaves copy from their masters — they publish the stable result. The slave's output is stable for the full high half-cycle before anything else can change. There is no simultaneous update window. Two adjacent steps can never be active at the same time.

---

## Without a Double step() Call, the Stepper Would Take 7 Cycles

When the token reaches slave[5] (pair 5, the last pair), a sentinel wire fires. The Stepper's `Update` catches this and triggers a reset:

```go
func (s *Stepper) Update(clockIn bool) {
    s.clockIn.Update(clockIn)
    s.reset.Update(s.outputs[6].Get())
    s.step()
    if s.outputs[6].Get() {
        s.reset.Update(true)
        s.step() // reset completes in the same Update call
    }
}
```

Without the second `step()` call, the reset state would persist until the next `Update` — burning one full clock cycle stuck in a "resetting" position. Any component watching the step wires would see a ghost 7th step. The second call resolves the reset immediately: with `reset=true`, all twelve latches clear, and step 0 goes active before `Update` returns. From the outside, every cycle is exactly six steps, with no ghost.

---

## What I Took Away

- Without a stepper, components fire whenever their inputs are ready, leading to bus races. The stepper converts "whenever ready" into "when my step is active" — giving the CPU a shared timeline.
- Step 0 is the default state — it activates via `OR(reset, NOT(slave[0]))`, so it is live at power-on with no initialization needed.
- The master-slave arrangement prevents race conditions by creating two distinct update phases per clock cycle. Without it, two adjacent steps can appear simultaneously active, causing bus collisions.
- The double `step()` call on sentinel fire ensures the reset completes within the same `Update()` call, keeping the cycle exactly six steps long with no ghost 7th step.
- Every component that needs sequenced behavior will AND its control signals with one of the six step outputs — that's the entire mechanism of the CPU's control unit.

---

## What's Next

Phase 11 assembles the ALU — eight operations selectable by a 3-bit opcode, with a decoder routing the result through exactly one Enabler onto the output bus. For the first time, all the compute components built so far exist inside one unit.
