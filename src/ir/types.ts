/**
 * What the compiler can know about a value before running anything.
 *
 * The language is dynamic and stays that way -- there is no annotation and no
 * file mode, and a value's type is decided by the value.  That is a property of
 * the *interpreter*, and this module must not quietly become a second answer to
 * it.  So the rule throughout is that anything not proven here is `any`, and
 * `any` means the runtime still gets to decide.  An unsound guess here does not
 * produce a crash in the compiler; it produces a native binary that disagrees
 * with the interpreter, which is the one failure this project exists to avoid.
 *
 * The lattice is a flat set of tags plus two summaries:
 *
 *     none    no value yet -- the start of the ascending chain, never read
 *     num     a number: int or float, and the code often cannot say which
 *     any     anything, including a type error
 *
 * `num` earns its place because int and float share a tag test and differ only in
 * how wide they are, so most arithmetic needs to know "a number" and not "which".
 * It cannot replace them, though: `add` of two known ints is `num` and not `int`,
 * because the sum of two int64s that overflows is a float.  That one fact is the
 * main limit on what inference buys, and it is why `sub` -- which cannot overflow
 * -- is the operation that gains the most.
 */

import type { IrFunc, Operand, VReg } from "./ir.ts";

export type Ty =
  | "none"
  | "any"
  | "null"
  | "bool"
  | "int"
  | "float"
  | "num"
  | "str"
  | "list"
  | "dict"
  | "struct"
  | "fn"
  | "upval"
  | "module"
  | "iter";

/**
 * The least upper bound: the weakest type that covers both.
 *
 * Upward and associative, which is what lets the fixpoint below be a plain loop
 * that re-runs until nothing moves.  Anything unrelated joins to `any`, because
 * two different tags have no single answer and the runtime still knows best.
 */
export function join(a: Ty, b: Ty): Ty {
  if (a === b) return a;
  if (a === "none") return b;
  if (b === "none") return a;
  if (a === "any" || b === "any") return "any";
  // int and float meet at num; num already is that meeting point.
  const numeric = (t: Ty): boolean => t === "int" || t === "float" || t === "num";
  if (numeric(a) && numeric(b)) {
    if (a === "num" || b === "num") return "num";
    return "num";
  }
  return "any";
}

/**
 * The type of a literal, which is also how it is *stored*.
 *
 * The range test is not decoration: `Number.isInteger(2**63)` is true, because a
 * double is a whole number long before it is a machine integer.  A literal
 * outside int64 has to be stored as a double, and codegen asks this function
 * rather than re-deriving the rule, so the two cannot drift apart.
 */
export function literalType(v: number | string | boolean | null): Ty {
  if (v === null) return "null";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  const fitsInt = v >= -(2 ** 63) && v < 2 ** 63;
  return Number.isInteger(v) && fitsInt ? "int" : "float";
}

const isNumber = (t: Ty): boolean => t === "int" || t === "float" || t === "num";

/**
 * Whether an operand could be a number.
 *
 * `any` counts, and that is the whole point.  These operators need numbers, so
 * if one of them returned, the values it returned are numbers -- whatever was
 * known about the operands going in.  Treating an unknown operand as "anything"
 * and answering `any` is sound but useless: it makes the fixpoint bottom out at
 * the first arithmetic instruction, so `acc = acc + i` in a loop is `any` at the
 * head, `i = i + 1` is `any` on the back edge, and the next pass has nothing to
 * work with either.
 *
 * An operand *known* to be a string still gives `any`, because then the operation
 * raises rather than returns, and the type of a value that was never produced is
 * not this pass's to decide.
 */
const couldBeNumber = (t: Ty): boolean => t === "any" || isNumber(t);

/** `+` is the only operator with three cases: numbers, strings and lists. */
function typeOfAdd(a: Ty, b: Ty): Ty {
  if (isNumber(a) && isNumber(b)) return "num";
  if (a === "str" && b === "str") return "str";
  if (a === "list" && b === "list") return "list";
  // Anything else is a type error at runtime, so the type of "it returned" is
  // not something this pass gets to decide.
  return "any";
}

/** What each built-in hands back.  Unknown names stay `any`. */
const BUILTIN_RESULT: Record<string, Ty> = {
  print: "null",
  len: "int",
  str: "str",
  int: "int",
  float: "float",
  bool: "bool",
  type: "str",
  iter: "iter",
  iter_more: "bool",
};

/**
 * The type an instruction produces, given the types of what it reads.
 *
 * Returning `any` is always sound and often correct, since most of these
 * operations reach the runtime for a reason.  The ones worth being precise about
 * are the arithmetic, because they are what the backend can then skip work for.
 */
