/**
 * Runtime values.
 *
 * Numbers and strings are plain JavaScript primitives on purpose: the fastest
 * possible representation, and the one a later WASM backend can use directly.
 * Everything else is a class instance, so `Array.isArray` alone identifies a
 * list -- there is no tagging or boxing.
 *
 * Two decisions here are about what comes later:
 *
 *  - an upvalue is a `{ frame, slot }` pair rather than a copied value.  The
 *    frame is the container, so a closure reads and writes the same storage the
 *    enclosing function does, and `var` inside a closure behaves.
 *  - a struct is a type name plus a flat field array, with field names kept
 *    only on the type.  Attribute lookup is then a name comparison, not a
 *    dictionary probe, which is what makes a `struct` worth having over a dict.
 */

import type { Proto } from "../bytecode/code.ts";

export type Value = number | string | boolean | null | Value[] | Dict | Struct | StructType | Closure | Builtin | Iterator | ModuleRef;

/** An ordered mapping.  Insertion order is preserved, so printing is stable. */
export class Dict {
  readonly map: Map<Value, Value> = new Map();

  static of(entries: Iterable<readonly [Value, Value]>): Dict {
    const d = new Dict();
    for (const [k, v] of entries) d.map.set(k, v);
    return d;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: Value): Value | undefined {
    return this.map.get(key);
  }

  set(key: Value, value: Value): void {
    this.map.set(key, value);
  }

  has(key: Value): boolean {
    return this.map.has(key);
  }

  delete(key: Value): boolean {
    return this.map.delete(key);
  }

  keys(): Value[] {
    return [...this.map.keys()];
  }

  entries(): [Value, Value][] {
    return [...this.map.entries()];
  }
}

/** The shape of a struct: field names in slot order. */
export class StructType {
  readonly name: string;
  readonly fields: readonly string[];
  /** Name to slot, for attribute lookup. */
  readonly index: ReadonlyMap<string, number>;
  /**
   * A type is callable, so it has to be a `Proto` to hand a `Closure`.  This
   * empty one exists only to satisfy the field; calling a struct type never
   * enters bytecode.
   */
  readonly entry: Proto;

  constructor(name: string, fields: readonly string[], index: ReadonlyMap<string, number>) {
    this.name = name;
    this.fields = fields;
    this.index = index;
    // `constValues` is read on every frame entry, so leaving it out here would
    // hand the hot loop an `undefined` the moment a struct's entry proto was
    // ever used as a frame.  Nothing calls it today, which is exactly why it
    // would have survived: a field nobody reads until the day somebody does.
    this.entry = {
      name, params: [], nslots: 0, slotKinds: [], code: [],
      consts: [], constValues: [], protos: [], upvalues: [], isModule: false,
    };
  }
}

export class Struct {
  readonly type: StructType;
  readonly values: Value[];

  constructor(type: StructType, values: Value[]) {
    this.type = type;
    this.values = values;
  }

  field(name: string): Value | undefined {
    const at = this.type.index.get(name);
    return at === undefined ? undefined : this.values[at];
  }
}

/** A function value: code plus the storage its free variables live in. */
export class Closure {
  readonly proto: Proto;
  readonly upvalues: readonly Upvalue[];
  readonly builtin: Builtin | null;
  readonly name: string;
  /** The struct type this name denotes, when a `struct` statement bound it. */
  readonly structType: StructType | null;

  constructor(
    proto: Proto,
    upvalues: readonly Upvalue[],
    builtin: Builtin | null = null,
    name?: string,
    structType: StructType | null = null,
  ) {
    this.proto = proto;
    this.upvalues = upvalues;
    this.builtin = builtin;
    this.name = name ?? proto.name;
    this.structType = structType;
  }
}

export interface Upvalue {
  frame: Frame;
  slot: number;
}

/** A host function exposed to l0puh code. */
export class Builtin {
  readonly name: string;
  readonly fn: (args: Value[], vm: Vm) => Value;
  readonly arity: number;

  constructor(name: string, fn: (args: Value[], vm: Vm) => Value, arity = -1) {
    this.name = name;
    this.fn = fn;
    this.arity = arity;
  }
}

/** Anything with `next()`: lists, strings, dicts and ranges. */
export interface Iterator {
  next(): Value | typeof DONE;
}

export const DONE = Symbol("done");

/**
 * A lazy arithmetic sequence.  `range(10 ** 9)` cannot be a list, so anything
 * long enough to matter is one of these instead: the iterator protocol is all
 * `for` needs.
 */
export class Range implements Iterator {
  private readonly from: number;
  private readonly count: number;
  private readonly step: number;
  private i = 0;

