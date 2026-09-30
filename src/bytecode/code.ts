/**
 * Compiled units: a module and the functions inside it.
 *
 * A `Proto` is a function body.  A `Module` is one compiled `.l0p` file: an
 * entry `Proto` plus every function nested inside it, in one flat table, because
 * a closure is then just an index.
 *
 * Two decisions worth stating:
 *
 *  - constants are per-proto and hold numbers, strings and small prototypes.
 *    Global names and attribute names are interned as strings here rather than
 *    kept in a side table, so an M8 inline cache only has to compare a string
 *    pointer to a remembered one.
 *  - slots carry their binding kind, so `x = 1` on a `let` is caught at run
 *    time by the VM with one array lookup, not by a separate symbol table.
 */

import type { Binding } from "../ast.ts";
import type { Op } from "./op.ts";

export type Constant =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "null" }
  /** A field list for `struct`: names paired with the slot each one lives in. */
  | { type: "fields"; value: readonly { name: string; slot: number }[] };

export interface Proto {
  readonly name: string;
  /** Parameter names, in slot order.  Slots 0..nparams-1. */
  readonly params: readonly string[];
  /** Total slots, parameters included. */
  readonly nslots: number;
  /** What each slot may be assigned to. */
  readonly slotKinds: readonly (Binding | "param")[];
  readonly code: readonly Op[];
  readonly consts: readonly Constant[];
  /**
   * The values behind `consts`, in the same order, ready to push.
   *
   * The interpreter used to call a function and switch on the constant's *type*
   * for every `Const` it executed.  Resolving them once at compile time turns
   * the hot instruction into a single array read, and the tag is still there in
   * `consts` for the few instructions that need it (attribute names, struct
   * field lists).
   */
  readonly constValues: readonly (number | string | boolean | null)[];
  /** Indices into the owning module's function table. */
  readonly protos: readonly number[];
  /** How each upvalue is found: a slot of the enclosing function, or its upvalue. */
  readonly upvalues: readonly UpvalueSource[];
  /** True for the module body, which is not a callable function. */
  readonly isModule: boolean;
}

export type UpvalueSource =
  | { kind: "parent-local"; slot: number }
  | { kind: "parent-upvalue"; index: number };

export interface Module {
  readonly name: string;
  readonly file: string | null;
  readonly entry: number;
  /**
   * Slot of the module frame holding the value of the last expression
   * statement, or null when the program ends in something else.  A REPL needs
   * it, and `Halt` cannot infer it: the value is popped before it runs.
   */
  readonly resultSlot: number | null;
  readonly protos: readonly Proto[];
  /** `import` statements, kept by index so the VM can resolve them at run time. */
  readonly imports: readonly ImportSpec[];
  /**
   * What each module-level name may be assigned to.  A function bound with
   * `def` is "def", which may not be reassigned either.
   */
  readonly globalKinds: ReadonlyMap<string, Binding | "def">;
}

export interface ImportSpec {
  readonly form: "import" | "from";
  readonly path: string;
  readonly alias: string | null;
  readonly names: readonly string[];
  readonly level: number;
  /** Name this import binds, or null for `from m import ...`. */
  readonly local: string | null;
  /** Instruction index of the `Import` site, for error positions. */
  readonly line: number;
  readonly col: number;
}

export class ConstPool {
  private readonly items: Constant[] = [];
  private readonly seen = new Map<string, number>();

  /** Interns a value; the same string always gets the same index. */
  add(value: Constant, key?: string): number {
    const index = key === undefined ? undefined : this.seen.get(key);
    if (index !== undefined) return index;
    const at = this.items.length;
    this.items.push(value);
    if (key !== undefined) this.seen.set(key, at);
    return at;
  }

  number(value: number): number {
    return this.add({ type: "number", value });
  }

  string(value: string): number {
    return this.add({ type: "string", value }, `s:${value}`);
  }

  bool(value: boolean): number {
    return this.add({ type: "bool", value }, `b:${value}`);
  }

  null(): number {
    return this.add({ type: "null" }, "null");
  }

  fields(value: readonly { name: string; slot: number }[]): number {
    // Field lists are compared by value, so they are not interned by identity.
    return this.add({ type: "fields", value });
  }

  list(): readonly Constant[] {
    return this.items;
  }
}

const NUMBER_LABELS = new Map<number, string>([
  [0, "0"], [1, "1"], [-1, "-1"], [2, "2"], [10, "10"],
]);

/**
 * The pushable value behind a constant.
 *
 * A field list is metadata, not something an instruction pushes, so it maps to
 * null; the two instructions that read one (`NewStruct`, `StructType`) go to
 * `consts` for the tag.
 */
export function plainValue(c: Constant): number | string | boolean | null {
  switch (c.type) {
    case "number":
    case "string":
    case "bool":
      return c.value;
    case "null":
    case "fields":
      return null;
  }
}

/** How a constant should appear in a disassembly. */
export function constLabel(c: Constant): string {
  switch (c.type) {
    case "number":
      return NUMBER_LABELS.get(c.value) ?? String(c.value);
    case "string":
      return JSON.stringify(c.value);
    case "bool":
      return c.value ? "true" : "false";
    case "null":
      return "null";
    case "fields":
      return `{${c.value.map((f) => f.name).join(", ")}}`;
  }
}
