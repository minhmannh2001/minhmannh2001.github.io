---
layout: post
title: "Building a Computer from Scratch — Part 9: The Register"
date: 2026-05-15 09:30:00 +0700
excerpt: >
  Combining storage and bus access into a single unit with two independent control wires.
comments: true
---

Parts 1–8 gave us storage (`Word`), bus routing, bitwise operations, and arithmetic. But `Word` knows nothing about the bus — connecting them requires manually copying 16 wires in both directions every time. As the system grows, every component that needs to hold a value and share it will need that same plumbing. This phase builds `Register`: a `Word` and an `Enabler` unified behind two control wires, SET and ENABLE, that handle the bus connection automatically.

```
  Part  1 → Gates & Wires
  Part  2 → Multi-Input Gates
  Part  3 → Storage Primitives
  Part  4 → The Bus
  Part  5 → Enabler & Bitwise Ops
  Part  6 → Comparison & BusOne
  Part  7 → Decoders
  Part  8 → The Adder
  Part  9 → Registers               ← you are here
  Part 10 → The Stepper
  Part 11 → The ALU
  Part 12 → Memory (64K RAM)
  Part 13 → I/O Bus & Keyboard
  Part 14 → Display
  Part 15 → The CPU
  Part 16 → The Complete Computer
  Part 17 → Assembler & Running It
```

> **Reading along with the book?** This phase covers the "Back to the Byte" and "The Magic Bus" chapters from _But How Do It Know?_ by J. Clark Scott.

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
[ Register ]   ← Part 9
      ↓
[ Stepper ]    ← next
      ↓
[ ALU ]
      ↓
[ CPU ]
      ↓
[ Computer ]
```

---

## Two Buttons, Not One

Think of a register as a smart filing cabinet next to a conveyor belt. Documents travel along the belt continuously. Press **SET** and the cabinet grabs whatever document is passing and files it. Press **ENABLE** and it places its stored document back on the belt for others to read. Press neither and it sits completely silent, ignoring everything on the belt.

The instinct is to make SET automatically enable — why store a value without wanting to read it back? To see why that's wrong, consider what happens when the ALU finishes an ADD in the CPU.

The ADD result has to go somewhere specific — say, back into R1. But R0, R2, and R3 are all connected to the same bus. If SET on R1 automatically triggered ENABLE on R1, then at the moment R1 latched the new value, R1 would also immediately drive that value back onto the bus. Now the bus carries the ADD result, which it was supposed to carry anyway — but what if another component was in the middle of using the bus for something else at that moment? Or what if R1's enable fired at the same moment R0 was trying to enable? Two components fight over the same 16 wires. No error is raised. The bus just carries garbage.

The two-wire design avoids this entirely. When the CPU writes a result into R1, ENABLE stays false. R1 silently stores the value. The bus is free for whatever comes next. The CPU chooses exactly when R1 is allowed to speak — which could be three steps later, or never in this program's execution.

A register can hold a value indefinitely, completely invisible to the rest of the circuit.

---

## ConnectOutput Eliminates a Hidden Copy Loop

The constructor wires the `Word` output directly into the `Enabler` input:

```go
func NewRegister(name string, inputBus *Bus, outputBus *Bus) *Register {
    r := &Register{
        word:    NewWord(),
        enabler: NewEnabler(),
        // ...
    }
    r.word.ConnectOutput(r.enabler)
    return r
}
```

Without `ConnectOutput`, every `Update()` call would need a manual loop:

```go
// what you'd have to write without ConnectOutput — at every Update site
for i := 0; i < 16; i++ {
    r.enabler.SetInputWire(i, r.word.GetOutputWire(i))
}
```

With it, `word.Update()` automatically pushes its 16 output wires into the enabler's 16 input wires as part of its normal execution. The wiring is established once at construction and runs itself from then on. No manual loop, no risk of forgetting to sync one of the 16 wires, no copy that has to be repeated at every call site that touches the register.

---

## Disabled Outputs Must Be Zero

When `enable` is false, the `Enabler` outputs all zeros — not the stored value. This is the guarantee from Phase 5: AND-with-false always produces false, regardless of what the input carries.

It matters because the output bus is shared. Think of a radio frequency. If four radio stations are all assigned the same frequency and three of them are "supposed to be silent," those three stations can't just leave their transmitters on but turned down — even faint signal from three stations mixed together sounds like noise to the fourth station's audience. The Enabler solves this by completely cutting transmission, not just reducing it. A disabled register outputs zero on every wire — not its stored value at a lower intensity, but genuinely zero, unconditionally.

Any component reading the bus sees exactly what the one enabled component intended to send. No interference.

Input and output buses can also point to the same object. When they do, reading happens before writing within `Update()` — the bus carries the incoming value when the word latches it, then carries the stored value if the register writes back. No conflict arises because read and write are ordered steps within a single function call, not simultaneous events.

---

## What I Took Away

- SET and ENABLE are independent by design. Without this independence, every SET would force a bus write — causing collisions in any cycle where multiple registers are being set at once, which is every cycle in the CPU.
- `ConnectOutput` establishes the word-to-enabler wiring once at construction. Without it, every Update site needs a 16-wire copy loop — 16 opportunities per update to introduce a bug.
- Disabled outputs are always zero, not the stored value. A shared bus requires this to be a physical guarantee, not a software promise — the Enabler's AND-gate design makes it unconditional.
- Input and output buses can be the same object; read always happens before write within a single `Update()` call.

---

## What's Next

Phase 10 builds the `Stepper` — a six-position shift register that cycles through steps 0–5 and tells every other component which moment in time it is. Without it, the machine has no sense of order: no "first do this, then do that."
