---
layout: post
title: "Building a Computer from Scratch — Part 14: Display"
date: 2026-05-23 20:30:00 +0700
excerpt: >
  Adding a 4,800-cell frame buffer with two independent address registers, a two-phase write protocol, and a 30fps scanner goroutine that never touches the CPU's bus.
comments: true
---

Parts 1–13 built everything needed to compute and communicate: wires, gates, storage, a shared bus, bitwise operations, a 16-bit adder, registers, a stepper, an ALU, 64K of RAM, and a keyboard. The keyboard solved input — press a key, get a value on the bus. This phase solves output.

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
  Part 14 → Display                  ← you are here
  Part 15 → The CPU
  Part 16 → The Complete Computer
  Part 17 → Assembler & Running It
```

> **Reading along with the book?** This phase covers "The Display Screen" from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage + Bus + Ops ]
      ↓
[ Register + Stepper + ALU + RAM ]
      ↓
[ I/O Bus + Keyboard + Display ]   ← Part 14
      ↓
[ CPU ]                            ← next
      ↓
[ Computer ]
```

---

## The Two Consumers Problem

The keyboard has one job: when the control logic asks, deliver a keycode. One device, one reader, one moment. The display is different. Two completely separate things need to access the same memory — and they don't take turns.

The **control logic** writes pixels in arbitrary order. A program might update cell 500, then cell 2, then cell 3001 — in whatever order the program dictates. It needs random write access to any of the 4,800 cells in the frame buffer on demand.

The **screen scanner** reads sequentially and on a timer. Every 33 milliseconds it marches through every cell in order — cell 0, cell 1, cell 2, all the way to cell 4,799 — and turns the values into visible pixels.

If they shared a single address register, chaos would follow. The scanner is stepping through cells 0, 1, 2... and the control logic redirects the pointer to write cell 500. Now the scanner jumps to 500 and resumes from there. Pixels land in wrong positions. The image tears.

The solution is two completely independent address registers: one owned by the control logic (write pointer), one owned by the scanner (read pointer). They never interfere because they are separate hardware — two registers pointing into the same flat array of 4,800 cells.

---

## The Frame Buffer Layout

The display is 240 pixels wide and 160 pixels tall — 38,400 pixels total. Each cell in the frame buffer is a 16-bit word, and each word holds 8 pixels packed into the high byte: bit 15 is the leftmost pixel in the group, bit 8 is the rightmost. The low byte is unused. 38,400 pixels ÷ 8 pixels per cell = 4,800 cells, which is a comfortable fit in a flat array.

The scanner extracts pixels by walking the bit positions from 15 down to 8. Bit 15 set means the leftmost pixel in that group is on. Bit 8 set means the rightmost is on. The result is a `[160][240]byte` frame — one byte per pixel, either `0x01` (on) or `0x00` (off) — pushed to a channel that the renderer reads.

---

## The Two-Phase Write Protocol

Writing a pixel takes two successive operations. The control logic can't send address and data simultaneously on a single 16-bit bus — so it sends them in separate phases, with a single-bit latch called `writeToRAM` tracking which phase is active.

**Phase 1** (`writeToRAM = false`): the bus carries the target cell address. The input address register latches it. The toggle flips to true.

**Phase 2** (`writeToRAM = true`): the bus carries the pixel data. The cell at the latched address is written. The toggle flips back to false.

This protocol has an important property: it is enforced by convention, not structurally. If the control logic sends two data values in a row and skips the address phase, the hardware doesn't crash — it just writes both values to the same cell. The toggle latch prevents one specific mistake (going from data directly to data without updating the address), but not all misuse. The hardware trusts the programmer to follow the two-phase sequence.

---

## The Display RAM is Separate from Main Memory

The keyboard introduced the I/O bus to keep memory and peripherals from fighting over the same channel at the same time. The display takes this further: it has its own RAM entirely.

The scanner goroutine reads from the frame buffer's cell array directly, without touching the main bus at all. The control logic writes to display RAM via the I/O bus peripheral protocol, at device address `0x0007`. They never share a bus cycle. This decoupling is what lets the scanner run at 30fps independently of whatever the CPU is doing — whether it's executing an ADD instruction, reading from keyboard, or writing a new pixel.

