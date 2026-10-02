/*
 * What the compiler is allowed to believe about a value.
 *
 * The language is dynamic and stays that way: a value's type is decided by the
 * value, and the interpreter is what decides it.  So this pass must never be the
 * second opinion -- anything not proven is `any`, and `any` means the runtime
 * still gets to choose.  An unsound guess here does not fail in the compiler, it
 * fails later as a native binary that disagrees with the interpreter, which is
 * the one outcome this project is built to rule out.
 *
 * So most of these are tests about what the pass *declines* to say.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/parser.ts";
import { lowerProgram } from "../src/ir/lower.ts";
import { inferTypes, join, literalType, type Ty } from "../src/ir/types.ts";
import type { IrFunc } from "../src/ir/ir.ts";

function typesOf(src: string, name: string): Ty[] {
  const f = lowerProgram(parse(src)).funcs.find((x) => x.name === name);
  assert.ok(f !== undefined, `no function named ${name}`);
  return inferTypes(f as IrFunc);
}

/** The type of the value each instruction defines, by source line and op. */
function byOp(types: Ty[], src: string, name: string): Map<string, Ty> {
  const f = lowerProgram(parse(src)).funcs.find((x) => x.name === name);
  assert.ok(f !== undefined, `no function named ${name}`);
  const out = new Map<string, Ty>();
  for (const b of (f as IrFunc).blocks) {
    for (const p of b.params) out.set(`phi@b${b.id}v${p.dest}`, types[p.dest] ?? "any");
    for (const i of b.instrs) {
      if (i.dest === null) continue;
      out.set(`${i.op}@${i.line}`, types[i.dest] ?? "any");
    }
  }
  return out;
}

describe("the type lattice", () => {
  it("joins unrelated tags to any, because nothing narrower is true", () => {
    assert.equal(join("str", "list"), "any");
    assert.equal(join("null", "dict"), "any");
    assert.equal(join("any", "int"), "any");
  });

  it("joins int and float to num, in both directions", () => {
    assert.equal(join("int", "float"), "num");
    assert.equal(join("float", "int"), "num");
    assert.equal(join("num", "int"), "num");
    assert.equal(join("int", "int"), "int");
  });

  it("is idempotent and absorbing on any, which is what lets the fixpoint loop", () => {
    for (const t of ["int", "num", "str", "any", "none"] as const) {
      assert.equal(join(t, t), t);
      assert.equal(join("any", t), "any");
      assert.equal(join(t, "any"), "any");
    }
    // `none` is the start of the ascending chain: it gives way to anything.
    assert.equal(join("none", "str"), "str");
  });

  it("stores a whole number too large for int64 as a float", () => {
    // `Number.isInteger(2**63)` is true -- a double is a whole number long
    // before it is a machine integer -- so without the range test a literal
    // outside int64 would be claimed as an int and codegen would truncate it.
    assert.equal(literalType(9223372036854775807), "float");
    assert.equal(literalType(-(2 ** 63)), "int");
    assert.equal(literalType(2 ** 63), "float");
    assert.equal(literalType(1.5), "float");
    assert.equal(literalType(0), "int");
    assert.equal(literalType("x"), "str");
    assert.equal(literalType(true), "bool");
    assert.equal(literalType(null), "null");
  });
});

