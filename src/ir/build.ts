/**
 * Building the IR, and constructing SSA on the way up.
 *
 * SSA is built by *construction*, not by analysis: the builder keeps a map from
 * each bound name to the value currently holding it, and lowering `x = e`
 * allocates a fresh virtual register and rebinds the name.  Reading `x` emits
 * whatever the map holds.  That yields SSA directly, with no dominator tree and
 * no second pass, which is what Cranelift's frontend does and the only approach
 * worth the trouble for a language with lexical scoping.
 *
 * The part that does need care is the join.  When an `if` ends, control arrives
 * from two blocks and a name may hold a different value in each.  A phi goes at
 * the head of the merge block with one entry per predecessor.  A name that both
 * sides left alone gets none: reading it after the join is the same read on both
 * paths, so it needs no new definition and no copy.  That distinction is the
 * difference between a correct join and a join that copies everything, and it is
 * the first thing the register allocator at M15 would complain about.
 *
 * `verifyFunc` in `verify.ts` checks the properties a backend depends on.
 * Enforcing them here is much cheaper than discovering at M15 that the input was
 * not actually in SSA.
 */

import type { Binding } from "../ast.ts";
import { L0pError } from "../errors.ts";
import { vreg, type Block, type Instr, type IrFunc, type IrOp, type Operand, type Phi, type Terminator, type VReg } from "./ir.ts";

/** A path through the function: what each name held when it left. */
export type Path = Map<string, VReg>;

export class FuncBuilder {
  private readonly blocks: Block[] = [];
  private current: Block;
  private nregs = 0;
  private nextBlock = 1;
  private readonly scopes: Map<string, VReg>[] = [];

  /** block id -> the values that path left behind, for the join. */
  private readonly paths = new Map<number, Path>();

  /** Every phi created, for the verifier and for de-SSA at M15. */
  readonly phis: { block: number; phi: Phi }[] = [];

  readonly name: string;
  readonly slotKinds: (Binding | "param")[];
  readonly isModule: boolean;

  constructor(name: string, slotKinds: (Binding | "param")[] = [], isModule = false) {
    this.name = name;
    this.slotKinds = slotKinds;
    this.isModule = isModule;
    this.scopes.push(new Map());
    this.current = this.newBlock("entry");
  }

  // ------------------------------------------------------------- registers

  /** A fresh virtual register.  Every definition gets exactly one. */
  newReg(): VReg {
    return this.nregs++;
  }

  get vregCount(): number {
    return this.nregs;
  }

  // ---------------------------------------------------------------- blocks

  newBlock(label = ""): Block {
    const b: Block = { id: this.nextBlock++, name: label, params: [], instrs: [], term: null };
    this.blocks.push(b);
    return b;
  }

  setCurrent(b: Block): void {
    this.current = b;
  }

  get currentBlock(): Block {
    return this.current;
  }

  /** The block being filled, for a caller that needs to append to it directly. */
  emitBlock(): Block {
    return this.current;
  }

  // ---------------------------------------------------------- instructions

  /**
   * Emits an instruction that defines a value, and returns it.
   *
   * The result is returned rather than looked up by the caller, because a caller
   * that got it wrong would produce a miscompiled program rather than a
   * malformed one, and that is the harder kind of bug to find.
   */
  define(op: IrOp, args: Operand[], line: number, info: Instr["info"] = null): VReg {
    const dest = this.newReg();
    this.current.instrs.push({ op, dest, args, info, line });
    return dest;
  }

  /** An instruction that defines nothing. */
  emit(op: IrOp, args: Operand[], line: number, info: Instr["info"] = null): void {
    this.current.instrs.push({ op, dest: null, args, info, line });
  }

  // ---------------------------------------------------------- terminators

  jump(to: Block, line: number): void {
    this.setTerm({ t: "jump", to: to.id, line });
  }

  branch(cond: Operand, then: Block, other: Block, line: number): void {
    this.setTerm({ t: "br", cond, then: then.id, else: other.id, line });
  }

  ret(value: Operand | null, line: number): void {
    this.setTerm({ t: "ret", value, line });
  }

  private setTerm(t: Terminator): void {
    if (this.current.term !== null) {
      throw new L0pError(`block b${this.current.id} already has a terminator`, 0, 0);
    }
    this.current.term = t;
  }

  // ---------------------------------------------------------------- scopes

  beginScope(): void {
    this.scopes.push(new Map());
  }

  endScope(): void {
    if (this.scopes.length === 1) throw new L0pError("cannot pop the function scope", 0, 0);
    this.scopes.pop();
  }

  /** Binds a name.  A later write allocates a new value rather than reusing this. */
  bind(name: string, value: VReg): void {
    (this.scopes[this.scopes.length - 1] as Map<string, VReg>).set(name, value);
  }

