/**
 * A Pratt (precedence-climbing) parser.
 *
 * Every binary and prefix operator goes through one loop keyed on a binding
 * power, instead of a cascade of mutually recursive descent routines.  Two
 * consequences worth knowing when reading the code:
 *
 *  - `leftBindingPower` decides whether an operator continues the current
 *    expression; `rightBindingPower` is what the right operand is parsed with.
 *    Left-associative operators have rbp = lbp + 1, right-associative ones have
 *    rbp = lbp - 1.  That single rule is what makes `a - b - c` left-associative
 *    and `a ** b ** c` right-associative without a special case.
 *  - `not` is a *prefix* operator whose binding power is lower than
 *    comparison's, so `not a == b` parses as `not (a == b)`.
 *
 * Keywords are matched on the text of an `Ident` token.  The lexer has no
 * keyword list, so `let` and `import` remain usable as variable names.
 */

import { L0pError } from "./errors.ts";
import { Lexer, tokenize } from "./lexer.ts";
import { TT } from "./token.ts";
import type { Token, TokenType } from "./token.ts";
import type {
  Assign, BinaryOp, Binding, Expr, Node, Param, Program,
  Stmt, StructField, UnaryOp,
} from "./ast.ts";

/** Binding powers.  The gaps are deliberate: they leave room to slot operators in. */
const BP = {
  ternary: 1,
  or: 2,
  and: 4,
  not: 6,
  compare: 7,
  bitor: 9,
  bitxor: 11,
  bitand: 13,
  shift: 15,
  additive: 17,
  multiplicative: 19,
  unary: 21,
  power: 23,
  postfix: 25,
  atom: 30,
} as const;

type Infix = readonly [lbp: number, rbp: number, op: BinaryOp];

/** Symbol operators.  Compound assignment is absent on purpose: it is a statement. */
const INFIX: Readonly<Partial<Record<TokenType, Infix>>> = {
  [TT.Eq]: [BP.compare, BP.compare + 1, "=="],
  [TT.Ne]: [BP.compare, BP.compare + 1, "!="],
  [TT.Lt]: [BP.compare, BP.compare + 1, "<"],
  [TT.Le]: [BP.compare, BP.compare + 1, "<="],
  [TT.Gt]: [BP.compare, BP.compare + 1, ">"],
  [TT.Ge]: [BP.compare, BP.compare + 1, ">="],

  [TT.Pipe]: [BP.bitor, BP.bitor + 1, "|"],
  [TT.Caret]: [BP.bitxor, BP.bitxor + 1, "^"],
  [TT.Amp]: [BP.bitand, BP.bitand + 1, "&"],
  [TT.Shl]: [BP.shift, BP.shift + 1, "<<"],
  [TT.Shr]: [BP.shift, BP.shift + 1, ">>"],

  [TT.Plus]: [BP.additive, BP.additive + 1, "+"],
  [TT.Minus]: [BP.additive, BP.additive + 1, "-"],
  [TT.Star]: [BP.multiplicative, BP.multiplicative + 1, "*"],
  [TT.Slash]: [BP.multiplicative, BP.multiplicative + 1, "/"],
  [TT.SlashSlash]: [BP.multiplicative, BP.multiplicative + 1, "//"],
  [TT.Percent]: [BP.multiplicative, BP.multiplicative + 1, "%"],

  // right-associative, and tighter than unary so that -2 ** 2 is -(2 ** 2)
  [TT.DStar]: [BP.power, BP.power - 1, "**"],
};

/** Compound assignment token -> the operator it stands for. */
const COMPOUND: Readonly<Partial<Record<TokenType, BinaryOp>>> = {
  [TT.PlusEq]: "+",
  [TT.MinusEq]: "-",
  [TT.StarEq]: "*",
  [TT.SlashEq]: "/",
  [TT.SlashSlashEq]: "//",
  [TT.PercentEq]: "%",
  [TT.DStarEq]: "**",
  [TT.AmpEq]: "&",
  [TT.PipeEq]: "|",
  [TT.CaretEq]: "^",
  [TT.ShlEq]: "<<",
  [TT.ShrEq]: ">>",
};

