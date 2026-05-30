---
layout: post
title: "Building a Computer from Scratch — Part 15: The CPU"
date: 2026-05-24 09:45:00 +0700
excerpt: >
  Wiring nine registers, a stepper, an ALU, and a control unit into a fetch-decode-execute machine that runs one instruction every six clock steps.
comments: true
---

Parts 1–14 built every component the CPU needs: storage primitives, a shared bus, bitwise and arithmetic operations, registers, a stepper, an ALU, RAM, and I/O. Each phase delivered one piece in isolation. This phase wires them all together into a control unit that can actually run a program.

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
  Part 15 → The CPU                  ← you are here
  Part 16 → The Complete Computer
  Part 17 → Assembler & Running It
```

> **Source code:** [github.com/minhmannh2001/simple-computer](https://github.com/minhmannh2001/simple-computer) — all 18 phases implemented in Go.

> **Reading along with the book?** This phase covers "The Other Half of the Computer" through "Ta Daa!" from _But How Do It Know?_ by J. Clark Scott.

---

## Where This Fits

```
[ Gates & Wires ]
      ↓
[ Storage + Bus + Ops ]
      ↓
[ Register + Stepper + ALU + RAM + I/O ]
      ↓
[ CPU ]        ← Part 15
      ↓
[ Computer ]   ← next
```

---

## The Loop That Everything Depends On

Before getting into registers and wires, it helps to have a mental model of what the CPU actually does, moment to moment.

Imagine a chef in a kitchen with a recipe binder. The process is always the same three steps:
1. **Fetch**: open the binder to the current page, read the recipe.
2. **Decode**: understand what the recipe is asking for — chop, boil, fry?
3. **Execute**: do it, then turn to the next page.

A CPU does the same thing with instructions. The "binder" is RAM. The "current page" is the address in the program counter (IAR). The "recipe" is a 16-bit instruction word. The CPU reads it, figures out what it means (which operation, which registers), does it, and advances the program counter.

This loop — fetch, decode, execute — repeats forever. There is no "main function" that the CPU calls. The loop *is* the CPU's entire job, running at roughly 6,000 cycles per second in this simulation.

The 6-step cycle in this computer maps directly to that model:

```
Steps 1–3 → Fetch  (same for every instruction)
Step 4     → Decode (determine what to do)
Steps 5–6  → Execute (do it, write result back)
```

---

## Nine Registers, Each with a Specific Role

The CPU holds nine registers. The number isn't arbitrary — each one exists to solve a specific problem in the fetch-decode-execute loop.

**General purpose: R0–R3.** The four registers programs actually use for computation and data. A program can freely read and write these.

**TMP** (temporary). When an ALU instruction like `ADD R0, R1` runs, the CPU needs to hold one operand while it fetches the other. TMP is the scratch pad for that. It's invisible to programs — no assembly instruction reads or writes TMP directly. It exists purely to give the control logic a place to park a value for one step.

**ACC** (accumulator). The ALU's output wire. Every ALU operation writes its result here. ACC exists because the ALU needs somewhere to put the result before the control unit decides where it goes next.

**IR** (instruction register). Holds the currently executing instruction — the 16-bit word fetched from RAM in step 2. The control unit reads individual bits of IR to decide which enables and sets to assert in steps 4–6.

**IAR** (instruction address register). The program counter. Holds the RAM address of the *next* instruction to fetch. Step 1 reads from IAR to tell RAM where to look; step 3 increments IAR by 1 so the next fetch gets the right address.

**FLAGS**. Four bits (carry, A-larger, equal, zero) written by the ALU on every operation. Conditional jump instructions read these bits to decide whether to actually jump.

---

## The Six-Step Cycle

Every instruction — no matter its type — executes in exactly six steps. The stepper from Phase 10 enforces this by activating exactly one step wire per half-clock-cycle.

Why six? Steps 1–3 are fixed overhead that every instruction needs (fetch the instruction, advance the program counter). The remaining three steps handle decode and execute. Six is the minimum that fits both halves without overlap. Making it variable-length — some instructions in 4 steps, some in 8 — would require the control logic to track how many steps remain per instruction. Six steps for everything keeps the control unit uniform: a fixed truth table, no counters.

```
Step 1: IAR → MAR         (put instruction address on bus, latch into MAR)
Step 2: RAM → IR          (fetch instruction from memory into IR)
Step 3: IAR + 1 → IAR     (advance the program counter by 1 via BusOne)
Step 4: decode & setup    (move operands into position based on opcode)
Step 5: execute           (run the ALU, or perform the memory/IO operation)
Step 6: writeback         (store result in destination register)
```

---

## Walking Through an Instruction

Abstract steps are easy to describe. What do they actually look like in gates and wires?

Let's trace `ADD R0, R1` — add the values in R0 and R1, store the result in R1. Suppose R0 = 5, R1 = 3, and this instruction lives at RAM address `0x0500`.

**Step 1 — Fetch address:**
IAR (= `0x0500`) enables onto the bus. MAR latches the bus value. Now MAR = `0x0500`. The bus is cleared.

**Step 2 — Fetch instruction:**
RAM reads cell at address `0x0500` (the MAR's value), finds the instruction word `0x0081` (the binary encoding of `ADD R0, R1`), and enables it onto the bus. IR latches the bus. Now IR = `0x0081`. The bus is cleared.

**Step 3 — Advance program counter:**
IAR (= `0x0500`) enables onto the bus. BusOne injects `0x0001` as a second input to the adder path. The result `0x0501` goes back into IAR. Now IAR = `0x0501`, ready for the next instruction.

At this point, steps 1–3 are identical for every instruction ever executed. The next three steps are where ADD diverges from, say, JMP or LD.

**Step 4 — Move Register B into TMP:**
The control unit reads IR bits 14–15 (`01`), decoding the B register as R1. R1 (value = 3) enables onto the bus. TMP latches the bus. Now TMP = 3. The bus is cleared.

*Why TMP?* The ALU needs two inputs simultaneously, but the bus can only carry one value at a time. TMP holds the first operand so the second operand can use the bus in the next step.

**Step 5 — Execute ALU:**
The control unit reads IR bits 12–13 (`00`), decoding the A register as R0. R0 (value = 5) enables onto the bus. The ALU receives: main bus = 5, TMP bus = 3, operation = ADD (decoded from IR bits 9–11). It computes 5 + 3 = 8. The result flows to ACC. Now ACC = 8.

**Step 6 — Write result back:**
ACC (= 8) enables onto the bus. R1 (the B register) latches the bus. Now R1 = 8. R0 is unchanged.

Final state after the instruction: R0 = 5, R1 = 8. The program counter already holds `0x0501` — the next instruction's address. The CPU is ready to fetch again without any reset or setup.

---

## The Stepper Index Shift

There is one non-obvious construction detail: the stepper offset.

The `Stepper` from Phase 10 bootstraps with step 0 already active before any `Update` call. The reference implementation in the book starts with all steps inactive — its first `Update` makes step 0 active. The net effect is a global shift: what the reference calls "step 0 fires on update 1" is what this implementation calls "step 0 is already active before update 1."

In practice this means every stepper index inside the CPU is offset by one: the reference's step[0] maps to `stepper.GetOutputWire(1)`, the reference's step[5] maps to `stepper.GetOutputWire(0)`. Once written down, the mapping is stable across all instructions. It is a construction-time decision, not a per-instruction quirk.

---

## Flags and the Double-Pass Pattern

The flags register is always enabled and always set. It reads ALU output flags after every operation — not just after a CMP instruction. This means conditional jump gates always see flags from the most recent ALU instruction, with no risk of stale state. The CLF instruction (clear flags) works by running a zero-producing ALU operation and letting the flags register latch the result normally.

The **double-pass enable/set** pattern appears throughout the CPU's Update sequence. The bus can only safely be written to by one component at a time. To move a value from component A to component B:

1. Assert A's enable — A drives its stored value onto the bus.
2. All components read the bus (including B).
3. De-assert A's enable — the bus returns to zero.
4. Assert B's set — B latches whatever the bus held.

Steps 2 and 3 happen before step 4 for a reason: if A's enable and B's set were asserted simultaneously, B might latch partial or conflicting bus values from other components that also respond to the set signal. De-asserting enable first guarantees the bus is stable before any component latches. This is a correctness requirement, not an optimization.

---

## What I Took Away

- A CPU is simpler than it sounds once the components exist. The control unit is mostly a truth table: for each (step, opcode) pair, which enables and sets fire? The gates implement the table; the stepper advances it.
- Six steps for every instruction — even a single-register NOT — is wasteful by modern standards, but makes the control logic completely uniform. There is no variable-length instruction timing to reason about.
- TMP and ACC exist because the bus can only carry one value at a time. TMP parks the first operand; ACC parks the result. Without them, ALU instructions would require two simultaneous bus transfers, which a single shared bus can't do.
- The flags register updating on every ALU instruction (not just CMP) means flags always reflect the most recent computation. Programs never need to clear flags before an operation — the next operation overwrites them automatically.
- The stepper index shift looks alarming when you first encounter it, but it is self-consistent. Writing it down once and applying it uniformly is exactly the right approach.

---

## What's Next

Phase 16 bolts all 15 components together into a complete computer: CPU plus RAM plus keyboard plus display, a memory map that divides the 65K address space into named regions, a sentinel jump at the top of memory so programs that run off the end restart cleanly, and a clock loop that drives everything forward.
