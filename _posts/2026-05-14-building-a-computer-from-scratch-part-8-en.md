---
layout: post
title: "Building a Computer from Scratch — Part 8: The Adder"
date: 2026-05-14 20:00:00 +0700
excerpt: >
  Building a 16-bit ripple-carry adder from five gates per bit column.
comments: true
---

Parts 1–7 gave us storage, a shared bus, bitwise operations, comparison logic, and address decoding. We can move values around, test them, and select individual targets by binary address — but we still can't compute anything new. Every value that exists had to be placed there manually. This phase fills that gap: `Add2` is a single full-adder stage, and `Adder` chains 16 of them into a 16-bit ripple-carry adder that adds two numbers from pure gate logic.

```
  Part  1 → Gates & Wires
  Part  2 → Multi-Input Gates
  Part  3 → Storage Primitives
  Part  4 → The Bus
  Part  5 → Enabler & Bitwise Ops
  Part  6 → Comparison & BusOne
  Part  7 → Decoders
  Part  8 → The Adder               ← you are here
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

> **Reading along with the book?** This phase covers the "The Adder" chapter from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage: Bit → Word ]
      ↓
[ Bus + Enabler + Ops ]
      ↓
[ Comparison + Decoders ]
      ↓
[ Adder ]      ← Part 8
      ↓
[ Register ]   ← next
      ↓
[ ALU ]
      ↓
[ CPU ]
      ↓
[ Computer ]
```

---

## The Carry Is Binary Column Overflow

When you add two decimal numbers by hand, you carry when a column reaches 10 — one decimal digit can't hold a value that large, so you write the ones place and pass a 1 to the next column. Binary is the same idea with a lower threshold: one bit can hold 0 or 1, but not 2. So 1 + 1 = 0, carry 1.

Let's trace `5 + 3` in 4-bit binary to make this concrete before looking at the gates:

```
    A = 0101  (5)
    B = 0011  (3)
```

Adding column by column from right to left (LSB first):

| Column | A bit | B bit | carry-in | sum | carry-out |
|--------|-------|-------|----------|-----|-----------|
| bit 3 (LSB) | 1 | 1 | 0 | **0** | **1** |
| bit 2       | 0 | 1 | 1 | **0** | **1** |
| bit 1       | 1 | 0 | 1 | **0** | **1** |
| bit 0 (MSB) | 0 | 0 | 1 | **1** | 0 |

Result: `1000` = 8. Correct.

Notice that carries cascade — bit 3's carry-out becomes bit 2's carry-in, and so on. This is *ripple carry*: the carry ripples leftward through each column. The full adder circuit implements exactly this column-by-column calculation in gates.

---

## Five Gates Per Column

The single stage, `Add2`, takes three inputs (bit A, bit B, carry-in from the right) and produces two outputs (sum bit, carry-out to the left). Five gates implement it completely:

```go
func (a *Add2) Update(inputA, inputB, carryIn bool) {
    a.xor1.Update(inputA, inputB)
    a.xor2.Update(a.xor1.Output(), carryIn)       // sum = A XOR B XOR carryIn

    a.and1.Update(carryIn, a.xor1.Output())
    a.and2.Update(inputA, inputB)
    a.or1.Update(a.and1.Output(), a.and2.Output()) // carry = (A AND B) OR ((A XOR B) AND carryIn)

    a.sumOut.Update(a.xor2.Output())
    a.carryOut.Update(a.or1.Output())
}
```

The sum formula `A XOR B XOR carryIn` works because XOR means "is the count of 1s odd?" — which matches the binary addition rule. The carry formula has two cases: carry when both A and B are 1 (`AND`), or carry when exactly one of A/B is 1 *and* there's already a carry-in coming (the `AND` of the partial sum with carryIn, all ORed together). That is all of computer arithmetic, reduced to five gates per bit position.

---

## Ripple Means Sequential, Not Simultaneous

The `Adder` chains 16 `Add2` stages. The loop walks from index 15 (the least significant bit) down to 0 (the most significant), passing each stage's carry-out as the next stage's carry-in:

```go
func (a *Adder) Update(carryIn bool) {
    carry := carryIn
    for i := 15; i >= 0; i-- {
        a.adds[i].Update(a.inputs[i].Get(), a.inputs[i+BUS_WIDTH].Get(), carry)
        a.outputs[i].Update(a.adds[i].Sum())
        carry = a.adds[i].Carry()
    }
    a.carryOut.Update(carry)
}
```

All 16 stages exist as separate circuits simultaneously, but carry cannot propagate in parallel — each stage needs the result from the stage to its right before it can compute. Stage 15 must finish before stage 14 knows its carry-in. This sequential dependency is why it's called a ripple-carry adder.

Real hardware uses look-ahead carry circuits that predict carry values without waiting for the full ripple, reducing latency significantly. The ripple approach is simpler, correct, and sufficient for this simulation — the sequential loop models the hardware dependency faithfully.

One edge case worth stating explicitly: `0xFFFF + 1 = 0x0000`, carry-out = true. Overflow is a carry, not garbage. The carry flag is the signal that the 16-bit result wrapped around.

---

## The Wire Layout Looks Backwards

Input wires 0–15 hold operand A, with index 0 as the MSB. Addition starts at wire 15 — the LSB — and the carry propagates toward wire 0. The loop counts downward.

This feels inverted, but it matches the convention established in Phase 4: index 0 is always the most significant bit. The adder walks wires in carry-propagation order (LSB to MSB), not in index order. The MSB lives at index 0 because that is where the bus convention puts it, not because addition is running backwards.

---

## What I Took Away

- Binary carry is column overflow — the same mechanism as decimal carrying, just with a threshold of 2 instead of 10. The 4-bit trace of `5 + 3` shows exactly how carries cascade column by column, which is what the 16-stage ripple-carry adder implements.
- Five gates (XOR, XOR, AND, AND, OR) implement one full-adder stage completely; this is the atomic unit of all computer arithmetic.
- Ripple carry is sequential by necessity: each stage depends on the carry-out of the stage to its right. Real hardware optimizes this with look-ahead carry, but ripple is simpler and correct.
- Overflow produces a carry flag, not garbage — the flag is the signal that the 16-bit result wrapped around.
- The wire layout counts index 0 as MSB, so the carry loop runs from index 15 downward.

---

## What's Next

Phase 9 wraps a `Word` (storage) and an `Enabler` (bus gating) into a single `Register` unit with two independent control wires — SET and ENABLE — making it the first component that can both hold a value and decide when to speak on the shared bus.