const BINDINGS: Readonly<Partial<Record<string, Binding>>> = {
  let: "let",
  var: "var",
  const: "const",
};

/** Words that start a statement and can never be an expression. */
const STATEMENT_WORDS = new Set([
  "if", "else", "for", "while", "def", "struct", "return", "break", "continue",
  "pass", "import", "from", "defer",
]);

export class Parser {
  private readonly toks: Token[];
  private readonly file: string | null;
  private pos = 0;
  /** Nesting depth of `def`, so `return` can be caught at parse time. */
  private fnDepth = 0;

  constructor(toks: Token[], file: string | null = null) {
    this.toks = toks;
    this.file = file;
  }

  static fromSource(src: string, file: string | null = null): Parser {
    return new Parser(tokenize(src, file), file);
  }

  parseProgram(): Program {
    const stmts = this.parseStatements(() => this.peek().type === TT.EOF);
    return { kind: "Program", stmts, line: 1, col: 1 };
  }

  /** Parses to the end and rejects leftovers; used for `${...}` holes. */
  parseExpression(): Expr {
    const e = this.parseExpr(0);
    this.skipNewlines();
    if (this.peek().type !== TT.EOF) {
      this.fail(`unexpected ${this.describe(this.peek())}`);
    }
    return e;
  }

  // ------------------------------------------------------------ statements

