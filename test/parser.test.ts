import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { L0pError } from "../src/errors.ts";
import { parse } from "../src/parser.ts";
import type { Def, Expr, If, Stmt } from "../src/ast.ts";

/** Strips positions so a tree can be compared against a plain literal. */
function bare<T>(value: T): T {
  if (Array.isArray(value)) return value.map(bare) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "line" || key === "col") continue;
      out[key] = bare(inner);
    }
    return out as T;
  }
  return value;
}

const stmts = (src: string): Stmt[] => bare(parse(src).stmts) as Stmt[];

/*
 * Narrowing helpers.
 *
 * The tests used to reach into a node with `as { otherwise: Stmt[] }`, which is a
 * claim the compiler will not accept -- and rightly: it is not true of every node,
 * so the assertion could be describing the wrong statement.  Narrowing on `kind`
 * says what is actually meant and fails when the node is a different one.
 */
const isIf = (s: Stmt | undefined): s is If & { otherwise: readonly Stmt[] | null } =>
  s !== undefined && s.kind === "If";
const isDef = (s: Stmt | undefined): s is Def => s !== undefined && s.kind === "Def";

/** The body of a `def`, or an immediate failure naming what came instead. */
const defBody = (s: Stmt): readonly Stmt[] => {
  assert.ok(isDef(s), `expected a Def, got ${s.kind}`);
  return s.body;
};

/** The single expression in a one-statement program. */
const expr = (src: string): Expr => {
  const list = stmts(src);
  assert.equal(list.length, 1, `expected one statement, got ${list.length}`);
  const only = list[0] as Stmt;
  assert.equal(only.kind, "ExprStmt");
  return bare((only as { expr: Expr }).expr);
};

const stmt = (src: string): Stmt => {
  const list = stmts(src);
  assert.equal(list.length, 1, `expected one statement, got ${list.length}`);
  return list[0] as Stmt;
};

const throws = (src: string, pattern: RegExp): L0pError => {
  try {
    parse(src);
  } catch (e) {
    assert.ok(e instanceof L0pError, `expected L0pError, got ${String(e)}`);
    assert.match(e.message, pattern);
    return e;
  }
  throw new assert.AssertionError({ message: `expected a failure for: ${src}` });
};

describe("literals", () => {
  it("reads numbers, strings, booleans and null", () => {
    assert.deepEqual(expr("42"), { kind: "Num", value: 42 });
    assert.deepEqual(expr('"hi"'), { kind: "Str", parts: ["hi"] });
    assert.deepEqual(expr("true"), { kind: "Bool", value: true });
    assert.deepEqual(expr("false"), { kind: "Bool", value: false });
    assert.deepEqual(expr("null"), { kind: "Null" });
  });

  it("treats a leading underscore name as an ordinary identifier", () => {
    assert.deepEqual(expr("_x"), { kind: "Ident", name: "_x" });
  });

  it("builds lists and dicts", () => {
    assert.deepEqual(expr("[1, 2]"), { kind: "ListLit", items: [{ kind: "Num", value: 1 }, { kind: "Num", value: 2 }] });
    assert.deepEqual(expr("[]"), { kind: "ListLit", items: [] });
    assert.deepEqual(expr('{"a": 1}'), {
      kind: "DictLit",
      entries: [{ key: { kind: "Str", parts: ["a"] }, value: { kind: "Num", value: 1 } }],
    });
    assert.deepEqual(expr("{}"), { kind: "DictLit", entries: [] });
  });

  it("parses an interpolation into parts", () => {
    assert.deepEqual(expr('"a${b}c"'), {
      kind: "Str",
      parts: ["a", { kind: "Ident", name: "b" }, "c"],
    });
  });

  it("parses an expression inside an interpolation", () => {
    assert.deepEqual(expr('"${1 + 2}"'), {
      kind: "Str",
      parts: [{ kind: "Binary", op: "+", left: { kind: "Num", value: 1 }, right: { kind: "Num", value: 2 } }],
    });
  });

  it("keeps a lone interpolation as one part", () => {
    assert.deepEqual(expr('"${x}"'), { kind: "Str", parts: [{ kind: "Ident", name: "x" }] });
  });

  it("allows nesting inside an interpolation", () => {
    assert.deepEqual(expr('"${f({1: 2})}"'), {
      kind: "Str",
      parts: [{ kind: "Call", callee: { kind: "Ident", name: "f" }, args: [
        { kind: "DictLit", entries: [{ key: { kind: "Num", value: 1 }, value: { kind: "Num", value: 2 } }] },
      ] }],
    });
  });
});

