/**
 * The lexer.
 *
 * Indentation is significant, so the scanner is line-oriented: it decides
 * INDENT/DEDENT before it looks at a single token.  Inside brackets a newline
 * is just whitespace, which is the only place continuation works -- there is no
 * backslash continuation and none is planned.
 *
 * Rules that are worth stating because they are choices, not necessities:
 *
 *   - a blank or comment-only line never affects indentation, so trailing
 *     whitespace before a dedent does not produce a spurious DEDENT;
 *   - tabs advance to the next multiple of 8, matching the Python default;
 *   - a closing bracket that returns the depth to 0 still ends the statement,
 *     so `x = (1 +\n 2)` terminates;
 *   - a string literal never spans a physical line.
 */

import { L0pError } from "./errors.ts";
import { CLOSERS, OPENERS, OPERATORS, TT } from "./token.ts";
import type { StringPart, Token, TokenType, TokenValue } from "./token.ts";

const TAB_WIDTH = 8;

/** Unicode letters, so `привет` is a legal identifier. */
const IDENT_START = /[\p{L}\p{Nl}_]/u;
const IDENT_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}_]/u;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
  e: "\x1b",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "`": "`",
  "\n": "",
};

const isDigit = (c: string): boolean => c >= "0" && c <= "9";

export class Lexer {
  private readonly src: string;
  private readonly file: string | null;
  private readonly toks: Token[] = [];
  /** Open brackets.  A newline inside one is not a statement terminator. */
  private depth = 0;
  private readonly indents: number[] = [0];
  private lineNo = 0;

  constructor(src: string, file: string | null = null) {
    this.src = src;
    this.file = file;
  }

  tokenize(): Token[] {
    const lines = this.src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      this.lineNo = i + 1;
      this.handleLine(stripCR(lines[i] ?? ""));
    }

