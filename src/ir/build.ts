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
import { vreg, type Block, type Instr, type IrFunc, type IrOp, type OpenPhi, type Operand, type Phi, type Terminator, type VReg } from "./ir.ts";

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
    /*
     * What this block leaves behind is settled at its terminator, so that is
     * when the snapshot is taken.  Recording earlier would miss the writes in
     * the block; recording later would see whatever the *next* block bound, which
     * is a different block's answer.
     */
    this.recordPath(this.current);
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

  /**
   * A loop head's phis, opened before the body that fills them in.
   *
   * A head is the one place a phi must exist *before* the code that fills it: the
   * body reads the name, and on the second pass that read has to see the value
   * arriving from the back edge, not the one from before the loop.  Making it
   * afterwards is too late -- every read in the body already points at the
   * pre-loop value, which is how `i = i + 1` compiled to a `copy` nobody read,
   * leaving the condition testing the same number forever.
   *
   * So each candidate name is bound to a phi carrying only the entry edge, and
   * `closeLoopPhis` supplies the back edge afterwards.  Candidates come from a
   * scan of the body, because a phi for every live name would be a phi for every
   * local the loop merely reads.
   */
  openLoopPhis(candidates: readonly string[], entry: Block, line: number): OpenPhi[] {
    const out: OpenPhi[] = [];
    for (const name of candidates) {
      const at = this.lookup(name);
      if (at === null) continue;   // not live here: the body creates it, no merge
      const dest = this.newReg();
      const phi: Phi = { dest, incoming: [{ from: entry.id, value: vreg(at) }], line };
      out.push({ name, phi });
      // The body reads the phi, which is what makes the second pass see the
      // back-edge value instead of the pre-loop one.
      this.bind(name, dest);
    }
    return out;
  }

  /** The blocks that can flow into `merge`, read off the terminators. */
  predecessorsOf(merge: Block): Block[] {
    return this.blocks.filter((b) => {
      const t = b.term;
      if (t === null) return false;
      if (t.t === "jump") return t.to === merge.id;
      if (t.t === "br") return t.then === merge.id || t.else === merge.id;
      return false;
    });
  }

  /**
   * Fills in the back edge and installs the phis on the head.
   *
   * Every predecessor of the head contributes an incoming value, not just the
   * block the body happened to end in.  A `continue` written inside an `if` two
   * blocks deep is its own edge into the head, and a phi with an incoming only
   * for the body is a phi missing an arm -- which the verifier rejects outright,
   * so the program does not compile rather than computing the wrong thing.
   *
   * Each value comes from that predecessor's own snapshot rather than from
   * looking the name up now, because a name read "now" is whatever the last
   * block lowered happened to bind, which is one path's answer and not the
   * other's.
   *
   * An incoming may well be the phi's own destination, and that is correct
   * rather than a cycle: on a back edge the value already in the phi's slot is
   * the previous iteration's, and naming it is how a name the body never writes
   * survives around the loop.  Guarding against that -- reading the pre-loop
   * value instead -- quietly resets the name on every `continue`, which is a
   * loop that counts correctly and then loses its accumulator.
   */
  closeLoopPhis(head: Block, open: readonly OpenPhi[]): void {
    const preds = this.predecessorsOf(head);
    if (preds.length < 2) return;
    for (const o of open) {
      const incoming: { from: number; value: Operand }[] = [];
      let complete = true;
      for (const p of preds) {
        const v = this.paths.get(p.id)?.get(o.name);
        if (v === undefined) {
          complete = false;
          break;
        }
        incoming.push({ from: p.id, value: vreg(v) });
      }
      if (!complete) continue;
      o.phi.incoming = incoming;
      head.params.push(o.phi);
      this.phis.push({ block: head.id, phi: o.phi });
    }
  }

  /** Remembers what a block left behind, so a join can build phis from it. */
  recordPath(block: Block): void {
    /*
     * First write wins.  A block's bindings are final once it is terminated, so
     * a second snapshot would capture names some later block rebound at the same
     * scope -- giving this block's predecessors someone else's values.
     */
    if (this.paths.has(block.id)) return;
    this.paths.set(block.id, this.snapshot());
  }

  /**
   * The phis for a block every predecessor flows into.
   *
   * The two-block `join` above handles an `if`.  A loop head and a loop exit do
   * not fit that shape: a head is entered both on the first pass and on every
   * back edge, and an exit is reached both by the condition failing and by any
   * `break` -- so the predecessor list is however long the source made it.
   *
   * Reading the predecessors out of the terminators rather than being handed them
   * is what makes that safe.  A `continue` written three blocks deep into a body
   * adds an edge no caller was tracking, and the phi still has to be there.
   */
  mergeParams(merge: Block, line: number): Phi[] {
    const preds = this.blocks.filter((b) => {
      const t = b.term;
      if (t === null) return false;
      if (t.t === "jump") return t.to === merge.id;
      if (t.t === "br") return t.then === merge.id || t.else === merge.id;
      return false;
    });
    if (preds.length < 2) return [];

    const out: Phi[] = [];
    const names = [...new Set(preds.flatMap((p) => [...(this.paths.get(p.id)?.keys() ?? [])]))].sort();
    for (const name of names) {
      const incoming: { from: number; value: Operand }[] = [];
      let same = true;
      let first: VReg | undefined;
      for (const p of preds) {
        const v = this.paths.get(p.id)?.get(name);
        /*
         * A name that is not live on every path is not this merge's business.
         * Deciding what reading it means on the path that lacks it belongs to
         * whoever writes the source, not here.
         */
        if (v === undefined) {
          incoming.length = 0;
          break;
        }
        if (first === undefined) first = v;
        else if (first !== v) same = false;
        incoming.push({ from: p.id, value: vreg(v) });
      }
      if (incoming.length === 0 || same) continue;

      const dest = this.newReg();
      const phi: Phi = { dest, incoming, line };
      out.push(phi);
      this.phis.push({ block: merge.id, phi });
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
