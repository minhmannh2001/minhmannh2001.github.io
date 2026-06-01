---
layout: post
title: "Building a Computer from Scratch — Part 18: Putting It All Together"
date: 2026-05-29 00:00:00 +0700
excerpt: >
  The three pieces that turn Go packages into a running simulator: a program generator that writes assembly from code, a bug that only appeared end-to-end, and a three-goroutine simulator that drives everything.
comments: true
---

After 17 phases — from a single NAND gate to a fully-wired computer with CPU, RAM, keyboard, display, and assembler — it's time to run the thing.

Part 17 covered the assembler and the programs themselves. This post covers the three pieces that make those programs actually runnable: the **generator** (how programs are built from Go code rather than hand-written assembly), a **subtle bug** that only surfaced end-to-end, and the **simulator** (the goroutine architecture that drives CPU, display, and keyboard concurrently).

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
  Part 16 → The Complete Computer
  Part 17 → Assembler & Running It
  Part 18 → Putting It All Together   ← you are here
```

> **Source code:** [github.com/minhmannh2001/simple-computer](https://github.com/minhmannh2001/simple-computer) — all 18 phases implemented in Go.


---

## Why Generate Assembly Instead of Writing It?

The four example programs (text-writer, ascii, brush, me) all share substantial infrastructure: a subroutine that loads the entire bitmap font into RAM, one that polls the keyboard, one that draws a character to the display. Hand-writing these in `.asm` files would mean copying them four times — or maintaining a single `.asm` file that every program includes, which the assembler doesn't support.

The generator solves this with a different approach: write programs as Go code using the same `asm.Instructions` builder used in tests, then call `String()` to emit the assembly source file.

```go
// The top-level of text-writer — everything else is shared subroutines
instructions.Add(asm.DEFLABEL{"main"})
instructions.AddBlocks(updatePenPosition(0x00F0))
instructions.Add(asm.DEFLABEL{"main-getInput"})
instructions.AddBlocks(
    callRoutine("ROUTINE-io-pollKeyboard"),
    callRoutine("ROUTINE-io-drawFontCharacter"),
)
instructions.Add(asm.JMP{asm.LABEL{"main-getInput"}})
```

The shared infrastructure — font loader, keyboard poller, display writer — is emitted once by `initialiseCommonCode()` and included in every program. The program-specific code defines `main` and any unique logic. Everything else is a Go function call.

This means adding a new program doesn't mean copying infrastructure. It means writing a small Go function that calls the shared builders, then running the generator. The assembler never needs to know that multiple programs were produced from the same shared code.

---

## How the Keyboard Actually Sends Data to the CPU

The poll loop in assembly looks like this:

```asm
OUT  Addr, R2        ; select keyboard adapter (address 0x000F)
loop:
  IN   Data, R3      ; read keycode
  AND  R3, R3        ; set Zero flag if nothing pressed
  JMPZ loop          ; keep waiting
ST   KEYCODE-REGISTER, R3
XOR  R2, R2
OUT  Addr, R2        ; deselect keyboard
```

What actually happens at the hardware level is less obvious than it looks.

**`OUT Addr, 0x000F` — selecting the adapter.** The CPU puts `0x000F` on the main bus and signals the IOBus with `SET + ADDRESS_MODE`. The `KeyboardAdapter` watches the main bus on every clock cycle. When it sees the address `0x000F` (bits 8–11 = 0, bits 12–15 = 1) alongside the right IOBus signals, it latches a single bit — `memoryBit = 1` — meaning "I am selected." Nothing else happens yet.

**`IN Data, R3` — reading the data.** The CPU switches the IOBus to `ENABLE + DATA_MODE`. The adapter checks: is `memoryBit` set? Is the enable signal active? If both are true, it calls `keycodeRegister.Enable()`, which pushes the register's current value onto the main bus. The CPU reads the main bus and stores it in R3.

The key insight is that the keyboard doesn't "send" anything on demand. A separate goroutine — `Keyboard.Run()` — listens to a Go channel for key events and calls `KeyboardInBus.SetValue(keycode)` continuously whenever a key is held. The `keycodeRegister` inside the adapter has its input wired to `KeyboardInBus` at all times. So the keycode is already sitting in the register. `IN Data` just opens the gate to let that value flow onto the main bus where the CPU can read it.

When no key is pressed, `KeyboardInBus` holds 0. `IN Data` reads 0, `AND R3, R3` sets the Zero flag, `JMPZ` loops. When a key is pressed, `KeyboardInBus` holds the keycode. The next `IN Data` reads a non-zero value, the Zero flag is clear, and the loop exits.

---

## A Bug That Only Appeared End-to-End

Every individual component in this project had unit tests. The assembler parsed correctly. The instruction types emitted correct binary. The simulator loaded `.bin` files correctly. And yet when the generator was first wired up, the programs wouldn't assemble.

The root cause was two `String()` methods that were individually correct but violated a round-trip contract:

- `SYMBOL{Name: "LINEX"}.String()` returned `"LINEX"` — but the assembler's parser expects `"%LINEX"` for symbols.
- `DEFLABEL{Name: "start"}.String()` returned `"start"` — but the parser's label regex requires a trailing colon: `"start:"`.

Both bugs were invisible in unit tests. The unit tests called `Emit()` directly, bypassing `String()` entirely. Only when the generator wrote assembly source and the assembler tried to parse it did the mismatch appear.

The lesson: `String()` methods on instruction types must be **round-trip safe** — the output must be parseable by the same parser that reads `.asm` files. A pipeline that skips the `String()` → `Parse()` round-trip in tests creates a class of bugs that can only be found by running the system end-to-end.

---

## The Three-Goroutine Simulator

The simulator is a thin wrapper around `SimpleComputer`, but its goroutine layout reflects a real concurrency constraint.

```
Main goroutine (OS thread, locked)
  └── GLFW event loop — handles keyboard, window close, renders frames

