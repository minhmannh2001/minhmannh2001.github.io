---
layout: post
title: "Building a Computer from Scratch — Part 13: I/O Bus & Keyboard"
date: 2026-05-22 09:00:00 +0700
excerpt: >
  Adding a 4-wire I/O control bus to keep RAM silent during peripheral cycles, and a keyboard that detects its own address in pure gate logic and delivers keycodes across a two-phase handshake.
comments: true
---

The CPU and RAM can compute and store. But a computer that only talks to itself isn't much use. This phase builds the I/O layer: a separate set of control wires that signals "this cycle is for a peripheral, not RAM," and a keyboard that uses pure gate logic to recognize when the CPU is addressing it.

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
  Part 12 → Memory (64K RAM)
  Part 13 → I/O Bus & Keyboard        ← you are here
  Part 14 → Display
  Part 15 → The CPU
  Part 16 → The Complete Computer
  Part 17 → Assembler & Running It
```

> **Source code:** [github.com/minhmannh2001/simple-computer](https://github.com/minhmannh2001/simple-computer) — all 18 phases implemented in Go.

> **Reading along with the book?** This phase covers "The Outside World" and "The Keyboard" from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage + Bus + Ops ]
      ↓
[ Register + Stepper + ALU + RAM ]
      ↓
[ I/O Bus + Keyboard ]   ← Part 13
      ↓
[ Display ]              ← next
      ↓
[ CPU ]
      ↓
[ Computer ]
```

---

## Why the IOBus Exists at All

The instinct is to treat the keyboard like a RAM cell: give it an address, and whenever the CPU wants a keycode, it reads from that address. The problem is that RAM responds to every address on the bus on every cycle — it can't tell whether an address is meant for it or for something else.

If the keyboard occupies address `0x000F`, RAM also has a cell at `0x000F`. When the CPU puts `0x000F` on the bus to read a keycode, RAM responds at the same time as the keyboard — two devices driving the same bus wires simultaneously. The bus sees noise.

The IOBus is the minimal fix: four separate control wires that say "this cycle is for a peripheral, not RAM." RAM is not connected to the IOBus and ignores it entirely. Peripherals only wake up when the IOBus is active.

The four wires are: `CLOCK_SET`, `CLOCK_ENABLE`, `MODE` (input vs output), and `DATA_OR_ADDRESS` (is the bus carrying a device address or payload data right now). The last wire is what makes the two-phase exchange work.

---

## Address Detection Is Pure Gate Logic

The keyboard lives at address `0x000F` = `0000 0000 0000 1111` in binary. To detect it, no comparator is needed. The address is just a pattern of ones and zeros, and the circuit is literally shaped to match that pattern:

```
Wire 0  (bit = 0) → NOT gate → 1
Wire 1  (bit = 0) → NOT gate → 1
Wire 2  (bit = 0) → NOT gate → 1
Wire 3  (bit = 0) → NOT gate → 1
Wire 12 (bit = 1) → direct  → 1
Wire 13 (bit = 1) → direct  → 1
Wire 14 (bit = 1) → direct  → 1
Wire 15 (bit = 1) → direct  → 1
         └──────────────────────────┘
                  ANDGate8
                     ↓
              fires only for 0x000F
```

Where the address has a `0` bit, a NOT gate inverts it to `1`. Where the address has a `1` bit, the wire connects directly. All eight signals go into an `ANDGate8`. The AND gate fires only when all eight match simultaneously — which is exactly and only when the bus carries `0x000F`.

Wires 4–11 go unchecked — this is *partial decoding*. It's acceptable here because this computer has only two peripherals (keyboard at `0x000F`, display at `0x0007`), and no other device matches the same 8-wire pattern. A third device at an address that collided on those 8 wires would be a bug — but the architecture makes that easy to reason about: add a device, check the 8 wires, no collision, proceed.

---

## The `memoryBit` Latch: Remembering Which Device Was Selected

The I/O exchange takes two separate bus cycles. Between them, the bus changes. Without something to remember "the keyboard was selected in the previous cycle," the keyboard loses track of itself the moment phase 1 ends.

Here's the problem concretely. The two-phase exchange works like this:

**Phase 1 (address):** CPU puts `0x000F` on the bus, IOBus = SET + ADDRESS. The address-detection AND gate fires. 

**Phase 2 (data):** CPU changes IOBus to ENABLE + DATA. Now the bus no longer carries `0x000F` — it's been cleared. The address-detection gate goes quiet.

If the keyboard only had the address-detection gate, it would see: "phase 1 fired, phase 2 — wait, the gate is quiet, I'm not selected anymore." The keyboard would deselect itself before delivering the keycode.

