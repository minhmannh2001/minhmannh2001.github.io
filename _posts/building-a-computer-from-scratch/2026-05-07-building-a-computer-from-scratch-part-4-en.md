---
layout: post
title: "Building a Computer from Scratch — Part 4: The Bus"
date: 2026-05-07 20:30:00 +0700
excerpt: >
  Storage cells can hold values, but they can't talk to each other. This phase builds the shared channel that every component in the computer will use to pass data.
comments: true
---

After Part 3, we have `Word` — a 16-bit storage cell that can latch and hold a value indefinitely. But holding a value is only half the problem. Components also need to *pass* values to each other. Right now, there's no mechanism for that. If register A wants to send its value to register B, someone has to manually copy 16 wires. Add a third register and you need cables between every pair — a wiring explosion.

The fix is the same one real buildings use for internet access: instead of running a cable between every pair of offices, run one shared cable to a central switch. Anyone who wants to talk puts their signal on the shared line; anyone who wants to listen reads from it. One cable, many users.

That shared cable is the Bus.

```
  Part  1 → Gates & Wires
  Part  2 → Multi-Input Gates
  Part  3 → Storage Primitives
  Part  4 → The Bus               ← you are here
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

> **Source code:** [github.com/minhmannh2001/simple-computer](https://github.com/minhmannh2001/simple-computer) — all 18 phases implemented in Go.

> **Reading along with the book?** This phase covers chapter "The Magic Bus" from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage: Bit → Word ]
      ↓
[ Bus ]              ← Part 4
      ↓
[ Logic & Ops ]      ← next
      ↓
[ ALU ]
      ↓
[ CPU ]
      ↓
[ Computer ]
```

The Bus is the spine of the entire machine. Every component built after this phase — registers, ALU, RAM, keyboard, display — connects to it. Adding a new component means wiring it to the bus, not to every other component.

---

## One Shared Channel, One Rule

The Bus is 16 wires. Any component can write to it; any component can read from it. The only rule: **one component writes at a time**.

That rule is what keeps signals clean. If two components both drive the same wire simultaneously — one pushing a 1, the other pushing a 0 — the bus sees noise. The mechanism for enforcing "one at a time" is the Enabler, which comes in Part 5. This phase just builds the channel itself.

`SetValue` decomposes a 16-bit number into individual wire states:

```go
func (b *Bus) SetValue(value uint16) {
    for i := b.width - 1; i >= 0; i-- {
        b.wires[i].Update(value&1 == 1)
        value >>= 1
    }
}
```

The loop runs from wire index 15 down to 0, reading from the lowest bit of `value` each time. This reversal is intentional and non-obvious: in Go, `uint16` bit 0 is the **least** significant (rightmost), but on the bus, wire index 0 is the **most** significant (leftmost). Getting this backwards produces a mirrored number — `0x0001` becomes `0x8000` — that passes superficial tests but fails edge cases.

---

## Shared Pointer, Not Copied Wires

In Go, `Bus` is passed as `*Bus` — a pointer. Every component that takes a bus pointer is looking at the exact same 16-wire object in memory. This is not a trivial detail.

When a `Register` is constructed, it receives two pointers:

```go
r := NewRegister("ACC", mainBus, mainBus)
```

Both point to the same `Bus`. When the register's Enabler writes its stored value onto the bus wires, it is writing directly into the shared object — not into a private copy that then has to be synced. When the ALU reads `mainBus.GetOutputWire(i)` a moment later, it reads from the same object. There is exactly one copy of each wire in the system.

This is what makes the bus architecture work at the simulation level. In real hardware, wires are physical connections — the same copper connects all attached pins. Pointer sharing is the Go equivalent: one object, many references, no copying.

If components held their own copies of the bus state and synced periodically, the update ordering would matter in complex ways — you'd have to ensure every copy was flushed before the next component read. With a single shared `*Bus`, there is no sync problem: write to the object, read from the object. The only rule is still the same: one component writes at a time.

---

## What Happens When Two Components Write Simultaneously

The bus has no hardware arbitration — it is just 16 `circuit.Wire` values. If two components both call `SetInputWire` or `SetValue` on overlapping wires in the same update cycle, the second write silently overwrites the first. No error, no exception, no noise — just wrong data.

This is the same problem as a real shared bus under bus contention, but without the electrical drama. In a real circuit, two drivers simultaneously pushing a wire to opposite voltages causes heat, current spikes, and potentially damaged components. In simulation, it just produces unpredictable values.

The Enabler in Part 5 is what makes "one component at a time" enforceable. Until then, correct behavior depends entirely on the programmer only enabling one component per update cycle. The bus trusts the protocol.

---

## The Bus Has State, Not Just Signal

The most tempting simplification would be a stateless bus: a plain array of `bool` reflecting whatever was last written.

But each slot is a `circuit.Wire` — the same committed-state holder from Part 1. `GetOutputWire` always returns the last **explicitly written** value, not "whatever is being driven right now." If nothing writes to a wire between two read operations, the wire returns the same value both times.

Without this, a component reading the bus mid-update — while another is halfway through writing — sees partially-set values. Committed state makes the bus a stable snapshot, not a live race condition.

The bus also has no "clear" step between cycles. At the start of a new CPU step, the wires still hold whatever value was last written. This is by design: the CPU's update sequence carefully controls who writes when, and relies on values persisting on the bus across the enable-then-set double-pass pattern described in Part 15. An auto-clearing bus would break that pattern silently.

---

## What I Took Away

- **The bit-reversal in `SetValue` is a real hardware constraint.** Go's bit numbering and the bus's wire numbering go in opposite directions. This kind of endianness mismatch is a common source of subtle bugs when crossing the software/hardware boundary — and every subsequent component that reads or writes the bus inherits this convention.
- **Pointer sharing is the simulation equivalent of a physical wire.** All components receive `*Bus` and see the same 16 wires. No sync, no copying. Write once, readable everywhere.
- **Bus contention is silent.** Two simultaneous writers produce wrong data with no runtime error. The Enabler in Part 5 is the only protection — the bus itself is completely passive.
- **Committed state makes bus reads safe.** Each wire returns its last written value, not a live expression. Values persist across cycles until overwritten — which the CPU's double-pass enable/set protocol depends on.
- **A shared channel needs an enforcement rule.** The bus is the infrastructure; "one writer at a time" is the protocol. Parts 5 onward implement that protocol in gates.

---

## What's Next

Part 5 adds two things the bus is missing. First, traffic control: the Enabler — a gate per wire, controlled by a single "go ahead" signal — lets a component stay completely silent until told to speak. Second, operations: `NOTer`, `ANDer`, `ORer`, `XORer`, `LeftShifter`, `RightShifter` — components that transform the 16-bit values flowing through the bus rather than just storing them.
