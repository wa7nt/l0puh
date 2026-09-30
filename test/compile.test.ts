import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compile } from "../src/compile/compiler.ts";
import { constLabel, type Module, type Proto } from "../src/bytecode/code.ts";
import { formatOp } from "../src/bytecode/op.ts";
import { L0pError } from "../src/errors.ts";
import { parse } from "../src/parser.ts";

function build(src: string): Module {
  return compile(parse(src), "test", null).module;
}

/** Disassembly of the module body. */
function asm(src: string): string[] {
  return disasm(build(src), (m) => m.protos[m.entry] as Proto);
}

/** Disassembly of a named nested function. */
function fnAsm(src: string, name: string): string[] {
  return disasm(build(src), (m) => {
    const found = m.protos.find((p) => p.name === name);
    assert.ok(found, `no function named ${name}; have ${m.protos.map((p) => p.name).join(", ")}`);
    return found;
  });
}

function disasm(m: Module, pick: (m: Module) => Proto): string[] {
  const p = pick(m);
  const consts = p.consts.map(constLabel);
  const protos = m.protos.map((q) => q.name);
  return p.code.map((o) => formatOp(o, consts, protos));
}

function protoOf(src: string, name: string): Proto {
  const m = build(src);
  const found = m.protos.find((p) => p.name === name);
  assert.ok(found, `no function named ${name}`);
  return found;
}

describe("literals and binding", () => {
  it("stores a module-level binding in globals", () => {
    assert.deepEqual(asm("let x = 1 + 2"), [
      "const 1", "const 2", "bin +", 'StoreGlobal "x"', "Pop", "Halt",
    ]);
  });

  it("records what a global may be assigned to", () => {
    const m = build("let a = 1\nvar b = 2\nconst C = 3\ndef d():\n    pass\n");
    assert.equal(m.globalKinds.get("a"), "let");
    assert.equal(m.globalKinds.get("b"), "var");
    assert.equal(m.globalKinds.get("C"), "const");
    assert.equal(m.globalKinds.get("d"), "def");
  });

  it("binds a function-local in a slot", () => {
    const src = "def f():\n    let a = 1\n    let b = 2\n";
    assert.deepEqual(asm(src), ["closure f", 'StoreGlobal "f"', "Pop", "Halt"]);
    const f = protoOf(src, "f");
    assert.deepEqual(f.slotKinds, ["let", "let"]);
    assert.equal(f.nslots, 2);
  });

  it("puts parameters in the first slots", () => {
    const f = protoOf("def f(a, b):\n    return a\n", "f");
    assert.deepEqual(f.params, ["a", "b"]);
    assert.deepEqual(f.slotKinds, ["param", "param"]);
  });

  it("emits a jump for a conditional", () => {
    assert.deepEqual(asm("if a:\n    b\nelse:\n    c\n"), [
      'LoadGlobal "a"',
      "JumpIfFalse -> 5",
      'LoadGlobal "b"',
      "Pop",
      "Jump -> 7",
      'LoadGlobal "c"',
      "Pop",
      "Halt",
    ]);
  });

  it("emits a back edge for a while loop", () => {
    assert.deepEqual(asm("while a:\n    b\n"), [
      'LoadGlobal "a"',
      "JumpIfFalse -> 5",
      'LoadGlobal "b"',
      "Pop",
      "Jump -> 0",
      "Halt",
    ]);
  });

  it("patches continue to the top and break to the end", () => {
    // `break` has to land after the back edge, not on it
    assert.deepEqual(asm("while a:\n    if b:\n        continue\n    break\n"), [
      'LoadGlobal "a"',    // 0  the condition
      "JumpIfFalse -> 7",  // 1  leaving the loop
      'LoadGlobal "b"',    // 2  the if condition
      "JumpIfFalse -> 5",  // 3
      "Jump -> 0",         // 4  continue: back to the condition
      "Jump -> 7",         // 5  break: past the back edge
      "Jump -> 0",         // 6  the back edge
      "Halt",              // 7
    ]);
  });

  it("emits GetIter and ForIter for a for loop", () => {
    assert.deepEqual(asm("for x in xs:\n    pass\n"), [
      'LoadGlobal "xs"',
      "GetIter",
      "ForIter -> 6",
      'StoreGlobal "x"',
      "Pop",
      "Jump -> 2",
      "Halt",
    ]);
  });

  it("emits a jump table entry for an import", () => {
    const m = build("import os.path as osp\nfrom . import helper\n");
    assert.deepEqual(m.imports.map((i) => [i.form, i.path, i.alias, i.names, i.level, i.local]), [
      ["import", "os.path", "osp", [], 0, "osp"],
      ["from", "", null, ["helper"], 1, null],
    ]);
    assert.deepEqual(asm("import math\n"), ["import #0", "Halt"]);
  });
});

