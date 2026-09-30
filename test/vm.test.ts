import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { L0pError } from "../src/errors.ts";
import { Session } from "../src/session.ts";
import { repr, type Value } from "../src/vm/value.ts";
import { memFs } from "./helpers/memfs.ts";

/** Runs a program and returns what it printed, with the result appended. */
function run(src: string): { out: string[]; result: Value; globals: Map<string, Value> } {
  const out: string[] = [];
  const session = new Session(undefined, { print: (t) => out.push(t) });
  const r = session.runSource(src);
  return { out, result: r.result, globals: r.globals };
}

/** The value of a single expression, stringified for comparison. */
function value(src: string): string {
  const out: string[] = [];
  const session = new Session(undefined, { print: (t) => out.push(t) });
  const r = session.runSource(`let __v = ${src}`);
  return repr(r.globals.get("__v") as Value);
}

/**
 * Runs statements and returns whatever they left in `__r`.
 *
 * `value` cannot be used for anything multi-line: it wraps its argument in a
 * single assignment, and a program that ends in an `if` or a `for` has no last
 * expression to wrap.
 */
function block(body: string): string {
  const out: string[] = [];
  const session = new Session(undefined, { print: (t) => out.push(t) });
  const r = session.runSource(`var __r = null\n${body}\n__r`);
  return repr(r.globals.get("__r") as Value);
}

/** The value of a whole program, which is its last expression statement. */
function last(src: string): string {
  const out: string[] = [];
  const session = new Session(undefined, { print: (t) => out.push(t) });
  return repr(session.runSource(src).result);
}

function fails(src: string, pattern: RegExp): L0pError {
  try {
    run(src);
  } catch (e) {
    assert.ok(e instanceof L0pError, `expected L0pError, got ${String(e)}`);
    assert.match(e.message, pattern);
    return e;
  }
  throw new assert.AssertionError({ message: `expected a failure for:\n${src}` });
}

describe("arithmetic", () => {
  it("does the six operations", () => {
    assert.equal(value("1 + 2"), "3");
    assert.equal(value("7 - 2"), "5");
    assert.equal(value("3 * 4"), "12");
    assert.equal(value("7 / 2"), "3.5");
    assert.equal(value("7 // 2"), "3");
    assert.equal(value("7 % 3"), "1");
    assert.equal(value("2 ** 10"), "1024");
  });

  it("follows precedence", () => {
    assert.equal(value("1 + 2 * 3"), "7");
    assert.equal(value("(1 + 2) * 3"), "9");
  });

  it("divides by zero rather than producing infinity", () => {
    fails("1 / 0", /division by zero/);
    fails("1 % 0", /division by zero/);
  });

  it("rejects a non-number", () => {
    fails('"a" + 1', /\+ needs a number/);
    fails("[1] + 1", /\+ needs a number/);
  });

  it("concatenates two strings with +", () => {
    assert.equal(value('"a" + "b"'), '"ab"');
  });

  it("adds two lists", () => {
    assert.equal(value("[1] + [2]"), "[1, 2]");
  });

  it("does bitwise work on integers", () => {
    assert.equal(value("6 & 3"), "2");
    assert.equal(value("6 | 3"), "7");
    assert.equal(value("6 ^ 3"), "5");
    assert.equal(value("1 << 4"), "16");
    assert.equal(value("16 >> 2"), "4");
  });
});

describe("comparison and logic", () => {
  it("compares numbers and strings", () => {
    assert.equal(value("1 < 2"), "true");
    assert.equal(value('"a" < "b"'), "true");
    assert.equal(value("1 == 1.0"), "true");
  });

  it("compares lists structurally", () => {
    assert.equal(value("[1, 2] == [1, 2]"), "true");
    assert.equal(value("[1, 2] == [2, 1]"), "false");
  });

  it("short-circuits and", () => {
    assert.equal(value("false and 1 / 0 == 0"), "false");
    assert.equal(value("true or 1 / 0 == 0"), "true");
  });

  it("returns the operand, not a boolean, for and or", () => {
    assert.equal(value("1 and 2"), "2");
    assert.equal(value("0 or 7"), "7");
    assert.equal(value("null or \"x\""), '"x"');
  });

  it("treats emptiness as false", () => {
    assert.equal(value("not []"), "true");
    assert.equal(value('not ""'), "true");
    assert.equal(value("not 0"), "true");
    assert.equal(value("not [1]"), "false");
  });

  it("tests membership", () => {
    assert.equal(value("2 in [1, 2, 3]"), "true");
    assert.equal(value('"b" in "abc"'), "true");
    assert.equal(value("2 not in [1]"), "true");
    assert.equal(value('"a" in {"a": 1}'), "true");
  });

  it("compares only like with like", () => {
    fails("1 < \"a\"", /cannot compare/);
  });
});

