---
layout: post
title: "Building a Computer from Scratch — Part 11: The ALU"
date: 2026-05-19 08:30:00 +0700
excerpt: >
  Assembling eight parallel operation units behind a decoder-controlled gate, so a 3-bit opcode routes exactly one result onto the bus — with no branching in sight.
comments: true
---

Parts 1–10 built all the ingredients: gates, storage cells, a shared bus, an adder, bitwise units, comparison logic, decoders, registers, and a stepper that gives the machine a sense of time. What's missing is the compute core — a single unit the CPU can point at any of eight operations and get the right answer back. That's the ALU.

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
  Part 10 → The Stepper
  Part 11 → The ALU                  ← you are here
  Part 12 → Memory (64K RAM)
  Part 13 → I/O Bus & Keyboard
  Part 14 → Display
  Part 15 → The CPU
  Part 16 → The Complete Computer
  Part 17 → Assembler & Running It
```

> **Source code:** [github.com/minhmannh2001/simple-computer](https://github.com/minhmannh2001/simple-computer) — all 18 phases implemented in Go.

> **Reading along with the book?** This phase covers "Logic" and "The Arithmetic and Logic Unit" from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage + Bus + Ops ]
      ↓
[ Register + Stepper ]
      ↓
[ ALU ]         ← Part 11
      ↓
[ RAM ]         ← next
      ↓
[ CPU ]
      ↓
[ Computer ]
```

---

## Hardware Doesn't Branch — It Gates

The CPU needs to do eight distinct things with the same pair of 16-bit inputs: add them, shift left, shift right, NOT one of them, AND them, OR them, XOR them, or compare them. The selection is controlled by a 3-bit opcode.

In software, this is a switch statement. In hardware, there's no such thing.

Think of a theater with eight performers on stage. The director has a spotlight that can only illuminate one performer at a time. All eight are on stage, ready — but only the one in the spotlight is visible to the audience. The 3-bit opcode is the director's cue: it tells the spotlight which performer to illuminate. The others are still present, still doing their job, but they produce output into darkness (zero).

In hardware terms: all eight operation units (adder, shifters, bitwise units, comparator) receive the input values and compute their results simultaneously. Each result sits behind an Enabler — the spotlight. A 3×8 decoder converts the 3-bit opcode into a one-hot output: exactly one of its eight outputs goes high. That one output enables exactly one Enabler. Only that operation's result reaches the output bus.

The decoder produces a one-hot output — only one of its eight outputs is true at a time. That one-hot output does double duty: it selects the Enabler, and — as you'll see below — it also gates the carry output.

---

## Walking Through op=ADD

When the CPU executes an ADD instruction, the opcode bits arrive at the decoder. Let's trace what happens:

The 3-bit opcode for ADD is `000`. The decoder receives `(0, 0, 0)` and activates its output wire 0. This wire flows to two places:

1. **The ADD Enabler**: output 0 of the decoder enables the adder's result onto the output bus. The adder has already computed the sum of the two input values — it was computing the whole time. Now its output is allowed through.

2. **The carry AND gate** (`andGates[0] = AND(adder.Carry(), opDecoder[ADD])`): this gate passes the adder's carry-out to the final carry wire. With `opDecoder[ADD] = true`, the adder's carry is forwarded. With all other opcodes, `opDecoder[ADD] = false` and the AND gate clamps the carry to zero regardless of what the adder outputs.

The six non-ADD Enablers all receive `false` from the decoder and output zero. Their underlying results (SHR, SHL, NOT, AND, OR, XOR) were computed, but the bus sees none of them. The "switch" wasn't a branch — it was a spotlight.

---

## The Comparator Always Runs

The comparator is not inside the operation switch. It runs on every `Update()` call, for every opcode, feeding the `aIsLarger` and `isEqual` flag wires continuously.

Why? Consider the alternative: run the comparator only during the CMP opcode, and store the flags until the next CMP. That means after a CMP instruction sets the equal flag, an ADD instruction runs, and the equal flag still reflects the old comparison — not the ADD result. Any jump instruction reading the flag in between sees stale data. The control unit would need extra logic to say "the flags are valid only if the last instruction was CMP." That's bookkeeping with no upside.

By running the comparator on every update, the flags always reflect the most recently seen inputs. After an ADD, the comparison flags reflect the ADD inputs. After a NOT, they reflect the NOT result. The control unit never has to track "which opcode last set the flags." If it ignores the comparison flags for non-CMP instructions, nothing breaks. If it reads them, it gets a valid (if unusual) result.

---

## Carry Routing via AND Gates

Only three operations can produce a carry: ADD (ripple-carry from the adder), SHR (the shifted-out LSB), and SHL (the shifted-out MSB). The other five never carry.

Rather than a conditional, three AND gates handle routing in hardware:

```
andGates[0] = AND(adder.Carry(),          opDecoder output[ADD])
andGates[1] = AND(rightShifter.ShiftOut(), opDecoder output[SHR])
andGates[2] = AND(leftShifter.ShiftOut(),  opDecoder output[SHL])
carryOut    = OR of the three
```

When op=ADD, the decoder's ADD output is true — so `andGates[0]` passes the adder's carry through. The other two gates receive `false` as their second input regardless of whatever stale ShiftOut values the shifters hold. OR-ing three gates where at most one can be true gives the correct single carry value.

This is the same one-hot decoder output doing its second job: selecting the Enabler *and* gating the carry. No conditional logic required anywhere.

---

## CMP Has No Result — Only Flags

CMP is the only opcode without an Enabler. There's no "result" to put on the bus — comparison doesn't produce a number. Instead, when op=CMP, the ALU forces all-false into the output bus.

The zero flag needs special handling here. If the ALU wrote all-false into the `isZero` inputs (which it does for the output), the zero detector would claim "the result is zero" — meaningless for a comparison. The fix: when op=CMP, write all-true into the `isZero` inputs. The zero detector sees non-zero and outputs false. The zero flag stays clear.

The actual comparison result lives on the flags bus — from the comparator's `aIsLarger` and `isEqual` outputs, which always run regardless of opcode.

Every `Update()` call writes all four flags simultaneously:

```
flagsOutputBus[0] = carryOut
flagsOutputBus[1] = aIsLarger
flagsOutputBus[2] = isEqual
flagsOutputBus[3] = isZero
```

---

## What I Took Away

- Hardware can't branch, so the ALU runs all operations simultaneously and gates the results. The one-hot decoder output is the spotlight — it illuminates exactly one result onto the bus. The other seven are always present but always dark.
- Letting the comparator run on every cycle eliminates a whole class of "which flags are valid right now" bookkeeping. The flags are always fresh; programs read them whenever they're useful.
- The carry routing — three AND gates ORed together — is a clean example of how the decoder's one-hot output earns its keep twice: once enabling the result, once isolating the carry.
- CMP's "no-enabler, all-true-into-zero-detector" trick shows how hardware handles the edge case without any conditional branching on the opcode.

---

## What's Next

Phase 12 builds Memory — 64K of RAM where programs and data live, organized as a 256×256 grid of cells with address decoding and a two-phase read/write protocol.
