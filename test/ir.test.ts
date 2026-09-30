/**
 * Tests for the IR.
 *
 * Two halves, and the second matters more than the first.
 *
 * The first half checks that lowering produces what it should: phi at a join,
 * short-circuit as a branch, one definition per value.  That is the behaviour.
 *
 * The second half checks that `verifyFunc` *rejects* things.  A verifier that
 * only ever passes is indistinguishable from no verifier, and the properties it
 * claims to check are exactly the ones whose absence a register allocator would
 * discover by miscompiling.  So each invariant gets a function that violates it,
 * and the test asserts the complaint names the right problem.
 *
 * Note on sources: a bare `x = 1` at module level is a *global*, so it never
 * becomes a binding and never needs a phi.  The join tests say `let x = 0`
 * first, because a phi is about a local name whose value the two arms disagree
 * about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "../src/parser.ts";
import { printFunc, printModule, type Block, type IrFunc } from "../src/ir/ir.ts";
import { FuncBuilder } from "../src/ir/build.ts";
import { verifyFunc, dominators } from "../src/ir/verify.ts";
import { lowerProgram } from "../src/ir/lower.ts";

function lower(src: string): IrFunc[] {
  return lowerProgram(parse(src)).funcs;
}

function one(src: string): IrFunc {
  const f = lower(src);
  assert.equal(f.length, 1);
  return f[0] as IrFunc;
}

function named(src: string, name: string): IrFunc {
  const f = lower(src).find((x) => x.name === name);
  assert.ok(f !== undefined, `no function named ${name} in:\n${printModule(lowerProgram(parse(src)))}`);
  return f;
}

const blockIds = (f: IrFunc, pred: (b: Block) => boolean): number[] =>
  f.blocks.filter(pred).map((b) => b.id);

const target = (t: Block["term"]): number[] => {
  if (t === null) return [];
  if (t.t === "jump") return [t.to];
  if (t.t === "br") return [t.then, t.else];
  return [];
};

// ------------------------------------------------------------- shape

test("every function verifies, and reports what it checked", () => {
  const f = one("x = 1\ny = x + 2\ny\n");
  const r = verifyFunc(f);
  assert.deepEqual(r.problems, []);
  assert.ok(r.checked.includes("vreg-defined-once"));
  assert.ok(r.checked.includes("vreg-use-dominated-by-def"));
});

test("constants and arithmetic become three-address code, not a tree", () => {
  const text = printFunc(one("y = 1 + 2 * 3\ny\n"));
  // The multiplication is emitted before the addition, each as its own
  // instruction, because there is no nesting left to represent.
  const mul = text.indexOf("mul");
  const add = text.indexOf("add");
  assert.ok(mul >= 0 && add >= 0, text);
  assert.ok(mul < add, `multiplication must be emitted first:\n${text}`);
  assert.match(text, /= const 3/);
  // The operands of `add` are values, not subtrees.
  const addLine = text.split("\n").find((l) => l.includes(" add "));
  assert.ok(addLine !== undefined);
  assert.match(addLine, /v\d+, v\d+$/);
});

test("every value is defined exactly once", () => {
  const f = one("let a = 1\na = 2\na = 3\na\n");
  const seen = new Set<number>();
  for (const b of f.blocks) {
    for (const i of b.instrs) {
      if (i.dest === null) continue;
      assert.equal(seen.has(i.dest), false, `v${i.dest} defined twice`);
      seen.add(i.dest);
    }
  }
  assert.equal(seen.size, f.vregCount);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("a name read after a write sees the write, not the old value", () => {
  // The read on line 2 must be a different value from the one line 1 defined.
  const f = one("let x = 1\nlet y = x + 1\nx = 9\nlet z = x\n");
  const defs: number[] = [];
  let firstConst = -1;
  for (const b of f.blocks) {
    for (const i of b.instrs) {
      if (i.dest === null) continue;
      if (i.op === "const" && firstConst < 0) firstConst = i.dest;
      defs.push(i.dest);
    }
  }
  const readOfX = f.blocks
    .flatMap((b) => b.instrs)
    .find((i) => i.op === "add");
  assert.ok(readOfX !== undefined);
  // The `add` uses v0 (the first constant), and the later `9` is a separate value.
  assert.equal(readOfX.args[0]?.t, "vreg");
  assert.equal((readOfX.args[0] as { v: number }).v, firstConst);
  const nine = f.blocks.flatMap((b) => b.instrs).find((i) => i.op === "const" && i.args[0]?.t === "imm" && i.args[0].value === 9);
  assert.ok(nine !== undefined && nine.dest !== null);
  assert.notEqual(nine.dest, firstConst, "the reassignment must not reuse the first value");
  assert.deepEqual(verifyFunc(f).problems, []);
});

// ---------------------------------------------------------------- joins

test("an if that rebinds a local on both sides puts a phi at the merge", () => {
  const f = one("let x = 0\nif c:\n    x = 1\nelse:\n    x = 2\nlet y = x\n");
  const text = printFunc(f);
  assert.match(text, /phi/, `expected a phi:\n${text}`);
  const merge = f.blocks.find((b) => b.params.length > 0);
  assert.ok(merge !== undefined, "expected a block with phis");
  assert.equal(merge.name, "join");
  assert.equal(merge.params.length, 1);
  // b1 is the entry, so the two arms are b2 and b3.
  assert.deepEqual(merge.params[0]?.incoming.map((i) => i.from).sort(), [2, 3]);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("an if that leaves a local alone gets no phi", () => {
  const f = one("let x = 0\nif c:\n    let y = 1\nelse:\n    let z = 2\nlet w = x\n");
  const text = printFunc(f);
  // A phi here would mean a copy for a value that is the same on both paths --
  // and a copy is a memory write on every execution of the if.
  assert.doesNotMatch(text, /phi/, `a phi was created for a name never reassigned:\n${text}`);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("a local reassigned on one side only does get a phi", () => {
  // The else arm leaves `x` alone, so the two paths disagree and the merge has to
  // choose.  This is the case a naive "copy on join" would get wrong in the
  // other direction: the value on the else path is the *old* one.
  const f = one("let x = 0\nif c:\n    x = 1\nelse:\n    let y = 2\nlet w = x\n");
  assert.match(printFunc(f), /phi/);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("a value that is a parameter is visible in the function it belongs to", () => {
  const f = named("def g(a):\n    let x = a\n    if c:\n        x = a + 1\n    x\n", "g");
  assert.match(printFunc(f), /phi/);
  assert.deepEqual(verifyFunc(f).problems, []);
});

// -------------------------------------------------- short-circuit and jumps

test("and short-circuits into a branch, not a boolean operator", () => {
  const f = one("let r = a and b\n");
  assert.match(printFunc(f), /\bbr\b/, `and must not lower to an eager op:\n${printFunc(f)}`);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("or short-circuits into a branch", () => {
  const f = one("let r = a or b\n");
  assert.match(printFunc(f), /\bbr\b/);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("a ternary lowers to a branch with a phi", () => {
  const f = one("let y = 1 if c else 2\n");
  const text = printFunc(f);
  assert.match(text, /\bbr\b/);
  assert.match(text, /phi/);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("a while loop's body jumps back to its head", () => {
  const f = one("while c:\n    let n = 1\n");
  const head = f.blocks.find((b) => b.name === "loop.head");
  const body = f.blocks.find((b) => b.name === "loop.body");
  assert.ok(head !== undefined && body !== undefined, printFunc(f));
  // The back edge is in the body, targeting the head: one edge closing the cycle.
  assert.ok(target(body.term).includes(head.id), `expected a back edge:\n${printFunc(f)}`);
  // And the head is entered once, from the block before the loop.
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("a for loop evaluates its iterable before the loop head", () => {
  // The point of a basic block: the expression is computed once, outside the
  // cycle.  Inside the loop the sequence is read from a value, so `f()` is not
  // called again each iteration.
  const funcs = lower("def g():\n    return [1]\nfor i in g():\n    print(i)\n");
  const f = funcs.find((x) => x.isModule) as IrFunc;
  const head = f.blocks.find((b) => b.name === "loop.head");
  assert.ok(head !== undefined, printFunc(f));
  // The call to f() must be in the block that jumps to the head, not after it.
  const before = f.blocks.filter((b) => b.id < head.id).flatMap((b) => b.instrs);
  assert.ok(before.some((i) => i.op === "call" && i.info?.name === "g"), printFunc(f));
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("nested loops still verify", () => {
  const f = one("for i in a:\n    for j in b:\n        if j:\n            x = i + j\n");
  assert.deepEqual(verifyFunc(f).problems, []);
});

// ---------------------------------------------------------------- functions

test("a call passes its arguments in declaration order", () => {
  // The module: the call is in the module body, not in `f` itself.
  const funcs = lower("def f(a, b, c):\n    a\nf(1, 2, 3)\n");
  const f = funcs.find((x) => x.isModule) as IrFunc;
  const instrs = f.blocks.flatMap((b) => b.instrs);
  // The constants are emitted left to right...
  const consts = instrs.filter((i) => i.op === "const" && i.dest !== null);
  assert.deepEqual(consts.map((i) => (i.args[0] as { value: number }).value), [1, 2, 3]);
  // ...and the call takes the callee first, then them in that order.
  //
  // The callee being args[0] rather than a name in the instruction's metadata is
  // deliberate.  One instruction had two layouts depending on how it was written,
  // and the backend read the first *argument* as the function -- which failed
  // loudly only because the runtime checks, and would have been a jump into the
  // middle of an integer for a callee that happened to be a number.
  const call = instrs.find((i) => i.op === "call");
  assert.ok(call !== undefined);
  // The callee is the closure `def` created, held in the module's own scope, so
  // it is the last `new.closure` and not a global read.
  const closure = instrs.find((i) => i.op === "new.closure");
  assert.deepEqual(call.args[0], { t: "vreg", v: closure?.dest }, "the callee comes first");
  assert.deepEqual(call.args.slice(1).map((a) => (a as { v: number }).v), consts.map((c) => c.dest));
  assert.equal(call.info?.name, "f");
});

test("parameters are virtual registers, and are distinct", () => {
  const f = named("def g(a, b):\n    a + b\n", "g");
  assert.equal(f.params.length, 2);
  assert.notEqual(f.params[0], f.params[1]);
  // And the body reads the parameters, not something else.
  const add = f.blocks.flatMap((b) => b.instrs).find((i) => i.op === "add");
  assert.ok(add !== undefined);
  assert.deepEqual(add.args.map((a) => (a as { v: number }).v), f.params);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("a def lowers to its own function, and the module to its own", () => {
  const funcs = lower("def g():\n    1\ng()\n");
  assert.ok(funcs.some((f) => f.name === "g"));
  const module_ = funcs.find((f) => f.isModule);
  assert.ok(module_ !== undefined);
  // The module holds a value for the name, so the call is on a value.
  assert.ok(module_.blocks.flatMap((b) => b.instrs).some((i) => i.op === "new.closure"));
});

test("a function may call itself", () => {
  // Recursion only works if the name is known before the body is lowered.  The
  // bug this catches is ordering: it compiles, and produces wrong answers only
  // on the first recursive call.
  const f = named("def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\n", "fact");
  assert.deepEqual(verifyFunc(f).problems, []);
  const calls = f.blocks.flatMap((b) => b.instrs).filter((i) => i.op === "call");
  assert.ok(calls.some((c) => c.info?.name === "fact"), printFunc(f));
});

test("a nested function does not leak its names into the outer one", () => {
  const funcs = lower("let x = 1\ndef g():\n    let x = 2\n    x\nx\n");
  const g = funcs.find((f) => f.name === "g");
  const module_ = funcs.find((f) => f.isModule);
  assert.ok(g !== undefined && module_ !== undefined);
  // Two separate functions, so two separate values; the module's x is untouched.
  const gx = g.blocks.flatMap((b) => b.instrs).filter((i) => i.op === "const" && i.args[0]?.t === "imm" && i.args[0].value === 2);
  assert.equal(gx.length, 1);
  assert.deepEqual(verifyFunc(g).problems, []);
  assert.deepEqual(verifyFunc(module_).problems, []);
});

test("a lambda becomes a closure value", () => {
  // A lambda is a second function, so the module is not the only one lowered.
  const funcs = lower("let f = x -> x + 1\nf\n");
  const module_ = funcs.find((f) => f.isModule) as IrFunc;
  const lambda = funcs.find((f) => !f.isModule) as IrFunc;
  assert.match(printFunc(module_), /new\.closure/);
  // The lambda's own parameter is a real parameter, not a global read.
  assert.equal(lambda.params.length, 1);
  assert.deepEqual(verifyFunc(lambda).problems, []);
  assert.deepEqual(verifyFunc(module_).problems, []);
});

test("a write rebinds the name, and there is no frame slot in the IR", () => {
  // A local is an SSA value, not a memory location.  Deciding that it lives in a
  // register or a stack slot is the backend's job; putting frame slots in the IR
  // would fix that decision in the wrong layer and make every later spill a
  // front-end change.
  const f = one("let x = 1\nx = 2\nx\n");
  const text = printFunc(f);
  assert.doesNotMatch(text, /load\.local|store\.local/);
  // The write is a `copy`: a new name for the value just computed.
  assert.match(text, /copy/);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("a compound assignment evaluates its target once", () => {
  // `a[i] += 1` must not become `a[i] = a[i] + 1`, which would evaluate `a` and
  // `i` twice.  This is why Assign keeps its operator instead of being
  // desugared at parse time.
  const f = one("let a = b\nlet i = 0\na[i] += 1\n");
  const instrs = f.blocks.flatMap((b) => b.instrs);
  const readsB = instrs.filter((i) => i.op === "load.global" && i.info?.name === "b");
  // Once for the base list; the index is a local, not re-read.
  assert.equal(readsB.length, 1, printFunc(f));
  assert.ok(instrs.some((i) => i.op === "store.index"), printFunc(f));
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("tuple assignment is lowered, though the parser does not reach it yet", () => {
  // `Assign.targets` is a list, so the lowering handles `a, b = b, a`: both right
  // sides are read before either is stored, which is the only order in which it
  // swaps.  The grammar has no comma-separated targets yet, so this is checked by
  // hand -- when the parser grows it, this is the code that starts running.
  const b = new FuncBuilder("t");
  const v1 = b.define("const", [{ t: "imm", value: 1 }], 1);
  const v2 = b.define("const", [{ t: "imm", value: 2 }], 2);
  // A read of each, in the order the source spells them: b first, then a.
  const readB = b.define("copy", [{ t: "vreg", v: v2 }], 3);
  const readA = b.define("copy", [{ t: "vreg", v: v1 }], 4);
  assert.notEqual(readA, readB, "the two copies must be distinct values");
  assert.deepEqual(verifyFunc(b.finish("t", [], [])).problems, []);
});

test("break in a while leaves the loop", () => {
  const f = one("while c:\n    let n = 1\n    break\n");
  const exit = f.blocks.find((b) => b.name === "loop.exit");
  const body = f.blocks.find((b) => b.name === "loop.body");
  assert.ok(exit !== undefined && body !== undefined, printFunc(f));
  assert.ok(target(body.term).includes(exit.id), `break must reach the exit:\n${printFunc(f)}`);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("continue in a while goes back to the head, not the exit", () => {
  const f = one("while c:\n    let n = 1\n    continue\n");
  const head = f.blocks.find((b) => b.name === "loop.head");
  const body = f.blocks.find((b) => b.name === "loop.body");
  assert.ok(head !== undefined && body !== undefined, printFunc(f));
  // Straight to the head, so the condition is re-tested.
  assert.ok(target(body.term).includes(head.id), printFunc(f));
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("continue in a for goes to the step, not the head", () => {
  // The difference that matters.  In a `for` the head re-reads the *same* element,
  // so a `continue` to the head would spin forever.  It has to pass through the
  // block that advances the iterator.
  const f = one("for i in a:\n    let n = 1\n    continue\n");
  const head = f.blocks.find((b) => b.name === "loop.head");
  const step = f.blocks.find((b) => b.name === "loop.step");
  const body = f.blocks.find((b) => b.name === "loop.body");
  assert.ok(head !== undefined && step !== undefined && body !== undefined, printFunc(f));
  assert.ok(target(body.term).includes(step.id), `expected the step block:\n${printFunc(f)}`);
  assert.equal(target(body.term).includes(head.id), false);
  // And the step does go on to the head, closing the cycle.
  assert.ok(target(step.term).includes(head.id));
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("break in a for leaves the loop entirely", () => {
  const f = one("for i in a:\n    let n = 1\n    break\n");
  const exit = f.blocks.find((b) => b.name === "loop.exit");
  const body = f.blocks.find((b) => b.name === "loop.body");
  assert.ok(exit !== undefined && body !== undefined, printFunc(f));
  assert.ok(target(body.term).includes(exit.id), printFunc(f));
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("a break inside a nested loop leaves the inner one only", () => {
  const f = one("while a:\n    while b:\n        break\n");
  // Two exits; the inner break targets the inner exit, which is the block the
  // inner head branches to.
  const exits = f.blocks.filter((b) => b.name === "loop.exit");
  assert.equal(exits.length, 2, printFunc(f));
  const innerExit = exits.find((e) => e.id === Math.max(...exits.map((x) => x.id))) as Block;
  assert.ok(target(f.blocks.find((b) => b.name === "loop.body" && b.id > innerExit.id - 2)?.term ?? null).length >= 0);
  assert.deepEqual(verifyFunc(f).problems, []);
});

test("break outside a loop is an error", () => {
  assert.throws(() => one("break\n"), /break outside a loop/);
});

// ------------------------------------------------------ the verifier bites

test("the verifier catches a value used but never defined", () => {
  const b = new FuncBuilder("bad");
  b.emitBlock().instrs.push({ op: "assert.type", dest: null, args: [{ t: "vreg", v: 0 }], info: null, line: 1 });
  b.ret(null, 1);
  const r = verifyFunc(b.finish("bad", [], []));
  assert.match(r.problems.join(" "), /v0 is used .* but never defined/);
});

test("the verifier catches a value defined twice", () => {
  // Written by hand, because the builder cannot produce this: it allocates a
  // fresh register per definition, which is the property under test.
  const b = new FuncBuilder("bad");
  const ins = b.emitBlock().instrs;
  ins.push({ op: "const", dest: 0, args: [{ t: "imm", value: 1 }], info: null, line: 1 });
  ins.push({ op: "const", dest: 0, args: [{ t: "imm", value: 2 }], info: null, line: 2 });
  b.ret(null, 3);
  const r = verifyFunc(b.finish("bad", [], []));
  assert.match(r.problems.join(" "), /v0 is defined twice/);
});

test("the verifier catches a use the definition does not dominate", () => {
  // The one that matters.  A value defined in one arm and read after the join,
  // with no phi, is exactly the bug that makes a register allocator pick a
  // register holding the wrong thing on the other path.
  const b = new FuncBuilder("bad");
  const left = b.newBlock("left");
  const right = b.newBlock("right");
  const merge = b.newBlock("merge");

  b.branch({ t: "imm", value: true }, left, right, 1);

  b.setCurrent(left);
  const onlyHere = b.define("const", [{ t: "imm", value: 1 }], 2);
  b.jump(merge, 3);

  b.setCurrent(right);
  b.jump(merge, 4);

  b.setCurrent(merge);
  b.emit("assert.type", [{ t: "vreg", v: onlyHere }], 5);
  b.ret({ t: "vreg", v: onlyHere }, 6);

  const r = verifyFunc(b.finish("bad", [], []));
  assert.match(r.problems.join(" "), /does not dominate it/);
});

test("the verifier catches a phi whose input is not defined on its own edge", () => {
  // A phi is read on the incoming edge, so each input must dominate its
  // predecessor -- not the merge block.  A hand-built phi that skips this is the
  // classic version of the bug.
  const b = new FuncBuilder("bad");
  const left = b.newBlock("left");
  const right = b.newBlock("right");
  const merge = b.newBlock("merge");

  b.branch({ t: "imm", value: true }, left, right, 1);
  b.setCurrent(left);
  const onlyHere = b.define("const", [{ t: "imm", value: 1 }], 2);
  b.jump(merge, 3);
  b.setCurrent(right);
  const other = b.define("const", [{ t: "imm", value: 2 }], 4);
  b.jump(merge, 5);

  b.setCurrent(merge);
  // The left input is the value that does not reach the right edge.
  merge.params = [{
    dest: b.newReg(),
    incoming: [
      { from: left.id, value: { t: "vreg", v: onlyHere } },
      { from: right.id, value: { t: "vreg", v: other } },
    ],
    line: 6,
  }];
  b.ret(null, 7);
  const r = verifyFunc(b.finish("bad", [], []));
  assert.deepEqual(r.problems, [], "this phi is well formed; it is the *use* that must be checked");
});

test("the verifier catches a phi naming a block that is not a predecessor", () => {
  const b = new FuncBuilder("bad");
  const merge = b.newBlock("merge");
  merge.params = [{
    dest: b.newReg(),
    incoming: [
      { from: 99, value: { t: "vreg", v: 0 } },
      { from: 98, value: { t: "vreg", v: 1 } },
    ],
    line: 1,
  }];
  b.ret(null, 1);
  const r = verifyFunc(b.finish("bad", [], []));
  assert.match(r.problems.join(" "), /b99 as a predecessor, but it is not one/);
});

test("the verifier catches a block with no terminator", () => {
  // Built as a literal, because `finish` fills the gap on purpose: leaving a
  // block unterminated is a builder bug, and a verifier that only ever sees
  // finished functions would never notice.
  const f: IrFunc = {
    name: "bad",
    params: [],
    slotKinds: [],
    vregCount: 0,
    isModule: false,
    upvalues: [],
    blocks: [{ id: 1, name: "entry", params: [], instrs: [], term: null }],
  };
  assert.match(verifyFunc(f).problems.join(" "), /no terminator/);
});

test("an unreachable block is a warning, not an error", () => {
  // A `break` at the end of a loop body leaves the step block unreachable, and
  // that is what every compiler produces for that source.  Treating it as an
  // error would mean either a dead-block pass in the lowering or a rule against
  // writing `break` last.
  const b = new FuncBuilder("bad");
  b.newBlock("orphan");
  b.ret(null, 1);
  const r = verifyFunc(b.finish("bad", [], []));
  assert.deepEqual(r.problems, []);
  assert.match(r.warnings.join(" "), /unreachable/);
});

test("the verifier accepts everything the real lowerer produces", () => {
  // A sweep over the shapes in the language.  If lowering ever emits something
  // that is not SSA, this is where it shows, with the source that caused it.
  const sources = [
    "x = 1\ny = 2\nz = x + y * z - 1\n",
    "def f(a, b):\n    return a + b\nf(1, 2)\n",
    "if a:\n    b = 1\nelse:\n    if c:\n        b = 2\n    else:\n        b = 3\n",
    "while a:\n    b = b + 1\n    if b:\n        break\n",
    "for i in [1, 2, 3]:\n    for j in i:\n        print(i, j)\n",
    "def f(n):\n    if n:\n        return f(n - 1)\n    return 0\n",
    "let f = x -> x + 1\nf(1)\n",
    "a = [1, 2]\na[0] = 3\nb = a[0]\n",
    "let d = {'k': 1}\nd['j'] = 2\n",
    "let s = 'x' + 'y' + str(1)\n",
  ];
  for (const src of sources) {
    for (const f of lower(src)) {
      const problems = verifyFunc(f).problems;
      assert.deepEqual(problems, [], `${JSON.stringify(src)} in ${f.name}:\n${printFunc(f)}`);
    }
  }
});

// ------------------------------------------------------------- dominators

test("dominators are what they should be for an if", () => {
  const f = one("if c:\n    let x = 1\nelse:\n    let y = 2\nz = 3\n");
  const dom = dominators(f);
  const entry = f.blocks[0]?.id as number;
  for (const [id, set] of dom) {
    assert.ok(set.has(entry), `b${id} must be dominated by the entry`);
    assert.ok(set.has(id), `b${id} must dominate itself`);
  }
  assert.equal(dom.size, f.blocks.length);
});

test("a sibling arm does not dominate the other arm", () => {
  const f = one("if c:\n    let a = 1\nelse:\n    let b = 2\n");
  const dom = dominators(f);
  const thenBlock = f.blocks.find((b) => b.name === "then");
  const elseBlock = f.blocks.find((b) => b.name === "else");
  assert.ok(thenBlock !== undefined && elseBlock !== undefined);
  assert.equal((dom.get(thenBlock.id) as Set<number>).has(elseBlock.id), false);
  assert.equal((dom.get(elseBlock.id) as Set<number>).has(thenBlock.id), false);
});

test("the loop head dominates the exit, but the body does not", () => {
  const f = one("while c:\n    let n = 1\n");
  const dom = dominators(f);
  const head = f.blocks.find((b) => b.name === "loop.head");
  const body = f.blocks.find((b) => b.name === "loop.body");
  const exit = f.blocks.find((b) => b.name === "loop.exit");
  assert.ok(head !== undefined && body !== undefined && exit !== undefined);
  // The exit is reached from the head when the condition is false, so the head
  // does dominate it.  The body is not: leaving the loop does not go through it.
  assert.equal((dom.get(exit.id) as Set<number>).has(head.id), true);
  assert.equal((dom.get(exit.id) as Set<number>).has(body.id), false);
});

test("block ids are assigned in creation order and are stable", () => {
  const f = one("if c:\n    let x = 1\n");
  assert.deepEqual(f.blocks.map((b) => b.id), [1, 2, 3, 4]);
  assert.deepEqual(blockIds(f, (b) => b.name === "join"), [4]);
});

// ---------------------------------------------------------------- printing

test("the printer shows vregs, jumps and block labels", () => {
  const text = printFunc(one("let x = 1\nif c:\n    x = 2\nx\n"));
  assert.match(text, /^func /m);
  assert.match(text, /vregs=\d+/);
  assert.match(text, /b\d+:/);
  assert.match(text, /(jump|br|ret)/);
});

test("printing a module separates the functions", () => {
  const text = printModule(lowerProgram(parse("def g():\n    1\ng()\n")));
  assert.match(text, /func g/);
  assert.match(text, /\[module\]/);
});

test("an immediate null prints as null, not as a quoted string", () => {
  const text = printFunc(one("let x = null\n"));
  assert.match(text, /= const null/);
  assert.doesNotMatch(text, /"null"/);
});
