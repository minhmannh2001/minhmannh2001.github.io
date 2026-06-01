---
layout: post
title: "Building a Computer from Scratch — Part 17: The Assembler"
date: 2026-05-27 08:00:00 +0700
excerpt: >
  After 16 phases of hardware, the computer can run programs — but only if you write them in raw binary. This final part adds an assembler that translates human-readable instructions into the binary the CPU executes, then runs the whole thing.
comments: true
---

After 16 phases, we have a complete 16-bit computer: CPU, 64K of RAM, a keyboard, a display, and a bus connecting them all. The hardware works. What it can't do yet is run a program that a human could write without going mad.

A program for this computer is a sequence of 16-bit numbers loaded into RAM at address `0x0500`. An instruction like "add register 0 and register 1" encodes as `0x0080`. A jump to some address requires two consecutive words. You have to know the opcode table, calculate every address by hand, and recount everything every time you insert or remove one instruction.

For a three-line test, this is annoying. For any real program — say, a keyboard-driven text renderer with subroutines and loops — it's impossible to maintain without tooling.

This phase adds the assembler: a program that reads instructions written like `ADD R0, R1` and `JMP loop` and produces the binary the CPU executes. Then we wire everything together and run it.

---

## Where This Fits

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
  Part 17 → Assembler & Running It  ← you are here
```

Parts 1–16 were all hardware: logic gates, storage cells, arithmetic circuits, control logic, I/O. Part 17 is the first software layer — a program that translates what programmers write into what the hardware executes.

```
[Assembly source]  ← what the programmer writes
        │
        ▼
  [Assembler]      ← what this phase builds
        │ binary words
        ▼
  [Computer]       ← Parts 1–16
        │
   CPU + RAM + Keyboard + Display
```

> **Source code:** [github.com/minhmannh2001/simple-computer](https://github.com/minhmannh2001/simple-computer) — all 18 phases implemented in Go.

> **Reading along with the book?** This phase covers the instruction mnemonic tables and chapters "Hardware and Software", "Programs", and "Languages" from _But How Do It Know?_ by J. Clark Scott.

---

## The Problem with Writing Binary

Here's what a short loop looks like in raw binary:

```
; load the value 3 into R0, then count down to zero
0x0200   ; DATA R0, (next word)
0x0003   ; value: 3
0x0098   ; NOT R0 — we'll use this later as a check
0x0040   ; JMP (next word is the address)
0x0502   ; jump to address 0x0502
```

Insert one instruction before that JMP and the target address `0x0502` is now wrong. You have to find every jump in the file and update it by hand. For a program with twenty subroutines and fifty jumps, that's unmaintainable.

The assembler lets you write this instead:

```
main:
  DATA R0, 3
  NOT  R0
  JMP  main
```

It calculates where `main` lives, replaces the label name with the actual address, and gets it right no matter how many times the program changes.

---

## Two Passes: Why One Isn't Enough

When the assembler reads `JMP main` near the top of a file, it doesn't know the address of `main` yet — that label might be defined fifty instructions later. A single pass through the file can't work.

The solution is two passes:

**Pass 1 — measure.** Walk every instruction. Count how many binary words each one takes. When you hit a label definition like `main:`, record the current position as that label's address. Don't emit anything — just build a map of name → address.

**Pass 2 — emit.** Walk again. For each instruction, look up any labels it references in the map from pass 1, then write out the binary words.

A `JMP main` in pass 2 finds `main` in the label table, gets back `0x0500`, and writes `[0x0040, 0x0500]`. Forward or backward reference — doesn't matter, because the full map is already built before a single word is emitted.

---

## One Non-Obvious Instruction: CALL

The CPU has no built-in "call a subroutine and return" mechanism. The assembler provides it as a convenience that expands into two real instructions:

```
CALL myRoutine

