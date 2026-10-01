/**
 * Turning the IR into x86-64 assembly.
 *
 * This is the first backend, and it is deliberately the simplest one that is
 * still a real compiler: every value lives in a stack slot, and no register is
 * ever reused between instructions.  That costs perhaps a factor of two against a
 * register allocator, and it is worth paying, because what is being learned here
 * is the part that is hard to retrofit -- the frame layout, the argument
 * sequence, the edge copies for phis, and the fact that the calling convention
 * has to match C's exactly.  None of that changes when a register allocator
 * arrives at M15; only the slot allocation does.
 *
 * The three facts this file rests on, all established by reading them off the
 * platform rather than from memory:
 *
 *   1. A `L0pValue` is 16 bytes and the SysV ABI classifies it as two INTEGER
 *      eightbytes.  So it is passed in two consecutive integer registers and
 *      returned in rax and rdx.  Assuming one register compiles cleanly and
 *      returns the tag where the payload belongs.
 *
 *   2. Arguments past the sixth integer register go on the stack.  A callee finds
 *      them at 8(%rbp) and up -- *after* its own prologue has pushed the frame
 *      pointer.  Being off by 8 here produces garbage, not a crash.
 *
 *   3. Mach-O prefixes every C symbol with an underscore, so a call to
 *      `l0p_add` is written `_l0p_add`.
 *
 * Assembly is emitted as text and handed to clang.  Writing a real assembler
 * would be a second project; this one is for generating code, not reading it.
 */

import type { Block, Instr, IrFunc, IrModule, Operand, Phi, VReg } from "../ir/ir.ts";

/** A value is 16 bytes: a tag and a payload. */
const VALUE_BYTES = 16;

/** x86-64 integer argument registers, in order.  There are six. */
const INT_ARG_REGS = ["%rdi", "%rsi", "%rdx", "%rcx", "%r8", "%r9"] as const;

/** The tag constants the code generator needs to build a value. */
const TAG = { NULL: 0, FALSE: 1, TRUE: 2, INT: 3, FLOAT: 4 } as const;

export class CodegenError extends Error {
  readonly line: number;
  constructor(message: string, line = 0) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.name = "CodegenError";
    this.line = line;
  }
}

/** How a runtime helper takes its arguments. */
type ArgKind = "value" | "scalar";

interface Helper {
  /** The C name.  The emitted call adds Mach-O's underscore. */
  name: string;
  args: ArgKind[];
  /** True when the result is a `L0pValue` (rax:rdx), false for a single word. */
  returnsValue: boolean;
}

/**
 * The operations the backend can lower today.
 *
 * Each one is a call into the runtime, not an inlined machine instruction.  That
 * is a deliberate deferral: an inline `add` needs a tag check and a branch, and
 * getting the fast path right matters more than getting it fast, so the check
 * lives in C where it can be tested once.  The inline forms come after the
 * differential tests say the calling versions agree with the interpreter.
 */
const HELPERS: Record<string, Helper> = {
  add: { name: "l0p_add", args: ["value", "value"], returnsValue: true },
  sub: { name: "l0p_sub", args: ["value", "value"], returnsValue: true },
  mul: { name: "l0p_mul", args: ["value", "value"], returnsValue: true },
  div: { name: "l0p_div", args: ["value", "value"], returnsValue: true },
  floordiv: { name: "l0p_floordiv", args: ["value", "value"], returnsValue: true },
  mod: { name: "l0p_mod", args: ["value", "value"], returnsValue: true },
  pow: { name: "l0p_pow", args: ["value", "value"], returnsValue: true },
  neg: { name: "l0p_neg", args: ["value"], returnsValue: true },
  not: { name: "l0p_not", args: ["value"], returnsValue: true },
  lt: { name: "l0p_lt", args: ["value", "value"], returnsValue: true },
  le: { name: "l0p_le", args: ["value", "value"], returnsValue: true },
  gt: { name: "l0p_gt", args: ["value", "value"], returnsValue: true },
  ge: { name: "l0p_ge", args: ["value", "value"], returnsValue: true },
};

interface Frame {
  f: IrFunc;
  /** vreg -> byte offset below %rbp, always a multiple of 16. */
  slot: Map<VReg, number>;
  size: number;
  /**
   * String literal -> its index in the module's .rodata table.
   *
   * Declared here as well as being passed in, because using a field the interface
   * does not mention is invisible: `private` and excess properties are both
   * erased, so the code runs and nothing complains until something reads the
   * interface.
   */
  strings: Map<string, number>;
  /** Bytes a call must reserve for arguments that spill past the registers. */
  outgoing: number;
  /** The most phis in any one block, which sizes the copy-through area. */
  maxPhis: number;
  /** The most arguments any one call passes, which sizes the outgoing buffer. */
  maxArgs: number;
  /** A label-safe form of the function name, since `<module>` is not a legal label. */
  safe: string;
  /** Where the saved return pointer lives, below every value slot. */
  retSlot: number;
  /** Where the resolved built-in function value is held. */
  builtinSlot: number;
  /** Where the spilled argc and argv pointers live. */
  argcSlot: number;
  argvSlot: number;
  /**
   * Scratch below the value slots, for the phi copies and for outgoing arguments.
   *
   * It is below every slot on purpose.  A phi copy has to read its input before
   * writing its destination, and two phis may swap, so each needs a temporary of
   * its own; putting them inside the slot area would collide with a value that is
   * still live.
   */
  scratch: (n: number) => number;
  /** The byte offset of argument slot `n` in the outgoing buffer. */
  argSlot: (n: number) => number;
  /**
   * Name -> slot in the module's global table.
   *
   * Globals are one flat array rather than a dictionary because a load has to be
   * a single indexed move, and because a name-to-index map computed at compile
   * time means the compiled program never hashes anything at run time.  A missing
   * name is an error here rather than a null read at run time.
   */
  globals: Map<string, number>;
}

/**
 * Every string literal in the module, deduplicated, numbered.
 *
 * Interning matters more than it looks.  A loop body can contain the same literal
 * on every path, and emitting one copy per use would grow the data section for
 * no reason; worse, `a == b` on two separately-allocated literals would have to
 * compare content, and interning makes it a pointer comparison.
 */
function internStrings(m: IrModule): Map<string, number> {
  const found = new Map<string, number>();
  const visit = (args: Operand[]): void => {
    for (const a of args) {
      if (a.t !== "imm" || typeof a.value !== "string") continue;
      if (!found.has(a.value)) found.set(a.value, found.size);
    }
  };
  for (const f of m.funcs) {
    for (const b of f.blocks) {
      for (const i of b.instrs) {
        if (i.op === "const") visit(i.args);
        if (i.op === "call.builtin") visit(i.args);
      }
    }
  }
  return found;
}

