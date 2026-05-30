---
layout: post
title: "Building a Computer from Scratch — Part 3: Storage Primitives"
date: 2026-05-05 08:00:00 +0700
excerpt: >
  Building the first component that can remember — a 4-NAND feedback loop that locks a bit in place, and why Go's zero values make it tricky.
comments: true
---

Parts 1 and 2 built logic gates and multi-input gates. Every component we have so far is a pure function of its inputs: change the input, the output changes immediately; remove the input, the output disappears. None of them remember anything. This phase changes that.

```
  Part  1 → Gates & Wires
  Part  2 → Multi-Input Gates
  Part  3 → Storage Primitives          ← you are here
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

> **Reading along with the book?** This phase covers "Remember When", "What Can We Do With a Bit?", "A Rose By Any Other Name", and "Eight Is Enough" from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage: Bit → Word ]  ← Part 3
      ↓
[ Bus ]                  ← next
      ↓
[ ALU ]
      ↓
[ CPU ]
      ↓
[ Computer ]
```

---

## The Feedback Trick

Every gate we built so far is stateless. The moment you remove the input, the output follows. To make a circuit remember, you need feedback — wire an output back into an input so the circuit reinforces its own state.

Think of a light switch with a latch. Normally, a light is on only while you hold the switch — release it and the light goes off. A latching switch is different: press it to turn the light on, and the light *stays on* after you remove your hand. It keeps itself on. The feedback loop is what enables this — the circuit's own output becomes one of its inputs, sustaining the state even when the original trigger disappears.

The SR latch builds exactly this using two NAND gates whose outputs cross-feed each other's inputs. When you assert Set, one side of the cross-coupling locks into a stable "on" state. The other side locks into "off." Then when you release Set, both sides hold their positions because each one's output is feeding back as the other's input. The latch has latched.

This implementation uses four NAND gates rather than the classic two, which adds the ability to gate the latch behind a single control signal (`wireS`, the "set" wire). `wireI` is the value to store; `wireS` is permission to store it. When `wireS=false`, changes to `wireI` are completely ignored — the stored bit is frozen regardless of what the data line carries.

---

## Why the Circuit Runs Twice Per Update

The gate sequence in `Update` runs **twice**:

```go
func (b *Bit) Update(wireI bool, wireS bool) {
    for range 2 {
        b.gates[0].Update(wireI, wireS)
        b.gates[1].Update(b.gates[0].Output(), wireS)
        b.gates[2].Update(b.gates[0].Output(), b.gates[3].Output())
        b.gates[3].Update(b.gates[2].Output(), b.gates[1].Output())
        b.wireO.Update(b.gates[2].Output())
    }
}
```

Why twice? Because feedback loops need two passes to settle.

On the first pass, `gates[2]` reads `gates[3].Output()` — but `gates[3]` hasn't updated yet this call, so it returns last cycle's committed value. The first pass uses a stale snapshot from the previous update. The result of `gates[2]` is therefore also stale. `wireO` gets a stale value.

On the second pass, `gates[3]` has now computed its new output (from the first pass). `gates[2]` reads that fresh value. The cross-coupling has had a chance to resolve. `wireO` now reflects the true stable state.

To make this concrete: suppose the latch is holding `false` and you assert `wireS=true, wireI=true` to store a `true`. 
- **Pass 1**: `gates[0]` and `gates[1]` respond to the new inputs. But `gates[2]` still reads the old `gates[3]` output (which reflects "false"). `wireO` still shows `false`.
- **Pass 2**: `gates[3]` has updated. `gates[2]` now sees the new value. The cross-coupling settles. `wireO` correctly shows `true`.

Without the second pass, rapidly toggling inputs can leave `wireO` one step behind reality — a subtle timing bug that would only manifest when another component reads `wireO` immediately after `Update`.

---

## The wireS=false Guarantee

When `wireS = false`, NAND(anything, false) = true, so gates 0 and 1 both output `true` regardless of `wireI`. The feedback pair (`gates[2]` and `gates[3]`) then sees the same inputs as in the previous cycle and produces the same outputs. The stored value is completely unaffected.

This is the guarantee that makes memory useful. Imagine a data wire carrying a continuously changing stream of values — keyboard input, computation results, whatever. The latch can be sitting right on that wire without absorbing any of it, as long as `wireS` is low. When the CPU wants to capture a specific value, it pulses `wireS` high for one cycle. The latch latches exactly what was on the wire at that moment, then holds it safely while the wire moves on to carry other values.

---

## The Zero-Value Trap

Go initializes struct fields to their zero values — all `false` for booleans. For most components that's harmless. For a NAND latch it's a silent bug.

NAND(0, 0) = 1. A real NAND latch cannot have all outputs at zero simultaneously — the gate logic forbids it. But a freshly allocated `Bit{}` starts there anyway. If you call `Update(false, false)` from that state (the "hold, don't change" operation), the circuit resolves to a wrong output because it's starting from an impossible configuration.

The fix is a constructor:

```go
func NewBit() *Bit {
    b := &Bit{}
    b.gates[3].Update(false, false) // bootstrap to stable hold-false state
    return b
}
```

One gate call puts `gates[3]` into the committed state it would hold after a legitimate "store false" operation. All subsequent `Update` calls behave correctly from there. This isn't an arbitrary hack — you cannot physically build a NAND latch that starts in the all-zero state. The constructor enforces the hardware constraint that Go's zero values can't express.

---

## Word: Sixteen Bits in Parallel

`Word` stacks 16 `Bit`s into a single unit, all sharing the same set signal. `Update(true)` latches all 16 input wires at once; `Update(false)` leaves all 16 bits unchanged while still writing the stored values to output wires.

`Word` also introduces the `Component` interface — `ConnectOutput`, `SetInputWire`, `GetOutputWire` — which defines how any 16-bit component hands off its outputs to the next component in the chain. This interface isn't fully used yet (there's nothing downstream to connect to), but establishing the contract now means Phase 4's `Bus` can slot in without changing `Word` at all.

---

## What I Took Away

- Memory is feedback. A stateless gate's output disappears the moment its input changes. A latch's output feeds back into its own input, sustaining the state after the original trigger is removed.
- The double-pass in `Update` isn't a performance concern — it's a correctness requirement. Cross-coupled feedback gates need two evaluations per update to settle: the first reads stale snapshots, the second reads fresh values from those first-pass computations.
- `wireS = false` is a mathematically guaranteed no-op. NAND forces both steering gates to `true` regardless of the data input, so the feedback pair sees identical inputs to last time and holds its state exactly. The data wire can change freely without disturbing what's stored.
- Go's zero-value initialization is friendly until it isn't. NAND latches require a constructor to put them in a physically realizable starting state.

---

## What's Next

A `Word` can store 16 bits. But when multiple components need to share a value — sending it from a register to the ALU, or from the ALU back to memory — connecting them point-to-point means a dedicated set of 16 wires for every pair. Phase 4 builds the Bus: a single shared 16-wire channel that any component can write to or read from.
