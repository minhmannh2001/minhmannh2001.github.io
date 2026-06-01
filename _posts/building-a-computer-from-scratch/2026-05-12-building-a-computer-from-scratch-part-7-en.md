---
layout: post
title: "Building a Computer from Scratch — Part 7: Decoders"
date: 2026-05-12 08:45:00 +0700
excerpt: >
  One NOT per input, not one per gate — and how cascading two 4×16 decoders selects any one of 256 outputs without 8-input AND gates.
comments: true
---

Parts 1–6 gave us logic, storage, a bus, bitwise operations, comparison, and BusOne. We can store values and operate on them, but we cannot yet select one specific target out of many. When memory has 256 locations and the CPU says "access location 173," something has to translate that binary number into exactly one activated wire. That is what a decoder does.

```
  Part  1 → Gates & Wires
  Part  2 → Multi-Input Gates
  Part  3 → Storage Primitives
  Part  4 → The Bus
  Part  5 → Enabler & Bitwise Ops
  Part  6 → Comparison & BusOne
  Part  7 → Decoders                  ← you are here
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

> **Source code:** [github.com/minhmannh2001/simple-computer](https://github.com/minhmannh2001/simple-computer) — all 18 phases implemented in Go.

> **Reading along with the book?** This phase covers the second part of "More Gate Combinations" from _But How Do It Know?_ by J. Clark Scott. Stop when you reach the Adder — that is Phase 8.

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
[ Comparison & BusOne ]
      ↓
[ Decoders ]   ← Part 7
      ↓
[ Adder ]      ← next
      ↓
[ ALU ]
      ↓
[ CPU ]
      ↓
[ Computer ]
```

---

## What a Decoder Does

Imagine a hotel with 16 rooms. You walk up to the front desk and say "room 7." The front desk doesn't walk down the hallway checking each door — it sends the signal directly to room 7's door release. Only room 7's light turns on. Every other room stays dark.

A decoder is that routing mechanism. It takes a binary number as input and activates exactly one output wire — the one corresponding to that number. Send it `0111` (binary 7) and output wire 7 lights up. Send it `1011` (binary 11) and output wire 11 lights up. Every other output stays at zero.

This is the primitive the entire memory system is built on. Instead of 65,536 direct wires between the CPU and each RAM cell, there are two decoders. The CPU sends a 16-bit address; each decoder routes half of it to the correct row or column.

---

## One NOT Per Input, Not One Per Gate

The core idea of a decoder is simple: for each possible combination of N input bits, build one AND gate that is satisfied by that combination and no other. With 2 inputs you get 4 combinations; with 4 inputs, 16; with 8 inputs, 256.

The 2×4 decoder truth table:

| A | B | out[0] | out[1] | out[2] | out[3] |
|---|---|--------|--------|--------|--------|
| 0 | 0 |   1    |   0    |   0    |   0    |
| 0 | 1 |   0    |   1    |   0    |   0    |
| 1 | 0 |   0    |   0    |   1    |   0    |
| 1 | 1 |   0    |   0    |   0    |   1    |

Each AND gate checks a specific combination: raw input for bits that should be 1, NOT-inverted input for bits that should be 0. For out[2] (binary `10`): AND(A, NOT(B)). For out[3] (binary `11`): AND(A, B).

The naive approach: compute NOT(A) separately inside each AND gate that needs it. In a 4×16 decoder, 8 of the 16 AND gates need NOT(A). That's 8 separate NOT computations for the same wire.

The correct approach: compute NOT(A) once and share the result across all 8 gates that need it. Four NOT gates — one per input — serve all 16 AND gates. When input A changes, one NOT gate recomputes, and all 8 AND gates that use NOT(A) see the updated value immediately.

This isn't a micro-optimization. It's the structurally correct model of how decoders are actually wired on silicon. A physical wire can drive as many gates as you connect to it — sharing NOT(A) across 8 AND gates costs the same as using it once.

---

## A Concrete Walk-Through: Address 0xB5

Take the 8-bit address `0xB5` = `1011 0101` in binary. The decoder splits it into two nibbles:

- **High nibble** `0xB` = `1011` — fed into the selector `Decoder4x16`
- **Low nibble** `0x5` = `0101` — fed into the sub-decoder chosen by the high nibble