  /** The value currently holding `name`, or null. */
  lookup(name: string): VReg | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i]?.get(name);
      if (found !== undefined) return found;
    }
    return null;
  }

  isBound(name: string): boolean {
    return this.lookup(name) !== null;
  }

  /** A snapshot of what every visible name holds, for the join. */
  snapshot(): Path {
    const out: Path = new Map();
    for (const scope of this.scopes) {
      for (const [k, v] of scope) out.set(k, v);
    }
    return out;
  }

  // ------------------------------------------------------------------ joins

  /** Remembers what a block left behind, so a join can build phis from it. */
  recordPath(block: Block): void {
    this.paths.set(block.id, this.snapshot());
  }

  /**
   * Creates the block two paths meet in, with a phi for every name they
   * disagree about.
   *
   * It has to come *after* both arms are lowered, because each arm's snapshot is
   * what says which names the two paths actually disagree on.  Creating the block
   * first and filling it in later works too, and is what `joinParams` is for --
   * but it splits the name in two places, so this is the one place that does it.
   */
  join(thenBlock: Block, elseBlock: Block, line: number): Block {
    const join = this.newBlock("join");
    join.params = this.makePhis(join, thenBlock, elseBlock, line);
    return join;
  }

  /** The phis for a join, without creating the merge block.  For a statement join. */
  joinParams(merge: Block, then: Block, other: Block, line: number): Phi[] {
    return this.makePhis(merge, then, other, line);
  }

  private makePhis(merge: Block, then: Block, other: Block, line: number): Phi[] {
    const a = this.paths.get(then.id);
    const b = this.paths.get(other.id);
    if (a === undefined || b === undefined) return [];

    const out: Phi[] = [];
    for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const va = a.get(name);
      const vb = b.get(name);
      if (va === undefined || vb === undefined) continue;
      // The same value on both sides: nothing to choose between, so no phi.  This
      // is the case that matters -- copy unconditionally and every read in the
      // code after the `if` becomes a copy.
      if (va === vb) continue;

      const dest = this.newReg();
      const phi: Phi = {
        dest,
        incoming: [
          { from: then.id, value: vreg(va) },
          { from: other.id, value: vreg(vb) },
        ],
        line,
      };
      out.push(phi);
      this.phis.push({ block: merge.id, phi });
      // After the merge, the name holds the phi.
      this.bind(name, dest);
    }
    return out;
  }

  // ---------------------------------------------------------------- output

  /**
   * `result`, when the function has one, is returned instead of a plain `ret`.
   *
   * A module body needs it so that a script's last expression is the program's
   * value, the way the interpreter treats it.  A function that has no such
   * expression, or that returns explicitly, passes null and gets the usual bare
   * return -- the terminator is only replaced when nothing else has claimed it.
   */
  /**
   * Returns the module's value from the block being filled, if that block is open
   * and the value is still in scope.
   *
   * A module body's value is its last expression, but that expression may have
   * been lowered into a *join* block rather than the entry -- `1 if c else 2`
   * produces its answer after the branch -- so attaching the return to the entry
   * block regardless left the join block terminated with `unreachable` and the
   * program returned a garbage tag, printed as `<object>`.
   *
   * The second condition is the one that is easy to miss.  A value computed
   * inside a loop body is not in scope after the loop, because the body may run
   * zero times; returning it reads a slot that was never written.  Requiring the
   * two blocks to match is the conservative rule, and the verifier catches the
   * alternative.
   */
  returnModuleValue(last: { value: Operand; block: Block } | null, line: number): void {
    if (last === null) return;
    if (last.block.id !== this.current.id) return;
    if (this.current.term !== null) return;
    this.current.term = { t: "ret", value: last.value, line };
  }

  finish(name: string, params: VReg[], upvalues: IrFunc["upvalues"], result: Operand | null = null): IrFunc {
    const entry = this.blocks[0];
    if (entry === undefined) throw new L0pError("a function needs at least one block", 0, 0);
    const hasExplicitReturn = this.blocks.some((b) => b.term?.t === "ret");
    if (entry.term === null) {
      entry.term = hasExplicitReturn || result === null
        ? { t: "ret", value: null, line: 0 }
        : { t: "ret", value: result, line: 0 };
    }
    for (const b of this.blocks) {
      if (b.term === null) b.term = { t: "unreachable", line: 0 };
    }
    return {
      name,
      params,
      slotKinds: this.slotKinds,
      vregCount: this.nregs,
      blocks: this.blocks,
      isModule: this.isModule,
      upvalues,
    };
  }

  get blockCount(): number {
    return this.blocks.length;
  }
}
