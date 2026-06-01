---
layout: post
title: "Building a Computer from Scratch — Part 5: Enabler & Bitwise Ops"
date: 2026-05-09 09:00:00 +0700
excerpt: >
  Building the gate that silences a component on the shared bus, and discovering that a left shift is just rewiring — no logic required.
comments: true
---

Part 4 gave us the bus — a 16-wire shared channel. But a bus with no traffic control is chaos. If two components both drive their values onto it at the same time, the signals collide and you get garbage. This phase adds the gate that enforces order: the Enabler. It also builds the family of bitwise operations — NOT, AND, OR, XOR, and both shifters — that the ALU will eventually call on.

```
  Part  1 → Gates & Wires
  Part  2 → Multi-Input Gates
  Part  3 → Storage Primitives
  Part  4 → The Bus
  Part  5 → Enabler & Bitwise Ops     ← you are here
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

> **Source code:** [github.com/minhmannh2001/simple-computer](https://github.com/minhmannh2001/simple-computer) — all 18 phases implemented in Go.

> **Reading along with the book?** This phase covers the Enabler section from "Back to the Byte", then "More Gates" and "Messing With Bytes", including the shifter chapters from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage: Bit → Word ]
      ↓
[ Bus ]
      ↓
[ Enabler + Bitwise Ops ]   ← Part 5
      ↓
[ Comparison & Addressing ] ← next
      ↓
[ ALU ]
      ↓
[ CPU ]
      ↓
[ Computer ]
```

---

## Silence Must Mean Zero, Not Floating

Here is the problem with "just don't write to the bus when you have nothing to say."

Imagine several radio stations sharing the same frequency. When station A is broadcasting, it puts its signal on the airwaves. When station A goes silent — what happens? In the real world, static fills the frequency. Nearby equipment, electrical interference, even the residual charge from the last transmission: all of it bleeds into what listeners hear. Silence is not clean zero. Silence is noise.

An undriven wire on a real circuit behaves the same way. It doesn't sit at zero — it *floats*. Capacitance from adjacent wires, charge left from the last operation, random electrical noise: any of these can register as 0 or 1 depending on conditions you can't control. "I said nothing" and "I said zero" are physically different states.

The Enabler solves this with a single gate per wire: `AND(input, enable)`. When `enable` is false, `AND(anything, false) = false` — the output is forced to zero unconditionally, regardless of what the input carries. The component isn't just quiet; it's definitively silent. Every disabled component on the bus contributes exactly zero to every wire, always.

Why specifically AND? Because AND with `false` is the only operation that unconditionally produces `false` regardless of the other input. Test the alternatives: `OR(input, false) = input` (lets the signal through), `XOR(input, false) = input` (same), `NAND(input, false) = true` (always outputs 1, opposite problem). Only AND with `false` gives an absolute zero output. The choice of AND is not arbitrary — it is the only gate that works.

---

## Shifting Is Rewiring, Not Computing

The NOTer, ANDer, ORer, and XORer all follow the same pattern: apply the 2-input gate across all 16 bit positions independently. If you understand one, you understand all four. The shifters are different — and they surface something genuinely strange about hardware thinking.

Consider shifting the value `5` left by one position in 8 bits:

```
Input:  0 0 0 0 0 1 0 1  (= 5, bit 0 is MSB)
Output: 0 0 0 0 1 0 1 0  (= 10, each bit moved one position left)
```

In software, you'd write `value << 1` and think of it as arithmetic — multiplying by 2. In hardware, nothing is computed. The output wire at position 4 is simply connected to the input wire at position 5. The output wire at position 6 is connected to the input wire at position 7. And so on for all 16 positions.

```go
func (ls *LeftShifter) Update(shiftIn bool) {
    ls.shiftOut.Update(ls.inputs[0].Get())   // MSB falls off as shiftOut
    for i := 1; i < BUS_WIDTH; i++ {
        ls.outputs[i].Update(ls.inputs[i-1].Get())  // each output reads one position earlier
    }
    ls.outputs[0].Update(shiftIn)  // new bit fills in at position 0 (MSB)
}
```

No gate evaluates a logical combination. No intermediate value is computed. The entire "operation" of shifting all 16 bits left is captured in which input index each output reads from: `output[i] = input[i-1]`. That is the whole thing.

For a software developer, this is one of the more disorienting moments in the build. You expect computation to live in code. Here, a nontrivial operation lives entirely in wiring topology. The code above is not a computation — it is a description of how the wires are physically connected. The "shift" was decided at circuit-build time, not at runtime. The RightShifter is identical with the index arithmetic reversed (`output[i] = input[i+1]`).

---

## IsZero Reuses What Already Exists

The last component this phase delivers is `IsZero`: a single-bit output that goes true when all 16 input wires are false. The obvious implementation is a fresh 16-input OR gate — if any bit is set, OR fires; negate that and you have IsZero.

But the ORer from earlier already exists. It takes two 16-bit operands and produces a 16-bit result. The trick: feed the same source into both operand slots. `OR(x, x) = x` for any bit, so each of the ORer's 16 gates collapses to a pass-through. Then a scan of those 16 outputs tells you whether any bit is set. Negate that, and you have IsZero — no new component needed.

This matters less as a performance optimization and more as a design habit. Before adding a new component, check whether an existing one, wired slightly differently, already does the job. In hardware, every additional gate is physical area and power draw. Reuse is not laziness; it is discipline.

---

## What I Took Away

- The Enabler uses AND specifically because AND with `false` is the only operation that unconditionally produces zero regardless of the other input. It's not convention — it's the only gate that physically enforces silence.
- An undriven wire floats, not zeros. The Enabler's guarantee of explicit zero is what makes a shared bus with multiple components physically coherent.
- A shift operation in hardware is a wiring decision made at circuit-build time, not a computation that runs when Update is called. The wiring topology *is* the operation.
- The concrete example: shifting `0b00000101` (= 5) left gives `0b00001010` (= 10). No gate fires. The bit at position 5 simply appears at position 4 in the output because that wire is connected there.
- `IsZero` routing both operand inputs of an ORer to the same source shows the reuse habit: look for existing components that already do what you need before reaching for a new one.

---

## What's Next

The bus can now carry a value safely, and we can perform bitwise operations on it. What we cannot do yet is ask whether two values are equal, or produce the constant 1 without storing it somewhere first. Phase 6 builds the Comparator and BusOne — the components that answer those questions.