describe("control flow", () => {
  it("takes a branch", () => {
    assert.equal(block("if 1 > 2:\n    __r = 10\nelse:\n    __r = 20"), "20");
    assert.equal(block("if 1 < 2:\n    __r = 10\nelse:\n    __r = 20"), "10");
  });

  it("leaves the value null without an else", () => {
    assert.equal(last("if false:\n    10"), "null");
  });

  it("chains else if", () => {
    const src = "if 1 == 2:\n    __r = 10\nelse if 1 == 1:\n    __r = 20\nelse:\n    __r = 30";
    assert.equal(block(src), "20");
  });

  it("loops with while", () => {
    assert.equal(last("var i = 0\nvar t = 0\nwhile i < 5:\n    t = t + i\n    i = i + 1\nt"), "10");
  });

  it("loops over a list, a string and a dict", () => {
    assert.equal(last("var t = 0\nfor x in [1, 2, 3]:\n    t = t + x\nt"), "6");
    assert.equal(last("var t = 0\nfor c in \"abc\":\n    t = t + 1\nt"), "3");
    assert.equal(last('var t = 0\nfor k in {"a": 1, "b": 2}:\n    t = t + 1\nt'), "2");
  });

  it("iterates a range with a step", () => {
    assert.equal(last("var t = 0\nfor i in range(0, 10, 3):\n    t = t + i\nt"), "18");
  });

  it("iterates a lazy range", () => {
    assert.equal(last("var t = 0\nfor i in range(10000):\n    t = t + 1\nt"), "10000");
  });

  it("honours break and continue", () => {
    assert.equal(last("var t = 0\nfor i in range(10):\n    if i == 3:\n        break\n    t = t + i\nt"), "3");
    assert.equal(last("var t = 0\nfor i in range(5):\n    if i % 2 == 0:\n        continue\n    t = t + i\nt"), "4");
  });

  it("leaves the loop variable behind, like a for at module level", () => {
    const { globals } = run("for i in range(3):\n    pass\n");
    assert.equal(globals.get("i"), 2);
  });

  it("chooses with a ternary", () => {
    assert.equal(last("1 < 2 ? \"yes\" : \"no\""), '"yes"');
  });
});

