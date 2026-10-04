/**
 * The intermediate representation.
 *
 * Three-address code in SSA form: every instruction defines at most one value,
 * every value is defined exactly once, and control flow is a graph of basic
 * blocks joined by typed terminators.  This is the shape LLVM uses and the one
 * the rest of the project is built on.
 *
 * Why it exists, concretely:
 *
 *   - Register allocation is impossible without it.  Two writes to the same
 *     variable have to become two distinct values before a register can be
 *     handed to each, and only SSA says which two.
 *
 *   - The recursion problem has a known answer.  A recursive function's body
 *     refers to a value the next call will overwrite, so a tree of definitions
 *     never closes.  TREE (Rao & Rossi 2007) rewrites recursion into a loop
 *     before SSA is built; the `TREE` step in the roadmap is that rewrite, and
 *     the IR is shaped so it has somewhere to put the result.
 *
 *   - A second backend should not need the parser.  WASM, or ARM, reads this and
 *     nothing else.
 *
 * Instruction granularity is *runtime call*, not machine instruction.  `add` means
 * "do what `l0p_add` does", and the backend may later expand it into a tag check
 * and an inline add.  That is deliberate: an IR that already prescribes
 * instructions is no use to a backend that wanted to choose them.
 */

import type { Binding } from "../ast.ts";

/** A virtual register.  SSA gives each definition one of these, once. */
export type VReg = number;

export type Operand =
  /** A value defined somewhere in this function. */
  | { t: "vreg"; v: VReg }
  /** An immediate, not a register.  The backend folds these into instructions. */
  | { t: "imm"; value: number | string | boolean | null }
  /** A name: a global, a function, a field.  Resolved through the symbol table. */
  | { t: "sym"; name: string };

export const vreg = (v: VReg): Operand => ({ t: "vreg", v });
export const imm = (value: number | string | boolean | null): Operand => ({ t: "imm", value });
export const sym = (name: string): Operand => ({ t: "sym", name });

/**
 * What an instruction does.  The names are the ones the printer shows, so a
 * disassembly reads like the source.
 *
 * There is deliberately no `load.local` or `store.local`.  A local is not a
 * memory location here; it is a name bound to an SSA value, and the backend
 * decides whether that value ends up in a register or a stack slot.  Putting
 * frame slots in the IR would fix that decision in the wrong layer, and would
 * make every later spill rewrite the front end.
 */
export type IrOp =
  // --- producing a value from nothing -------------------------------
  | "const"        // dest = imm
  | "copy"         // dest = arg.  A new name for an existing value.
  | "load.global"  // dest = global
  | "load.upval"   // dest = upvals[index]
  | "load.field"   // dest = obj.sym
  | "load.index"   // dest = obj[index]

  // --- storing --------------------------------------------------------
  | "store.global" // sym = value
  | "store.upval"  // index = value
  | "store.field"  // obj.sym = value
  | "store.index"  // obj[index] = value

  // --- computing -------------------------------------------------------
  | "add" | "sub" | "mul" | "div" | "floordiv" | "mod" | "pow"
  | "neg" | "pos" | "bitnot"
  | "eq" | "ne" | "lt" | "le" | "gt" | "ge"
  | "not"          // logical not
  | "truthy"       // dest = whether the value is true
  | "in" | "notin"
  | "concat"       // dest = a .. b
  | "list.new"     // dest = [a, b, ...]
  | "list.push"    // dest = list.push(item)
  | "dict.new"
  | "dict.get" | "dict.set"
  | "struct.new"   // dest = Struct(sym, fields...)

  // --- control, as ordinary instructions ------------------------------
  | "call"         // dest = callee(args...)
  | "call.builtin" // dest = @sym(args...)
  | "new.closure"  // dest = closure over this function

  // --- invariants the compiler must uphold -----------------------------
  | "assert.type"  // check a tag, or fail with a message
  | "unreachable"  // raise; nothing follows it

  /** `phi` is not an instruction: it belongs to a block's entry. */
  | "nop";

export type IrBinOp = Extract<IrOp, "add" | "sub" | "mul" | "div" | "floordiv" | "mod" | "pow">;
export type IrCmpOp = Extract<IrOp, "eq" | "ne" | "lt" | "le" | "gt" | "ge">;

/**
 * A loop-head phi that exists before the back edge that fills it is known.
 *
 * Not part of the IR: it is the half-open state the builder passes to itself
 * while a loop body is being lowered, and nothing else ever sees it.
 */
export interface OpenPhi {
  /** The source name, needed to find it in each predecessor's snapshot. */
  name: string;
  phi: Phi;
  /**
   * What the name held when the phi was opened.
   *
   * `openLoopPhis` binds the name to the phi immediately, because the body has
   * to read it.  If the phi then turns out not to belong -- the head has one
   * predecessor, so there is nothing to choose between -- the name has to go back
   * to this, or it is left pointing at a value nothing defines.
   */
  entryValue: VReg;
}

export interface Phi {
  dest: VReg;
  /** One entry per predecessor: which block it comes from, and from what value. */
  incoming: { from: number; value: Operand }[];
  /** Line, so a debug build can point at the assignment. */
  line: number;
}

