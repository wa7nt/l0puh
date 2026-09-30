import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { L0pError } from "../src/errors.ts";
import { Lexer, formatTokens, tokenize } from "../src/lexer.ts";
import { TT } from "../src/token.ts";
import type { StringPart, Token } from "../src/token.ts";

const types = (src: string): string[] => tokenize(src).map((t) => t.type);
const values = (src: string): unknown[] => tokenize(src).map((t) => t.value);

/** Token types with the noisy literals removed, for shaping assertions. */
const shape = (src: string): string[] =>
  tokenize(src)
    .map((t) => t.type)
    .filter((t) => t !== TT.Newline && t !== TT.EOF);

const only = <T>(toks: Token[], type: string): T[] =>
  toks.filter((t) => t.type === type).map((t) => t.value) as T[];

/** The single interpolated expression in a part list. */
const hole = (parts: StringPart[] | undefined): string | undefined =>
  parts?.find((p) => p.kind === "expr")?.src;

describe("numbers", () => {
  it("reads decimals, floats and exponents", () => {
    assert.deepEqual(only<number>(tokenize("1 2.5 1e3 2.5E-3 0.5"), TT.Number), [1, 2.5, 1000, 0.0025, 0.5]);
  });

  it("reads hex, binary and octal", () => {
    assert.deepEqual(only<number>(tokenize("0xff 0b1011 0o755"), TT.Number), [255, 11, 493]);
  });

  it("allows underscores as separators", () => {
    assert.deepEqual(only<number>(tokenize("1_000_000 0xFF_FF 1_0.5_0"), TT.Number), [1e6, 65535, 10.5]);
  });

  it("does not swallow a following dot", () => {
    assert.deepEqual(shape("1.5"), [TT.Number]);
    assert.deepEqual(shape("1.5"), [TT.Number]);
    // a '.' with no digit after it stays punctuation
    assert.deepEqual(shape("x.1"), [TT.Ident, TT.Dot, TT.Number]);
  });

  it("rejects a radix prefix with no digits", () => {
    assert.throws(() => tokenize("0x"), (e: L0pError) => /malformed 0x literal/.test(e.message));
  });
});

describe("identifiers", () => {
  it("accepts unicode letters", () => {
    assert.deepEqual(only<string>(tokenize("привет мир"), TT.Ident), ["привет", "мир"]);
  });

  it("allows underscores and digits inside", () => {
    assert.deepEqual(only<string>(tokenize("_x a_1"), TT.Ident), ["_x", "a_1"]);
  });

  it("emits no keyword tokens", () => {
    // `import` and `let` are ordinary identifiers until the parser wants them,
    // which is what lets them be used as variable names.
    assert.deepEqual(only<string>(tokenize("let import def"), TT.Ident), ["let", "import", "def"]);
  });
});

describe("operators", () => {
  it("prefers the longest match", () => {
    assert.deepEqual(shape("** * ** == = -> - // / << <"), [
      TT.DStar, TT.Star, TT.DStar, TT.Eq, TT.Assign, TT.Arrow, TT.Minus, TT.SlashSlash, TT.Slash,
      TT.Shl, TT.Lt,
    ]);
  });

  it("reports the offending character", () => {
    assert.throws(
      () => tokenize("x = $"),
      (e: L0pError) => e.message === 'unexpected character "$"',
    );
  });
});

describe("indentation", () => {
  it("emits INDENT and DEDENT around a block", () => {
    // the final Newline is the one that ended the last source line; the DEDENTs
    // follow it, so the parser never sees a dangling statement
    assert.deepEqual(types("if a:\n    b\n"), [
      TT.Ident, TT.Ident, TT.Colon, TT.Newline,
      TT.Indent, TT.Ident, TT.Newline,
      TT.Dedent, TT.EOF,
    ]);
  });

  it("emits one DEDENT per level closed", () => {
    assert.deepEqual(shape("if a:\n    if b:\n        c\n    d\n"), [
      TT.Ident, TT.Ident, TT.Colon,
      TT.Indent, TT.Ident, TT.Ident, TT.Colon,
      TT.Indent, TT.Ident,
      TT.Dedent, TT.Ident,
      TT.Dedent,
    ]);
  });

  it("ignores blank and comment-only lines", () => {
    // no INDENT for the blank lines, and the block still closes once
    const t = types("if a:\n\n    # note\n\n    b\n");
    assert.equal(t.filter((x) => x === TT.Indent).length, 1);
    assert.equal(t.filter((x) => x === TT.Dedent).length, 1);
  });

  it("closes every open level at EOF", () => {
    assert.deepEqual(types("if a:\n    if b:\n        c\n").slice(-3), [TT.Dedent, TT.Dedent, TT.EOF]);
  });

  it("expands tabs to multiples of 8", () => {
    // one tab is 8 columns, two spaces are not: mixed depth must not match
    assert.throws(
      () => tokenize("if a:\n\tb\n  c\n"),
      (e: L0pError) => /unindent does not match/.test(e.message),
    );
  });

  it("rejects an indent that matches no outer level", () => {
    assert.throws(
      () => tokenize("if a:\n        b\n    c\n"),
      (e: L0pError) => /unindent does not match/.test(e.message),
    );
  });
});