The `memoryBit` latch solves this the same way the SR latch from Part 3 solved persistent storage: it commits a state and holds it until explicitly changed.

Think of it like a hotel key card system. Phase 1 is "checking in" — you prove you belong in room 15. The system records your assignment. Phase 2 is "entering the room" — you use the key card that was issued in phase 1. The card works even though you're no longer standing at the front desk proving your identity.

`memoryBit` is that record. It latches `true` in phase 1 (address phase, address-detection fired). It stays `true` through phase 2 (data phase), even though the bus no longer carries `0x000F`. The keyboard sees `memoryBit=true` and drives the main bus with the stored keycode.

The two IOBus phases are mutually exclusive — the address gate can't fire during the data phase, and vice versa — so `memoryBit` is only ever set during the address phase and read during the data phase. There is no ambiguity.

---

## Tracing a Keypress End-to-End

Here's what actually happens on the bus when a program reads a keypress, step by step:

```
Step 1: CPU puts 0x000F on bus
        IOBus: SET=1, ADDRESS=1
        → keyboard's AND gate fires
        → memoryBit latches true
        → bus cleared

Step 2: CPU puts nothing on bus
        IOBus: ENABLE=1, DATA=1
        → keyboard sees memoryBit=true
        → keyboard drives keycode onto bus (e.g., 0x0041 for 'A')
        → destination register latches 0x0041
        → bus cleared

Step 3: CPU puts 0x0000 on bus
        IOBus: SET=1, ADDRESS=1
        → AND gate does not fire (0x0000 ≠ 0x000F)
        → memoryBit latches false (deselect)
```

The result: keycode `0x0041` is in the destination register. The keyboard is deselected. The main bus is available for the next operation.

---

## How Keyboard Simulation Works in Go

The hardware description above is gate logic. In the simulator, the keyboard bridges two worlds that operate at different speeds: the OS fires key events at human-typing speed, the CPU reads the bus thousands of times per second.

**Layer 1 — GLFW event callbacks.**
The GLFW windowing library fires a callback on every key event. The callback sends a `KeyPress` value to a buffered channel:

```go
window.SetKeyCallback(func(w *glfw.Window, key glfw.Key, ..., action glfw.Action, ...) {
    if action == glfw.Press || action == glfw.Repeat {
        keyPressChannel <- &down_key_presses[int(key)]
    } else {
        keyPressChannel <- &up_key_presses[int(key)]
    }
})
```

`down_key_presses` and `up_key_presses` are pre-allocated slices indexed by GLFW key code — the callback never allocates.

**Layer 2 — the `Keyboard` goroutine.**
A goroutine ticks at 33ms. Each tick it drains one event from the channel and writes the keycode to the output bus:

```go
func (k *Keyboard) Run() {
    ticker := time.NewTicker(33 * time.Millisecond)
    for {
        select {
        case <-ticker.C:
            select {
            case key := <-k.keyPressChannel:
                if key.IsDown {
                    k.outBus.SetValue(uint16(key.Value))
                }
            default:
            }
        }
    }
}
```

The CPU polls `IN Data` in a loop waiting for a non-zero value. The goroutine holds the keycode on the bus until the next event arrives. This works because the CPU samples continuously — it doesn't need a precisely timed pulse.

---

## What I Took Away

- The IOBus is the minimum intervention needed: four wires that let RAM and peripherals share the same data bus without fighting. RAM ignores those four wires entirely; peripherals only respond when they're active.
- Address detection in hardware is not comparison — it's gate topology. The circuit is physically shaped to match the address pattern: NOT where bits are 0, direct wire where bits are 1, all into an AND gate.
- Partial decoding (checking 8 of 16 wires) is a pragmatic trade-off. In a sparse address space with two devices, the false-positive risk is zero. It only becomes a problem if a third device is added at a colliding address.
- `memoryBit` is the Part 3 SR latch deployed in a completely different context. It solves the same problem: sustaining a state across time even after the triggering signal disappears. The "hotel key card" pattern — prove identity once, hold the credential — appears constantly in hardware.
- The keyboard goroutine is a rate adapter. OS key events arrive asynchronously; the CPU polls continuously. The 33ms tick acts as a buffer between the two, holding the last event visible until the CPU catches up.

---

## What's Next

Phase 14 builds the display — the output side of I/O. A frame buffer with two independent address registers, a scanner goroutine that reads pixels at 30fps, and a `DisplayAdapter` that handles its own two-phase write protocol at device address `0x0007`.