export interface Instr {
  op: IrOp;
  /** The value defined, or null for an instruction that defines nothing. */
  dest: VReg | null;
  args: Operand[];
  /**
   * Extra, op-specific.  `store.local` puts a slot here, `call.builtin` a
   * symbol.  Kept as a small record rather than a field per op so adding an
   * instruction does not change this type.
   */
  info: { slot?: number; index?: number; name?: string; tag?: number } | null;
  line: number;
}

export type Terminator =
  | { t: "jump"; to: number; line: number }
  | { t: "br"; cond: Operand; then: number; else: number; line: number }
  | { t: "ret"; value: Operand | null; line: number }
  | { t: "unreachable"; line: number };

export interface Block {
  id: number;
  name: string;
  /** At most one, and only in the entry block. */
  params: Phi[];
  instrs: Instr[];
  term: Terminator | null;
}

export interface IrFunc {
  name: string;
  /** Incoming parameters, as virtual registers in order. */
  params: number[];
  /** What each slot may be assigned to, parallel to the frame's slots. */
  slotKinds: (Binding | "param")[];
  /** One extra vreg holding the value of the last expression. */
  vregCount: number;
  blocks: Block[];
  /** The module body is not callable; it is run once. */
  isModule: boolean;
  /** Names captured from enclosing functions. */
  upvalues: { fromLocalSlot: number; fromUpvalue: number | null }[];
}

export interface IrModule {
  name: string;
  file: string | null;
  entry: number;
  funcs: IrFunc[];
  globalNames: string[];
  /** Module-level binding kinds, for the immutability check. */
  globalKinds: Map<string, Binding | "def">;
}

// ------------------------------------------------------------- inspection

export function isTerminator(i: Instr): boolean {
  return i.op === "unreachable";
}

/** Does this instruction produce a value?  Used by the verifier. */
export function definesValue(i: Instr): boolean {
  return i.dest !== null;
}

export function isBinaryOp(op: IrOp): op is IrBinOp {
  return op === "add" || op === "sub" || op === "mul" || op === "div" || op === "floordiv" || op === "mod" || op === "pow";
}

export function isCompareOp(op: IrOp): op is IrCmpOp {
  return op === "eq" || op === "ne" || op === "lt" || op === "le" || op === "gt" || op === "ge";
}

// ---------------------------------------------------------------- printer

/**
 * A readable dump, with virtual registers numbered and blocks labelled.
 *
 * Two things it deliberately shows rather than hides: the value each name
 * currently holds, and every jump.  A miscompiled jump is the failure this
 * project will spend most of its time on, and it is invisible in the AST.
 */
export function printFunc(f: IrFunc): string {
  const lines: string[] = [];
  const nameOf = new Map<number, string>();
  f.params.forEach((p, i) => nameOf.set(p, `p${i}`));

  const show = (o: Operand): string => {
    switch (o.t) {
      case "vreg": {
        const known = nameOf.get(o.v);
        return known ?? `v${o.v}`;
      }
      case "imm":
        return o.value === null ? "null" : JSON.stringify(o.value);
      case "sym":
        return `@${o.name}`;
    }
  };

  const head = `func ${f.name}(${f.params.map((p) => show({ t: "vreg", v: p })).join(", ")})  `
    + `vregs=${f.vregCount} slots=${f.slotKinds.length} blocks=${f.blocks.length}`
    + (f.isModule ? "  [module]" : "");
  lines.push(head);
  if (f.upvalues.length > 0) {
    lines.push(`  ; upvalues ${f.upvalues.map((u) => `slot${u.fromLocalSlot}`).join(" ")}`);
  }

  for (const b of f.blocks) {
    lines.push(`b${b.id}:${b.name ? `  ; ${b.name}` : ""}`);
    for (const p of b.params) {
      const incoming = p.incoming.map((i) => `b${i.from}: ${show(i.value)}`).join(", ");
      nameOf.set(p.dest, `v${p.dest}`);
      lines.push(`  ${show({ t: "vreg", v: p.dest })} = phi ${incoming}`);
    }
    for (const i of b.instrs) {
      const target = i.dest === null ? "" : `${show({ t: "vreg", v: i.dest })} = `;
      const args = i.args.map(show).join(", ");
      const extra = i.info?.slot !== undefined ? ` [${i.info.slot}]`
        : i.info?.index !== undefined ? ` [${i.info.index}]`
        : i.info?.name !== undefined ? ` [${i.info.name}]`
        : i.info?.tag !== undefined ? ` [tag ${i.info.tag}]`
        : "";
      if (i.dest !== null) nameOf.set(i.dest, `v${i.dest}`);
      lines.push(`  ${target}${i.op}${args === "" ? "" : ` ${args}`}${extra}`);
    }
    const term = b.term;
    if (term === null) lines.push("  (no terminator)");
    else lines.push(`  ${printTerm(term, show)}`);
  }
  return lines.join("\n");
}

function printTerm(t: Terminator, show: (o: Operand) => string): string {
  switch (t.t) {
    case "jump":
      return `jump b${t.to}`;
    case "br":
      return `br ${show(t.cond)}, b${t.then}, b${t.else}`;
    case "ret":
      return t.value === null ? "ret" : `ret ${show(t.value)}`;
    case "unreachable":
      return "unreachable";
  }
}

export function printModule(m: IrModule): string {
  return m.funcs.map((f) => printFunc(f)).join("\n\n");
}