describe("brackets", () => {
  it("swallows newlines inside brackets", () => {
    assert.deepEqual(shape("f(\n  1,\n  2,\n)"), [
      TT.Ident, TT.LParen, TT.Number, TT.Comma, TT.Number, TT.Comma, TT.RParen,
    ]);
  });

  it("still ends the statement when a bracket closes on a later line", () => {
    const t = types("x = (1 +\n     2)\ny = 3\n");
    assert.deepEqual(t, [
      TT.Ident, TT.Assign, TT.LParen, TT.Number, TT.Plus, TT.Number, TT.RParen, TT.Newline,
      TT.Ident, TT.Assign, TT.Number, TT.Newline,
      TT.EOF,
    ]);
  });

  it("treats a blank line inside brackets as nothing at all", () => {
    assert.deepEqual(shape("f(\n\n\n  1\n\n)"), [TT.Ident, TT.LParen, TT.Number, TT.RParen]);
  });

  it("rejects an unmatched closer", () => {
    assert.throws(() => tokenize("x = )"), (e: L0pError) => /unmatched "\)"/.test(e.message));
  });
});

describe("strings", () => {
  it("reads plain strings with either quote", () => {
    assert.deepEqual(only(tokenize(`"ab" 'cd'`), TT.String), ["ab", "cd"]);
  });

  it("decodes escapes", () => {
    assert.deepEqual(only(tokenize(`"a\\nb\\tc\\"d\\\\e\\x41\\u00e9"`), TT.String), ['a\nb\tc"d\\eAé']);
  });

  it("rejects an unknown escape and names it", () => {
    assert.throws(() => tokenize('"\\q"'), (e: L0pError) => /unknown escape \\q/.test(e.message));
  });

  it("rejects an unterminated string", () => {
    assert.throws(() => tokenize('"abc'), (e: L0pError) => /unterminated string/.test(e.message));
    assert.throws(() => tokenize('"abc\n'), (e: L0pError) => /unterminated string/.test(e.message));
  });

  it("keeps a plain string as a plain string", () => {
    const v = only<string>(tokenize('"hi"'), TT.String);
    assert.equal(typeof v[0], "string");
  });

  it("splits an interpolated string into parts", () => {
    const v = only<StringPart[]>(tokenize('"a${b}c"'), TT.String);
    // col 5 is the 'b', not the opening quote at col 1
    assert.deepEqual(v[0], [
      { kind: "lit", value: "a" },
      { kind: "expr", src: "b", line: 1, col: 5 },
      { kind: "lit", value: "c" },
    ]);
  });

  it("keeps braces balanced inside an interpolation", () => {
    const v = only<StringPart[]>(tokenize('"${f({1: 2})}"'), TT.String);
    assert.equal(hole(v[0]), "f({1: 2})");
  });

  it("handles a string inside an interpolation", () => {
    const v = only<StringPart[]>(tokenize('"${g("x")}"'), TT.String);
    assert.equal(hole(v[0]), 'g("x")');
  });

  it("reports the column of the quote, not the hole", () => {
    const toks = tokenize('ok = "v=${q}"');
    const s = toks.find((t) => t.type === TT.String);
    assert.equal(s?.col, 6);
  });

  it("rejects an empty interpolation", () => {
    assert.throws(() => tokenize('"${}"'), (e: L0pError) => /empty interpolation/.test(e.message));
  });
});

describe("comments", () => {
  it("runs to the end of the line", () => {
    assert.deepEqual(shape("x = 1 # this is dropped\n"), [TT.Ident, TT.Assign, TT.Number]);
  });

  it("does not open a bracket", () => {
    assert.deepEqual(shape("x = 1 # (\n"), [TT.Ident, TT.Assign, TT.Number]);
  });
});

describe("layout and output", () => {
  it("records a line and column for every token", () => {
    const toks = tokenize("def f():\n    return 1\n");
    const ret = toks.find((t) => t.value === "return");
    assert.deepEqual([ret?.line, ret?.col], [2, 5]);
  });

  it("terminates an unterminated final line", () => {
    const t = types("x = 1");
    assert.deepEqual(t.slice(-2), [TT.Newline, TT.EOF]);
  });

  it("emits only EOF for empty input", () => {
    assert.deepEqual(types(""), [TT.EOF]);
    assert.deepEqual(types("   \n\n# just a comment\n"), [TT.EOF]);
  });

  it("formats a token dump", () => {
    // operators print as their own text, not as the TT key
    const rows = formatTokens(tokenize("1 + 2")).split("\n");
    assert.equal(rows.length, 5);
    assert.match(rows[0] as string, /1:1\s+Number\s+1/);
    assert.match(rows[1] as string, /1:3\s+\+/);
  });

  it("formats an error with a caret under the column", () => {
    // col 3 of "  x = 1" is the 'x', and the caret lands on it
    const err = new L0pError("boom", 2, 3);
    assert.equal(err.format("a\n  x = 1\n"), "line 2, col 3: boom\n    x = 1\n    ^");
  });

  it("omits the source line when none is given", () => {
    assert.equal(new L0pError("boom", 9, 1).format(), "line 9, col 1: boom");
  });

  it("carries the file name into errors", () => {
    assert.throws(
      () => new Lexer("x = $", "demo.l0p").tokenize(),
      (e: L0pError) => e.file === "demo.l0p" && e.prefix() === "demo.l0p:1:5",
    );
  });

  it("keeps values out of the way for operators", () => {
    assert.deepEqual(values("1 + 2"), [1, null, 2, null, null]);
  });
});