describe("precedence", () => {
  it("binds multiplication tighter than addition", () => {
    assert.deepEqual(expr("1 + 2 * 3"), {
      kind: "Binary", op: "+",
      left: { kind: "Num", value: 1 },
      right: { kind: "Binary", op: "*", left: { kind: "Num", value: 2 }, right: { kind: "Num", value: 3 } },
    });
  });

  it("honours parentheses", () => {
    assert.deepEqual(expr("(1 + 2) * 3"), {
      kind: "Binary", op: "*",
      left: { kind: "Binary", op: "+", left: { kind: "Num", value: 1 }, right: { kind: "Num", value: 2 } },
      right: { kind: "Num", value: 3 },
    });
  });

  it("makes arithmetic left-associative", () => {
    assert.deepEqual(expr("1 - 2 - 3"), {
      kind: "Binary", op: "-",
      left: { kind: "Binary", op: "-", left: { kind: "Num", value: 1 }, right: { kind: "Num", value: 2 } },
      right: { kind: "Num", value: 3 },
    });
  });

  it("makes ** right-associative", () => {
    assert.deepEqual(expr("2 ** 3 ** 2"), {
      kind: "Binary", op: "**",
      left: { kind: "Num", value: 2 },
      right: { kind: "Binary", op: "**", left: { kind: "Num", value: 3 }, right: { kind: "Num", value: 2 } },
    });
  });

  it("binds ** tighter than unary minus", () => {
    assert.deepEqual(expr("-2 ** 2"), {
      kind: "Unary", op: "-",
      operand: { kind: "Binary", op: "**", left: { kind: "Num", value: 2 }, right: { kind: "Num", value: 2 } },
    });
  });

  it("allows a unary minus in the exponent", () => {
    assert.deepEqual(expr("2 ** -1"), {
      kind: "Binary", op: "**",
      left: { kind: "Num", value: 2 },
      right: { kind: "Unary", op: "-", operand: { kind: "Num", value: 1 } },
    });
  });

  it("orders comparison below additive", () => {
    assert.deepEqual(expr("1 + 2 < 4"), {
      kind: "Binary", op: "<",
      left: { kind: "Binary", op: "+", left: { kind: "Num", value: 1 }, right: { kind: "Num", value: 2 } },
      right: { kind: "Num", value: 4 },
    });
  });

  it("orders bitwise below comparison and above additive", () => {
    // a | b < c & d  ==>  (a | b) < (c & d)
    assert.deepEqual(expr("a | b < c & d"), {
      kind: "Binary", op: "<",
      left: { kind: "Binary", op: "|", left: { kind: "Ident", name: "a" }, right: { kind: "Ident", name: "b" } },
      right: { kind: "Binary", op: "&", left: { kind: "Ident", name: "c" }, right: { kind: "Ident", name: "d" } },
    });
  });

  it("binds `not` looser than comparison", () => {
    assert.deepEqual(expr("not a == b"), {
      kind: "Unary", op: "not",
      operand: { kind: "Binary", op: "==", left: { kind: "Ident", name: "a" }, right: { kind: "Ident", name: "b" } },
    });
  });

  it("separates short-circuiting logicals from arithmetic", () => {
    assert.deepEqual(expr("a or b and c"), {
      kind: "Logical", op: "or",
      left: { kind: "Ident", name: "a" },
      right: { kind: "Logical", op: "and", left: { kind: "Ident", name: "b" }, right: { kind: "Ident", name: "c" } },
    });
  });

  it("keeps `and` tighter than `or`", () => {
    assert.deepEqual(expr("a and b or c"), {
      kind: "Logical", op: "or",
      left: { kind: "Logical", op: "and", left: { kind: "Ident", name: "a" }, right: { kind: "Ident", name: "b" } },
      right: { kind: "Ident", name: "c" },
    });
  });

  it("reads in and not in as comparisons", () => {
    assert.deepEqual(expr("x in y"), {
      kind: "Binary", op: "in", left: { kind: "Ident", name: "x" }, right: { kind: "Ident", name: "y" },
    });
    assert.deepEqual(expr("x not in y"), {
      kind: "Binary", op: "not in", left: { kind: "Ident", name: "x" }, right: { kind: "Ident", name: "y" },
    });
  });

  it("tolerates a newline inside brackets", () => {
    assert.deepEqual(expr("f(\n  1,\n  2\n)"), {
      kind: "Call", callee: { kind: "Ident", name: "f" },
      args: [{ kind: "Num", value: 1 }, { kind: "Num", value: 2 }],
    });
  });
});