function transfer(op: string, a: Ty, b: Ty, extra: Ty, name: string | undefined): Ty {
  switch (op) {
    case "const":
      return name === undefined ? "any" : a;
    case "copy":
      return a;

    // Arithmetic.  `sub` is the interesting one, and the only one of these that
    // can stay exactly `int`: two int64s always have an int64 difference, since
    // two's complement wraps around rather than out of range.  `add` and `mul`
    // overflow, and the runtime widens to a double when they do, so they cannot.
    case "sub": {
      if (a === "int" && b === "int") return "int";
      return couldBeNumber(a) && couldBeNumber(b) ? "num" : "any";
    }
    case "add":
      return typeOfAdd(a, b);
    case "mul":
    case "div":
    case "floordiv":
    case "mod":
    case "pow":
      return couldBeNumber(a) && couldBeNumber(b) ? "num" : "any";
    case "neg":
      return couldBeNumber(a) ? "num" : "any";
    case "pos":
      // `+x` is the value itself, so it can be exactly as wide as its operand.
      return isNumber(a) ? a : "any";
    case "bitnot":
      // `~x` goes through int32 in JavaScript and comes back an integer.
      return isNumber(a) ? "int" : "any";

    // Comparisons and predicates are bool whatever they compare.
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge":
    case "in":
    case "notin":
    case "not":
    case "truthy":
      return "bool";

    case "concat":
      return "str";
    case "list.new":
    case "list.push":
      return "list";
    case "dict.new":
      return "dict";
    case "struct.new":
      return "struct";
    case "new.closure":
      return "fn";

    // A call, a global, a field, an index, an unknown built-in: the runtime
    // decides, and so does this.
    case "call":
    case "load.global":
    case "load.upval":
    case "load.field":
    case "load.index":
    case "dict.get":
    case "dict.set":
      return "any";
    case "call.builtin": {
      if (name === undefined) return "any";
      const r = BUILTIN_RESULT[name];
      return r === undefined ? "any" : r;
    }

    default:
      return "any";
  }
}

/**
 * The type of an operand, for callers that want an answer now.
 *
 * A value the pass has nothing to say about reads as `any`.  Inside the fixpoint
 * the same value has to read as `none` instead, and `typeIn` is why: `any` is the
 * top of the lattice and absorbing, so a single premature `any` on a loop-head
 * phi would pin it there for the rest of the run.
 */
export function typeOfOperand(opnd: Operand, types: readonly Ty[]): Ty {
  const t = typeIn(opnd, types);
  return t === "none" ? "any" : t;
}

/** The type of an operand, with "not known yet" reported as the bottom. */
function typeIn(opnd: Operand, types: readonly Ty[]): Ty {
  if (opnd.t === "vreg") return types[opnd.v] ?? "none";
  if (opnd.t === "imm") return literalType(opnd.value);
  // A bare name is a global, read at run time.
  return "any";
}

/**
 * Infer a type for every virtual register in a function.
 *
 * A plain ascending fixpoint: start at `none`, join in what each instruction
 * produces, and repeat until nothing moves.  The lattice is finite, so it stops.
 * Loop-carried values settle at the join of what every path brings in, which is
 * why `x = 0` followed by `while ...: x = y` ends up `any` when `y` is `any`.
 *
 * Parameters start at `any` and globals are read as `any`, because this pass
 * looks at one function at a time and nothing outside it is knowable yet.
 */
export function inferTypes(f: IrFunc): Ty[] {
  const types: Ty[] = new Array<Ty>(f.vregCount).fill("none");
  // The values that arrive from outside carry no information at all.
  for (const p of f.params) types[p] = "any";

  /* Reading a slot that the fixpoint has not reached yet means "nothing known",
     which is what it was initialised to and never anything more hopeful. */
  const type = (v: VReg): Ty => types[v] ?? "none";

  let changed = true;
  while (changed) {
    changed = false;
    for (const b of f.blocks) {
      // A block's parameters are the join of what its predecessors hand over,
      // so they can only be settled once those predecessors have been read.
      for (const p of b.params) {
        let incoming: Ty = "none";
        for (const inc of p.incoming) incoming = join(incoming, typeIn(inc.value, types));
        const next = join(type(p.dest), incoming);
        if (next !== type(p.dest)) {
          types[p.dest] = next;
          changed = true;
        }
      }

      for (const i of b.instrs) {
        const at = (k: number): Ty => (i.args[k] === undefined ? "none" : typeIn(i.args[k], types));
        let produced: Ty;
        if (i.op === "const") {
          const imm = i.args[0];
          produced = imm !== undefined && imm.t === "imm" ? literalType(imm.value) : "any";
        } else {
          produced = transfer(i.op, at(0), at(1), at(2), i.info?.name);
        }
        if (i.dest !== null) {
          const next = join(type(i.dest), produced);
          if (next !== type(i.dest)) {
            types[i.dest] = next;
            changed = true;
          }
        }
      }
    }
  }
  return types;
}

/** The single type worth special-casing in codegen: provably an int64. */
export function isInt(t: Ty): boolean {
  return t === "int";
}