The `ScreenControl` goroutine owns its own clock: a 33-millisecond ticker. Each tick it scans all 4,800 cells and pushes the completed frame to an output channel. If the consumer (the renderer) is slow and hasn't read the last frame yet, the new frame is dropped rather than blocking the scanner. Frames can be lost; the scanner never stalls.

---

## GLFW and OpenGL: the Rendering Layer

The simulation renders the display using two Go libraries from the `go-gl` family:

- **`github.com/go-gl/glfw/v3.2/glfw`** — creates the OS window and handles keyboard and close events.
- **`github.com/go-gl/gl/v3.2-compatibility/gl`** — wraps OpenGL for drawing.

The window is 240×160 pixels — exactly one pixel per display cell — created with:

```go
glfw.WindowHint(glfw.Resizable, glfw.False)
window, _ := glfw.CreateWindow(240, 160, title, nil, nil)
window.MakeContextCurrent()
gl.Init()
```

`DrawFrame` receives a pointer to a `[160][240]byte` frame snapshot and renders it using `GL_POINTS`. Each pixel becomes one OpenGL point:

```go
gl.Ortho(0, 240, 160, 0, -1, 1)   // map pixels to screen coords
gl.PointSize(2.0)
gl.Begin(gl.POINTS)
for y := 0; y < 160; y++ {
    for x := 0; x < 240; x++ {
        if screenData[y][x] > 0 {
            gl.Color3ub(220, 220, 220) // "on" pixel: light gray
        } else {
            gl.Color3ub(50, 50, 50)    // "off" pixel: dark gray
        }
        gl.Vertex2i(int32(x), int32(y))
    }
}
gl.End()
glfw.PollEvents()
window.SwapBuffers()
```

The coordinate origin is top-left (row 0, column 0 = top-left corner), and the projection matrix maps pixel indices directly to screen coordinates with no scaling.

**Why `runtime.LockOSThread()`?**
GLFW requires all OpenGL calls to happen on the OS thread that created the window — the main thread. Go's runtime may move goroutines between OS threads freely, so `init()` in the simulator calls `runtime.LockOSThread()` to pin the main goroutine to its OS thread for the lifetime of the process. The CPU and keyboard run in separate goroutines and never call GLFW or OpenGL.

---

## The Goroutine Architecture

The simulator runs three concurrent execution paths:

```
Main goroutine (OS thread, locked)
  └── glfw.Run() — polls OS events, redraws at 33ms tick

CPU goroutine
  └── comp.Run(time.Tick(1ns)) — steps CPU clock as fast as Go allows (~6KHz)

ScreenControl goroutine
  └── time.NewTicker(33ms) — scans displayRAM → pushes frame to channel
```

The channel between `ScreenControl` and the main goroutine has capacity 1. If the GLFW loop hasn't consumed the last frame when a new one arrives, the scanner drops the new frame rather than blocking:

```go
select {
case s.outputChan <- &frame:
default:   // drop if channel is full
}
```

This means the CPU never stalls waiting for the display to catch up. The visual effect is a slightly missed frame — imperceptible at 30fps.

The channel in the other direction (keyboard) goes from the GLFW callback into the `Keyboard` goroutine. GLFW fires the callback synchronously on the main thread; the `Keyboard` goroutine drains it at 33ms ticks and writes the key code to the bus that the CPU reads.

---

## What I Took Away

- Two address registers solve a real concurrency problem without any synchronization primitives. The write pointer and read pointer are physically separate — they can't interfere because there is no shared state between them beyond the cell array itself.
- Packing 8 pixels per 16-bit word is a space-efficiency choice. The display is 240 pixels wide, which means 30 cells per row — a clean multiple that requires no padding.
- The toggle-bit protocol is simpler than it looks. "Two-phase write" sounds complex, but it's just a single bit that flips between "you're sending an address" and "you're sending data." The hardware for this is one NOT gate and one latch.
- Dropping frames rather than blocking is the right default for a display scanner. A stalled scanner would back-pressure the whole system. A dropped frame produces a slight visual stutter, which is acceptable.
- GLFW needs the main OS thread. This is the most non-obvious constraint in the whole simulator — it forces a specific goroutine layout where OpenGL stays on the locked main goroutine and all simulation work goes to separate goroutines.

---

## What's Next

Phase 15 wires all 14 previous components together into a CPU — a control unit that fetches instructions from RAM, decodes them, and drives the ALU, registers, memory, and I/O bus through the correct sequence of operations for each instruction type.