describe("conditionals", () => {
  it("reads cond ? a : b", () => {
    assert.deepEqual(expr("c ? a : b"), {
      kind: "Ternary", cond: { kind: "Ident", name: "c" },
      then: { kind: "Ident", name: "a" }, other: { kind: "Ident", name: "b" },
    });
  });

  it("reads a if c else b", () => {
    assert.deepEqual(expr("a if c else b"), {
      kind: "Ternary", cond: { kind: "Ident", name: "c" },
      then: { kind: "Ident", name: "a" }, other: { kind: "Ident", name: "b" },
    });
  });

  it("nests to the right", () => {
    assert.deepEqual(expr("a if c else b if d else e"), {
      kind: "Ternary", cond: { kind: "Ident", name: "c" },
      then: { kind: "Ident", name: "a" },
      other: { kind: "Ternary", cond: { kind: "Ident", name: "d" },
        then: { kind: "Ident", name: "b" }, other: { kind: "Ident", name: "e" } },
    });
  });

  it("spans multiple lines inside brackets", () => {
    assert.deepEqual(expr("(\n  a\n  if c\n  else b\n)"), {
      kind: "Ternary", cond: { kind: "Ident", name: "c" },
      then: { kind: "Ident", name: "a" }, other: { kind: "Ident", name: "b" },
    });
  });
});

describe("calls and access", () => {
  it("chains calls, attributes and indexes", () => {
    assert.deepEqual(expr("a.b(1)[0]"), {
      kind: "Index",
      obj: { kind: "Call", callee: { kind: "Attr", obj: { kind: "Ident", name: "a" }, name: "b" },
        args: [{ kind: "Num", value: 1 }] },
      index: { kind: "Num", value: 0 },
    });
  });

  it("calls the result of a call", () => {
    assert.deepEqual(expr("f()()"), {
      kind: "Call", callee: { kind: "Call", callee: { kind: "Ident", name: "f" }, args: [] }, args: [],
    });
  });
});

describe("lambdas", () => {
  it("reads a bare parameter", () => {
    assert.deepEqual(expr("x -> x * 2"), {
      kind: "Lambda", params: [{ name: "x", default: null }],
      body: { kind: "Binary", op: "*", left: { kind: "Ident", name: "x" }, right: { kind: "Num", value: 2 } },
    });
  });

  it("reads a parameter list with defaults", () => {
    assert.deepEqual(expr("(a, b = 2) -> a"), {
      kind: "Lambda",
      params: [{ name: "a", default: null }, { name: "b", default: { kind: "Num", value: 2 } }],
      body: { kind: "Ident", name: "a" },
    });
  });

  it("does not mistake a call for a lambda", () => {
    assert.deepEqual(expr("(f)(1)"), { kind: "Call", callee: { kind: "Ident", name: "f" }, args: [{ kind: "Num", value: 1 }] });
  });
});

describe("bindings", () => {
  it("distinguishes let, var and const", () => {
    assert.deepEqual(stmt("let x = 1"), { kind: "Let", binding: "let", name: "x", init: { kind: "Num", value: 1 } });
    assert.deepEqual(stmt("var y"), { kind: "Let", binding: "var", name: "y", init: null });
    assert.deepEqual(stmt("const N = 8"), { kind: "Let", binding: "const", name: "N", init: { kind: "Num", value: 8 } });
  });

  it("accepts any word as a binding name, including keywords", () => {
    assert.deepEqual(stmt("let import = 1"), { kind: "Let", binding: "let", name: "import", init: { kind: "Num", value: 1 } });
  });
});