describe("functions", () => {
  it("calls with arguments and returns", () => {
    assert.equal(last("def add(a, b):\n    return a + b\nadd(2, 3)"), "5");
  });

  it("recurses", () => {
    const src = "def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\nfib(20)";
    assert.equal(last(src), "6765");
  });

  it("recurses as a nested def", () => {
    const src = "def outer():\n    def fact(n):\n        if n < 2:\n            return 1\n        return n * fact(n - 1)\n    return fact(5)\nouter()";
    assert.equal(last(src), "120");
  });

  it("returns null when it falls off the end", () => {
    assert.equal(last("def f():\n    pass\nf()"), "null");
  });

  it("uses a default only when the argument is missing", () => {
    const src = "def f(a, b = 5):\n    return a + b\n[f(1), f(1, 2)]";
    assert.equal(last(src), "[6, 3]");
  });

  it("makes a closure that outlives its frame", () => {
    const src = "def counter():\n    var n = 0\n    def inc():\n        n = n + 1\n        return n\n    return inc\nlet c = counter()\n[c(), c(), c()]";
    assert.equal(last(src), "[1, 2, 3]");
  });

  it("gives each call its own locals", () => {
    const src = "def make():\n    var n = 0\n    def inc():\n        n = n + 1\n        return n\n    return inc\nlet a = make()\nlet b = make()\n[a(), a(), b()]";
    assert.equal(last(src), "[1, 2, 1]");
  });

  it("does not let a recycled frame leak locals into the next call", () => {
    // frames come from a pool, so a slot the previous call left behind has to
    // be cleared -- otherwise the second call reads the first call's value.
    // Each call takes a different branch, so the slot is written in one and
    // read in the other.
    const src = [
      "def f(flag):",
      "    var seen = 0",
      "    if flag:",
      "        seen = 99",
      "    return seen",
      "[f(true), f(false)]",
    ].join("\n");
    assert.equal(last(src), "[99, 0]");
  });

  it("clears every slot a proto can reach, not just the ones written", () => {
    // a deeper call reuses the same slot for a different purpose
    const src = [
      "def inner(x):",
      "    var y = x * 2",
      "    return y",
      "def outer(n):",
      "    var a = inner(n)",
      "    return a + n",
      "[outer(3), outer(5)]",
    ].join("\n");
    assert.equal(last(src), "[9, 15]");
  });

  it("recycles frames without corrupting a live closure", () => {
    // the pool must not hand a captured frame to a later call, or these two
    // closures would end up sharing one counter
    const src = [
      "def make():",
      "    var n = 0",
      "    def get():",
      "        return n",
      "    def set(v):",
      "        n = v",
      "    return [get, set]",
      "let a = make()",
      "let b = make()",
      "a[1](1)",
      "b[1](2)",
      "[a[0](), b[0]()]",
    ].join("\n");
    assert.equal(last(src), "[1, 2]");
  });

  it("captures a variable two frames up", () => {
    const src = "def a():\n    var x = 1\n    def b():\n        def c():\n            x = x + 10\n            return x\n        return c()\n    return b()\na()";
    assert.equal(last(src), "11");
  });

  it("uses a lambda as a value", () => {
    assert.equal(last("let f = (a, b) -> a * b\nf(3, 4)"), "12");
  });

  it("passes a lambda a default only when it is missing", () => {
    assert.equal(last("let f = (a, b = 10) -> a + b\n[f(1), f(1, 2)]"), "[11, 3]");
  });

  it("reports a call of something that is not a function", () => {
    fails("let x = 1\nx()", /1 is not callable/);
  });
});

describe("bindings", () => {
  it("refuses to assign to a let", () => {
    fails("let x = 1\nx = 2", /cannot assign to x: it is immutable/);
  });

  it("refuses to assign to a const", () => {
    fails("const C = 1\nC = 2", /it is a constant/);
  });

  it("refuses to redefine a function", () => {
    fails("def f():\n    pass\nf = 1", /it is a function/);
  });

  it("allows a var", () => {
    assert.equal(last("var x = 1\nx = 2\nx"), "2");
  });

  it("refuses to assign to a let inside a function", () => {
    fails("def f():\n    let a = 1\n    a = 2\nf()", /cannot assign to slot 0: it is immutable/);
  });

  it("allows a var inside a function", () => {
    assert.equal(last("def f():\n    var a = 1\n    a = 2\n    return a\nf()"), "2");
  });

  it("reports a name that was never bound", () => {
    fails("print(nope)", /no such name: nope/);
  });
});

describe("collections", () => {
  it("builds and indexes a list", () => {
    assert.equal(block("let l = [10, 20, 30]\n__r = l[1]"), "20");
    assert.equal(block("let l = [10, 20]\n__r = l[-1]"), "20");
  });

  it("checks a list index", () => {
    fails("let l = [1]\nl[5]", /index out of range/);
    fails("let l = [1]\nl[7] = 2", /index out of range/);
  });

  it("builds and indexes a dict", () => {
    assert.equal(block('let m = {"a": 1, "b": 2}\n__r = m["b"]'), "2");
    assert.equal(block('let m = {"a": 1}\nm["z"] = 9\n__r = m["z"]'), "9");
  });

  it("reports a missing dict key rather than returning null", () => {
    fails('let m = {}\nm["nope"]', /key not found/);
  });

  it("uses a struct's fields", () => {
    const src = "struct P:\n    x = 1\n    y = 2\nlet p = P()\np.x = 10\n__r = [p.x, p.y]";
    assert.equal(block(src), "[10, 2]");
  });

  it("constructs a value with a constructor call", () => {
    const src = "struct P:\n    x = 1\n    y = 2\n__r = [P().x, P(9).x, P(9).y]";
    assert.equal(block(src), "[1, 9, 2]");
  });

  it("gives a field with no default null", () => {
    assert.equal(block("struct P:\n    a = 1\n    b\nlet p = P()\n__r = p.b"), "null");
  });

  it("keeps instances independent", () => {
    const src = "struct P:\n    x = 1\na = P()\na.x = 5\n__r = [P().x, a.x]";
    assert.equal(block(src), "[1, 5]");
  });

  it("names a missing field and lists the ones there are", () => {
    fails("struct P:\n    x = 1\nlet p = P()\np.z", /has no field z; it has x/);
  });

  it("does not let a struct be indexed", () => {
    fails("struct P:\n    x = 1\nlet p = P()\np[0]", /cannot index a P/);
  });

  it("reports too many arguments to a struct", () => {
    fails("struct P:\n    x = 1\nP(1, 2)", /takes at most 1 arguments, got 2/);
  });
});