    const last = this.toks[this.toks.length - 1];
    if (last !== undefined && last.type !== TT.Newline) {
      this.push(TT.Newline, null, 1);
    }
    while (this.indents.length > 1) {
      this.indents.pop();
      this.push(TT.Dedent, null, 1);
    }
    this.push(TT.EOF, null, 1);
    return this.toks;
  }

  // ---------------------------------------------------------------- lines

  private handleLine(text: string): void {
    const continued = this.depth > 0;
    let from = 0;

    if (continued) {
      if (text.trim() === "") return;
    } else {
      const width = this.measureIndent(text);
      if (width === null) return; // blank or comment-only: never affects indent
      this.applyIndent(width);
      while (from < text.length && isBlank(text[from] ?? "")) from++;
    }

    this.scanLine(text, from);

    if (this.depth === 0) this.push(TT.Newline, null, text.length + 1);
  }

  /** Indentation width, or null when the line carries no code. */
  private measureIndent(text: string): number | null {
    let col = 0;
    let i = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === " ") col += 1;
      else if (c === "\t") col += TAB_WIDTH - (col % TAB_WIDTH);
      else break;
    }
    if (i >= text.length) return null;
    if (text[i] === "#") return null;
    return col;
  }

  private applyIndent(width: number): void {
    const top = this.indents[this.indents.length - 1] ?? 0;
    if (width > top) {
      this.indents.push(width);
      this.push(TT.Indent, null, width + 1);
      return;
    }
    if (width === top) return;

    while (this.indents.length > 1 && width < (this.indents[this.indents.length - 1] ?? 0)) {
      this.indents.pop();
      this.push(TT.Dedent, null, width + 1);
    }
    if (width !== (this.indents[this.indents.length - 1] ?? 0)) {
      throw new L0pError(
        `unindent does not match any outer indentation level (got ${width}, expected ${this.indents[this.indents.length - 1] ?? 0})`,
        this.lineNo,
        width + 1,
        this.file,
      );
    }
  }

  // ------------------------------------------------------------- scanning

  private scanLine(text: string, from: number): void {
    let i = from;
    while (i < text.length) {
      const c = text[i] as string;
      if (isBlank(c)) {
        i++;
        continue;
      }
      if (c === "#") return; // comment runs to the end of the line
      if (c === '"' || c === "'") {
        i = this.scanString(text, i, c);
        continue;
      }
      if (isDigit(c)) {
        i = this.scanNumber(text, i);
        continue;
      }
      if (IDENT_START.test(c)) {
        i = this.scanIdent(text, i);
        continue;
      }
      const op = this.matchOperator(text, i);
      if (op === null) {
        throw new L0pError(`unexpected character ${JSON.stringify(c)}`, this.lineNo, i + 1, this.file);
      }
      if (OPENERS.includes(op)) this.depth++;
      else if (CLOSERS.includes(op)) {
        this.depth--;
        if (this.depth < 0) {
          throw new L0pError(`unmatched ${JSON.stringify(op)}`, this.lineNo, i + 1, this.file);
        }
      }
      this.push(op, null, i + 1);
      i += op.length;
    }
  }

  /**
   * The token type of the operator at `at`, or null.
   *
   * Typed `TokenType` rather than `string` because that is what it returns and
   * what every caller does with it -- `OPENERS.includes(op)` is a lookup in a
   * `TokenType[]`, and it silently never matched when the type said `string`.
   */
  private matchOperator(text: string, at: number): TokenType | null {
    for (const op of OPERATORS) {
      if (text.startsWith(op, at)) return op;
    }
    return null;
  }

  private scanIdent(text: string, start: number): number {
    let i = start;
    while (i < text.length && IDENT_PART.test(text[i] as string)) i++;
    this.push(TT.Ident, text.slice(start, i), start + 1);
    return i;
  }

  private scanNumber(text: string, start: number): number {
    const col = start + 1;
    const prefix = radixAt(text, start);
    if (prefix !== null) {
      const digits = prefix.digit;
      let j = start + 2;
      while (j < text.length && (digits.test(text[j] as string) || text[j] === "_")) j++;
      const body = text.slice(start + 2, j).replace(/_/g, "");
      if (body === "") {
        throw new L0pError(`malformed ${prefix.radix} literal: no digits`, this.lineNo, col, this.file);
      }
      const value = Number.parseInt(body, prefix.radix === "0b" ? 2 : prefix.radix === "0o" ? 8 : 16);
      if (Number.isNaN(value)) {
        throw new L0pError(`malformed ${prefix.radix} literal`, this.lineNo, col, this.file);
      }
      this.push(TT.Number, value, col);
      return j;
    }

    let i = start;
    while (i < text.length && (isDigit(text[i] as string) || text[i] === "_")) i++;
    // A '.' only starts a fraction when a digit follows, so `1.method` and
    // range-style `0..10` cannot be mistaken for a float.
    if (text[i] === "." && isDigit(text[i + 1] ?? "")) {
      i++;
      while (i < text.length && (isDigit(text[i] as string) || text[i] === "_")) i++;
    }
    const e = text[i];
    if (e === "e" || e === "E") {
      let j = i + 1;
      if (text[j] === "+" || text[j] === "-") j++;
      if (isDigit(text[j] ?? "")) {
        i = j;
        while (i < text.length && isDigit(text[i] as string)) i++;
      }
    }

    const raw = text.slice(start, i).replace(/_/g, "");
    this.push(TT.Number, Number(raw), col);
    return i;
  }

  // ---------------------------------------------------------------- strings

  private scanString(text: string, start: number, quote: string): number {
    const col = start + 1;
    const parts: StringPart[] = [];
    let lit = "";
    let holed = false;
    let i = start + 1;

    for (;;) {
      if (i >= text.length || text[i] === "\n") {
        throw new L0pError("unterminated string literal", this.lineNo, col, this.file);
      }
      const c = text[i] as string;

      if (c === quote) {
        i++;
        break;
      }
      if (c === "\\") {
        const esc = this.readEscape(text, i);
        lit += esc.ch;
        i = esc.next;
        continue;
      }
      if (c === "$" && text[i + 1] === "{") {
        parts.push({ kind: "lit", value: lit });
        lit = "";
        holed = true;
        const hole = this.scanInterpolation(text, i + 2, col);
        // The hole's column is where its first character actually sits, not
        // where the string began -- otherwise a parse error inside `${}` would
        // be reported several characters to the left.
        parts.push({ kind: "expr", src: hole.src, line: this.lineNo, col: i + 3 });
        i = hole.next;
        continue;
      }
      lit += c;
      i++;
    }

    // A plain string is a plain string; only interpolation needs the part list.
    if (!holed) {
      this.push(TT.String, lit, col);
      return i;
    }
    parts.push({ kind: "lit", value: lit });
    // Empty text between or around holes is not a part: `"${a}${b}"` has two
    // expressions and nothing between them, not an empty string in the middle.
    this.push(TT.String, parts.filter((p) => p.kind !== "lit" || p.value !== ""), col);
    return i;
  }

  /** Scans from just after `${` to the matching `}`.  Braces nest; so do strings. */
  private scanInterpolation(text: string, from: number, col: number): { src: string; next: number } {
    const start = from;
    let depth = 1;
    let i = from;
    while (i < text.length) {
      const c = text[i] as string;
      if (c === "\n") {
        throw new L0pError("unterminated string interpolation", this.lineNo, col, this.file);
      }
      if (c === '"' || c === "'") {
        i = this.skipNestedString(text, i);
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    if (i >= text.length) {
      throw new L0pError("unterminated string interpolation", this.lineNo, col, this.file);
    }
    if (i === start) {
      throw new L0pError("empty interpolation ${}", this.lineNo, col, this.file);
    }
    return { src: text.slice(start, i), next: i + 1 };
  }

  private skipNestedString(text: string, start: number): number {
    const quote = text[start] as string;
    let i = start + 1;
    while (i < text.length) {
      const c = text[i] as string;
      if (c === "\n") return i; // let the caller report against the outer quote
      if (c === "\\") {
        i = this.readEscape(text, i).next;
        continue;
      }
      if (c === "$" && text[i + 1] === "{") {
        i = this.scanInterpolation(text, i + 2, start + 1).next;
        continue;
      }
      if (c === quote) return i + 1;
      i++;
    }
    return i;
  }

  private readEscape(text: string, at: number): { ch: string; next: number } {
    const col = at + 1;
    const kind = text[at + 1] ?? "";
    const simple = SIMPLE_ESCAPES[kind];
    if (simple !== undefined) {
      return { ch: simple, next: at + 2 };
    }
    if (kind === "x" || kind === "u" || kind === "U") {
      const width = kind === "x" ? 2 : kind === "u" ? 4 : 8;
      const body = text.slice(at + 2, at + 2 + width);
      if (body.length < width || !/^[0-9a-fA-F]+$/.test(body)) {
        throw new L0pError(`\\${kind} needs ${width} hex digits`, this.lineNo, col, this.file);
      }
      return { ch: String.fromCodePoint(Number.parseInt(body, 16)), next: at + 2 + width };
    }
    if (kind === "") {
      throw new L0pError("line continuation is not supported; use brackets", this.lineNo, col, this.file);
    }
    throw new L0pError(`unknown escape \\${kind}`, this.lineNo, col, this.file);
  }

  // ---------------------------------------------------------------- output

  private push(type: TokenType, value: TokenValue, col: number): void {
    this.toks.push({ type, value, line: this.lineNo, col });
  }
}

const isBlank = (c: string): boolean => c === " " || c === "\t" || c === "\r";

const stripCR = (s: string): string => (s.endsWith("\r") ? s.slice(0, -1) : s);

function radixAt(text: string, at: number): { radix: string; digit: RegExp } | null {
  if (text[at] !== "0" || at + 1 >= text.length) return null;
  switch ((text[at + 1] as string).toLowerCase()) {
    case "x":
      return { radix: "0x", digit: /[0-9a-fA-F]/ };
    case "b":
      return { radix: "0b", digit: /[01]/ };
    case "o":
      return { radix: "0o", digit: /[0-7]/ };
    default:
      return null;
  }
}

/** Convenience wrapper. */
export function tokenize(src: string, file: string | null = null): Token[] {
  return new Lexer(src, file).tokenize();
}

/** Human-readable dump, for `l0p lex` and for debugging a parse. */
export function formatTokens(toks: Token[]): string {
  return toks
    .map((t) => {
      const at = `${t.line}:${t.col}`.padEnd(7);
      const kind = t.type.padEnd(9);
      const val = t.value === null ? "" : ` ${JSON.stringify(t.value)}`;
      return `${at} ${kind}${val}`;
    })
    .join("\n");
}