The selector `Decoder4x16` receives `(A=1, B=0, C=1, D=1)`. Only one of its 16 AND gates is satisfied by this exact combination:

```
out[11] = AND(A=1, NOT(B)=1, C=1, D=1) → true (1011 binary = 11 decimal)
```

Only output 11 is active. The selector stores `index = 11`.

Now `decoders4x16[11].Update(0, 1, 0, 1)` runs — the low nibble `0101`:

```
out[5] = AND(NOT(E)=1, F=1, NOT(G)=1, H=1) → true (0101 binary = 5 decimal)
```

Final result: `index = 11 * 16 + 5 = 181`. One of 256 outputs is active, and `Index()` returns 181 — computed from both sub-decoders' tracked indices, no wire scan needed.

The other 15 sub-decoders (`decoders4x16[0..10, 12..15]`) were never called this cycle. Their outputs remain in whatever state from the previous address, but they're irrelevant — only bank 11's output is connected to the selection logic.

---

## Decoder8x256 Cascades Two 4×16s

A direct 8-input decoder needs 256 eight-input AND gates. There are two problems with this. First, Phase 2's multi-input gates stop at `ANDGate5` — there's no `ANDGate8`. Second, and more importantly, building one enormous gate structure when you can build two smaller cascaded ones is wasteful — only 16 of the 256 gates need to run for any given input.

The cascaded approach splits 8 inputs into two nibbles. The high 4 bits select one of 16 "banks." Within that bank, the low 4 bits select one of 16 outputs. Only one sub-decoder's `Update` runs per call:

```go
func (d *Decoder8x256) Update(a, b, c, dd, e, f, g, h bool) {
    d.decoderSelector.Update(a, b, c, dd)   // high nibble selects a bank
    sel := d.decoderSelector.Index()
    d.decoders4x16[sel].Update(e, f, g, h)  // only that bank runs
    d.index = sel*16 + d.decoders4x16[sel].Index()
}
```

Per address cycle: 16 AND gates run in the selector, 16 AND gates run in one sub-decoder. Total: 32 gates. The direct approach would run all 256 AND gates every cycle. The cascade is not just simpler — it does less work.

The "exactly one active" invariant is preserved end-to-end: the selector activates exactly one bank, and within that bank exactly one output fires. No two AND gates anywhere in the structure can be simultaneously satisfied.

---

## How `Index()` Is Used in Memory

The `Decoder8x256` appears twice in `Memory64K` — once for row selection (high byte of the 16-bit address), once for column selection (low byte). The `Index()` result from each decoder directly indexes the cell array:

```
address 0xB5C3:
  high byte 0xB5 → row decoder → Index() = 181  → memory[181][...]
  low byte  0xC3 → col decoder → Index() = 195  → memory[...][195]
  selected cell = memory[181][195]
```

The decoder doesn't hand a list of active wires — it hands a single integer. Memory indexes directly with it. No scan required.

This is why "exactly one active" isn't just a nice property — it's a correctness requirement. `Index()` assumes exactly one output fired and returns that position. If two outputs were simultaneously active, `Index()` would return whichever it encountered first — silent wrong addressing with no error.

---

## What I Took Away

- A decoder is "one number in, one wire out." It translates a binary address into a point-select signal. Everything in the memory system depends on this primitive.
- Sharing NOT outputs across all AND gates is not a micro-optimization — it's the structurally correct model of how physical wires work. One wire can drive any number of gates; recomputing NOT 16 times on the same input is pure waste.
- Cascading two 4×16 decoders into an 8×256 runs 32 AND gates per cycle instead of 256 — and mirrors how real decoder ICs are built. Smaller units, composed.
- `Index()` returns a single integer computed from both sub-decoders' tracked positions during `Update` — O(1), no scan. This is only correct because exactly one output is active.

---

## What's Next

With decoders in place, the system can address specific locations. What it still cannot do is add. Phase 8 builds the full-adder — a single stage that handles carry-in and carry-out — and chains 16 of them into a ripple-carry adder. For the first time, the simulation will compute 1 + 1 = 2 entirely in gates.
