---
layout: post
title: "Building a Computer from Scratch — Part 16: The Complete Computer"
date: 2026-05-26 21:00:00 +0700
excerpt: >
  Connecting CPU, RAM, keyboard, and display into a single runnable machine — with a memory map, a sentinel jump, and a clock loop.
comments: true
---

Part 15 delivered a fully working CPU sitting next to a fully working RAM, a keyboard, and a display. None of them are connected to each other. This phase connects them. The components are finished; the computer isn't — until now.

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
  Part 13 → I/O Bus & Keyboard
  Part 14 → Display
  Part 15 → The CPU
  Part 16 → The Complete Computer     ← you are here
  Part 17 → Assembler & Running It
```

> **Reading along with the book?** This phase covers "Ta Daa!" (complete) and "A Few More Words on Arithmetic" from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage + Bus + Ops ]
      ↓
[ Register + Stepper + ALU + RAM + I/O + CPU ]
      ↓
[ SimpleComputer ]   ← Part 16
      ↓
[ Assembler ]        ← next (and final)
```

---

## Construction Order Is a Dependency Order

Building `SimpleComputer` is almost entirely wiring — there is no new hardware here. The interesting parts are which order things get connected, how the address space is divided, and what happens at the edges.

The construction sequence follows a strict dependency order:

1. **Bus** — must exist first. Both RAM and CPU share the same `*Bus` pointer — the same 16 physical wires in memory.
2. **RAM** — takes the bus pointer. Exposes `AddressRegister`, which the CPU needs to wire into its internal routing.
3. **CPU** — takes both the bus and RAM pointers. The CPU reaches into RAM to find `memory.AddressRegister` and sets it up as one of the registers it controls.
4. **Peripherals** — `ConnectPeripheral` wires the peripheral's detection gates into the CPU's I/O bus. Only works after the CPU exists.

Why does order matter? Consider constructing RAM before the Bus exists. RAM's constructor takes a `*Bus` — but the Bus doesn't exist yet, so the pointer is nil. RAM stores that nil pointer. The RAM object exists, but its bus reference is broken. This doesn't crash at construction time; Go is fine with a struct holding a nil pointer. It crashes at the first `Update()` call when RAM tries to read from that pointer.

Getting construction order right is the same as getting the dependency graph right. Writing it explicitly in the constructor is as much documentation as it is code.

---

## The Memory Map

The 16-bit address space spans 65,536 addresses. Rather than treating this as one undifferentiated block, `SimpleComputer` divides it into three regions by convention:

| Address range | Contents |
|---|---|
| `0x0000` – `0x04FF` | System space — display at `0x0007`, keyboard at `0x000F` |
| `0x0500` – `0xFEFD` | User code — programs load here |
| `0xFEFE` – `0xFFFF` | Sentinel zone |

`LoadToRAM` panics on writes outside the user region. This turns a logic error — "my program accidentally wrote to address `0x0003`" — into an immediate hard stop during loading rather than a mysterious failure at runtime. The convention is enforced structurally, not by hoping the programmer remembers it.

---

## The Sentinel Jump

When a program has no explicit loop — say, a program that prints a message and exits — the CPU keeps fetching instructions past the last one. The instruction pointer walks into whatever comes after the program: possibly uninitialized memory, possibly the addresses where the system space lives. Either way, unpredictable behavior.

The sentinel jump is the simplest possible solution. Before the clock starts, `Run()` writes two words to the sentinel zone:

- Address `0xFEFE`: the JMP opcode
- Address `0xFEFF`: the jump target `0x0500` (start of user code)

If the instruction pointer ever reaches `0xFEFE`, the CPU decodes a JMP and jumps back to `0x0500`, restarting the program. Clean behavior, no manual handling required.

Why not put this logic in the clock loop? The loop would have to inspect the CPU's internal state (the IAR register value) between steps to detect "we've gone out of range." That means the loop needs to know about CPU internals — a coupling that breaks the separation between the machine and its driver. The sentinel approach keeps the responsibility inside the machine itself. It costs two RAM words and is invisible to the programmer.

---

## The Clock Loop

`Run()` sets the instruction address register to `0x0500`, starts the screen scanner goroutine, then drives the clock:

```go
c.cpu.SetIAR(CODE_REGION_START)
go c.screenControl.Run()

for {
    select {
    case <-c.quitChannel:
        return
    case <-tickInterval:
        c.cpu.Step()
    }
}
```

`tickInterval` is a channel — the computer doesn't know or care how fast it runs. In the simulator, it's a `time.Tick` at the target clock rate. In tests, it's a manually-driven buffered channel that advances exactly N ticks, one at a time, so tests can inspect state between steps without any timing pressure. Neither changes `SimpleComputer`'s code.

The `quitChannel` lets external code stop the loop cleanly without global state or OS signals — just send on the channel.

---

## What I Took Away

- Construction order and dependency order are the same thing. A nil pointer stored in a struct doesn't crash at construction — it crashes at first use, far from the root cause. Spelling out the dependency order explicitly makes the constraint visible.
- The sentinel jump is the simplest possible solution to "what happens when a program ends." Two words of RAM, completely transparent to the programmer. Adding end-detection to the clock loop would add coupling; putting it in the machine keeps the machine self-contained.
- Separating clock speed from the machine (`tickInterval` as a channel) decouples the clock rate from the machine's logic. Tests step one instruction at a time; the simulator runs at maximum throughput. Neither requires changes to `SimpleComputer`.
- The memory map is a convention enforced at load time. A panic during loading is far more useful than silent corruption at runtime.

---

## What's Next

Phase 17 — the final phase — adds an assembler that translates human-readable mnemonics like `ADD R0, R1` or `JMP end` into the binary the CPU executes, plus a GLFW simulator to display the output in a real window. It is the piece that makes the machine programmable without counting bits by hand.