describe("operators", () => {
  it("turns a binary operator into one Bin with a table index", () => {
    const lines = asm("let x = 1 * 2\n");
    assert.equal(lines[2], "bin *");
  });

  it("short-circuits and", () => {
    assert.deepEqual(asm("let x = a and b\n"), [
      'LoadGlobal "a"', "Dup", "JumpIfFalseOrPop -> 5", "Pop", 'LoadGlobal "b"',
      'StoreGlobal "x"', "Pop", "Halt",
    ]);
  });

  it("short-circuits or", () => {
    assert.deepEqual(asm("let x = a or b\n"), [
      'LoadGlobal "a"', "Dup", "JumpIfTrueOrPop -> 5", "Pop", 'LoadGlobal "b"',
      'StoreGlobal "x"', "Pop", "Halt",
    ]);
  });

  it("branches for a ternary", () => {
    assert.deepEqual(asm("let x = c ? a : b\n"), [
      'LoadGlobal "c"', "JumpIfFalse -> 4", 'LoadGlobal "a"', "Jump -> 5",
      'LoadGlobal "b"', 'StoreGlobal "x"', "Pop", "Halt",
    ]);
  });

  it("uses Concat, not +, for interpolation", () => {
    assert.deepEqual(asm('let s = "a${1}b"\n'), [
      'const "a"', "const 1", 'const "b"', "concat 3", 'StoreGlobal "s"', "Pop", "Halt",
    ]);
  });

  it("keeps a plain string as one constant", () => {
    assert.deepEqual(asm('let s = "ab"\n'), ['const "ab"', 'StoreGlobal "s"', "Pop", "Halt"]);
  });
});

describe("assignment", () => {
  it("reads, combines and writes back for a compound assignment", () => {
    assert.deepEqual(asm("x += 1\n"), [
      'LoadGlobal "x"', "const 1", "bin +", 'StoreGlobal "x"', "Pop", "Halt",
    ]);
  });

  it("evaluates an index target once for a compound assignment", () => {
    // obj, index, index, old-value, rhs, bin, setindex -- the index expression
    // is emitted once and duplicated, never written out twice
    assert.deepEqual(asm("a[i] += 1\n"), [
      'LoadGlobal "a"', 'LoadGlobal "i"', "Dup", "GetIndex", "const 1", "bin +",
      "SetIndex", "Pop", "Halt",
    ]);
  });

  it("duplicates the value for a chained assignment", () => {
    // each store consumes its own copy, so the value survives to the last target
    assert.deepEqual(asm("a = b = 1\n"), [
      "const 1",
      "Dup",
      'StoreGlobal "a"',
      "Dup",
      'StoreGlobal "b"',
      "Pop",
      "Halt",
    ]);
  });
});

describe("functions and upvalues", () => {
  it("builds a closure and binds it", () => {
    assert.deepEqual(asm("def f():\n    pass\n"), ["closure f", 'StoreGlobal "f"', "Pop", "Halt"]);
  });

  it("calls a module-level function by global, callee first", () => {
    assert.deepEqual(fnAsm("def f(n):\n    return f(n - 1)\n", "f"), [
      'LoadGlobal "f"',
      "LoadLocal 0",
      "const 1",
      "bin -",
      "call 1",
      "Return",
      "const null",
      "Return",
    ]);
  });

  it("captures a local from one frame up", () => {
    const src = "def outer():\n    let n = 1\n    def inner():\n        return n\n    return inner\n";
    const inner = protoOf(src, "inner");
    assert.deepEqual(inner.upvalues, [{ kind: "parent-local", slot: 0 }]);
    // the trailing `const null; return` is the implicit end of a def body
    assert.deepEqual(disasm(build(src), () => inner), [
      "LoadUpval 0", "Return", "const null", "Return",
    ]);
  });

  it("chains upvalues through a third frame", () => {
    const src = [
      "def a():",
      "    let x = 1",
      "    def b():",
      "        def c():",
      "            return x",
      "        return c",
      "    return b",
    ].join("\n");
    const c = protoOf(src, "c");
    const b = protoOf(src, "b");
    // c reads x from b's upvalue, and b reads it from a's slot
    assert.deepEqual(c.upvalues, [{ kind: "parent-upvalue", index: 0 }]);
    assert.deepEqual(b.upvalues, [{ kind: "parent-local", slot: 0 }]);
  });

  it("lets a nested def see itself, for recursion", () => {
    const src = "def outer():\n    def fact(n):\n        return n < 2 ? 1 : n * fact(n - 1)\n    return fact\n";
    const fact = protoOf(src, "fact");
    // `fact` is bound in outer's scope before its body is compiled
    assert.deepEqual(fact.upvalues, [{ kind: "parent-local", slot: 0 }]);
  });

  it("does not treat an unknown name as an upvalue", () => {
    const f = protoOf("def f():\n    return missing\n", "f");
    assert.deepEqual(f.upvalues, []);
  });
});

describe("things that are not built yet", () => {
  it("says so for async, with a position", () => {
    for (const src of ["x = await f()\n", "x = spawn f()\n", "defer f()\n"]) {
      assert.throws(
        () => build(src),
        (e: L0pError) => {
          assert.match(e.message, /M7/);
          assert.equal(e.line, 1);
          return true;
        },
      );
    }
  });

  it("rejects a chained assignment to something that is not a name", () => {
    assert.throws(() => build("a[0] = b[1] = 1\n"), (e: L0pError) => /only names can be chained/.test(e.message));
  });
});
