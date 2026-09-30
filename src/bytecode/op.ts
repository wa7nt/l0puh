/**
 * The instruction set.
 *
 * A stack machine with locals in a per-call array, in the style of CPython's
 * "fast locals".  Two properties matter more than elegance here:
 *
 *  - the loop is a `switch` over small integers, which V8 turns into a jump
 *    table, so dispatch is a few nanoseconds rather than a property lookup;
 *  - every operand is a plain number and every instruction is a flat object,
 *    which is what a later WASM backend wants to walk as well.  There is no
 *    separate IR stage: this stream *is* the IR, and the WASM backend
 *    (M9) consumes it directly.
 *
 * Operands live in `a` and `b`, unused ones zero.  What each op means:
 *
 *   Const        a = constant index
 *   LoadLocal    a = slot              StoreLocal   a = slot
 *   LoadUpval    a = upvalue index     StoreUpval   a = upvalue index
 *   LoadGlobal   a = name index        StoreGlobal  a = name index
 *                                          b = 1 for a declaration, 0 for an assignment
 *   LoadAttr     a = name index        SetAttr      a = name index
 *   NewList      a = element count     NewDict      a = pair count
 *   NewStruct    a = type name index   b = fields constant index
 *   Concat       a = part count
 *   Bin          a = binary op         Un           a = unary op
 *   Jump         a = target            JumpIfFalse  a = target
 *   JumpIfTrue   a = target            JumpIfFalseOrPop a = target
 *   JumpIfTrueOrPop a = target
 *   GetIter                            ForIter      a = target
 *   Closure      a = proto index       Call         a = argument count
 *   Import       a = index into the module's import table
 *   Return                            Halt
 *
 * `Store*` leave the stored value on the stack, so `x = y = 1` needs no
 * duplication and an expression statement can discard one slot with `Pop`.
 */

/**
 * The opcodes, as numbers.
 *
 * Numbers, not strings, and that is the single biggest performance decision in
 * the VM.  A `switch` over string keys is a chain of string comparisons; over a
 * small dense range of integers V8 builds a jump table.  Measured on a
 * 10-million-iteration dispatch loop, string dispatch ran 2764 ms and integer
 * dispatch 509 ms -- 5.4x -- and the interpreter spends most of its time
 * dispatching.
 *
 * `OP_NAME` is the reverse table, for the disassembler.  Never compare
 * `o.op` to a string.
 */
export const OP = {
  Const: 0,
  Pop: 1,
  Dup: 2,
  LoadLocal: 3,
  StoreLocal: 4,
  LoadUpval: 5,
  StoreUpval: 6,
  LoadGlobal: 7,
  StoreGlobal: 8,
  NewList: 9,
  NewDict: 10,
  NewStruct: 11,
  StructType: 12,
  Concat: 13,
  GetIndex: 14,
  SetIndex: 15,
  GetAttr: 16,
  SetAttr: 17,
  Bin: 18,
  Un: 19,
  Not: 20,
  Jump: 21,
  JumpIfFalse: 22,
  JumpIfTrue: 23,
  JumpIfFalseOrPop: 24,
  JumpIfTrueOrPop: 25,
  GetIter: 26,
  ForIter: 27,
  Closure: 28,
  Call: 29,
  Import: 30,
  Return: 31,
  Halt: 32,
} as const;

export type OpKind = (typeof OP)[keyof typeof OP];

/** Opcode to its name, for readable output. */
export const OP_NAME: Readonly<Record<OpKind, string>> = {
  [OP.Const]: "Const",
  [OP.Pop]: "Pop",
  [OP.Dup]: "Dup",
  [OP.LoadLocal]: "LoadLocal",
  [OP.StoreLocal]: "StoreLocal",
  [OP.LoadUpval]: "LoadUpval",
  [OP.StoreUpval]: "StoreUpval",
  [OP.LoadGlobal]: "LoadGlobal",
  [OP.StoreGlobal]: "StoreGlobal",
  [OP.NewList]: "NewList",
  [OP.NewDict]: "NewDict",
  [OP.NewStruct]: "NewStruct",
  [OP.StructType]: "StructType",
  [OP.Concat]: "Concat",
  [OP.GetIndex]: "GetIndex",
  [OP.SetIndex]: "SetIndex",
  [OP.GetAttr]: "GetAttr",
  [OP.SetAttr]: "SetAttr",
  [OP.Bin]: "Bin",
  [OP.Un]: "Un",
  [OP.Not]: "Not",
  [OP.Jump]: "Jump",
  [OP.JumpIfFalse]: "JumpIfFalse",
  [OP.JumpIfTrue]: "JumpIfTrue",
  [OP.JumpIfFalseOrPop]: "JumpIfFalseOrPop",
  [OP.JumpIfTrueOrPop]: "JumpIfTrueOrPop",
  [OP.GetIter]: "GetIter",
  [OP.ForIter]: "ForIter",
  [OP.Closure]: "Closure",
  [OP.Call]: "Call",
  [OP.Import]: "Import",
  [OP.Return]: "Return",
  [OP.Halt]: "Halt",
};

