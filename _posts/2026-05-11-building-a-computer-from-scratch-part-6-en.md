---
layout: post
title: "Building a Computer from Scratch — Part 6: Comparison & BusOne"
date: 2026-05-11 21:00:00 +0700
excerpt: >
  Building the comparator that chains 16 bit-stages MSB-first, and BusOne — the gate that injects the constant 1 without an if-statement.
comments: true
---

Parts 1–5 gave us logic gates, storage, a shared bus, and bitwise operations. We can move values around and transform them — but we cannot yet ask whether two values are equal, and we have no way to get the constant 1 on demand without loading it from a storage cell. This phase fills both gaps.

```
  Part  1 → Gates & Wires
  Part  2 → Multi-Input Gates
  Part  3 → Storage Primitives
  Part  4 → The Bus
  Part  5 → Enabler & Bitwise Ops
  Part  6 → Comparison & BusOne       ← you are here
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

> **Reading along with the book?** This phase covers "The Comparator and Zero" and the Bus 1 section of "More of the Processor" from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage: Bit → Word ]
      ↓
[ Bus ]
      ↓
[ Enabler + Bitwise Ops ]
      ↓
[ Comparison & BusOne ]   ← Part 6
      ↓
[ Decoders ]              ← next
      ↓
[ ALU ]
      ↓
[ CPU ]
      ↓
[ Computer ]
```

---

## The Comparison Chain Must Run MSB-First

The Comparator is built from 16 identical one-bit stages chained in sequence. Each stage (`Compare2`) takes four inputs — the two bits at this position, whether all higher bits were equal, and whether A was already found to be larger — and produces updated equal and larger-than signals for the next stage.

The chain starts with `equalIn=true` and `isLargerIn=false`. Each stage's output feeds directly into the next stage's input, MSB to LSB.

The critical design choice is direction — and to see why it matters, let's trace a concrete comparison: **A = 5, B = 3** in 4-bit binary.

```
A = 0101
B = 0011
```

Walking bit by bit from MSB (bit 0) to LSB (bit 3):

| Bit | A | B | equal (in) | isLarger (in) | equal (out) | isLarger (out) |
|-----|---|---|-----------|----------------|-------------|----------------|
|  0  | 0 | 0 | true      | false          | true        | false          |
|  1  | 1 | 0 | true      | false          | **false**   | **true**       |
|  2  | 0 | 1 | false     | true           | false       | **true** (OR)  |
|  3  | 1 | 1 | false     | true           | false       | **true** (OR)  |

The OR gate in `isLargerOut` only *accumulates* — it can never retract a finding. Once bit 1 sets `isLarger=true`, every subsequent stage sees `isLargerIn=true` and preserves it via OR. Even though bit 2 shows B's bit is larger than A's (1 vs 0), it can't undo what bit 1 already decided.

Final answer: A > B. Correct — because bit 1 is the *highest bit that differs*, and that is the bit that counts.

Now imagine the chain ran LSB-first (bit 3 → bit 0). It would examine bit 3 first (both 1), then bit 2 (B=1 > A=0), setting `isLarger(B)=true`. By the time it reaches bit 1 where A is genuinely larger, the OR gate has already locked in B's claim. The answer would be wrong.

This is the same left-to-right order humans use when comparing numbers written out digit by digit. The first digit that differs is the only one that matters. Every digit after that is irrelevant — and the OR gate's accumulate-never-retract property encodes exactly this rule in gates.

---

## Why BusOne Must Be Hardware

The CPU increments its program counter (IAR) after every instruction — that's one of the three mandatory steps in every fetch cycle. In a 16-step program, the counter increments 16 times. In a loop that runs 1,000 times, it increments thousands of times.

The naive alternative: store the value `1` in a register, enable that register onto the bus, and use the adder. That works, but it costs one full register slot — a resource programs could otherwise use — and it requires the control unit to manage "fetch the constant 1 from register X" as part of every increment.

BusOne eliminates this entirely. It's a dedicated circuit wired between the TMP register output and the adder's second input, activated by a single control wire. When that wire is true, BusOne forces `0x0001` onto the adder's input regardless of what TMP holds. When false, it passes TMP through unchanged.

The formula per bit is:

```go
// wires 0..14 (upper bits)
output[i] = input[i] AND NOT(bus1)

// wire 15 (LSB)
output[15] = input[15] OR bus1
```

When `bus1 = false`: `NOT(false) = true`, so `AND(input, true) = input` for the upper bits. `OR(input, false) = input` for the LSB. The input passes through unchanged.

When `bus1 = true`: `NOT(true) = false`, so `AND(input, false) = 0` for all upper bits. `OR(input, true) = 1` for the LSB. Output is `0x0001` regardless of what the input held.

No if-statement, no register consumed, no extra instruction cycle. The `bus1` wire acts as a mode switch baked into the gate formula itself. This AND/NOT + OR selector pattern — choosing between pass-through and a fixed constant using a single control bit — will appear again in later phases.

---

## What I Took Away

- The comparison chain's OR gate only accumulates, never retracts. The first bit position that differs determines the final answer. MSB-first ordering ensures that highest-value difference wins — which is the correct definition of "larger." Running the chain in any other direction would require a different mechanism to suppress wrong early findings.
- BusOne is not just a convenience. Storing the constant 1 in a register would waste a register slot permanently and add overhead to every instruction fetch. A dedicated circuit eliminates both costs.
- BusOne has no latch, no stored state. The "mode" it operates in is entirely determined by the current value of the `bus1` wire. Change the wire, change the output instantly. It is pure combinational logic.
- The AND/NOT + OR formula is a fundamental selector pattern. Recognizing it here makes it easier to spot the same structure in the multiplexers and control logic that appear in later phases.

---

## What's Next

The system can now compare values and inject the constant 1. What it still cannot do is select one specific target from many. Phase 7 builds the decoder family — components that take a binary number and activate exactly one of many output wires. That is the mechanism the memory and CPU will use for addressing.