describe("strings", () => {
  it("interpolates", () => {
    assert.equal(block('let n = "l0p"\n__r = "hello, ${n}! ${1 + 2}"'), '"hello, l0p! 3"');
  });

  it("interpolates a nested call", () => {
    assert.equal(value('"${len("abcd")}"'), '"4"');
  });

  it("keeps a string with no holes a plain constant", () => {
    assert.equal(value('"plain"'), '"plain"');
  });

  it("has methods", () => {
    assert.equal(value('"a,b".split(",")'), '["a", "b"]');
    assert.equal(value('"  x  ".strip()'), '"x"');
    assert.equal(value('"ab".repeat(3)'), '"ababab"');
    assert.equal(value('"abc".upper()'), '"ABC"');
  });

  it("has a list method", () => {
    assert.equal(block("let l = [1, 2]\nl.push(3)\n__r = l"), "[1, 2, 3]");
    assert.equal(block("let l = [1, 2, 3]\nl.pop()\n__r = l"), "[1, 2]");
  });

  it("has a dict method", () => {
    assert.equal(block('let m = {"a": 1}\n__r = m.len()'), "1");
    assert.equal(block('let m = {"a": 1, "b": 2}\n__r = m.keys()'), '["a", "b"]');
  });
});

describe("printing", () => {
  it("joins with a space", () => {
    assert.deepEqual(run('print("a", 1, true)').out, ["a 1 true"]);
  });

  it("prints a string bare and a list with quotes on its parts", () => {
    assert.deepEqual(run('print("hi", ["a"])').out, ['hi ["a"]']);
  });

  it("prints nothing extra for a null argument", () => {
    assert.deepEqual(run("print(null)").out, ["null"]);
  });
});

describe("recovery after a failure", () => {
  it("does not let one failure poison the next program", () => {
    const out: string[] = [];
    const session = new Session(undefined, { print: (t) => out.push(t) });
    assert.throws(() => session.runSource("let x = 1\nx = 2"), L0pError);
    session.runSource("print(1 + 1)");
    assert.deepEqual(out, ["2"]);
  });
});

describe("a session keeps state between runs", () => {
  function make(out: string[]): Session {
    return new Session(undefined, { print: (t) => out.push(t) });
  }

  it("remembers a name", () => {
    const s = make([]);
    s.runSource("let x = 10");
    assert.equal(repr(s.runSource("x").result), "10");
  });

  it("remembers a function that closes over an earlier name", () => {
    const s = make([]);
    s.runSource("let x = 10\ndef f(n):\n    return n * x");
    assert.equal(repr(s.runSource("f(3)").result), "30");
  });

  it("treats a later line as a new declaration, not a reassignment", () => {
    // the point of a prompt: re-entering `let x = 5` has to work
    const s = make([]);
    s.runSource("let x = 10");
    assert.doesNotThrow(() => s.runSource("let x = 5"));
    assert.equal(repr(s.runSource("x").result), "5");
  });

  it("still refuses to assign to a let within one input", () => {
    const s = make([]);
    assert.throws(() => s.runSource("let x = 1\nx = 2"), (e: L0pError) => /immutable/.test(e.message));
  });

  it("keeps the builtins available after a first run", () => {
    const out: string[] = [];
    const s = make(out);
    s.runSource("let x = 1");
    s.runSource('print("still here")');
    assert.deepEqual(out, ["still here"]);
  });

  it("starts clean after fresh", () => {
    const s = make([]);
    s.runSource("let x = 10");
    s.runSource("print(1)", "<repl>", null, true);
    assert.throws(() => s.runSource("x"), (e: L0pError) => /no such name/.test(e.message));
  });

  it("forgets names on clear", () => {
    const s = make([]);
    s.runSource("let x = 10");
    s.clear();
    assert.throws(() => s.runSource("x"), (e: L0pError) => /no such name/.test(e.message));
  });

  it("reports the names in scope", () => {
    const s = make([]);
    assert.equal(s.lastGlobals(), null);
    s.runSource("let x = 1");
    assert.equal(repr(s.lastGlobals()?.get("x") as Value), "1");
  });
});