describe("inference over a function", () => {
  it("keeps `sub` an int, because two int64s always have an int64 difference", () => {
    const src = "def w():\n    let a = 5\n    let b = 2\n    a - b\n";
    const t = byOp(typesOf(src, "w"), src, "w");
    assert.equal(t.get("sub@4"), "int", "subtraction cannot overflow, so it stays an int");
  });

  it("widens add and mul to num even with both operands known, because they can leave int64", () => {
    const src = "def w():\n    let a = 5\n    let b = 2\n    a + b\n    a * b\n";
    const t = byOp(typesOf(src, "w"), src, "w");
    assert.equal(t.get("add@4"), "num");
    assert.equal(t.get("mul@5"), "num");
  });

  it("keeps strings and lists out of the numeric lattice", () => {
    const src = 'def w():\n    let a = "x"\n    let b = "y"\n    a + b\n';
    assert.equal(byOp(typesOf(src, "w"), src, "w").get("add@4"), "str");
    const l = "def v():\n    let a = [1]\n    let b = [2]\n    a + b\n";
    assert.equal(byOp(typesOf(l, "v"), l, "v").get("add@4"), "list");
  });

  it("says nothing at all about a parameter, or a global, or a call", () => {
    const src = "g = 1\ndef w(n):\n    n + 1\n    g + 1\n    str(1) + 1\n";
    const t = byOp(typesOf(src, "w"), src, "w");
    // `add` is the operator that can return a string or a list, so an unknown
    // operand really does leave it unknown -- unlike `sub`, above.
    assert.equal(t.get("add@3"), "any", "n + 1 could be a concatenation");
    assert.equal(t.get("add@4"), "any", "a global read is unknown");
    assert.equal(t.get("add@5"), "any", "a call result is unknown");
    assert.equal(typesOf("def w(n):\n    n - 1\n", "w")[0], "any", "the parameter is still unknown");
    // The parameter itself must not be narrowed by how it is used.
    assert.equal(typesOf(src, "w")[0], "any");
  });

  it("settles a loop-carried name at the join of every path", () => {
    // `i` is an int at the head and an int on the back edge, so it stays int.
    // `acc` picks up an `add`, which may leave int64, so it is num.
    const src = "def w(n):\n    var i = 0\n    var acc = 0\n    while i < n:\n        acc = acc + i\n        i = i + 1\n    return acc\n";
    const t = byOp(typesOf(src, "w"), src, "w");
    const phis = [...t].filter(([k]) => k.startsWith("phi@b2v"));
    assert.equal(phis.length, 2, "the head should carry a phi per written name");
    /*
     * Both settle at `num`, never at `int`, and that is the interesting part.
     *
     * `i` is an int on the way in and `i = i + 1` on the way round, so the head
     * has to join them.  The addition cannot stay int -- the sum of two int64s
     * that overflows is a float, and the runtime widens it -- so the counter
     * becomes `num` and stays there.
     *
     * It could have been worse: read as `any` instead of `num`, which is what
     * happens if an unresolved value is treated as the top of the lattice rather
     * than the bottom.  `num` at least lets the next instruction know it has a
     * number, and `int` is exactly the type the backend would need to drop a tag
     * check.  A loop written with `+` will not get it, and that is the ceiling.
     */
    for (const [, ty] of phis) assert.equal(ty, "num");
    assert.equal(t.get("add@5"), "num");
    assert.equal(t.get("add@6"), "num");
  });

  it("narrows a loop counter written with `-`, which cannot concatenate", () => {
    // The same loop with `i = i - 1`.  `sub` needs numbers, so if it returned, it
    // returned a number, and two int64s always have an int64 difference -- so the
    // counter is an int at the head and stays one round the loop.  This is the
    // case the pass is actually good at, and it is a narrow one.
    const src = "def w(n):\n    var i = n\n    var t = 0\n    while i > 0:\n        t = t + 1\n        i = i - 1\n    return i\n";
    assert.equal(byOp(typesOf(src, "w"), src, "w").get("sub@6"), "num", "i is unknown, so sub is num");
    const ints = "def v(n):\n    var i = 0\n    while i < n:\n        i = i - 1\n    return i\n";
    const t2 = byOp(typesOf(ints, "v"), ints, "v");
    assert.equal(t2.get("sub@4"), "int", "0 - 1 is two int64s, so it is an int");
    assert.equal(t2.get("phi@b2v2"), "int", "so the counter is an int across the back edge");
  });

  it("gives a name two values to `any` rather than picking one", () => {
    const src = "def w(c):\n    var x = 0\n    if c:\n        x = 1\n    else:\n        x = \"s\"\n    return x\n";
    const t = byOp(typesOf(src, "w"), src, "w");
    const phi = [...t].find(([k]) => k.startsWith("phi@b4v"));
    assert.ok(phi !== undefined, "the if join should have a phi for `x`");
    assert.equal(phi[1], "any", "int and str have no common narrower type");
  });

  it("knows what the built-ins return", () => {
    const src = 'def w(s):\n    len(s)\n    str(1)\n    type(1)\n    print(1)\n';
    const t = byOp(typesOf(src, "w"), src, "w");
    assert.equal(t.get("call.builtin@2"), "int");
    assert.equal(t.get("call.builtin@3"), "str");
    assert.equal(t.get("call.builtin@4"), "str");
    assert.equal(t.get("call.builtin@5"), "null");
  });

  it("does not narrow a value the source never assigned", () => {
    const src = "def w():\n    let a = 1\n    a\n";
    const types = typesOf(src, "w");
    assert.ok(types.length >= 1);
    for (const t of types) assert.ok(t !== undefined);
  });
});
