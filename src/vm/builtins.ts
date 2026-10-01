/**
 * The builtins a program can call without importing anything.
 *
 * They are host functions wrapped in the same `Closure` a l0puh `def` compiles
 * to, so calling one costs the same as calling any other function.  Anything
 * that needs a module goes through the loader instead.
 *
 * `range` and `str` are here rather than in a `std` module on purpose: they are
 * needed by the first program anyone writes, and a REPL with an empty namespace
 * is a bad first impression.
 */

import { Dict, Range, repr, toDisplay, truthy, type Value, type Vm } from "./value.ts";
import { Builtin } from "./value.ts";

export function makeBuiltins(): [string, Value][] {
  return Object.entries(BUILTINS).map(([name, fn]) => [name, new Builtin(name, fn)]);
}

const BUILTINS: Record<string, (args: Value[], vm: Vm) => Value> = {
  print: (args, vm) => {
    vm.print(args.map(toDisplay).join(" "));
    return null;
  },

  len: (args) => {
    const v = args[0] as Value;
    if (typeof v === "string") return v.length;
    if (Array.isArray(v)) return v.length;
    if (v instanceof Dict) return v.size;
    throw new Error(`len() has no length for ${repr(v)}`);
  },

  str: (args) => toDisplay(args[0] as Value),

  repr: (args) => repr(args[0] as Value),

  bool: (args) => truthy(args[0] as Value),

  int: (args) => {
    const v = args[0] as Value;
    if (typeof v === "number") return Math.trunc(v);
    if (typeof v === "string") {
      const n = Number(v.trim());
      if (Number.isNaN(n)) throw new Error(`int(): ${JSON.stringify(v)} is not a number`);
      return Math.trunc(n);
    }
    throw new Error(`int() cannot convert ${repr(v)}`);
  },

  float: (args) => {
    const v = args[0] as Value;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number(v.trim());
      if (Number.isNaN(n)) throw new Error(`float(): ${JSON.stringify(v)} is not a number`);
      return n;
    }
    throw new Error(`float() cannot convert ${repr(v)}`);
  },

  type: (args) => typeName(args[0] as Value),

  range: (args) => makeRange(args),

  abs: (args) => Math.abs(number("abs", args[0] as Value)),
  min: (args) => extremum(args, Math.min),
  max: (args) => extremum(args, Math.max),

  list: (args) => {
    const v = args[0] as Value;
    if (v === undefined) return [];
    if (Array.isArray(v)) return [...v];
    if (typeof v === "string") return v.split("");
    if (v instanceof Dict) return v.keys();
    throw new Error(`list() cannot convert ${repr(v)}`);
  },

  dict: (args) => {
    const v = args[0] as Value;
    if (v === undefined) return new Dict();
    if (v instanceof Dict) return Dict.of(v.entries());
    if (Array.isArray(v)) {
      const out = new Dict();
      for (const pair of v) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error("dict() needs pairs");
        out.set(pair[0] as Value, pair[1] as Value);
      }
      return out;
    }
    throw new Error(`dict() cannot convert ${repr(v)}`);
  },

  keys: (args) => {
    const v = args[0] as Value;
    if (v instanceof Dict) return v.keys();
    throw new Error(`keys() needs a dict, got ${repr(v)}`);
  },

  values: (args) => {
    const v = args[0] as Value;
    if (v instanceof Dict) return v.entries().map(([, val]) => val);
    throw new Error(`values() needs a dict, got ${repr(v)}`);
  },

  get: (args) => {
    const v = args[0] as Value;
    const key = args[1] as Value;
    const fallback = (args[2] ?? null) as Value;
    if (v instanceof Dict) {
      const got = v.get(key);
      return got === undefined && !v.has(key) ? fallback : (got as Value);
    }
    if (Array.isArray(v) && typeof key === "number") {
      const at = key < 0 ? v.length + key : key;
      return at >= 0 && at < v.length ? (v[at] as Value) : fallback;
    }
    throw new Error(`get() needs a dict or list, got ${repr(v)}`);
  },

  push: (args) => {
    const list = args[0];
    if (!Array.isArray(list)) throw new Error(`push() needs a list, got ${repr(list as Value)}`);
    for (const a of args.slice(1)) list.push(a);
    return null;
  },

  has: (args) => {
    const v = args[0] as Value;
    const key = args[1] as Value;
    if (v instanceof Dict) return v.has(key);
    if (Array.isArray(v)) return v.some((x) => x === key);
    if (typeof v === "string") return v.includes(String(key));
    throw new Error(`has() needs a dict, list or str, got ${repr(v)}`);
  },

  delete: (args) => {
    const v = args[0] as Value;
    const key = args[1] as Value;
    if (v instanceof Dict) return v.delete(key);
    if (Array.isArray(v) && typeof key === "number") {
      if (key < 0 || key >= v.length) return false;
      v.splice(key, 1);
      return true;
    }
    throw new Error(`delete() needs a dict or list, got ${repr(v)}`);
  },

  assert: (args) => {
    if (!truthy(args[0] as Value)) {
      const message = args[1];
      throw new Error(message === undefined ? "assertion failed" : toDisplay(message));
    }
    return null;
  },
};

function number(who: string, v: Value): number {
  if (typeof v !== "number") throw new Error(`${who}() needs a number, got ${repr(v)}`);
  return v;
}

function extremum(args: Value[], pick: (a: number, b: number) => number): Value {
  if (args.length === 0) throw new Error("min()/max() need at least one value");
  let best = number("min/max", args[0] as Value);
  for (const a of args.slice(1)) {
    const n = number("min/max", a as Value);
    if (pick(n, best) === n) best = n;
  }
  return best;
}

/**
 * `range(n)`, `range(from, to)` and `range(from, to, step)`, with `to`
 * exclusive.  A list is produced eagerly for the two common small cases and
 * lazily otherwise, so `range(10**9)` does not try to allocate a billion cells.
 */
function makeRange(args: Value[]): Value {
  let from = 0;
  let to: number;
  let step = 1;

  if (args.length === 1) {
    to = number("range", args[0] as Value);
  } else if (args.length === 2) {
    from = number("range", args[0] as Value);
    to = number("range", args[1] as Value);
  } else if (args.length === 3) {
    from = number("range", args[0] as Value);
    to = number("range", args[1] as Value);
    step = number("range", args[2] as Value);
  } else {
    throw new Error(`range() takes one to three arguments, got ${args.length}`);
  }
  if (step === 0) throw new Error("range() step cannot be zero");
  if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(step)) {
    throw new Error("range() needs integers");
  }

  const count = Math.max(0, Math.ceil((to - from) / step));
  if (count <= 4096) {
    const out: number[] = new Array<number>(count);
    for (let i = 0; i < count; i++) out[i] = from + i * step;
    return out;
  }
  return new Range(from, count, step);
}

function typeName(v: Value): string {
  /* `typeof null` is `"object"`, so null is checked before the switch. */
  if (v === null) return "null";
  switch (typeof v) {
    case "number":
      return Number.isInteger(v) ? "int" : "float";
    case "string":
      return "str";
    case "boolean":
      return "bool";
    default:
      break;
  }
  if (Array.isArray(v)) return "list";
  if (v instanceof Dict) return "dict";
  return "object";
}