; expands to:
DATA R3, <return address>   ; put return address in register 3
JMP  myRoutine              ; jump to the routine
```

Register 3 holds the return address by convention. The routine ends with `JR R3` — jump to whatever address R3 holds — which sends execution back to the instruction immediately after the original `CALL`.

`CALL` has `Size() = 4` — two words for `DATA R3` and two for `JMP`. The assembler uses this to calculate the return address during pass 2.

Here's the key detail: `NEXTINSTRUCTION` is not computed once — it's re-injected into the symbol table **before every instruction is emitted**:

```go
for i, ins := range instructions {
    currentOffset := position + codeStartOffset
    symbols[CURRENTINSTRUCTION] = currentOffset
    symbols[NEXTINSTRUCTION] = currentOffset + ins.Size()  // recomputed each time

    words, _ := ins.Emit(resolveLabel, resolveSymbol)
    output = append(output, words...)
    position += ins.Size()
}
```

`CALL.Emit()` reads `NEXTINSTRUCTION` from the symbol resolver at emit time. Because it's freshly set to `currentOffset + 4` for this specific `CALL`, the return address is always the instruction immediately after this particular call — not some global value.

If `NEXTINSTRUCTION` were computed once at the start of pass 2, every `CALL` in the program would emit the same wrong return address.

---

## The Bitmap Font: How Characters Become Pixels

Each printable character is stored as eight 16-bit rows. Each row is a bitmask where each bit represents one pixel — bit 7 is the leftmost pixel of an 8-pixel-wide glyph, bit 0 is the rightmost:

```go
'A': [8]uint16{
    0x007C,  // 0 1 1 1 1 1 0 0  — top row
    0x00C6,  // 1 1 0 0 0 1 1 0
    0x0082,  // 1 0 0 0 0 0 1 0
    0x00FE,  // 1 1 1 1 1 1 1 0  — crossbar
    0x0082,  // 1 0 0 0 0 0 1 0
    0x0082,  // 1 0 0 0 0 0 1 0
    0x0082,  // 1 0 0 0 0 0 1 0
    0x0000,  // (padding row)
}
```

These eight rows need to live in RAM so the CPU can read them at draw time. The address of a character's row `r` is:

```
address = (charCode << 3) + r
```

Shifting left by 3 is multiplying by 8 — it packs the 8 rows of each character into a contiguous 8-word block. Character `A` (ASCII 65) lives at addresses `65 × 8 = 520` through `527` (`0x208`–`0x20F`). Character `space` (ASCII 32) lives at `32 × 8 = 256` through `263`.

This is the `ROUTINE-init-fontDescriptions` subroutine — it runs once at startup and writes every character's 8 rows into RAM using `ST` instructions. The assembly for one character looks like:

```asm
DATA R0, 0x208      ; address of 'A' row 0 = 65*8 + 0
DATA R1, 0x7C       ; pixel data for row 0
ST   R0, R1
DATA R0, 0x209      ; row 1
DATA R1, 0xC6
ST   R0, R1
...                 ; repeat for all 8 rows
```

Because the generator writes this programmatically, the assembled output contains hundreds of these `DATA`/`ST` pairs — one block per character.

---

## How `ROUTINE-io-drawFontCharacter` Works

This routine reads the keycode from a memory location (`KEYCODE-REGISTER` at address `0x0401`), looks up the glyph, and writes 8 rows of pixels to the display adapter. Step by step:

**1. Calculate the glyph's base address.**
The keycode is in R3. Three left-shift operations multiply it by 8:

```asm
DATA R3, %KEYCODE-REGISTER
LD   R3, R3          ; load keycode into R3
SHL  R3              ; R3 = keycode * 2
SHL  R3              ; R3 = keycode * 4
SHL  R3              ; R3 = keycode * 8  ← base address of glyph
```

**2. Select the display adapter.**
The display lives at I/O device address `0x0007`. `OUT Addr` sends that address on the IOBus, telling the display adapter "I am about to talk to you":

```asm
DATA R3, %DISPLAY-ADAPTER-ADDR   ; 0x0007
OUT  Addr, R3
```

**3. Loop over 8 rows.**
A loop counter (`fontY`) starts at 0 and counts up to 7. On each iteration:
- Add the counter to the glyph base address to get the RAM address of this row.
- Load the pixel data from that address (`LD R3, R0`).
- Write to the display adapter with two `OUT Data` instructions: first the display cell address (where to write), then the pixel data (what to write). This is the two-phase write protocol the display adapter expects.
- Add the line width (30 cells per row) to the display cell address to move to the next row.

```asm
ROUTINE-io-drawFontCharacter-STARTLOOP:
  ; base + fontY = glyph row address in RAM
  LD   R3, R0          ; load pixel data for this row
  OUT  Data, R2        ; phase 1: display cell address (pen position)
  OUT  Data, R0        ; phase 2: pixel data
  ADD  R1, R2          ; pen position += LINE-WIDTH (move down one row on screen)
  ; increment fontY, compare to 7, loop or exit
  JMPE ROUTINE-io-drawFontCharacter-ENDLOOP
  JMP  ROUTINE-io-drawFontCharacter-STARTLOOP
```

**4. Advance the cursor.**
After drawing all 8 rows, the pen position advances by 1 (one cell to the right). When it reaches the end of the line (column 30), the routine performs a carriage return: it moves the pen to the start of the next line and resets the column counter to 0.

**5. Deselect the display adapter.**
```asm
XOR  R3, R3
OUT  Addr, R3          ; put 0x0000 on IOBus address — deselect all
```

---

## The `text-writer` Program Flow

The text-writer is the most interactive demo. Its top-level loop is three lines:

```asm
main-getInput:
  CALL ROUTINE-io-pollKeyboard
  CALL ROUTINE-io-drawFontCharacter
  JMP  main-getInput
```

`ROUTINE-io-pollKeyboard` selects the keyboard adapter with `OUT Addr, 0x000F`, then spins reading `IN Data` until a non-zero keycode arrives. When a key is pressed, the keycode is written to the `KEYCODE-REGISTER` memory cell and the keyboard adapter is deselected:

```asm
ROUTINE-io-pollKeyboard-STARTLOOP:
  IN   Data, R3        ; read keycode from keyboard adapter
  AND  R3, R3          ; set Zero flag if R3 == 0
  JMPZ ROUTINE-io-pollKeyboard-STARTLOOP  ; keep polling if no key pressed
