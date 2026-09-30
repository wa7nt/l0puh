import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatProgram } from "../src/astprint.ts";
import { parse } from "../src/parser.ts";

const show = (src: string): string => formatProgram(parse(src));

describe("statement dump", () => {
  it("shows bindings and their kind", () => {
    assert.equal(show("let x = 1"), "let x = 1");
    assert.equal(show("var y"), "var y");
    assert.equal(show("const N = 8"), "const N = 8");
  });

  it("indents a function body", () => {
    assert.equal(show("def f(a, b = 2):\n    return a\n"), "def f(a, b = 2)\n  return a");
  });

  it("nests control flow", () => {
    assert.equal(
      show("while a:\n    if b:\n        c\n"),
      "while a\n  if b\n    c",
    );
  });

  it("shows an else branch", () => {
    assert.equal(show("if a:\n    b\nelse:\n    c\n"), "if a\n  b\nelse\n  c");
  });

  it("shows a struct and its defaults", () => {
    assert.equal(show("struct P:\n    x = 0\n    y\n"), "struct P\n  x = 0\n  y");
  });

  it("shows both import forms", () => {
    assert.equal(show("import os.path as osp"), "import os.path as osp");
    assert.equal(show("from ..pkg import a, b"), "from ..pkg import a, b");
    assert.equal(show("from . import m"), "from . import m");
  });

  it("shows assignment and compound assignment", () => {
    assert.equal(show("a = b = 1"), "a, b = 1");
    assert.equal(show("a[0] += 1"), "a[0] += 1");
  });
});

describe("expression dump", () => {
  it("parenthesises every nested binary, so the shape is unambiguous", () => {
    // a debug dump that shows 1 + 2 * 3 flat would hide whether the tree
    // actually nests the way the precedence table says it does
    assert.equal(show("x = 1 + 2 * 3"), "x = 1 + (2 * 3)");
    assert.equal(show("x = (1 + 2) * 3"), "x = (1 + 2) * 3");
    assert.equal(show("x = (1 + 2) + 3"), "x = (1 + 2) + 3");
    assert.equal(show("x = a and b or c"), "x = (a and b) or c");
  });

  it("leaves a lone operator alone", () => {
    assert.equal(show("x = 1 + 2"), "x = 1 + 2");
  });

  it("quotes strings so they cannot be read as bare words", () => {
    assert.equal(show('let n = "x"'), 'let n = "x"');
    assert.equal(show("let n = x"), "let n = x");
  });

  it("keeps an interpolation visible", () => {
    assert.equal(show('let s = "a${1 + 2}b"'), 'let s = "a${1 + 2}b"');
  });

  it("renders calls, attributes and indexes", () => {
    assert.equal(show("f(1, 2)"), "f(1, 2)");
    assert.equal(show("a.b.c"), "a.b.c");
    assert.equal(show("a[0][1]"), "a[0][1]");
    assert.equal(show("f()(1)"), "f()(1)");
  });

  it("renders lambdas, ternaries and async forms", () => {
    assert.equal(show("x -> x * 2"), "(x) -> x * 2");
    assert.equal(show("x = (a, b) -> a"), "x = (a, b) -> a");
    assert.equal(show("x = c ? a : b"), "x = c ? a : b");
    assert.equal(show("x = a if c else b"), "x = c ? a : b");
    assert.equal(show("x = spawn f()"), "x = spawn f()");
    assert.equal(show("x = await f()"), "x = await f()");
    assert.equal(show("defer f()"), "defer f()");
  });

  it("renders lists and dicts", () => {
    assert.equal(show("x = [1, 2]"), "x = [1, 2]");
    assert.equal(show('x = {"k": 1}'), 'x = {"k": 1}');
  });
});