export type OpKind = (typeof OP)[keyof typeof OP];

export interface Op {
  op: OpKind;
  a: number;
  b: number;
  line: number;
}

export function op(kind: OpKind, a = 0, b = 0, line = 0): Op {
  return { op: kind, a, b, line };
}

/** Binary operators, by index.  The order is the VM's switch order. */
export const BIN = [
  "+", "-", "*", "/", "//", "%", "**",
  "==", "!=", "<", "<=", ">", ">=",
  "&", "|", "^", "<<", ">>",
  "in", "not in",
  "and", "or",
] as const;

export type BinOp = (typeof BIN)[number];

const BIN_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  BIN.map((name, i) => [name, i]),
);

export function binIndex(name: string): number {
  const index = BIN_INDEX[name];
  if (index === undefined) throw new Error(`unknown binary operator: ${name}`);
  return index;
}

export function binName(index: number): string {
  return BIN[index] ?? "?";
}

/** Unary operators, by index. */
export const UN = ["-", "+", "~", "not"] as const;
export type UnOp = (typeof UN)[number];

const UN_INDEX: Readonly<Record<string, number>> = Object.fromEntries(UN.map((name, i) => [name, i]));

export function unIndex(name: string): number {
  const index = UN_INDEX[name];
  if (index === undefined) throw new Error(`unknown unary operator: ${name}`);
  return index;
}

export function unName(index: number): string {
  return UN[index] ?? "?";
}

/** A readable dump of a compiled function, for tests and for `l0p disasm`. */
export function formatOp(o: Op, constNames: readonly string[], protoNames: readonly string[]): string {
  switch (o.op) {
    case OP.Const:
      return `const ${constNames[o.a] ?? o.a}`;
    case OP.LoadLocal:
    case OP.StoreLocal:
      return `${OP_NAME[o.op]} ${o.a}`;
    case OP.LoadUpval:
    case OP.StoreUpval:
      return `${OP_NAME[o.op]} ${o.a}`;
    case OP.LoadGlobal:
    case OP.StoreGlobal:
    case OP.GetAttr:
    case OP.SetAttr:
      return `${OP_NAME[o.op]} ${constNames[o.a] ?? o.a}`;
    case OP.NewList:
      return `newlist ${o.a}`;
    case OP.NewDict:
      return `newdict ${o.a}`;
    case OP.NewStruct:
      return `newstruct ${constNames[o.a] ?? o.a}/${o.b}`;
    case OP.Concat:
      return `concat ${o.a}`;
    case OP.Import:
      return `import #${o.a}`;
    case OP.Bin:
      return `bin ${binName(o.a)}`;
    case OP.Un:
      return `un ${unName(o.a)}`;
    case OP.Jump:
    case OP.JumpIfFalse:
    case OP.JumpIfTrue:
    case OP.JumpIfFalseOrPop:
    case OP.JumpIfTrueOrPop:
    case OP.ForIter:
      return `${OP_NAME[o.op]} -> ${o.a}`;
    case OP.GetIter:
      return "GetIter";
    case OP.Closure:
      return `closure ${protoNames[o.a] ?? o.a}`;
    case OP.Call:
      return `call ${o.a}`;
    default:
      return OP_NAME[o.op];
  }
}

export function formatCode(code: readonly Op[], constNames: readonly string[], protoNames: readonly string[]): string {
  return code
    .map((o, i) => `${String(i).padStart(3)}  ${formatOp(o, constNames, protoNames)}`)
    .join("\n");
}