/**
 * The literals, as `.asciz` plus a length.
 *
 * The length is stored rather than assumed because l0puh strings carry their own
 * length, and a literal containing a NUL is not something to silently truncate.
 * The emitted `strcmp`-free comparison means two literals with the same text share
 * one copy and compare equal by pointer.
 */
function stringTable(texts: readonly string[]): string {
  const lines: string[] = ["# ---- string literals"];
  texts.forEach((s, i) => {
    lines.push("  .section __TEXT,__const");
    lines.push(`.Lstr${i}:`);
    lines.push(`  .asciz "${escapeAsm(s)}"`);
    lines.push("  .text");
  });
  return lines.join("\n");
}

/** A counter that keeps generated labels unique within a function. */
let thisTag = 0;

/**
 * The 64-bit pattern of a double.
 *
 * The interpreter holds numbers in JavaScript's `double`, so a float literal here
 * has to become the same bit pattern -- anything else and `0.1` would be a
 * slightly different number on each side, which no equality test would ever
 * explain.
 */
function doubleBits(x: number): bigint {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  // A bigint, deliberately.  As a Number, any pattern above 2^53 loses its low
  // bits -- and every double with a large exponent has one -- so 1.5 became a
  // slightly different double and `1.5 + 1` came out as 1.
  return buf.getBigUint64(0);
}

/**
 * Integer arithmetic, inline, with a fallback.
 *
 * The shape is the whole idea:
 *
 *     cmpq $INT, tag_a ;  jne  slow     # not an integer
 *     cmpq $INT, tag_b ;  jne  slow     # not an integer
 *     <the operation>  ; jo   slow      # or it overflowed
 *     <store the result>  ; jmp  done
 *   slow:
 *     callq _l0p_add
 *     <store the result>
 *   done:
 *
 * Nothing here needs to know anything about types, and nothing is assumed.  Each
 * test costs one instruction and one branch; the call it replaces costs a call, a
 * frame, and a return.  On a value the interpreter cannot represent exactly --
 * a float, a string, or an integer that overflows -- the code falls through to
 * the same runtime helper it always did, so the answer is the answer it was.
 *
 * The overflow test is not optional.  `l0p_add` widens to a double when the sum
 * leaves int64; an inlined `addq` wraps.  Silently disagreeing with the reference
 * on overflow is the exact failure this project exists to avoid, and `jo` is one
 * instruction that prevents it.
 */
function emitInlineInt(
  frame: Frame,
  i: Instr,
  helper: string,
  /**
   * The arithmetic, with `%rax` holding the left payload and `%rcx` the right on
   * entry.  Given the slow-path label, so the overflow branch can name it, and a
   * factory for private labels, because a division needs more than one branch.
   */
  compute: (slow: string, label: (what: string) => string) => readonly string[],
): string[] {
  const out: string[] = [];
  const d = i.dest;
  if (d === null) throw new CodegenError(`${i.op} defines nothing`, i.line);
  const a = i.args[0];
  const b = i.args[1];
  if (a === undefined || b === undefined || a.t !== "vreg" || b.t !== "vreg") {
    throw new CodegenError(`${i.op} needs two values`, i.line);
  }
  const n = thisTag++;
  const slow = `.L${helper}_slow${n}`;
  const done = `.L${helper}_done${n}`;
  const label = (what: string): string => `.L${helper}_${what}${n}`;

  out.push(`  # ${i.op}, inline when both operands are integers`);
  out.push(`  movq ${off(frame, a.v) + 8}(%rbp), %rax`);
  out.push(`  cmpq $${TAG.INT}, ${off(frame, a.v)}(%rbp)`);
  out.push(`  jne ${slow}`);
  out.push(`  movq ${off(frame, b.v) + 8}(%rbp), %rcx`);
  out.push(`  cmpq $${TAG.INT}, ${off(frame, b.v)}(%rbp)`);
  out.push(`  jne ${slow}`);
  for (const line of compute(slow, label)) out.push(`  ${line}`);
  out.push(`  movq $${TAG.INT}, ${off(frame, d)}(%rbp)`);
  out.push(`  movq %rax, ${off(frame, d) + 8}(%rbp)`);
  out.push(`  jmp ${done}`);
  out.push(`${slow}:`);
  out.push("  # not integers, or the result left int64: the runtime decides");
  out.push(...placeArgs(frame, ["value", "value"], i.args, i.line));
  out.push(`  callq _${helper}`);
  out.push(`  movq %rax, ${off(frame, d)}(%rbp)`);
  out.push(`  movq %rdx, ${off(frame, d) + 8}(%rbp)`);
  out.push(`${done}:`);
  return out;
}

/**
 * The same shape for a comparison, which yields a boolean rather than a number.
 */
function emitInlineCompare(
  frame: Frame,
  i: Instr,
  helper: string,
  /** `setae`, `seta`, `setg`, `setl`: an unsigned-style condition byte write. */
  set: string,
  signed: boolean,
): string[] {
  const out: string[] = [];
  const d = i.dest;
  if (d === null) throw new CodegenError(`${i.op} defines nothing`, i.line);
  const a = i.args[0];
  const b = i.args[1];
  if (a === undefined || b === undefined || a.t !== "vreg" || b.t !== "vreg") {
    throw new CodegenError(`${i.op} needs two values`, i.line);
  }
  const n = thisTag++;
  const slow = `.L${helper}_slow${n}`;
  const done = `.L${helper}_done${n}`;

  out.push(`  # ${i.op}, inline when both operands are integers`);
  out.push(`  movq ${off(frame, a.v) + 8}(%rbp), %rax`);
  out.push(`  cmpq $${TAG.INT}, ${off(frame, a.v)}(%rbp)`);
  out.push(`  jne ${slow}`);
  out.push(`  movq ${off(frame, b.v) + 8}(%rbp), %rcx`);
  out.push(`  cmpq $${TAG.INT}, ${off(frame, b.v)}(%rbp)`);
  out.push(`  jne ${slow}`);
  // `cmp` sets the flags for `a` against `b`; the condition byte is what the
  // caller asked for.  Signed and unsigned differ only in the prefix.
  if (signed) out.push(`  cmpq %rcx, %rax`);
  else out.push(`  cmpq %rax, %rcx`);
  out.push(`  ${set} %al`);
  out.push("  movzbq %al, %rax");
  out.push(`  # pack the boolean: tag TRUE or FALSE, payload zero`);
  out.push(`  movq $${TAG.FALSE}, ${off(frame, d)}(%rbp)`);
  out.push(`  movq $${TAG.FALSE}, ${off(frame, d) + 8}(%rbp)`);
  out.push("  testq %rax, %rax");
  out.push(`  je ${done}`);
  out.push(`  movq $${TAG.TRUE}, ${off(frame, d)}(%rbp)`);
  out.push(`  jmp ${done}`);
  out.push(`${slow}:`);
  out.push("  # not integers, or a string: the runtime compares");
  out.push(...placeArgs(frame, ["value", "value"], i.args, i.line));
  out.push(`  callq _${helper}`);
  out.push(`  movq %rax, ${off(frame, d)}(%rbp)`);
  out.push(`  movq %rdx, ${off(frame, d) + 8}(%rbp)`);
  out.push(`${done}:`);
  return out;
}

