/**
 * The abstract syntax tree.
 *
 * Two things about this shape are load-bearing for what comes later:
 *
 *  - `Logical` and `Ternary` are separate from `Binary`.  They short-circuit,
 *    so the compiler has to emit a jump rather than a binary op, and a generic
 *    "operator + two operands" shape would hide that.
 *  - `Assign.op` is nullable instead of being desugared into `a = a + b`.  For
 *    an `Ident` target the desugaring is safe, but for `a[i] += 1` it would
 *    evaluate `i` twice, and `buf.fill_into(...)`-style batch updates are the
 *    whole point of this language.
 *
 * There are no type annotations.  A `Param` is a name and an optional default,
 * nothing else.
 */

export interface Node {
  readonly line: number;
  readonly col: number;
}

// ------------------------------------------------------------- expressions

export type UnaryOp = "-" | "+" | "~" | "not";

export type BinaryOp =
  | "+" | "-" | "*" | "/" | "//" | "%" | "**"
  | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "&" | "|" | "^" | "<<" | ">>"
  | "in" | "not in";

export interface Num extends Node {
  readonly kind: "Num";
  readonly value: number;
}

export interface Bool extends Node {
  readonly kind: "Bool";
  readonly value: boolean;
}

export interface Null extends Node {
  readonly kind: "Null";
}

/** A string literal: alternating plain text and interpolated expressions. */
export interface Str extends Node {
  readonly kind: "Str";
  readonly parts: readonly (string | Expr)[];
}

export interface Ident extends Node {
  readonly kind: "Ident";
  readonly name: string;
}

export interface ListLit extends Node {
  readonly kind: "ListLit";
  readonly items: readonly Expr[];
}

export interface DictEntry {
  readonly key: Expr;
  readonly value: Expr;
}

export interface DictLit extends Node {
  readonly kind: "DictLit";
  readonly entries: readonly DictEntry[];
}

export interface Unary extends Node {
  readonly kind: "Unary";
  readonly op: UnaryOp;
  readonly operand: Expr;
}

export interface Binary extends Node {
  readonly kind: "Binary";
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

/** Short-circuits; the right operand is not evaluated unless it must be. */
export interface Logical extends Node {
  readonly kind: "Logical";
  readonly op: "and" | "or";
  readonly left: Expr;
  readonly right: Expr;
}

export interface Ternary extends Node {
  readonly kind: "Ternary";
  readonly cond: Expr;
  readonly then: Expr;
  readonly other: Expr;
}

export interface Param {
  readonly name: string;
  readonly default: Expr | null;
  readonly line: number;
  readonly col: number;
}

export interface Call extends Node {
  readonly kind: "Call";
  readonly callee: Expr;
  readonly args: readonly Expr[];
}

export interface Attr extends Node {
  readonly kind: "Attr";
  readonly obj: Expr;
  readonly name: string;
}

export interface Index extends Node {
  readonly kind: "Index";
  readonly obj: Expr;
  readonly index: Expr;
}

export interface Lambda extends Node {
  readonly kind: "Lambda";
  readonly params: readonly Param[];
  readonly body: Expr;
}

/** `spawn f(x)` -- starts a task and evaluates to a handle. */
export interface Spawn extends Node {
  readonly kind: "Spawn";
  readonly call: Call;
}

/** `await task` -- an expression, so `x = await f()` reads naturally. */
export interface Await extends Node {
  readonly kind: "Await";
  readonly expr: Expr;
}

export type Expr =
  | Num | Bool | Null | Str | Ident | ListLit | DictLit
  | Unary | Binary | Logical | Ternary | Call | Attr | Index | Lambda
  | Spawn | Await;

// -------------------------------------------------------------- statements

/** `let` is immutable, `var` is mutable, `const` is fixed at compile time. */
export type Binding = "let" | "var" | "const";

export interface ExprStmt extends Node {
  readonly kind: "ExprStmt";
  readonly expr: Expr;
}

export interface Let extends Node {
  readonly kind: "Let";
  readonly binding: Binding;
  readonly name: string;
  readonly init: Expr | null;
}

export interface Assign extends Node {
  readonly kind: "Assign";
  readonly targets: readonly Expr[];
  /** null for `=`, otherwise the operator of a compound assignment. */
  readonly op: BinaryOp | null;
  readonly value: Expr;
}

export interface Def extends Node {
  readonly kind: "Def";
  readonly name: string;
  readonly params: readonly Param[];
  readonly body: readonly Stmt[];
}

export interface StructField {
  readonly name: string;
  readonly value: Expr | null;
}

export interface StructDef extends Node {
  readonly kind: "StructDef";
  readonly name: string;
  readonly fields: readonly StructField[];
}

export interface If extends Node {
  readonly kind: "If";
  readonly cond: Expr;
  readonly then: readonly Stmt[];
  /** an `else if` chain nests as another If. */
  readonly otherwise: readonly Stmt[] | null;
}

export interface While extends Node {
  readonly kind: "While";
  readonly cond: Expr;
  readonly body: readonly Stmt[];
}

export interface For extends Node {
  readonly kind: "For";
  readonly name: string;
  readonly iter: Expr;
  readonly body: readonly Stmt[];
}

export interface Return extends Node {
  readonly kind: "Return";
  readonly value: Expr | null;
}

export interface Branch extends Node {
  readonly kind: "Branch";
  readonly what: "break" | "continue" | "pass";
}

export type ImportForm = "import" | "from";

export interface Import extends Node {
  readonly kind: "Import";
  readonly form: ImportForm;
  /** Dotted path as written, e.g. `os.path`. */
  readonly path: string;
  /** `import a.b as c` binds this; null means the last segment. */
  readonly alias: string | null;
  /** `from m import x, y` -- the names pulled in.  Empty for a plain import. */
  readonly names: readonly string[];
  /** Leading dots: 0 is absolute, 1 is `.`, 2 is `..`. */
  readonly level: number;
}

export interface Defer extends Node {
  readonly kind: "Defer";
  readonly call: Call;
}

export type Stmt =
  | ExprStmt | Let | Assign | Def | StructDef | If | While | For
  | Return | Branch | Import | Defer;

export interface Program extends Node {
  readonly kind: "Program";
  readonly stmts: readonly Stmt[];
}