  constructor(from: number, count: number, step: number) {
    this.from = from;
    this.count = count;
    this.step = step;
  }

  next(): Value | typeof DONE {
    return this.i < this.count ? this.from + this.i++ * this.step : DONE;
  }
}

/** A loaded module, as seen by l0puh code. */
export class ModuleRef {
  readonly name: string;
  readonly file: string | null;
  readonly exports: Map<string, Value>;

  constructor(name: string, file: string | null, exports: Map<string, Value>) {
    this.name = name;
    this.file = file;
    this.exports = exports;
  }
}

/**
 * A call frame.
 *
 * `slots` holds parameters then locals.  There is no separate cell array: a
 * closure captures the frame itself, so a write through an upvalue lands in the
 * same place a read will find it.
 */
/**
 * A call frame.
 *
 * `slots` holds parameters then locals.  There is no separate cell array: a
 * closure captures the frame itself, so a write through an upvalue lands in the
 * same place a read will find it.
 *
 * The object is mutated and reused rather than allocated per call, so every
 * field here has to be assigned on entry, not just the ones that changed.
 * `escaped` is the one piece of bookkeeping that matters for that: a frame a
 * closure captured must not go back into the pool, because the closure is still
 * holding it.
 */
export interface Frame {
  proto: Proto;
  closure: Closure | null;
  slots: Value[];
  /** Where this frame's operands start on the shared stack. */
  base: number;
  /** Instruction to resume at when this frame returns. */
  retIp: number;
  retFrame: number;
  /** The module this frame belongs to; a call cannot cross into another one. */
  module: unknown;
  /** Module-level names.  Shared with every frame the module calls into. */
  globals: Map<string, Value>;
  /** Set when a closure captures this frame; then it cannot be pooled. */
  escaped: boolean;
}

export type { Proto };

/** The shape the VM exposes to builtins, kept minimal to avoid a cycle. */
export interface Vm {
  print(text: string): void;
  readonly stack: Value[];
  readonly frames: Frame[];
}

// ------------------------------------------------------------- formatting

/**
 * How a value prints.  Strings print bare here; `str()` and `repr()` add the
 * quotes, which is why this is not the same as `toDisplay`.
 */
export function toDisplay(v: Value): string {
  if (typeof v === "string") return v;
  return repr(v);
}

export function repr(v: Value): string {
  /*
   * Null first, and not in the switch below.
   *
   * `typeof null` is `"object"` in JavaScript, so `case "null"` in a `typeof`
   * switch names a value that `typeof` never returns.  The case was dead: it
   * never ran, and `repr(null)` printed `null` only because the last line of the
   * function is `String(v)`, which happens to spell it the same way.  That is the
   * whole failure mode -- a branch that cannot execute, whose result is right for
   * a reason unrelated to why the branch was there.
   */
  if (v === null) return "null";
  switch (typeof v) {
    case "number":
      return formatNumber(v);
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    default:
      break;
  }
  /*
   * Past the primitives, only the object members remain.
   *
   * One assertion here, and then ordinary narrowing works for the whole
   * `instanceof` chain below.  Without it TypeScript narrows `v` to `never` and
   * then reports every property access as missing -- 28 complaints that say
   * nothing about the code and everything about how `Value` is modelled.
   */
  const o = v as Value[] | Dict | Struct | StructType | Closure | Builtin | Iterator | ModuleRef;
  if (Array.isArray(o)) return `[${o.map(repr).join(", ")}]`;
  if (o instanceof Dict) {
    return `{${o.entries().map(([k, val]: readonly [Value, Value]) => `${repr(k)}: ${repr(val)}`).join(", ")}}`;
  }
  if (o instanceof Struct) {
    return `${o.type.name}(${o.type.fields.map((f: string, i: number) => `${f}=${repr(o.values[i] ?? null)}`).join(", ")})`;
  }
  if (o instanceof StructType) return `<struct ${o.name}>`;
  if (o instanceof Closure) return `<fn ${o.name}>`;
  if (o instanceof Builtin) return `<builtin ${o.name}>`;
  if (o instanceof ModuleRef) return `<module ${o.name}>`;
  return String(v);
}

/** Whole numbers print without a `.0`, the way a person would write them. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return String(n);
}

export function typeName(v: Value): string {
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
  if (v instanceof Struct) return v.type.name;
  if (v instanceof StructType) return "struct";
  if (v instanceof Closure) return "fn";
  if (v instanceof Builtin) return "builtin";
  if (v instanceof ModuleRef) return "module";
  return "object";
}

/** Truthiness, following Python: empty collections and zero are false. */
export function truthy(v: Value): boolean {
  if (v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Dict) return v.size > 0;
  return true;
}