describe("assignment", () => {
  it("wraps a bare expression in an ExprStmt", () => {
    assert.deepEqual(stmt("f()"), { kind: "ExprStmt", expr: { kind: "Call", callee: { kind: "Ident", name: "f" }, args: [] } });
  });

  it("assigns to a name", () => {
    assert.deepEqual(stmt("x = 1"), { kind: "Assign", targets: [{ kind: "Ident", name: "x" }], op: null, value: { kind: "Num", value: 1 } });
  });

  it("chains a = b = 1", () => {
    assert.deepEqual(stmt("a = b = 1"), {
      kind: "Assign", targets: [{ kind: "Ident", name: "a" }, { kind: "Ident", name: "b" }], op: null,
      value: { kind: "Num", value: 1 },
    });
  });

  it("keeps the compound operator instead of desugaring", () => {
    // a desugared `a[0] += 1` would evaluate the index twice
    assert.deepEqual(stmt("a[0] += 1"), {
      kind: "Assign", targets: [{ kind: "Index", obj: { kind: "Ident", name: "a" }, index: { kind: "Num", value: 0 } }],
      op: "+", value: { kind: "Num", value: 1 },
    });
    assert.equal((stmt("x **= 2") as { op: string }).op, "**");
    assert.equal((stmt("x >>= 1") as { op: string }).op, ">>");
  });

  it("assigns through an index and an attribute", () => {
    assert.deepEqual(stmt("a.b = 1"), {
      kind: "Assign", targets: [{ kind: "Attr", obj: { kind: "Ident", name: "a" }, name: "b" }],
      op: null, value: { kind: "Num", value: 1 },
    });
  });

  it("refuses to assign to a literal", () => {
    throws("1 = 2", /cannot assign/);
  });

  it("separates statements with a semicolon", () => {
    assert.deepEqual(stmts("a = 1; b = 2").length, 2);
  });
});

describe("definitions", () => {
  it("reads a function with a body", () => {
    assert.deepEqual(stmt("def f(a, b = 2):\n    return a + b\n"), {
      kind: "Def", name: "f",
      params: [{ name: "a", default: null }, { name: "b", default: { kind: "Num", value: 2 } }],
      body: [{ kind: "Return", value: { kind: "Binary", op: "+", left: { kind: "Ident", name: "a" }, right: { kind: "Ident", name: "b" } } }],
    });
  });

  it("accepts a one-line body", () => {
    assert.deepEqual(stmt("def f(): return 1"), {
      kind: "Def", name: "f", params: [],
      body: [{ kind: "Return", value: { kind: "Num", value: 1 } }],
    });
  });

  it("allows blank and comment lines inside a body", () => {
    assert.deepEqual(stmt("def f():\n\n    # note\n\n    return 1\n").kind, "Def");
  });

  it("reads a struct with defaults", () => {
    assert.deepEqual(stmt("struct Point:\n    x = 0\n    y\n"), {
      kind: "StructDef", name: "Point",
      fields: [{ name: "x", value: { kind: "Num", value: 0 } }, { name: "y", value: null }],
    });
  });
});

describe("control flow", () => {
  it("reads if with an indented block", () => {
    assert.deepEqual(stmt("if a:\n    b\n    c\n"), {
      kind: "If", cond: { kind: "Ident", name: "a" },
      then: [{ kind: "ExprStmt", expr: { kind: "Ident", name: "b" } }, { kind: "ExprStmt", expr: { kind: "Ident", name: "c" } }],
      otherwise: null,
    });
  });

  it("reads else", () => {
    const s = stmt("if a:\n    b\nelse:\n    c\n") as { otherwise: Stmt[] | null };
    assert.deepEqual(s.otherwise, [{ kind: "ExprStmt", expr: { kind: "Ident", name: "c" } }]);
  });

  it("nests else if instead of flattening it", () => {
    const s = stmt("if a:\n    b\nelse if c:\n    d\nelse:\n    e\n");
    assert.ok(isIf(s), "expected an If");
    const inner = s.otherwise?.[0];
    assert.ok(isIf(inner), "the else arm is itself an If, not a flattened one");
    assert.equal(inner.otherwise?.length, 1);
  });

  it("reads while and for", () => {
    assert.deepEqual(stmt("while a:\n    b\n"), {
      kind: "While", cond: { kind: "Ident", name: "a" }, body: [{ kind: "ExprStmt", expr: { kind: "Ident", name: "b" } }],
    });
    assert.deepEqual(stmt("for x in xs:\n    y\n"), {
      kind: "For", name: "x", iter: { kind: "Ident", name: "xs" },
      body: [{ kind: "ExprStmt", expr: { kind: "Ident", name: "y" } }],
    });
  });

  it("reads return, break, continue and pass", () => {
    // `return` is only legal inside a `def`, so these live in one
    assert.deepEqual(defBody(stmt("def f():\n    return 1\n"))[0], {
      kind: "Return", value: { kind: "Num", value: 1 },
    });
    assert.deepEqual(defBody(stmt("def f():\n    return\n"))[0], { kind: "Return", value: null });
    assert.deepEqual(stmt("break"), { kind: "Branch", what: "break" });
    assert.deepEqual(stmt("continue"), { kind: "Branch", what: "continue" });
    assert.deepEqual(stmt("pass"), { kind: "Branch", what: "pass" });
  });

  it("ends a one-line return at the line end", () => {
    assert.deepEqual(stmt("def f(): return"), { kind: "Def", name: "f", params: [], body: [{ kind: "Return", value: null }] });
  });
});

