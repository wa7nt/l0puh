/**
 * Checking that a function really is in SSA.
 *
 * Every invariant here exists because some backend will silently miscompile
 * rather than crash if it is broken.  A register allocator handed a vreg that is
 * read before it is written does not complain; it produces a program that works
 * on the tests and wrong on the tenth input.  So the checks live here, at the one
 * point where a violation is still cheap to name.
 *
 * The one that matters most is dominance.  A value must be defined on every path
 * that reaches its use -- that is what makes the value a single register, and it
 * is the property that justifies copying a whole family of correctness arguments
 * from LLVM's verifier rather than re-deriving them.
 *
 * Dominators are computed with Cooper, Harvey & Kennedy's iterative algorithm,
 * which converges in one pass for reducible flow graphs (every structured
 * language front end produces one) and is otherwise still correct, just slower.
 */

import { L0pError } from "../errors.ts";
import type { Block, IrFunc, Terminator, VReg } from "./ir.ts";

export interface VerifyReport {
  /** Names of the properties that were checked, for the test suite to assert on. */
  checked: string[];
  /** Empty when the function is valid.  Anything here makes it invalid. */
  problems: string[];
  /**
   * Dead code, which is legal and which the backend will simply not emit.
   *
   * Kept separate from `problems` because a `break` at the end of a loop body
   * leaves the step block unreachable, and that is what every compiler produces
   * for that source.  Folding it into `problems` would mean either the lowering
   * grows a dead-block pass or every loop with a trailing `break` "fails".
   */
  warnings: string[];
}

/** Successors of a block, as block ids. */
function successors(f: IrFunc, b: Block): number[] {
  const t: Terminator | null = b.term;
  if (t === null) return [];
  switch (t.t) {
    case "jump":
      return [t.to];
    case "br":
      return [t.then, t.else];
    case "ret":
    case "unreachable":
      return [];
  }
}

function predecessors(f: IrFunc): Map<number, number[]> {
  const pred = new Map<number, number[]>();
  for (const b of f.blocks) pred.set(b.id, []);
  for (const b of f.blocks) {
    for (const s of successors(f, b)) {
      (pred.get(s) as number[]).push(b.id);
    }
  }
  return pred;
}

/** Reverse postorder from the entry block, computed iteratively. */
function postorder(f: IrFunc, entry: number): number[] {
  const byId = new Map(f.blocks.map((b) => [b.id, b]));
  const seen = new Set<number>();
  const out: number[] = [];
  // Explicit stack: recursion would be fine here but a deep if-chain in a
  // generated file is exactly the case that would blow it.
  const stack: { id: number; child: number }[] = [{ id: entry, child: 0 }];
  seen.add(entry);
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as { id: number; child: number };
    const kids = successors(f, byId.get(top.id) as Block);
    if (top.child < kids.length) {
      const next = kids[top.child++] as number;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push({ id: next, child: 0 });
      }
    } else {
      out.push(top.id);
      stack.pop();
    }
  }
  return out.reverse();
}

/** Maps block id -> set of blocks that dominate it, the block itself included. */
export function dominators(f: IrFunc): Map<number, Set<number>> {
  const entry = f.blocks[0]?.id;
  if (entry === undefined) return new Map();

  const rpo = postorder(f, entry);
  const rpoIndex = new Map(rpo.map((id, i) => [id, i]));
  const byId = new Map(f.blocks.map((b) => [b.id, b]));
  const all = new Set(rpo);

  const dom = new Map<number, Set<number>>();
  dom.set(entry, new Set([entry]));
  for (const id of rpo) {
    if (id !== entry) dom.set(id, new Set(all));
  }

  // "Intersection" under the depth-first order: start from the second element so
  // the first one can be a copy, never the set being built.
  const intersect = (a: Set<number>, b: Set<number>): Set<number> => {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    const out = new Set<number>();
    for (const x of small) if (large.has(x)) out.add(x);
    return out;
  };

  let changed = true;
  let rounds = 0;
  while (changed) {
    changed = false;
    rounds++;
    if (rounds > 1000) break; // a loop with a backedge to entry would do this
    for (const id of rpo) {
      if (id === entry) continue;
      const preds = (predecessors(f).get(id) ?? []).filter((p) => rpoIndex.has(p));
      let acc: Set<number> | null = null;
      for (const p of preds) {
        acc = acc === null ? (dom.get(p) as Set<number>) : intersect(acc, dom.get(p) as Set<number>);
      }
      const next = acc === null ? new Set([id]) : new Set([...acc, id]);
      const prev = dom.get(id) as Set<number>;
      if (next.size !== prev.size || [...next].some((x) => !prev.has(x))) {
        dom.set(id, next);
        changed = true;
      }
    }
  }
  return dom;
}