; fall through: R3 now holds a non-zero keycode
  DATA R0, %KEYCODE-REGISTER
  ST   R0, R3          ; save keycode for drawFontCharacter to read
  XOR  R2, R2
  OUT  Addr, R2        ; deselect keyboard
```

The program also handles backspace (key code `0x103`): if the keycode matches, it calls `ROUTINE-io-backspace` which clears the current character cell on screen and moves the pen position back by one.

---

## The `CALL` Convention

The CPU has no call stack. `CALL` is an assembler pseudo-instruction that expands to two real instructions:

```asm
CALL myRoutine

; expands to:
DATA R3, <returnAddress>   ; R3 = address of next instruction
JMP  myRoutine
```

Inside the routine, the first thing it does is save R3 (which contains the return address) to a memory slot called `CALL-RETURN-ADDRESS` (`0xFF33`):

```asm
DATA R2, %CALL-RETURN-ADDRESS
ST   R2, R3              ; save return address to RAM
```

At the end of the routine, it loads that address back and jumps to it:

```asm
CLF                          ; clear flags before returning
DATA R3, %CALL-RETURN-ADDRESS
LD   R3, R3                  ; load return address from RAM
JR   R3                      ; jump to R3 (return)
```

`CLF` (opcode `0x0060`) resets all four flags — Carry, A-larger, Equal, Zero — to zero. Instructions like `ADD` and `CMP` leave flag state behind. If those flags survive the return, a `JMPF` in the caller might branch on a stale result from inside the routine. Clearing flags before `JR R3` prevents that.

This convention is entirely in software — the hardware has no idea it's a "call." R3 and `0xFF33` are just registers and RAM cells. The limitation is that routines can't call other routines that use the same convention without overwriting the return address — the examples handle this by saving and restoring carefully.

---

## Running the Computer

The assembler produces a flat binary file — a sequence of 16-bit words. Two more tools connect it to the hardware simulation.

**`cmd/assembler`** reads a `.asm` source file and writes a `.bin` binary, ready to load into RAM.

**`cmd/simulator`** loads a `.bin`, initializes the computer, opens a GLFW window for the display, hooks up keyboard events, and runs the CPU clock in a goroutine. The CPU runs as fast as Go can drive it — roughly 6KHz on a modern machine — while the display redraws at 30fps.

The four example programs:

| Program | What it does |
|---------|-------------|
| `text-writer.bin` | Type characters; they render on screen using a bitmap font |
| `ascii.bin` | Walks the full printable ASCII table and renders every character — no keyboard needed |
| `brush.bin` | Arrow keys move a single pixel around the screen |
| `me.bin` | Static display — writes a name card to screen and stops |

To build and run:

```bash
make                   # build all tools
make programs          # assemble the example programs
./bin/simulator -bin _programs/text-writer.bin
```

Requirements: Go 1.18+, GLFW 3.2, OpenGL 3.2 (macOS: comes with Xcode CLT).

---

## What I Took Away

- **Two-pass assembly exists because of forward references.** A single pass can't resolve `JMP end` when "end" is defined at the bottom of the file. Pass 1 measures everything; pass 2 emits with full knowledge. The same structure appears in any system where you use something before you define it.
- **CALL is software, not hardware.** The CPU has no call stack. The convention — store return address in R3, jump, return with `JR R3` — is entirely a software convention enforced by the assembler's expansion. It's a useful reminder that "calling a function" is not a hardware primitive.
- **6KHz is both shockingly slow and shockingly fast.** A real 1980s 8-bit computer ran at 1–4MHz. Our simulation runs at ~6KHz — 100× slower than a Commodore 64. But it's fast enough to run all four example programs interactively, because the programs are small and the simulated CPU has no memory latency.
- **The assembler is the first end-to-end test.** Before this phase, every test operated at the Go level — calling functions directly. The assembler's tests are the first place where you write something that looks like a real program and verify the binary output. Bugs invisible in unit tests — like a label formatter missing its trailing colon — only surfaced here.

---

## The Complete Picture

Seventeen phases, built layer by layer:

| Layer | What we built |
|-------|--------------|
| Gates | NAND → AND, OR, NOT, XOR, NOR |
| Storage | Bit latch → Word → Register |
| Arithmetic | Half adder → Full adder → 16-bit ripple-carry |
| Logic | Enabler, Shifters, Comparator, BusOne |
| Decode | 2-to-4 → 8-to-256 decoder |
| Memory | Cell → 64K (256×256 grid) |
| ALU | 8 operations, 4 flags (Carry, A-larger, Equal, Zero) |
| Control | Stepper (6-step), CPU (fetch-decode-execute) |
| I/O | IOBus, KeyboardAdapter, DisplayAdapter |
| Software | Assembler (two-pass), CALL pseudo-instruction |
| System | SimpleComputer, GLFW simulator |

The whole thing starts from a `Wire` — a named boolean — and ends at a window on your screen where you can type characters and watch them render, driven by a CPU built from logic gates in Go.

The book this series is based on, _But How Do It Know?_ by J. Clark Scott, remains one of the clearest explanations of how computers actually work. If this series made sense, the book will too — and it goes deeper on the "why" behind the instruction set design.