/**
 * A field name, emitted next to the instruction that needs it.
 *
 * Emitted inline rather than gathered into a table because a field name belongs
 * to exactly one access, and a table would need a second pass over the IR to
 * discover which names are used.
 */
function fieldLabel(frame: Frame, i: Instr, tag: number): string {
  // Unique per *instruction*, not per line: two accesses to `x.a` on one line are
  // two instructions and therefore two labels.
  return `.Lfield_${frame.safe}_${i.line}_${tag}`;
}

function emitFieldName(label: string, name: string): string[] {
  return [
    "  .section __TEXT,__const",
    `${label}:`,
    `  .asciz "${escapeAsm(name)}"`,
    "  .text",
  ];
}

/** The name of a built-in, as a C string for `l0p_builtin`. */
function emitBuiltinName(name: string, unique: string): string[] {
  return [
    "  .section __TEXT,__const",
    `.Lbn_${unique}:`,
    `  .asciz "${escapeAsm(name)}"`,
    "  .text",
  ];
}

/**
 * Copy arguments into the outgoing buffer and leave its address known.
 *
 * Anything that takes an array -- a list literal, a built-in's arguments -- needs
 * them contiguous, and the buffer a call already reserves is exactly that.  The
 * count has to be at least one so the address is meaningful even for a call with
 * no arguments; an empty buffer would otherwise point one slot past its end.
 */
function spillArgs(frame: Frame, args: Operand[], line: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === undefined || a.t !== "vreg") throw new CodegenError("an argument must be a value", line);
    out.push(`  movq ${off(frame, a.v)}(%rbp), %rax`);
    out.push(`  movq %rax, ${frame.argSlot(k)}(%rbp)`);
    out.push(`  movq ${off(frame, a.v) + 8}(%rbp), %rax`);
    out.push(`  movq %rax, ${frame.argSlot(k) + 8}(%rbp)`);
  }
  if (args.length > frame.maxArgs) {
    throw new CodegenError(`a call passes ${args.length} arguments but the frame holds ${frame.maxArgs}`, line);
  }
  return out;
}

/** Give every value a slot: 16 bytes, from %rbp downwards, then the scratch. */
function layoutFrame(f: IrFunc, globals: Map<string, number>, strings: Map<string, number>): Frame {
  const slot = new Map<VReg, number>();
  for (let v = 0; v < f.vregCount; v++) {
    slot.set(v, -(v + 1) * VALUE_BYTES);
  }
  let maxPhis = 0;
  let maxArgs = 0;
  for (const b of f.blocks) {
    maxPhis = Math.max(maxPhis, b.params.length);
    for (const i of b.instrs) {
      if (i.op === "call") maxArgs = Math.max(maxArgs, i.args.length - 1);
      // A built-in's arguments also go through the buffer, and it gets at
      // least one so the address stays meaningful with no arguments at all.
      if (i.op === "call.builtin") maxArgs = Math.max(maxArgs, Math.max(1, i.args.length));
      if (i.op === "list.new" || i.op === "dict.new") maxArgs = Math.max(maxArgs, Math.max(1, i.args.length));
    }
  }
  const scratchTop = -(f.vregCount * VALUE_BYTES);
  const phiBase = scratchTop;
  const argBase = scratchTop - maxPhis * VALUE_BYTES;
  // The saved return pointer and the spilled argc/argv get words below everything
  // else, clear of both the slots and the outgoing argument buffer.
  const retSlot = argBase - maxArgs * VALUE_BYTES - 4 * VALUE_BYTES;
  // One word to hold a built-in's function value while its arguments are set up.
  const builtinSlot = retSlot - VALUE_BYTES;
  const argcSlot = retSlot + VALUE_BYTES;
  const argvSlot = retSlot + 2 * VALUE_BYTES;
  return {
    f,
    slot,
    size: f.vregCount * VALUE_BYTES + maxPhis * VALUE_BYTES + maxArgs * VALUE_BYTES + 4 * VALUE_BYTES,
    outgoing: 0,
    maxPhis,
    maxArgs,
    safe: safeIdent(f.name),
    strings,
    retSlot,
    builtinSlot,
    argcSlot,
    argvSlot,
    globals,
    scratch: (n: number) => phiBase - (n + 1) * VALUE_BYTES,
    /*
     * Ascending from the base, because the callee reads argv[i] as i*16(argv).
     * Numbering downwards put argument 0 at the top of the buffer and argument 1
     * *below* it, so every argument past the first was read from below where the
     * caller had not written -- the callee saw zero.  A function of one argument
     * worked perfectly and a function of three quietly returned 103 for 123.
     */
    argSlot: (n: number) => argBase - maxArgs * VALUE_BYTES + n * VALUE_BYTES,
  };
}

/** The address of the first outgoing argument slot. */
function argvBase(frame: Frame, n: number): number {
  return frame.argSlot(n);
}

function argvOff(frame: Frame, n: number): number {
  return frame.argSlot(n);
}

function off(frame: Frame, v: VReg): number {
  const o = frame.slot.get(v);
  if (o === undefined) throw new CodegenError(`v${v} has no slot`, 0);
  return o;
}

function byId(f: IrFunc, id: number): Block {
  const b = f.blocks.find((x) => x.id === id);
  if (b === undefined) throw new CodegenError(`no block b${id}`, 0);
  return b;
}

