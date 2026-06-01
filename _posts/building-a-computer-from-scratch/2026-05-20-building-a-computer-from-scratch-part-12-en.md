---
layout: post
title: "Building a Computer from Scratch — Part 12: Memory (64K RAM)"
date: 2026-05-20 21:15:00 +0700
excerpt: >
  Building 65,536 cells in a 256×256 grid, selected by two 8-bit decoders, with a Memory Address Register that makes the two-phase read/write protocol possible.
comments: true
---

The ALU gives the CPU the ability to compute. Now it needs a place to store more than a handful of values — programs have thousands of instructions and the data they work on. A single register holds one word. Sixteen registers hold sixteen words. This phase builds 65,536 of them, organized so the CPU can reach any one using only a 16-bit address.

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
  Part 11 → The ALU
  Part 12 → Memory (64K RAM)          ← you are here
  Part 13 → I/O Bus & Keyboard
  Part 14 → Display
  Part 15 → The CPU
  Part 16 → The Complete Computer
  Part 17 → Assembler & Running It
```

> **Source code:** [github.com/minhmannh2001/simple-computer](https://github.com/minhmannh2001/simple-computer) — all 18 phases implemented in Go.

> **Reading along with the book?** This phase covers "Numbers", "Addresses", and "First Half of the Computer" from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage + Bus + Ops ]
      ↓
[ Register + Stepper + ALU ]
      ↓
[ RAM (64K) ]   ← Part 12
      ↓
[ I/O Bus ]     ← next
      ↓
[ CPU ]
      ↓
[ Computer ]
```

---

## Addressing 65,536 Cells with Two Decoders

If each RAM cell had a direct control wire from the CPU, reaching 65,536 cells would require 65,536 control lines. That's not a design — that's a wiring nightmare.

The solution is the decoder pattern from Part 7: instead of one wire per destination, send a number and decode it. A 16-bit address names any of 65,536 cells. Split it down the middle: the high byte selects one of 256 rows, the low byte selects one of 256 columns. Two `Decoder8x256` units intersect at exactly one cell — the only one that receives both a row-select and a column-select signal.

Think of it like a spreadsheet. The address `0x0203` means row 2, column 3. You don't need a direct connection from the CPU to cell (2, 3) — you just tell the row decoder "activate row 2" and the column decoder "activate column 3," and only their intersection responds.

```go
// Memory64K.Update() after MAR holds the address
row := m.rowDecoder.Index()   // high byte → row 0–255
col := m.colDecoder.Index()   // low byte  → col 0–255
m.data[row][col].Update(m.set.Get(), m.enable.Get())
```

It's a grid lookup, not a direct connection.

---

## The One-Bus Problem

Before explaining the Memory Address Register, it helps to understand the constraint that makes it necessary.

The bus is a single shared channel — 16 wires that carry exactly one value at a time. To write a value to memory, you need two separate pieces of information: *where* to write (the address) and *what* to write (the data). On a two-bus computer these could travel simultaneously on separate wires. On a one-bus computer, they have to travel in sequence.

Think of mailing a package. The post office needs two things: the destination address and the package contents. You can't hand them both at the same time — you fill out the address form first, then hand over the package. The address form is held between the two steps. The MAR is that form: a register that holds the address across the gap between the two bus cycles.

---

## The MAR: Holding the Address Across Two Cycles

The Memory Address Register (MAR) makes the two-phase protocol possible. Here is a concrete write — storing the value `0x0042` at address `0x0203`:

**Phase 1 — address:**
```
bus ← 0x0203
MAR.Set()       → MAR latches 0x0203
MAR.Unset()
bus ← 0x0000    (bus cleared)
```

At this point, the bus is empty again, but the MAR still holds `0x0203`. The row decoder reads high byte `0x02` → row 2. The column decoder reads low byte `0x03` → column 3. That cell is selected and waiting.

**Phase 2 — data:**
```
bus ← 0x0042
memory.Set()    → cell[2][3] latches 0x0042 from bus
memory.Unset()
```

Cell (2, 3) is now written. The MAR never changed — it held the address silently across both cycles. This is exactly the property from Part 3: a latched `Bit` ignores new input when its set wire is false, retaining whatever it stored indefinitely.

Reading follows the same two-phase sequence, but with enable instead of set in Phase 2:

**Read example — loading the value from address `0x0203`:**
```
bus ← 0x0203
MAR.Set()       → MAR latches 0x0203
MAR.Unset()
bus ← 0x0000

memory.Enable() → cell[2][3] drives its stored value onto bus
                  bus now carries 0x0042
```

The destination register (say, R0) then latches the bus value in the same cycle.

---

## Why Not Load MAR Separately?

The natural question is: why is the MAR even needed? Why can't the CPU just tell the memory module directly which address to use?

Because the CPU only has one way to send information to anything: the bus. The MAR *is* the CPU's way of sending an address to the memory module without using a dedicated address wire. It's a register — loaded via the bus exactly like any other register. The CPU doesn't know or care that this particular register happens to control which memory cell gets selected next. It just loads a value onto the bus and calls `MAR.Set()`, the same way it loads R0 or TMP.

This is why the MAR is exported as a plain public field on `Memory64K`. The CPU loads it with no special instruction — just the normal bus-and-set sequence that works for every register in the system.

---

## All 65,536 Cells Share the Same Bus

Every cell's Register is wired to the same bus for both input and output. During a write, only the selected cell has its set signal active — it latches from the bus. During a read, only the selected cell has its enable signal active — it drives the bus. All other cells ignore both signals.

This safety guarantee comes from Part 9: `Register.Update()` only writes to `outputBus` when `enable.Get()` is true. Non-selected cells never touch the bus regardless of what value they hold. The shared-bus architecture works because disabled always means zero output, not "whatever I was storing."

The cell-level implementation wraps a Register and three AND gates that gate the set and enable signals in hardware style — even the control signals pass through gates rather than being applied as raw booleans. This keeps the simulation disciplined: every signal path runs through a gate, the same way it would on silicon.

---

## What I Took Away

- Two 8-bit decoders replace 65,536 direct control wires with a grid lookup — the same insight as Part 7, now applied at scale. Row + column intersection is all addressing is.
- The MAR is the practical consequence of having a single bus: any two-bus architecture would let you send address and data simultaneously, but a one-bus design requires sequencing them. The MAR is the sequencer.
- The "register retains value when set=false" property from Part 3 is what makes the two-phase protocol work. The MAR holds the address across the gap between cycles with no extra mechanism — that property was built in three phases ago.
- Exporting the MAR as a plain field — not hiding it behind a special method — keeps the control unit's view consistent: all registers are loaded the same way.
- The write protocol (address then data) and read protocol (address then enable) are the same two-phase structure. The difference is whether Phase 2 asserts set or enable on the selected cell.

---

## What's Next

Phase 13 connects the computer to the outside world — an I/O Bus with four control wires that keeps RAM out of peripheral cycles, and a keyboard that can inject a keycode onto the main bus when the CPU asks for it.