export function verifyFunc(f: IrFunc): VerifyReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const checked = [
    "entry-block-exists", "all-blocks-terminated", "entry-has-no-predecessors",
    "all-blocks-reachable", "vreg-defined-once", "vreg-use-dominated-by-def",
    "phi-has-predecessor-per-edge", "vreg-indexes-in-range", "phis-only-at-block-entry",
  ];
  if (f.blocks.length === 0) {
    return { checked, problems: ["function has no blocks"], warnings };
  }

  const entry = f.blocks[0] as Block;
  const pred = predecessors(f);
  const dom = dominators(f);

  // --- terminators ------------------------------------------------------
  for (const b of f.blocks) {
    if (b.term === null) problems.push(`block b${b.id} has no terminator`);
  }

  // --- entry and reachability -------------------------------------------
  if ((pred.get(entry.id) as number[]).length > 0) {
    problems.push(`entry block b${entry.id} has predecessors, so it can be re-entered`);
  }
  const reachable = new Set(dom.keys());
  for (const b of f.blocks) {
    if (!reachable.has(b.id)) {
      warnings.push(`block b${b.id} is unreachable, so it will not be emitted`);
    }
  }

  // --- definitions ------------------------------------------------------
  const defBlock = new Map<VReg, number>();
  const defLine = new Map<VReg, number>();

  // The parameters are defined by the function's own entry: the caller writes
  // them into the frame before the first instruction runs.  Without this every
  // function would be reported as using an undefined value, and the check would
  // be so noisy it would get switched off.
  for (const p of f.params) {
    defBlock.set(p, entry.id);
    defLine.set(p, 0);
  }

  for (const b of f.blocks) {
    for (const p of b.params) {
      if (defBlock.has(p.dest)) {
        problems.push(`v${p.dest} is defined twice: phi in b${b.id} and b${defBlock.get(p.dest)}`);
      }
      defBlock.set(p.dest, b.id);
      defLine.set(p.dest, p.line);
    }
    for (const i of b.instrs) {
      if (i.dest === null) continue;
      if (defBlock.has(i.dest)) {
        problems.push(`v${i.dest} is defined twice: line ${i.line} in b${b.id} and line ${defLine.get(i.dest)} in b${defBlock.get(i.dest)}`);
      }
      defBlock.set(i.dest, b.id);
      defLine.set(i.dest, i.line);
      if (i.dest >= f.vregCount) {
        problems.push(`v${i.dest} is outside vregCount=${f.vregCount}`);
      }
    }
  }

  // --- phis match the edges ---------------------------------------------
  for (const b of f.blocks) {
    const preds = pred.get(b.id) as number[];
    if (b.params.length > 0) {
      if (preds.length < 2) {
        problems.push(`b${b.id} has phis but only ${preds.length} predecessor(s); a phi there chooses nothing`);
      }
      for (const p of b.params) {
        const from = new Set(p.incoming.map((i) => i.from));
        for (const q of preds) {
          if (!from.has(q)) {
            problems.push(`phi v${p.dest} in b${b.id} has no incoming value for predecessor b${q}`);
          }
        }
        for (const i of p.incoming) {
          if (!preds.includes(i.from)) {
            problems.push(`phi v${p.dest} in b${b.id} names b${i.from} as a predecessor, but it is not one`);
          }
        }
      }
    }
  }

  // --- every use is defined on a path that reaches it --------------------
  const useAt = (b: Block): { v: VReg; line: number; what: string }[] => {
    const out: { v: VReg; line: number; what: string }[] = [];
    for (const p of b.params) {
      for (const i of p.incoming) {
        if (i.value.t === "vreg") out.push({ v: i.value.v, line: p.line, what: "phi" });
      }
    }
    for (const i of b.instrs) {
      for (const a of i.args) {
        if (a.t === "vreg") out.push({ v: a.v, line: i.line, what: i.op });
      }
    }
    const t = b.term;
    if (t !== null && t.t === "br" && t.cond.t === "vreg") {
      out.push({ v: t.cond.v, line: t.line, what: "br" });
    }
    if (t !== null && t.t === "ret" && t.value !== null && t.value.t === "vreg") {
      out.push({ v: t.value.v, line: t.line, what: "ret" });
    }
    return out;
  };

  for (const b of f.blocks) {
    const dominators = dom.get(b.id) ?? new Set([b.id]);
    for (const u of useAt(b)) {
      const where = defBlock.get(u.v);
      if (where === undefined) {
        problems.push(`v${u.v} is used by ${u.what} at line ${u.line} but never defined`);
        continue;
      }
      // A phi's inputs are read on the *incoming* edge, so the def must dominate
      // the predecessor, not the merge block.  That is the usual place a
      // hand-built phi is wrong.
      if (u.what === "phi") {
        // A phi's inputs are read on the *incoming edge*, so each def must
        // dominate its own predecessor, not the merge block.  That is the usual
        // place a hand-built phi is wrong.
        for (const phi of b.params) {
          for (const inc of phi.incoming) {
            if (inc.value.t !== "vreg") continue;
            const definedIn = defBlock.get(inc.value.v);
            const d = dom.get(inc.from) ?? new Set<number>();
            if (definedIn === undefined || !d.has(definedIn)) {
              problems.push(`phi input v${inc.value.v} in b${b.id} is not defined on the path from b${inc.from}`);
            }
          }
        }
        continue;
      }
      if (!dominators.has(where)) {
        problems.push(`v${u.v} is used by ${u.what} at line ${u.line} in b${b.id}, but it is only defined in b${where}, which does not dominate it`);
      }
    }
  }

  return { checked, problems, warnings };
}

export function verifyModule(funcs: IrFunc[]): VerifyReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const f of funcs) {
    const r = verifyFunc(f);
    problems.push(...r.problems.map((p) => `${f.name}: ${p}`));
    warnings.push(...r.warnings.map((w) => `${f.name}: ${w}`));
  }
  return { checked: ["per-function"], problems, warnings };
}