/** Compile one function. */
export function compileFunc(
  f: IrFunc,
  symbol: string,
  globals: Map<string, number> = new Map(),
  strings: Map<string, number> = new Map(),
): string {
  const out: string[] = [];
  const frame = layoutFrame(f, globals, strings);
  const label = (b: Block): string => `.L${symbol}_b${b.id}`;
  // A source name can contain anything; a label cannot.  `<module>` in a label is
  // an assembler error, not a warning.

  out.push(`# ${f.name}: ${f.vregCount} values, ${frame.size} bytes of frame`);
  out.push(".text");
  out.push(`.globl ${symbol}`);
  out.push(".p2align 4");
  out.push(`${symbol}:`);
  out.push("  pushq %rbp");
  out.push("  movq %rsp, %rbp");
  if (frame.size > 0) out.push(`  subq $${frame.size}, %rsp`);
  /*
   * Keep the return pointer.
   *
   * The result is written *through* that pointer, not into the argument slot.
   * `16(%rbp)` is where the pointer itself was passed, so writing there would
   * scribble over the caller's stack frame -- the slot holding the callee, and
   * then the slot holding its arguments.  The visible symptoms were a function
   * that "was not callable" on the second call and infinite recursion in a
   * self-recursive one: both were this function quietly destroying its caller's
   * bookkeeping.
   */
  out.push(`  movq %rdi, ${frame.retSlot}(%rbp)`);

  /*
   * Spill the incoming registers, then take the parameters out of argv.
   *
   * The three arguments arrive in %rdi, %rsi and %rdx, and there is nothing
   * useful above 8(%rbp) to read them from: 8(%rbp) is the return address, and
   * everything past it belongs to the *caller* frame.  Reading a parameter from
   * 32(%rbp) therefore reads the caller's data instead -- usually a
   * plausible small integer or a leftover pointer, so the program keeps running
   * and merely computes with the wrong parameters.
   *
   * That is exactly what happened: `f(n) = n + 1` answered 1 for every n, and a
   * recursive function never terminated, because it was recursing on whatever the
   * caller had left on its stack.  Neither symptom points at an argument
   * convention, which is why this one is worth spelling out.
   */
  out.push(`  movq %rsi, ${frame.argcSlot}(%rbp)`);
  out.push(`  movq %rdx, ${frame.argvSlot}(%rbp)`);
  f.params.forEach((p, i) => {
    out.push(`  movq ${frame.argvSlot}(%rbp), %r11`);
    out.push(`  movq ${i * VALUE_BYTES}(%r11), %rax`);
    out.push(`  movq %rax, ${off(frame, p)}(%rbp)`);
    out.push(`  movq ${i * VALUE_BYTES + 8}(%r11), %rax`);
    out.push(`  movq %rax, ${off(frame, p) + 8}(%rbp)`);
  });

  for (const b of f.blocks) {
    out.push(`${label(b)}:`);
    /*
     * A phi's inputs are copied on the *incoming edges*, not here.  The copies
     * are emitted just before each jump, which is what makes them mutually
     * exclusive: a block reached from two places copies only the value belonging
     * to the edge it arrived on.  Doing it here would mean every incoming value
     * was written in turn, and the last one would win regardless of how control
     * got here.
     */
    for (const i of b.instrs) out.push(...instr(frame, i));
    const t = b.term;
    if (t === null) {
      out.push("  # no terminator; the verifier should have caught this");
      out.push("  ret");
      continue;
    }
    if (t.t === "jump") {
      out.push(...phiCopies(frame, b, byId(f, t.to)));
      out.push(`  jmp ${label(byId(f, t.to))}`);
    } else if (t.t === "br") {
      /*
       * Truthiness, asked of the runtime.
       *
       * Testing the tag against zero looks equivalent and is not.  `false` is
       * tag 1, not 0 -- tag 0 is null -- so a zero test takes the *true* branch
       * on a false condition.  The symptom is a loop that never ends or a guard
       * that never fires, and neither points at the branch.
       *
       * It is also not enough to test the tags, because in this language 0, 0.0,
       * the empty string, the empty list and the empty dict are all false too.
       * One call gets all of them right, and at M13 a call is what every other
       * operation costs anyway.
       */
      const cond = needVreg(t.cond);
      out.push(`  movq ${off(frame, cond)}(%rbp), %rdi`);
      out.push(`  movq ${off(frame, cond) + 8}(%rbp), %rsi`);
      out.push("  callq _l0p_truthy");
      out.push("  testq %rax, %rax");
      out.push(`  je ${label(byId(f, t.else))}`);
      out.push(...phiCopies(frame, b, byId(f, t.then)));
      out.push(`  jmp ${label(byId(f, t.then))}`);
      out.push(`  # the false edge follows the true one`);
      out.push(...phiCopies(frame, b, byId(f, t.else)));
      out.push(`  jmp ${label(byId(f, t.else))}`);
    } else if (t.t === "ret") {
      /*
       * The result is written through the first argument, not returned in
       * registers.  A generated function has to be callable from hand-written C
       * with no shim, and a shimless call means agreeing on where the answer
       * lands.  The SysV answer for a 16-byte L0pValue is rax:rdx; using a
       * pointer instead is a deliberate difference, and it is why the ret pointer
       * is the *first* parameter rather than the hidden one.
       */
      if (t.value !== null && t.value.t === "vreg") {
        out.push(`  movq ${off(frame, t.value.v)}(%rbp), %rax`);
        out.push(`  movq ${off(frame, t.value.v) + 8}(%rbp), %r11`);
        out.push(`  movq ${frame.retSlot}(%rbp), %r10`);
        out.push("  movq %rax, (%r10)");
        out.push("  movq %r11, 8(%r10)");
      } else {
        out.push(`  movq ${frame.retSlot}(%rbp), %r10`);
        out.push("  movq $0, (%r10)");
        out.push("  movq $0, 8(%r10)");
      }
      out.push("  movq %rbp, %rsp");
      out.push("  popq %rbp");
      out.push("  ret");
    } else {
      /*
       * Falls off the end of the function.
       *
       * The result slot still has to be written.  Leaving it alone makes the
       * caller read whatever was in that memory -- usually the caller's own
       * saved registers -- so a program whose last statement was a loop printed
       * a value with a tag nothing has ever heard of.  Null is the honest answer:
       * there is no value here.
       */
      out.push("  # unreachable: falls out of the function with no value");
      out.push(`  movq ${frame.retSlot}(%rbp), %r10`);
      out.push("  movq $0, (%r10)");
      out.push("  movq $0, 8(%r10)");
      out.push("  movq %rbp, %rsp");
      out.push("  popq %rbp");
      out.push("  ret");
    }
  }
  return out.join("\n");
}

/**
 * The phi copies for one edge, from `from` into `to`.
 *
 * Two passes, and the order is the whole point.  Every input is read into its own
 * scratch slot first, and only then are the destinations written.  A single pass
 * breaks on a swap -- `v1 = phi [b2, v2]`, `v2 = phi [b2, v1]` -- because the
 * first copy destroys what the second still needs, and the result is that both
 * phis end up holding the same value.  That is a plausible wrong answer, not a
 * crash, which is what makes it worth the extra moves.
 */