describe("imports", () => {
  it("reads a plain import", () => {
    assert.deepEqual(stmt("import os"), {
      kind: "Import", form: "import", path: "os", alias: null, names: [], level: 0,
    });
  });

  it("reads a dotted path and an alias", () => {
    assert.deepEqual(stmt("import os.path as osp"), {
      kind: "Import", form: "import", path: "os.path", alias: "osp", names: [], level: 0,
    });
  });

  it("reads from-imports at each level", () => {
    assert.deepEqual(stmt("from os import path, sep"), {
      kind: "Import", form: "from", path: "os", alias: null, names: ["path", "sep"], level: 0,
    });
    assert.deepEqual(stmt("from . import m"), {
      kind: "Import", form: "from", path: "", alias: null, names: ["m"], level: 1,
    });
    assert.deepEqual(stmt("from ..pkg import m"), {
      kind: "Import", form: "from", path: "pkg", alias: null, names: ["m"], level: 2,
    });
  });

  it("spreads names across lines", () => {
    const s = stmt("from m import (\n  a,\n  b,\n)");
    assert.equal(s.kind, "Import");
    assert.deepEqual(s.names, ["a", "b"]);
  });

  it("says plainly that per-name aliases are missing", () => {
    throws("from m import a as b", /not supported yet/);
  });

  it("rejects `from import x`", () => {
    throws("from import x", /needs a module name/);
  });
});

describe("async surface", () => {
  it("reads spawn and await as expressions", () => {
    assert.deepEqual(expr("spawn f(1)"), { kind: "Spawn", call: { kind: "Call", callee: { kind: "Ident", name: "f" }, args: [{ kind: "Num", value: 1 }] } });
    // `await` has to be an expression, not a statement, or this would not parse
    assert.deepEqual((stmt("x = await f()") as { value: unknown }).value, {
      kind: "Await", expr: { kind: "Call", callee: { kind: "Ident", name: "f" }, args: [] },
    });
  });

  it("reads defer as a statement", () => {
    assert.deepEqual(stmt("defer f.close()"), {
      kind: "Defer", call: { kind: "Call", callee: { kind: "Attr", obj: { kind: "Ident", name: "f" }, name: "close" }, args: [] },
    });
  });

  it("rejects spawn and defer without a call", () => {
    throws("spawn x", /spawn takes a call/);
    throws("defer x", /defer takes a call/);
  });
});

describe("errors", () => {
  it("points at the token it choked on", () => {
    const e = throws("def f(:\n    pass\n", /expected a parameter name/);
    assert.deepEqual([e.line, e.col], [1, 7]);
  });

  it("rejects a missing colon after a header", () => {
    throws("if a\n    b\n", /expected `:`/);
  });

  it("rejects a missing `in` in a for loop", () => {
    throws("for x xs:\n    pass\n", /expected `in`/);
  });

  it("rejects a keyword used as an expression", () => {
    throws("return 1", /`return` outside a function/);
    throws("x = def", /`def` cannot be used here/);
    throws("x = while", /`while` cannot be used here/);
  });

  it("accepts return inside a function at any depth", () => {
    assert.equal(stmt("def f():\n    def g():\n        return 1\n").kind, "Def");
  });

  it("rejects an unterminated bracket", () => {
    throws("f(1", /expected `\)`/);
  });

  it("rejects a dangling else", () => {
    throws("a if c", /expected `else`/);
  });

  it("rejects trailing junk in an interpolation", () => {
    throws('"${a b}"', /unexpected/);
  });
});