CPU goroutine
  └── time.Tick(1ns) → comp.Step() — runs as fast as Go allows (~6KHz)

ScreenControl goroutine
  └── time.Tick(33ms) → scan 4800 cells → push frame to channel
```

**Why does the main goroutine have to be the GLFW thread?** GLFW requires all OpenGL calls to happen on the OS thread that created the window. Go's scheduler moves goroutines between OS threads freely. If the GLFW event loop ran in a regular goroutine, Go could silently migrate it to a different OS thread between calls — causing a crash or undefined behavior in OpenGL. `runtime.LockOSThread()` in `init()` pins the main goroutine to its OS thread for the lifetime of the process.

**Why does the CPU run in a separate goroutine?** The CPU clock loop runs at maximum throughput — `time.Tick(1ns)` is effectively "as fast as the scheduler allows." If the CPU ran on the main goroutine, it would block the GLFW event loop, making the window unresponsive and stopping keyboard input from being processed.

**The frame channel has capacity 1.** When the ScreenControl goroutine produces a new frame faster than the GLFW loop consumes it, the new frame is dropped rather than blocking:

```go
select {
case s.outputChan <- &frame:
default:   // drop if channel is full — scanner never blocks
}
```

A dropped frame produces a slight visual stutter at most. A blocked scanner would stall the CPU goroutine (because ScreenControl and the CPU share timing resources) and make the whole simulation slow. The right trade-off is always: drop frames, never stall the CPU.

---

## Building and Running

```bash
# Build all tools
make

# Generate and assemble the example programs
make programs

# Run the text-writer (type ASCII characters to see them rendered)
./bin/simulator -bin _programs/text-writer.bin

# Walk through the full ASCII table automatically
./bin/simulator -bin _programs/ascii.bin

# Move a pixel brush with arrow keys
./bin/simulator -bin _programs/brush.bin
```

Requirements: Go 1.18+, GLFW 3.2, OpenGL 3.2 (macOS: comes with Xcode CLT).

---

## What I Took Away

- Generating assembly from Go rather than hand-writing it isn't a shortcut — it's the only practical way to share subroutine code across multiple programs without duplication. The assembler stays simple (no `#include`); the generator handles composition.
- `String()` methods that aren't round-trip safe create an entire class of bugs invisible to unit tests. The fix is either to test the `String()` → `Parse()` pipeline explicitly, or to generate through `Emit()` rather than `String()`.
- `runtime.LockOSThread()` is the non-obvious requirement for any Go program that uses GLFW. Forgetting it produces crashes that look random because goroutine migration is non-deterministic.
- Frame dropping is the right default for display output. Stalling the scanner to wait for the renderer would back-pressure the CPU. A missed frame is imperceptible at 30fps; a stalled CPU makes everything feel laggy.

---

## The Complete Picture

Seventeen phases, one complete 16-bit computer built from NAND gates up:

| Layer | What we built |
|-------|--------------|
| Gates | NAND → AND, OR, NOT, XOR, NOR |
| Storage | Bit latch → Word → Register |
| Arithmetic | Full adder → 16-bit ripple-carry |
| Logic | Enabler, Shifters, Comparator, BusOne |
| Decode | 2-to-4 → 8-to-256 decoder |
| Memory | Cell → Memory64K (256×256 grid) |
| ALU | 8 operations, 4 flags (Carry, A-larger, Equal, Zero) |
| Control | Stepper (6-step), CPU (fetch-decode-execute) |
| I/O | IOBus, KeyboardAdapter, DisplayAdapter, ScreenControl |
| Software | Assembler (two-pass), Parser, Generator |
| System | SimpleComputer, GLFW simulator |

The whole thing starts from a `Wire` — a named boolean — and ends at a window on your screen where you can type characters and watch them render, driven by a CPU built from logic gates in Go.

<video width="100%" controls muted loop playsinline style="border-radius:6px;margin:1rem 0;">
  <source src="/img/simple-computer/demo.mp4" type="video/mp4">
</video>