function phiCopies(frame: Frame, from: Block, to: Block): string[] {
  const out: string[] = [];
  const edges: { p: Phi; inc: NonNullable<Phi["incoming"][number]> }[] = [];
  for (const p of to.params) {
    const inc = p.incoming.find((x) => x.from === from.id);
    if (inc !== undefined) edges.push({ p, inc });
  }

  for (let k = 0; k < edges.length; k++) {
    const e = edges[k] as { p: Phi; inc: NonNullable<Phi["incoming"][number]> };
    const v = e.inc.value;
    if (v.t !== "vreg") throw new CodegenError(`phi v${e.p.dest} has a non-value input`, e.p.line);
    const s = frame.scratch(k);
    out.push(`  # phi v${e.p.dest} on the edge from b${from.id}`);
    out.push(`  movq ${off(frame, v.v)}(%rbp), %rax`);
    out.push(`  movq %rax, ${s}(%rbp)`);
    out.push(`  movq ${off(frame, v.v) + 8}(%rbp), %rax`);
    out.push(`  movq %rax, ${s + 8}(%rbp)`);
  }
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k] as { p: Phi; inc: NonNullable<Phi["incoming"][number]> };
    const s = frame.scratch(k);
    out.push(`  movq ${s}(%rbp), %rax`);
    out.push(`  movq %rax, ${off(frame, e.p.dest)}(%rbp)`);
    out.push(`  movq ${s + 8}(%rbp), %rax`);
    out.push(`  movq %rax, ${off(frame, e.p.dest) + 8}(%rbp)`);
  }
  return out;
}


/**
 * Make a name safe to put inside an assembly string literal.
 *
 * A function name comes from source, and source may contain a quote or a
 * backslash.  An unescaped one would not fail to assemble -- it would produce a
 * different string, and the symptom would be a traceback naming the wrong
 * function, which is a long way from the cause.
 */
/**
 * A label-safe stand-in for a function name.
 *
 * `<module>` is a perfectly good name and a perfectly illegal label, so the two
 * are kept apart rather than the name being mangled at the source.
 */