  private parseStatements(stop: () => boolean): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      this.skipNewlines();
      if (stop()) return out;
      out.push(this.parseStmt());
      while (this.match(TT.Semicolon)) this.skipNewlines();
    }
  }

  private parseStmt(): Stmt {
    const t = this.peek();
    if (t.type === TT.Ident) {
      switch (t.value) {
        case "let":
        case "var":
        case "const":
          return this.parseLet();
        case "def":
          return this.parseDef();
        case "struct":
          return this.parseStruct();
        case "if":
          return this.parseIf();
        case "while":
          return this.parseWhile();
        case "for":
          return this.parseFor();
        case "return":
          return this.parseReturn();
        case "break":
        case "continue":
        case "pass":
          return this.parseBranch();
        case "import":
        case "from":
          return this.parseImport();
        case "defer":
          return this.parseDefer();
        default:
          break;
      }
    }
    return this.parseAssignLine();
  }

  private parseLet(): Stmt {
    const t = this.advance();
    const binding = BINDINGS[t.value as string] ?? "let";
    const name = this.expectIdent("a name after the binding").value as string;
    const init = this.match(TT.Assign) ? this.parseExpr(0) : null;
    return { kind: "Let", binding, name, init, line: t.line, col: t.col };
  }

  /**
   * `expr`, `target = value`, `a = b = value`, `target += value`.
   * A bare expression with no `=` becomes an ExprStmt, which is why this is the
   * fallback for every statement that is not a keyword.
   */
  private parseAssignLine(): Stmt {
    const start = this.peek();
    const first = this.parseExpr(0);
    const targets: Expr[] = [];
    let current = first;
    let op: BinaryOp | null = null;

    for (;;) {
      const t = this.peek();
      if (t.type === TT.Assign) {
        this.advance();
        targets.push(current);
        current = this.parseExpr(0);
        continue;
      }
      const compound = COMPOUND[t.type];
      if (compound !== undefined) {
        this.advance();
        this.checkAssignable(current);
        targets.push(current);
        const value = this.parseExpr(0);
        return { kind: "Assign", targets, op: compound, value, line: start.line, col: start.col };
      }
      break;
    }

    if (targets.length === 0) {
      return { kind: "ExprStmt", expr: first, line: start.line, col: start.col };
    }
    for (const target of targets) this.checkAssignable(target);
    return { kind: "Assign", targets, op: null, value: current, line: start.line, col: start.col };
  }

  private checkAssignable(target: Expr): void {
    if (target.kind === "Ident" || target.kind === "Index" || target.kind === "Attr") return;
    this.failAt(target, "cannot assign to this expression", "");
  }

  private parseDef(): Stmt {
    const t = this.advance();
    const name = this.expectIdent("a function name").value as string;
    const params = this.parseParams();
    this.fnDepth++;
    const body = this.parseBlock();
    this.fnDepth--;
    return { kind: "Def", name, params, body, line: t.line, col: t.col };
  }

  private parseStruct(): Stmt {
    const t = this.advance();
    const name = this.expectIdent("a struct name");
    this.expect(TT.Colon);
    this.match(TT.Newline);
    this.expect(TT.Indent);
    const fields: StructField[] = [];
    this.skipNewlines();
    while (this.peek().type !== TT.Dedent && this.peek().type !== TT.EOF) {
      const f = this.expectIdent("a field name");
      const value = this.match(TT.Assign) ? this.parseExpr(0) : null;
      fields.push({ name: f.value as string, value });
      while (this.match(TT.Semicolon)) this.skipNewlines();
      this.skipNewlines();
    }
    this.expect(TT.Dedent);
    return { kind: "StructDef", name: name.value as string, fields, line: t.line, col: t.col };
  }

  private parseIf(): Stmt {
    const t = this.advance();
    const cond = this.parseExpr(0);
    const then = this.parseBlock();

    let otherwise: Stmt[] | null = null;
    const mark = this.pos;
    this.skipNewlines();
    if (this.isWord("else")) {
      this.advance();
      otherwise = this.isWord("if") ? [this.parseIf()] : this.parseBlock();
    } else {
      this.pos = mark; // no `else`: put the newlines back
    }
    return { kind: "If", cond, then, otherwise, line: t.line, col: t.col };
  }

  private parseWhile(): Stmt {
    const t = this.advance();
    const cond = this.parseExpr(0);
    const body = this.parseBlock();
    return { kind: "While", cond, body, line: t.line, col: t.col };
  }

  private parseFor(): Stmt {
    const t = this.advance();
    const name = this.expectIdent("a loop variable");
    this.expectWord("in", "expected `in` in a for loop");
    const iter = this.parseExpr(0);
    const body = this.parseBlock();
    return { kind: "For", name: name.value as string, iter, body, line: t.line, col: t.col };
  }

  private parseReturn(): Stmt {
    const t = this.advance();
    if (this.fnDepth === 0) {
      this.failAt(t, "`return` outside a function", "put it inside a `def` block");
    }
    const value = this.atLineEnd() ? null : this.parseExpr(0);
    return { kind: "Return", value, line: t.line, col: t.col };
  }

  private parseBranch(): Stmt {
    const t = this.advance();
    return { kind: "Branch", what: t.value as "break" | "continue" | "pass", line: t.line, col: t.col };
  }

  private parseDefer(): Stmt {
    const t = this.advance();
    const expr = this.parseExpr(BP.unary);
    if (expr.kind !== "Call") {
      this.failAt(t, "defer takes a call", "expected `defer f(...)`");
    }
    return { kind: "Defer", call: expr, line: t.line, col: t.col };
  }

  private parseImport(): Stmt {
    const t = this.advance();
    const isFrom = t.value === "from";
    let level = 0;
    if (isFrom) {
      while (this.match(TT.Dot)) level++;
      if (level === 0 && this.peek().type !== TT.Ident) {
        this.fail("expected a module name after `from`");
      }
    }
    // `from . import m` has no path at all: the leading dots are the whole
    // reference, so the `import` keyword must not be read as a module name.
    const path = isFrom && this.isWord("import") ? "" : this.parseDottedName();
    if (isFrom && level === 0 && path === "") {
      this.failAt(t, "`from import ...` needs a module name or a leading dot", "");
    }

    let alias: string | null = null;
    let names: string[] = [];
    if (isFrom) {
      this.expectWord("import", "expected `import` after the module path");
      names = this.parseImportNames();
      // `from m import a as b` parses the name `a` and then stops; without this
      // check `as` would silently become a second statement.
      if (this.isWord("as")) {
        this.fail("`from m import x as y` is not supported yet; import the module and use `m.y`");
      }
    } else if (this.isWord("as")) {
      this.advance();
      alias = this.expectIdent("an alias after `as`").value as string;
    }
    return { kind: "Import", form: isFrom ? "from" : "import", path, alias, names, level, line: t.line, col: t.col };
  }

  private parseImportNames(): string[] {
    const names: string[] = [];
    // `from m import (\n  a,\n  b,\n)` -- the parentheses only exist so the
    // list can span lines; the lexer already hides those newlines.
    const paren = this.match(TT.LParen);
    for (;;) {
      this.skipNewlines();
      if (this.isWord("as")) {
        this.fail("`from m import x as y` is not supported yet; import the module and use `m.y`");
      }
      const tok = this.expectIdent("a name to import");
      names.push(tok.value as string);
      this.skipNewlines();
      if (!this.match(TT.Comma)) break;
      this.skipNewlines();
      if (paren && this.check(TT.RParen)) break; // trailing comma
    }
    if (paren) {
      this.skipNewlines();
      this.expect(TT.RParen);
    }
    return names;
  }

  private parseDottedName(): string {
    const parts = [this.expectIdent("a module name").value as string];
    while (this.peek().type === TT.Dot) {
      this.advance();
      parts.push(this.expectIdent("a module name after `.`").value as string);
    }
    return parts.join(".");
  }

  /** A block is `:` then either an indented suite or a single inline statement. */
  private parseBlock(): Stmt[] {
    this.expect(TT.Colon);
    if (!this.match(TT.Newline)) return [this.parseStmt()];
    this.skipNewlines();
    this.expect(TT.Indent);
    const body = this.parseStatements(() => {
      const t = this.peek().type;
      return t === TT.Dedent || t === TT.EOF;
    });
    this.expect(TT.Dedent);
    return body;
  }

  private parseParams(): Param[] {
    this.expect(TT.LParen);
    const params: Param[] = [];
    this.skipNewlines();
    if (!this.check(TT.RParen)) {
      for (;;) {
        this.skipNewlines();
        const name = this.expectIdent("a parameter name");
        const def = this.match(TT.Assign) ? this.parseExpr(0) : null;
        params.push({ name: name.value as string, default: def, line: name.line, col: name.col });
        this.skipNewlines();
        if (!this.match(TT.Comma)) break;
      }
      this.skipNewlines();
    }
    this.expect(TT.RParen);
    return params;
  }

  // ----------------------------------------------------------- expressions

  private parseExpr(minBp: number): Expr {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();

      if (t.type === TT.Ident) {
        const word = this.handleWordInfix(t, left, minBp);
        if (word !== null) {
          left = word;
          continue;
        }
      }

      if (t.type === TT.Question) {
        if (BP.ternary < minBp) break;
        this.advance();
        const then = this.parseExpr(0);
        this.expect(TT.Colon);
        const other = this.parseExpr(BP.ternary); // right-associative
        left = { kind: "Ternary", cond: left, then, other, line: t.line, col: t.col };
        continue;
      }

      const entry = INFIX[t.type];
      if (entry !== undefined) {
        const [lbp, rbp, op] = entry;
        if (lbp < minBp) break;
        this.advance();
        const right = this.parseExpr(rbp);
        left = { kind: "Binary", op, left, right, line: t.line, col: t.col };
        continue;
      }

      if (t.type === TT.LParen && BP.postfix >= minBp) {
        left = this.parseCall(left);
        continue;
      }
      if (t.type === TT.LBracket && BP.postfix >= minBp) {
        left = this.parseIndex(left);
        continue;
      }
      if (t.type === TT.Dot && BP.postfix >= minBp) {
        left = this.parseAttr(left);
        continue;
      }
      break;
    }
    return left;
  }

  /** Word operators, which cannot live in the symbol table.  Null means "not one". */
  private handleWordInfix(t: Token, left: Expr, minBp: number): Expr | null {
    switch (t.value) {
      case "or":
        if (BP.or < minBp) return null;
        this.advance();
        return { kind: "Logical", op: "or", left, right: this.parseExpr(BP.or + 1), line: t.line, col: t.col };

      case "and":
        if (BP.and < minBp) return null;
        this.advance();
        return { kind: "Logical", op: "and", left, right: this.parseExpr(BP.and + 1), line: t.line, col: t.col };

      case "in":
        if (BP.compare < minBp) return null;
        this.advance();
        return { kind: "Binary", op: "in", left, right: this.parseExpr(BP.compare + 1), line: t.line, col: t.col };

      case "not": {
        if (BP.compare < minBp) return null;
        const nxt = this.peek(1);
        if (nxt.type !== TT.Ident || nxt.value !== "in") return null;
        this.advance();
        this.advance();
        return { kind: "Binary", op: "not in", left, right: this.parseExpr(BP.compare + 1), line: t.line, col: t.col };
      }

      // `A if C else B` -- the Python spelling, right-associative
      case "if": {
        if (BP.ternary < minBp) return null;
        this.advance();
        const cond = this.parseExpr(0);
        this.expectWord("else", "expected `else` in a conditional expression");
        const other = this.parseExpr(BP.ternary);
        return { kind: "Ternary", cond, then: left, other, line: t.line, col: t.col };
      }

      default:
        return null;
    }
  }

  private parsePrefix(): Expr {
    const t = this.peek();

    switch (t.type) {
      case TT.Number:
        this.advance();
        return { kind: "Num", value: t.value as number, line: t.line, col: t.col };

      case TT.String:
        this.advance();
        return this.buildString(t);

      case TT.Minus:
      case TT.Plus:
      case TT.Tilde: {
        this.advance();
        const operand = this.parseExpr(BP.unary);
        return { kind: "Unary", op: t.type as UnaryOp, operand, line: t.line, col: t.col };
      }

      case TT.LParen:
        if (this.lambdaAhead()) return this.parseLambda();
        this.advance();
        const inner = this.parseExpr(0);
        this.expect(TT.RParen);
        return inner;

      case TT.LBracket:
        return this.parseListLit();

      case TT.LBrace:
        return this.parseDictLit();

      case TT.Ident:
        return this.parseIdentExpr();

      default:
        this.fail(`unexpected ${this.describe(t)}`);
    }
  }

  private parseIdentExpr(): Expr {
    const t = this.peek();
    const name = t.value as string;
    switch (name) {
      case "true":
        this.advance();
        return { kind: "Bool", value: true, line: t.line, col: t.col };
      case "false":
        this.advance();
        return { kind: "Bool", value: false, line: t.line, col: t.col };
      case "null":
        this.advance();
        return { kind: "Null", line: t.line, col: t.col };

      case "not": {
        this.advance();
        const operand = this.parseExpr(BP.not);
        return { kind: "Unary", op: "not", operand, line: t.line, col: t.col };
      }

      case "await": {
        this.advance();
        return { kind: "Await", expr: this.parseExpr(BP.unary), line: t.line, col: t.col };
      }

      case "spawn": {
        this.advance();
        const inner = this.parseExpr(BP.unary);
        if (inner.kind !== "Call") {
          this.failAt(t, "spawn takes a call", "expected `spawn f(...)`");
        }
        return { kind: "Spawn", call: inner, line: t.line, col: t.col };
      }

      // A keyword that starts a statement cannot begin an expression.
      case "import":
      case "from":
      case "return":
      case "elif":
        this.failAt(t, `\`${name}\` cannot be used here`, "");

      default:
        break;
    }
    if (STATEMENT_WORDS.has(name)) {
      this.failAt(t, `\`${name}\` cannot be used here`, "");
    }
    this.advance();
    // `x -> body` is a lambda, not an identifier followed by a stray arrow.
    if (this.peek().type === TT.Arrow) {
      this.advance();
      const body = this.parseExpr(0);
      const param: Param = { name, default: null, line: t.line, col: t.col };
      return { kind: "Lambda", params: [param], body, line: t.line, col: t.col };
    }
    return { kind: "Ident", name, line: t.line, col: t.col };
  }

  private parseCall(callee: Expr): Expr {
    const t = this.advance(); // (
    const args: Expr[] = [];
    this.skipNewlines();
    if (!this.check(TT.RParen)) {
      for (;;) {
        this.skipNewlines();
        args.push(this.parseExpr(0));
        this.skipNewlines();
        if (!this.match(TT.Comma)) break;
        this.skipNewlines();
        if (this.check(TT.RParen)) break; // trailing comma
      }
      this.skipNewlines();
    }
    this.expect(TT.RParen);
    return { kind: "Call", callee, args, line: t.line, col: t.col };
  }

  private parseIndex(obj: Expr): Expr {
    const t = this.advance(); // [
    this.skipNewlines();
    const index = this.parseExpr(0);
    this.skipNewlines();
    this.expect(TT.RBracket);
    return { kind: "Index", obj, index, line: t.line, col: t.col };
  }

  private parseAttr(obj: Expr): Expr {
    const t = this.advance(); // .
    const name = this.expectIdent("an attribute name after `.`");
    return { kind: "Attr", obj, name: name.value as string, line: t.line, col: t.col };
  }

  private parseListLit(): Expr {
    const t = this.advance(); // [
    const items: Expr[] = [];
    this.skipNewlines();
    if (!this.check(TT.RBracket)) {
      for (;;) {
        this.skipNewlines();
        items.push(this.parseExpr(0));
        this.skipNewlines();
        if (!this.match(TT.Comma)) break;
        this.skipNewlines();
        if (this.check(TT.RBracket)) break; // trailing comma
      }
      this.skipNewlines();
    }
    this.expect(TT.RBracket);
    return { kind: "ListLit", items, line: t.line, col: t.col };
  }

  private parseDictLit(): Expr {
    const t = this.advance(); // {
    const entries: { key: Expr; value: Expr }[] = [];
    this.skipNewlines();
    if (!this.check(TT.RBrace)) {
      for (;;) {
        this.skipNewlines();
        const key = this.parseExpr(BP.compare);
        this.expect(TT.Colon);
        const value = this.parseExpr(0);
        entries.push({ key, value });
        this.skipNewlines();
        if (!this.match(TT.Comma)) break;
        this.skipNewlines();
        if (this.check(TT.RBrace)) break; // trailing comma
      }
      this.skipNewlines();
    }
    this.expect(TT.RBrace);
    return { kind: "DictLit", entries, line: t.line, col: t.col };
  }

  /** `(a, b = 1) -> e`; the parameter list consumes its own parentheses. */
  private parseLambda(): Expr {
    const t = this.peek();
    const params = this.parseParams();
    this.expect(TT.Arrow);
    const body = this.parseExpr(0);
    return { kind: "Lambda", params, body, line: t.line, col: t.col };
  }

  /** True when the `(` at the cursor opens a parameter list rather than a group. */
  private lambdaAhead(): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.toks.length; i++) {
      const t = this.toks[i] as Token;
      if (t.type === TT.LParen || t.type === TT.LBracket || t.type === TT.LBrace) depth++;
      else if (t.type === TT.RParen || t.type === TT.RBracket || t.type === TT.RBrace) {
        depth--;
        if (depth === 0) return this.toks[i + 1]?.type === TT.Arrow;
      } else if (t.type === TT.EOF) return false;
    }
    return false;
  }

  /**
   * The lexer already resolved interpolation holes to raw source.  Each hole is
   * lexed and parsed on its own, and its columns are shifted so that an error
   * inside `${...}` points at the right character of the original line.
   */
  private buildString(t: Token): Expr {
    if (typeof t.value === "string") {
      return { kind: "Str", parts: [t.value], line: t.line, col: t.col };
    }
    const parts = t.value as { kind: "lit" | "expr"; src?: string; value?: string; line?: number; col?: number }[];
    const built: (string | Expr)[] = [];
    for (const part of parts) {
      if (part.kind === "lit") built.push(part.value ?? "");
      else built.push(this.parseHole(part.src ?? "", part.line ?? t.line, part.col ?? t.col));
    }
    return { kind: "Str", parts: built, line: t.line, col: t.col };
  }

  private parseHole(src: string, line: number, col: number): Expr {
    const shifted = tokenize(src, this.file).map((tok) => ({ ...tok, line, col: tok.col + col - 1 }));
    return new Parser(shifted, this.file).parseExpression();
  }

  // ---------------------------------------------------------------- cursor

  private peek(offset = 0): Token {
    return this.toks[Math.min(this.pos + offset, this.toks.length - 1)] as Token;
  }

  private advance(): Token {
    const t = this.peek();
    if (t.type !== TT.EOF) this.pos++;
    return t;
  }

  private match(type: TokenType): boolean {
    if (this.peek().type !== type) return false;
    this.pos++;
    return true;
  }

  /**
   * Lookahead only.  Empty-bracket handling needs this: `match` would consume
   * the closer and leave the `expect` that follows it looking for a second one.
   */
  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private isWord(word: string): boolean {
    const t = this.peek();
    return t.type === TT.Ident && t.value === word;
  }

  private skipNewlines(): void {
    while (this.peek().type === TT.Newline) this.pos++;
  }

  private atLineEnd(): boolean {
    const t = this.peek().type;
    return t === TT.Newline || t === TT.Dedent || t === TT.EOF || t === TT.Semicolon;
  }

  private expect(type: TokenType, what = this.describeType(type)): Token {
    const t = this.peek();
    if (t.type !== type) this.fail(`expected ${what} but found ${this.describe(t)}`);
    this.pos++;
    return t;
  }

  private expectIdent(what: string): Token {
    const t = this.peek();
    if (t.type !== TT.Ident) this.fail(`expected ${what} but found ${this.describe(t)}`);
    this.pos++;
    return t;
  }

  private expectWord(word: string, message?: string): Token {
    const t = this.peek();
    if (t.type !== TT.Ident || t.value !== word) {
      this.fail(message ?? `expected \`${word}\` but found ${this.describe(t)}`);
    }
    this.pos++;
    return t;
  }

  // ---------------------------------------------------------------- errors

  private describeType(type: TokenType): string {
    if (type.length > 0 && !/^[A-Z]/.test(type)) return `\`${type}\``;
    return `\`${type.toLowerCase()}\``;
  }

  private describe(t: Token): string {
    switch (t.type) {
      case TT.EOF:
        return "end of input";
      case TT.Newline:
        return "end of line";
      case TT.Indent:
        return "an indented block";
      case TT.Dedent:
        return "end of block";
      case TT.Ident:
        return `\`${String(t.value)}\``;
      case TT.Number:
        return `number ${String(t.value)}`;
      case TT.String:
        return "a string";
      default:
        return `\`${t.type}\``;
    }
  }

  private fail(message: string): never {
    this.failAt(this.peek(), message, "");
  }

  private failAt(node: Node, message: string, hint = ""): never {
    throw new L0pError(hint === "" ? message : `${message} -- ${hint}`, node.line, node.col, this.file);
  }
}

/** Convenience wrapper. */
export function parse(src: string, file: string | null = null): Program {
  return Parser.fromSource(src, file).parseProgram();
}