describe("running a program from a file", () => {
  const TREE = {
    "/app/main.l0p": [
      "import helper",
      "import pkg.util as util",
      "import pkg.util as u2",
      "print(helper.twice(21))",
      "print(util.name, u2.name, u2.tag)",
      "print(__name__)",
    ].join("\n"),
    "/app/helper.l0p": "def twice(n):\n    return n * 2\nlet tag = 'h'\n",
    "/app/pkg/util.l0p": "let name = 'util'\nlet tag = 't'\n",
    "/app/pkg/": "",
    "/app/lib.l0p": "let shared = 1\n",
  };

  function session(): Session {
    return new Session(memFs(TREE), { print: () => {} });
  }

  it("imports a module and uses its names", () => {
    const out: string[] = [];
    const s = new Session(memFs(TREE), { print: (t) => out.push(t) });
    s.runFile("/app/main.l0p");
    assert.deepEqual(out, ["42", "util util t", "__main__"]);
  });

  it("binds the last segment, and the alias when there is one", () => {
    const out: string[] = [];
    const s = new Session(memFs(TREE), { print: (t) => out.push(t) });
    s.runFile("/app/main.l0p");
    // `import helper` binds the last segment, `as` overrides it
    assert.match(out[1] ?? "", /util util/);
  });

  it("exports a name only once the module has run", () => {
    const out: string[] = [];
    const fs = memFs({
      "/app/main.l0p": "from lib import shared\nprint(shared)",
      "/app/lib.l0p": "let shared = 99\n",
    });
    new Session(fs, { print: (t) => out.push(t) }).runFile("/app/main.l0p");
    assert.deepEqual(out, ["99"]);
  });

  it("names the entry point __main__", () => {
    const out: string[] = [];
    const fs = memFs({ "/app/main.l0p": "print(__name__)" });
    new Session(fs, { print: (t) => out.push(t) }).runFile("/app/main.l0p");
    assert.deepEqual(out, ["__main__"]);
  });

  it("gives an imported module its own __name__", () => {
    const out: string[] = [];
    const fs = memFs({
      "/app/main.l0p": "import m\nprint(m.__name__)",
      "/app/m.l0p": "let x = 1\n",
    });
    new Session(fs, { print: (t) => out.push(t) }).runFile("/app/main.l0p");
    assert.deepEqual(out, ["m"]);
  });

  it("runs a module once no matter how often it is imported", () => {
    const out: string[] = [];
    const fs = memFs({
      "/app/main.l0p": "import a\nimport a\nimport a\nprint(a.count)",
      "/app/a.l0p": "var count = 0\ncount = count + 1\n",
    });
    new Session(fs, { print: (t) => out.push(t) }).runFile("/app/main.l0p");
    assert.deepEqual(out, ["1"]);
  });

  it("resolves a relative import next to the importer", () => {
    const out: string[] = [];
    const fs = memFs({
      "/app/main.l0p": "from . import s\nprint(s.v)",
      "/app/s.l0p": "let v = 7\n",
    });
    new Session(fs, { print: (t) => out.push(t) }).runFile("/app/main.l0p");
    assert.deepEqual(out, ["7"]);
  });

  it("reports a missing module with where it looked", () => {
    assert.throws(
      () => session().runFile("/app/nope.l0p"),
      (e: L0pError) => /no such file/.test(e.message),
    );
  });
});