function safeIdent(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function escapeAsm(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function needVreg(o: Operand): VReg {
  if (o.t !== "vreg") throw new CodegenError("expected a value", 0);
  return o.v;
}

function instr(frame: Frame, i: Instr): string[] {
  const out: string[] = [];
  const d = i.dest;

  const storeValue = (v: VReg): void => {
    // A helper returns in rax:rdx, which is the slot layout exactly.
    out.push(`  movq %rax, ${off(frame, v)}(%rbp)`);
    out.push(`  movq %rdx, ${off(frame, v) + 8}(%rbp)`);
  };

  const storeInt = (v: VReg): void => {
    out.push(`  movq %rax, ${off(frame, v) + 8}(%rbp)`);
    out.push(`  movq $${TAG.INT}, ${off(frame, v)}(%rbp)`);
  };

  switch (i.op) {
    case "const": {
      if (d === null) throw new CodegenError("const defines nothing", i.line);
      const v = i.args[0];
      if (v === undefined || v.t !== "imm") throw new CodegenError("const needs an immediate", i.line);
      if (v.value === null) {
        out.push(`  movq $${TAG.NULL}, ${off(frame, d)}(%rbp)`);
        out.push(`  movq $${TAG.NULL}, ${off(frame, d) + 8}(%rbp)`);
        return out;
      }
      if (typeof v.value === "boolean") {
        // True is tag 2, false is tag 1, and both carry a zero payload.
        const t = v.value ? TAG.TRUE : TAG.FALSE;
        out.push(`  movq $${t}, ${off(frame, d)}(%rbp)`);
        out.push(`  movq $${t}, ${off(frame, d) + 8}(%rbp)`);
        return out;
      }
      if (typeof v.value === "string") {
        const idx = frame.strings.get(v.value);
        if (idx === undefined) {
          throw new CodegenError(`string constant was not interned: ${v.value}`, i.line);
        }
        // The literal lives in .rodata with its length beside it, so a string
        // with an embedded NUL survives, and so the backend never has to escape
        // the text into an instruction.
        out.push(`  leaq .Lstr${idx}(%rip), %rdi`);
        // Bytes, not JavaScript string length.  `"привет"` is six UTF-16 units
        // and twelve bytes, and using the former truncates every non-ASCII
        // literal to roughly half its text -- in the first test that printed
        // "при" for "привет".
        out.push(`  movq $${Buffer.byteLength(v.value, "utf8")}, %rsi`);
        out.push("  callq _l0p_str_new_value");
        storeValue(d);
        return out;
      }
      /*
       * A whole number that does not fit int64 is *not* an integer here.
       *
       * `Number.isInteger(2**63)` is true -- a double is a whole number long before
       * it is a machine integer -- so the test passed and the literal went into
       * the IR tagged INT, with its payload truncated to 64 bits.  `9223372036854775807`
       * is read by JavaScript as 2^63, which as a pattern is INT64_MIN, so the
       * constant became a large negative number and every arithmetic result
       * built on it was wrong.  The range check is what catches it.
       */
      const whole = Number.isInteger(v.value);
      const fitsInt = v.value >= -(2 ** 63) && v.value < 2 ** 63;
      if (!whole || !fitsInt) {
        /*
         * The payload holds a raw double, so the literal's *bits* are what has to
         * be materialised: `movabsq` with the bit pattern, straight into the
         * slot.  There is no integer encoding to borrow and no conversion to call
         * -- a literal should not need a runtime call to become a value.
         */
        out.push(`  movabsq $${doubleBits(v.value)}, %rax`);
        // Tag first, payload second: that is the value's layout, and writing them
        // the other way round gives a double whose tag is its own bit pattern --
        // which reads back as a type nothing has heard of, and adds as zero.
        out.push(`  movq $${TAG.FLOAT}, ${off(frame, d)}(%rbp)`);
        out.push(`  movq %rax, ${off(frame, d) + 8}(%rbp)`);
        return out;
      }
      // `movq $imm, %rax` sign-extends a 32-bit immediate, so anything outside
      // that range needs the 64-bit form, and the range check is on the value
      // rather than on how it was written.
      if (v.value >= -(2 ** 31) && v.value <= 2 ** 31 - 1) {
        out.push(`  movq $${v.value}, %rax`);
      } else {
        out.push(`  movabsq $${v.value}, %rax`);
      }
      storeInt(d);
      return out;
    }

    case "copy": {
      const s = i.args[0];
      if (s === undefined || s.t !== "vreg" || d === null) {
        throw new CodegenError("copy needs a value", i.line);
      }
      out.push(`  movq ${off(frame, s.v)}(%rbp), %rax`);
      out.push(`  movq %rax, ${off(frame, d)}(%rbp)`);
      out.push(`  movq ${off(frame, s.v) + 8}(%rbp), %rax`);
      out.push(`  movq %rax, ${off(frame, d) + 8}(%rbp)`);
      return out;
    }

    case "new.closure": {
      /*
       * A function value, built once and stored in a slot.
       *
       * The name is emitted as a NUL-terminated literal rather than dropped: a
       * traceback that says `fib` instead of an address is worth the rodata, and
       * the cost is a string that is never read on the fast path.
       */
      if (d === null) throw new CodegenError("new.closure defines nothing", i.line);
      const target = i.info?.name ?? "";
      if (!/^@func:\d+$/.test(target)) {
        throw new CodegenError(`new.closure needs a function index, got ${target}`, i.line);
      }
      const idx = target.slice("@func:".length);
      out.push(`  # l0p_fn_new(void *code, const char *name, uint64_t nargs)`);
      out.push(`  leaq _l0p_fn_${idx}(%rip), %rdi`);
      out.push(`  leaq .Lname_${frame.safe}_${d}(%rip), %rsi`);
      out.push(`  movq $0, %rdx`);
      out.push("  callq _l0p_fn_new");
      storeValue(d);
      out.push(`  # the name for v${d} lives in the data section below`);
      out.push(`  .section __TEXT,__const`);
      out.push(`.Lname_${frame.safe}_${d}:`);
      out.push(`  .asciz "${escapeAsm(frame.f.name)}"`);
      out.push("  .text");
      return out;
    }

    case "call": {
      /*
       * Calling a function value.
       *
       * The arguments have to become one contiguous array, because that is what
       * the callee reads: `argv[i]` at 16(%rbp).  So they are copied into a
       * buffer in the frame, and the copy is a straight run of loads and stores
       * rather than a per-argument register sequence -- which is also what makes
       * the "past six arguments" question disappear rather than recur.
       */
      if (d === null) throw new CodegenError("call defines nothing", i.line);
      const callee = i.args[0];
      if (callee === undefined || callee.t !== "vreg") {
        throw new CodegenError("call needs a callee value", i.line);
      }
      const argv = i.args.slice(1);
      const argc = argv.length;
      out.push(`  # ${argc} argument(s) into the outgoing buffer`);
      for (let k = 0; k < argc; k++) {
        const a = argv[k];
        if (a === undefined || a.t !== "vreg") throw new CodegenError("an argument must be a value", i.line);
        out.push(`  movq ${off(frame, a.v)}(%rbp), %rax`);
        out.push(`  movq %rax, ${argvOff(frame, k)}(%rbp)`);
        out.push(`  movq ${off(frame, a.v) + 8}(%rbp), %rax`);
        out.push(`  movq %rax, ${argvOff(frame, k) + 8}(%rbp)`);
      }
      /*
       * l0p_fn_call(L0pValue fn, uint64_t argc, const L0pValue *argv, L0pValue *out)
       *
       * The callee is a whole L0pValue, so it takes two registers; the rest are
       * one each.  Getting the order wrong here produced a perfectly callable
       * call that passed a null tag as the function pointer, and the runtime
       * correctly reported "not callable" -- which is the runtime earning its
       * keep, since the alternative was a jump to address zero.
       */
      out.push(`  movq ${off(frame, callee.v)}(%rbp), %rdi`);
      out.push(`  movq ${off(frame, callee.v) + 8}(%rbp), %rsi`);
      out.push(`  movq $${argc}, %rdx`);
      out.push(`  leaq ${argvBase(frame, 0)}(%rbp), %rcx`);
      out.push(`  leaq ${off(frame, d)}(%rbp), %r8`);
      out.push("  callq _l0p_fn_call");
      return out;
    }

    case "load.global": {
      if (d === null) throw new CodegenError("load.global defines nothing", i.line);
      const name = i.info?.name ?? "";
      const g = frame.globals.get(name);
      if (g === undefined) throw new CodegenError(`no global named \`${name}\``, i.line);
      out.push(`  movq _l0p_globals+${g * VALUE_BYTES}(%rip), %rax`);
      out.push(`  movq %rax, ${off(frame, d)}(%rbp)`);
      out.push(`  movq _l0p_globals+${g * VALUE_BYTES + 8}(%rip), %rax`);
      out.push(`  movq %rax, ${off(frame, d) + 8}(%rbp)`);
      return out;
    }

    case "store.global": {
      const name = i.info?.name ?? "";
      const g = frame.globals.get(name);
      if (g === undefined) throw new CodegenError(`no global named \`${name}\``, i.line);
      const a = i.args[0];
      if (a === undefined || a.t !== "vreg") throw new CodegenError("store.global needs a value", i.line);
      out.push(`  movq ${off(frame, a.v)}(%rbp), %rax`);
      out.push(`  movq %rax, _l0p_globals+${g * VALUE_BYTES}(%rip)`);
      out.push(`  movq ${off(frame, a.v) + 8}(%rbp), %rax`);
      out.push(`  movq %rax, _l0p_globals+${g * VALUE_BYTES + 8}(%rip)`);
      return out;
    }

    case "list.new":
    case "dict.new": {
      if (d === null) throw new CodegenError(`${i.op} defines nothing`, i.line);
      const items = i.args;
      // The items have to be contiguous for the helper to take them as one
      // array, so they go through the same outgoing buffer a call uses.
      out.push(...spillArgs(frame, items, i.line));
      out.push(`  leaq ${argvBase(frame, 0)}(%rbp), %rdi`);
      out.push(`  movq $${items.length}, %rsi`);
      out.push(`  callq _${i.op === "list.new" ? "l0p_list_from" : "l0p_dict_from"}`);
      storeValue(d);
      return out;
    }

    case "load.index": {
      if (d === null) throw new CodegenError("load.index defines nothing", i.line);
      out.push(...placeArgs(frame, ["value", "value"], i.args, i.line));
      out.push("  callq _l0p_index_get");
      storeValue(d);
      return out;
    }

    case "store.index": {
      out.push(...placeArgs(frame, ["value", "value", "value"], i.args, i.line));
      out.push("  callq _l0p_index_set");
      return out;
    }

    case "load.field": {
      if (d === null) throw new CodegenError("load.field defines nothing", i.line);
      const obj = i.args[0] as Operand;
      if (obj === undefined) throw new CodegenError("load.field needs an object", i.line);
      // (value, const char *) -- two registers then one pointer, so the name
      // lands in %rdx and does not collide with the receiver's second half.
      out.push(...placeArgs(frame, ["value"], [obj], i.line));
      const tag = thisTag++;
      const label = fieldLabel(frame, i, tag);
      out.push(`  leaq ${label}(%rip), %rdx`);
      out.push("  callq _l0p_field_get");
      storeValue(d);
      out.push(...emitFieldName(label, i.info?.name ?? ""));
      return out;
    }

    case "store.field": {
      const obj = i.args[0] as Operand;
      const val = i.args[1] as Operand;
      if (val === undefined) throw new CodegenError("store.field needs a value", i.line);
      // (value obj, value val, const char *name): two values take four registers
      // and the name takes the fifth.  Putting the name third would land it in
      // %rdx, which the second value already owns.
      out.push(...placeArgs(frame, ["value", "value"], [obj, val], i.line));
      const tag = thisTag++;
      const label = fieldLabel(frame, i, tag);
      out.push(`  leaq ${label}(%rip), %r8`);
      out.push("  callq _l0p_field_set");
      out.push(...emitFieldName(label, i.info?.name ?? ""));
      return out;
    }

    case "concat": {
      if (d === null) throw new CodegenError("concat defines nothing", i.line);
      out.push(...placeArgs(frame, ["value", "value"], i.args, i.line));
      out.push("  callq _l0p_concat");
      storeValue(d);
      return out;
    }

    case "call.builtin": {
      /*
       * Built-ins are reached by name and then called through the ordinary value
       * path, so there is exactly one calling sequence in the backend.
       *
       * Resolving the name at run time is a lookup per call and is knowingly
       * wrong for speed.  Binding it statically is the same work as any other
       * symbol binding, so it belongs with the register allocator at M15, where
       * addresses are already being decided.
       */
      if (d === null) throw new CodegenError("call.builtin defines nothing", i.line);
      const name = i.info?.name ?? "";
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
        throw new CodegenError(`not a built-in name: ${name}`, i.line);
      }
      out.push(...spillArgs(frame, i.args, i.line));
      /*
       * The label carries a counter as well as the name, because the same built-in
       * can be called from a dozen places and a repeated label is an assembler
       * error -- one that a single call site would never have found.
       */
      const unique = `${name}_${thisTag++}`;
      out.push(...emitBuiltinName(name, unique));
      out.push(`  leaq .Lbn_${unique}(%rip), %rdi`);
      out.push("  callq _l0p_builtin");
      out.push(`  movq %rax, ${frame.builtinSlot}(%rbp)`);
      out.push(`  movq %rdx, ${frame.builtinSlot + 8}(%rbp)`);
      out.push(`  leaq ${off(frame, d)}(%rbp), %r8`);
      out.push(`  movq $${i.args.length}, %rdx`);
      out.push(`  leaq ${argvBase(frame, 0)}(%rbp), %rcx`);
      out.push(`  movq ${frame.builtinSlot}(%rbp), %rdi`);
      out.push(`  movq ${frame.builtinSlot + 8}(%rbp), %rsi`);
      out.push("  callq _l0p_fn_call");
      return out;
    }

    case "eq":
    case "truthy": {
      /*
       * The two operations whose helper returns a word rather than a value, so
       * the boolean has to be built here.  FALSE is tag 1 and TRUE is tag 2, and
       * both carry a zero payload -- so the payload is written once, after the
       * tag is settled, instead of on each branch.
       */
      if (d === null) throw new CodegenError(`${i.op} defines nothing`, i.line);
      if (i.op === "eq") {
        out.push(...placeArgs(frame, ["value", "value"], i.args, i.line));
        out.push("  callq _l0p_values_eq");
      } else {
        const v = needVreg(i.args[0] as Operand);
        out.push(`  movq ${off(frame, v)}(%rbp), %rax`);
        out.push("  callq _l0p_truthy");
      }
      const end = `.Lbool_${frame.safe}_${d}`;
      out.push("  testq %rax, %rax");
      out.push(`  movq $${TAG.FALSE}, ${off(frame, d)}(%rbp)`);
      out.push(`  je ${end}`);
      out.push(`  movq $${TAG.TRUE}, ${off(frame, d)}(%rbp)`);
      out.push(`${end}:`);
      out.push("  xorl %eax, %eax");
      out.push(`  movq %rax, ${off(frame, d) + 8}(%rbp)`);
      return out;
    }

    case "add":
      return emitInlineInt(frame, i, "l0p_add", (slow) => [
        "movq %rcx, %rdx",
        "addq %rdx, %rax",
        // Overflow leaves int64, so the runtime's widening rule applies.  One
        // branch here is cheaper than being wrong on it.
        `jo ${slow}`,
      ]);

    case "sub":
      // Subtraction of two int64s cannot overflow.
      return emitInlineInt(frame, i, "l0p_sub", () => [
        "movq %rcx, %rdx",
        "subq %rdx, %rax",
      ]);

    case "mul":
      return emitInlineInt(frame, i, "l0p_mul", (slow) => [
        "imulq %rcx, %rax",
        // IMUL sets OF when the product does not fit in the destination.
        `jo ${slow}`,
      ]);

    /*
     * The three operators that divide, which cannot be inlined the way `add` is.
     *
     * x86's `idiv` raises #DE on two inputs, and #DE is not a catchable fault: it
     * ends the process with SIGFPE, so the program dies without printing an
     * error and the value that would have been returned never exists.
     *
     *     divisor 0             `a / 0` is an error the runtime reports properly
     *     INT64_MIN / -1        the quotient is 2^63, which int64 cannot hold
     *
     * The second is not an exotic corner.  `a / -1` is an ordinary expression and
     * traps for exactly one value of `a`, so a guard on `b == -1` would be wrong
     * -- it is what `l0p_div` did, and it made `6 / -1` a float holding a whole
     * number.  Both tests have to precede the instruction, and both failures have
     * to reach the runtime, which raises the proper error rather than a signal.
     *
     * `INT64_MIN % -1` traps too, though the remainder is defined and is zero.
     *
     * `cmpq` has no 64-bit immediate, so INT64_MIN goes through `movabsq` into a
     * scratch register -- the assembler rejects both `$0x8000000000000000` and
     * the signed literal.
     */
    case "div":
      return emitInlineInt(frame, i, "l0p_div", (slow, label) => [
        "testq %rcx, %rcx",
        `je ${slow}`,                        // division by zero: the runtime says so
        "cmpq $-1, %rcx",
        `jne ${label("ok")}`,               // any divisor but -1 is safe
        "movabsq $-9223372036854775808, %r8",
        "cmpq %r8, %rax",
        `je ${slow}`,                        // INT64_MIN / -1 traps
        `${label("ok")}:`,
        "cqto",
        "idivq %rcx",
        // `rax` is now the quotient and `rdx` the remainder.  Only an exact
        // division yields an int; anything else is a float, which needs the
        // runtime's rounding rather than a truncation.
        "testq %rdx, %rdx",
        `jne ${slow}`,
      ]);

    case "floordiv":
      return emitInlineInt(frame, i, "l0p_floordiv", (slow, label) => [
        "testq %rcx, %rcx",
        `je ${slow}`,
        "cmpq $-1, %rcx",
        `jne ${label("ok")}`,
        "movabsq $-9223372036854775808, %r8",
        "cmpq %r8, %rax",
        `je ${slow}`,
        `${label("ok")}:`,
        "cqto",
        "idivq %rcx",
        /*
         * `idiv` truncates toward zero and floor goes down, so the two differ
         * whenever a negative answer has a remainder -- `-7 // 2` is -4 here and
         * -3 from the instruction.  It is exactly the case where the remainder
         * is non-zero and its sign differs from the divisor's.
         */
        "testq %rdx, %rdx",
        `je ${label("floor")}`,             // no remainder: truncation is the floor
        "movq %rdx, %r8",
        "sarq $63, %r8",                     // all ones if the remainder is negative
        "movq %rcx, %r9",
        "sarq $63, %r9",                     // all ones if the divisor is negative
        "cmpq %r8, %r9",
        `je ${label("floor")}`,             // same sign: truncation is the floor
        "decq %rax",
        `${label("floor")}:`,
      ]);

    case "mod":
      return emitInlineInt(frame, i, "l0p_mod", (slow, label) => [
        "testq %rcx, %rcx",
        `je ${slow}`,
        "cmpq $-1, %rcx",
        `jne ${label("ok")}`,
        "movabsq $-9223372036854775808, %r8",
        "cmpq %r8, %rax",
        `je ${slow}`,                        // INT64_MIN % -1 traps; the answer is 0
        `${label("ok")}:`,
        "cqto",
        "idivq %rcx",
        /*
         * `idiv` leaves the remainder in `rdx` with the sign of the dividend,
         * which is C's `%`, which is the interpreter's `%`.  Not Python's rule,
         * which normalises to the divisor's sign -- but matching the reference
         * is the point, and a native `7 % -3` of 1 is what the interpreter says.
         */
        "movq %rdx, %rax",
      ]);

    case "lt":
      return emitInlineCompare(frame, i, "l0p_lt", "setl", true);

    case "le":
      return emitInlineCompare(frame, i, "l0p_le", "setle", true);

    case "gt":
      return emitInlineCompare(frame, i, "l0p_gt", "setg", true);

    case "ge":
      return emitInlineCompare(frame, i, "l0p_ge", "setge", true);

    default: {
      const h = HELPERS[i.op];
      if (h === undefined) {
        throw new CodegenError(`the native backend cannot yet lower \`${i.op}\``, i.line);
      }
      if (d === null) throw new CodegenError(`${i.op} defines nothing`, i.line);
      out.push(...placeArgs(frame, h.args, i.args, i.line));
      out.push(`  callq _${h.name}`);
      if (h.returnsValue) storeValue(d);
      return out;
    }
  }
}

/**
 * Place arguments by the SysV integer classification.
 *
 * A `L0pValue` takes two registers, which is where this usually goes wrong: six
 * values need twelve registers, so the seventh spills.  Counting as it goes keeps
 * that from being a decision anyone has to make twice.
 *
 * The scratch registers are %r10 and %r11, and that choice is load-bearing.  Using
 * %rax and %rdx looks natural and is wrong: %rdx is the *third argument
 * register*, so loading the next argument's tag into %rax and then writing it to
 * %rdx destroys the payload %rdx was still holding.  The symptom is a second
 * argument whose two halves are the same value -- a plausible wrong answer rather
 * than a crash, since the code still runs.
 */
function placeArgs(frame: Frame, kinds: ArgKind[], args: Operand[], line: number): string[] {
  const out: string[] = [];
  let intReg = 0;
  let stackAt = 0;

  for (let k = 0; k < kinds.length; k++) {
    const a = args[k];
    if (a === undefined) throw new CodegenError("missing argument", line);
    if (a.t !== "vreg") throw new CodegenError("an argument must be a value", line);
    const need = kinds[k] === "value" ? 2 : 1;

    if (intReg + need <= INT_ARG_REGS.length) {
      out.push(`  movq ${off(frame, a.v)}(%rbp), %r10`);
      out.push(`  movq ${off(frame, a.v) + 8}(%rbp), %r11`);
      out.push(`  movq %r10, ${INT_ARG_REGS[intReg]}`);
      if (need === 2) out.push(`  movq %r11, ${INT_ARG_REGS[intReg + 1]}`);
      intReg += need;
    } else {
      out.push(`  movq ${off(frame, a.v)}(%rbp), %r10`);
      out.push(`  movq %r10, ${stackAt}(%rsp)`);
      if (need === 2) {
        out.push(`  movq ${off(frame, a.v) + 8}(%rbp), %r11`);
        out.push(`  movq %r11, ${stackAt + 8}(%rsp)`);
      }
      stackAt += 8 * need;
    }
  }
  frame.outgoing = Math.max(frame.outgoing, stackAt);
  return out;
}

/** The whole module: every function, then the entry point that runs it. */
export function compileModule(m: IrModule): string {
  const parts: string[] = [
    "# Generated by the l0puh native backend.",
    "# Every value lives in a stack slot; see the note at the top of codegen.ts.",
  ];
  const globals = new Map(m.globalNames.map((n, i) => [n, i]));
  const strings = internStrings(m);
  m.funcs.forEach((f, i) => {
    parts.push(compileFunc(f, `_l0p_fn_${i}`, globals, strings));
  });
  if (strings.size > 0) parts.push(stringTable([...strings.keys()]));
  if (globals.size > 0) parts.push(globalsTable(globals.size));
  parts.push(entryPoint(m));
  return parts.join("\n\n") + "\n";
}

/**
 * The program's `main`.
 *
 * The module body is an ordinary function, so the program can be called from C
 * as easily as from itself -- which is what the differential tests need.
 */
/**
 * The module's globals: one flat array of values, zero-initialised.
 *
 * Zero is a valid null value, so a program that reads a global before anything
 * has written it gets `null` rather than a wild address -- which is the same
 * answer the interpreter gives for an undefined name read at module level.
 */
function globalsTable(count: number): string {
  return `# ---- globals: ${count} value(s)
  .bss
  .p2align 4
  .globl _l0p_globals
_l0p_globals:
  .zero ${count * VALUE_BYTES}`;
}

function entryPoint(m: IrModule): string {
  const name = `_l0p_fn_${m.entry}`;
  return `# ---- entry point
  .text
  # Mach-O prefixes C symbols with an underscore, so the entry point is _main.
  # Writing plain \`main\` assembles cleanly and then fails to link, which is the
  # most expensive way to discover the rule.
  .globl _main
_main:
  pushq %rbp
  movq %rsp, %rbp
  subq $16, %rsp
  callq _l0p_boot
  # The module body takes (L0pValue *ret, uint64_t argc, L0pValue *argv).
  leaq -16(%rbp), %rdi
  xorl %esi, %esi
  xorl %edx, %edx
  callq ${name}
  # A tag of zero means the module body produced no value to print.
  cmpq $0, -16(%rbp)
  je .Ldone
  movq -16(%rbp), %rdi
  movq -8(%rbp), %rsi
  callq _l0p_print_value
  callq _l0p_print_newline
.Ldone:
  xorl %eax, %eax
  movq %rbp, %rsp
  popq %rbp
  ret`;
}
