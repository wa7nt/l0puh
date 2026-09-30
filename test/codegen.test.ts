/**
 * M13: the native backend.
 *
 * These compile l0puh to machine code, run it, and compare the answer with the
 * interpreter's.  The interpreter is the oracle throughout -- not a set of
 * expected values typed in by hand, because a literal in a test is a belief
 * about what the program should do, and this project's whole risk is that the
 * native and interpreted versions disagree without either being obviously wrong.
 *
 * Every test here builds a real executable.  Nothing is mocked, and a wrong
 * calling convention does not fail an assertion about assembly text -- it produces
 * a wrong number, which is the failure mode that actually happens.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildNative, toolchain } from "../src/rt/build.ts";
import { Session } from "../src/session.ts";
import { CodegenError, compileModule } from "../src/ir/codegen.ts";
import { lowerProgram } from "../src/ir/lower.ts";
import { verifyModule } from "../src/ir/verify.ts";
import { parse } from "../src/parser.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where the tests drop a program for the interpreter to run. */
const PRINTED = join(tmpdir(), "l0p-codegen-test.l0p");

const haveCc = ((): boolean => {
  try {
    toolchain();
    return true;
  } catch {
    return false;
  }
})();

const SKIP = haveCc ? false : "no C compiler on this machine";

/** Compile both ways and require identical output. */
function agreeOut(source: string): void {
  writeFileSync(PRINTED, source);
  const vm = execFileSync(process.execPath, ["src/cli/main.ts", "run", PRINTED], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  const built = buildNative(source, PRINTED);
  const nat = execFileSync(built.binary, { encoding: "utf8" });
  assert.equal(nat, vm, `disagree on:\n${source}`);
};



/** What the interpreter says a program is worth. */
function interpreted(source: string): string {
  const session = new Session();
  const r = session.runSource(source, "test.l0p");
  if (r.result === null || r.result === undefined) return "";
  return String(r.result);
}

/** What the native build says, by building and running it. */
function native(source: string, filename = "test.l0p"): string {
  const built = buildNative(source, filename);
  return execFileSync(built.binary, { encoding: "utf8" }).trim();
}

/** The two, which is the only comparison that means anything. */
function agree(source: string, filename = "test.l0p"): string {
  const got = native(source, filename);
  const want = interpreted(source);
  assert.equal(got, want, `native and interpreter disagree on:\n${source}`);
  return got;
}

// ------------------------------------------------------------------ basics

describe("the native backend", { skip: SKIP }, () => {
  it("computes arithmetic", () => {
    assert.equal(agree("1 + 2"), "3");
    assert.equal(agree("2 * 3 + 4"), "10");
    assert.equal(agree("(2 + 3) * 4"), "20");
    assert.equal(agree("7 // 2"), "3");
    assert.equal(agree("7 % 2"), "1");
    assert.equal(agree("2 ** 10"), "1024");
  });

  it("computes negative arithmetic, where the signs are easy to get wrong", () => {
    assert.equal(agree("-7 // 2"), "-4");
    assert.equal(agree("7 // -2"), "-4");
    assert.equal(agree("-7 % 2"), "-1");
    assert.equal(agree("7 % -2"), "1");
  });

  it("computes with integers up to what the interpreter can hold", () => {
    /*
     * The comparison stops at 2^53, and not as a matter of caution.
     *
     * The interpreter holds numbers in a double, so from 2^53 upward it stops
     * being exact -- `2^53 + 1` comes back as `2^53` there.  The native backend
     * has 64-bit integers and answers `2^53 + 1` correctly, which means the two
     * genuinely disagree above that point and the native one is right.
     *
     * That is worth stating rather than papering over: the interpreter is the
     * oracle everywhere else, and past 2^53 it is the thing that is wrong.
     */
    assert.equal(agree("9007199254740990 + 1"), "9007199254740991");
    assert.equal(agree("12345678 * 87654321"), "1082152022374638");
    assert.equal(agree("4294967296 * 1048576"), "4503599627370496");
  });

  it("compares and branches", () => {
    assert.equal(agree("1 if 3 < 7 else 2"), "1");
    assert.equal(agree("1 if 7 < 3 else 2"), "2");
    assert.equal(agree("1 if 3 <= 3 else 2"), "1");
    assert.equal(agree("1 if 3 > 7 else 2"), "2");
    assert.equal(agree("1 if 3 >= 3 else 2"), "1");
  });

  it("treats falsiness the way the interpreter does", () => {
    /*
     * A branch cannot test the tag against zero.  `false` is tag 1 and `null` is
     * tag 0, so a zero test takes the true branch on a false condition -- and 0,
     * 0.0 and the empty string are all false here as well.  Every one of these
     * cases is a loop that would never end or a guard that would never fire.
     */
    assert.equal(agree("1 if false else 2"), "2");
    assert.equal(agree("1 if true else 2"), "1");
    assert.equal(agree("1 if null else 2"), "2");
    assert.equal(agree("1 if 0 else 2"), "2");
    assert.equal(agree("1 if 0.0 else 2"), "2");
    assert.equal(agree("1 if 1 else 2"), "1");
  });

  it("compares equality", () => {
    assert.equal(agree("1 if 3 == 3 else 2"), "1");
    assert.equal(agree("1 if 3 == 4 else 2"), "2");
  });

  it("calls a function and returns its value", () => {
    assert.equal(agree("def f(n):\n    return n + 1\nf(41)"), "42");
  });

  it("passes several arguments in order", () => {
    // The weights are 1, 2, 3 rather than 1, 2, 4, so a swapped pair changes the
    // answer instead of coinciding.
    assert.equal(agree("def f(a, b, c):\n    return a * 100 + b * 10 + c\nf(1, 2, 3)"), "123");
    assert.equal(agree("def f(a, b, c):\n    return a * 100 + b * 10 + c\nf(3, 2, 1)"), "321");
  });

  it("passes more than six arguments", () => {
    /*
     * Past six, arguments stop being registers and go on the stack, and the
     * callee has to find them in the right place.  This is the case where an
     * off-by-eight in the frame produces garbage rather than a crash.
     */
    const src = "def f(a, b, c, d, e, g, h, i, j):\n    return a + b + c + d + e + g + h + i + j\nf(1, 2, 3, 4, 5, 6, 7, 8, 9)";
    assert.equal(agree(src), "45");
  });

  it("recurses", () => {
    const fib = "def f(n):\n    if n < 2:\n        return n\n    return f(n - 1) + f(n - 2)\n";
    assert.equal(agree(`${fib}f(10)`), "55");
    assert.equal(agree(`${fib}f(20)`), "6765");
  });

  it("runs a while loop", () => {
    // A loop needs only arithmetic, a branch and a phi, all of which are here.
    // This is the case that catches a branch testing the wrong field: `while`
    // with a false condition that reads as true never terminates.
    const src = "i = 0\ntotal = 0\nwhile i < 5:\n    total = total + i\n    i = i + 1\ntotal";
    assert.equal(agree(src), "10");
  });

  it("runs a nested while loop", () => {
    const src = "t = 0\ni = 0\nwhile i < 3:\n    j = 0\n    while j < 3:\n        t = t + 1\n        j = j + 1\n    i = i + 1\nt";
    assert.equal(agree(src), "9");
  });



  it("nests calls and arithmetic", () => {
    const src = "def sq(n):\n    return n * n\nsq(3) + sq(4)";
    assert.equal(agree(src), "25");
  });

  it("keeps a value across a join", () => {
    // Exercises a phi: the two arms disagree and the value is read after the if.
    const src = "def pick(c):\n    if c:\n        x = 10\n    else:\n        x = 20\n    return x\n";
    assert.equal(agree(`${src}pick(1)`), "10");
    assert.equal(agree(`${src}pick(0)`), "20");
  });

  it("swaps two phi values without either ending up with the same one", () => {
    // A phi copy that reads and writes in the same pass destroys the other
    // phi's input.  The result is two variables holding the same value, which is
    // a plausible wrong answer rather than a crash.
    const src = "def swap(c):\n    a = 1\n    b = 2\n    if c:\n        a = 2\n        b = 1\n    return a * 10 + b\n";
    assert.equal(agree(`${src}swap(1)`), "21");
    assert.equal(agree(`${src}swap(0)`), "12");
  });

  it("carries a parameter through a loop-free function", () => {
    const src = "def add3(a, b, c):\n    return a + b + c\nadd3(1, 2, 3)";
    assert.equal(agree(src), "6");
  });
});

// -------------------------------------------------- refusing to compile

describe("the native backend refuses what it cannot do", { skip: SKIP }, () => {
  const refuses = (source: string, pattern: RegExp): void => {
    const module = lowerProgram(parse(source), "t.l0p");
    assert.deepEqual(verifyModule(module.funcs).problems, [], "the IR itself should be valid");
    assert.throws(() => compileModule(module), pattern);
  };

  it("refuses a program it cannot lower, naming what is missing", () => {
    // `spawn` has no native implementation yet.  The point is not that it fails
    // -- it is that it fails *here*, with a line, rather than producing assembly
    // that assembles and then does the wrong thing at run time.
    const module = lowerProgram(parse("spawn f()\n"), "t.l0p");
    assert.deepEqual(verifyModule(module.funcs).problems, [], "the IR itself should be valid");
    assert.throws(() => compileModule(module), /cannot yet lower|no global|callable/);
  });

  it("puts every string literal in one deduplicated table", () => {
    /*
     * Interning matters for more than size: two separately-allocated copies of
     * the same text would have to be compared by content, and interning makes it
     * a pointer comparison.
     */
    const asm = compileModule(lowerProgram(parse("x = 'same'\ny = 'same'\nz = 'other'\n"), "t.l0p"));
    const labels = asm.match(/^\.Lstr\d+:/gm) ?? [];
    assert.equal(labels.length, 2, asm);
    assert.equal(asm.match(/\.asciz "same"/g)?.length, 1);
  });

  it("rejects a global it has never heard of, rather than reading a wild address", () => {
    const module = lowerProgram(parse("def f():\n    return g\n"), "t.l0p");
    assert.throws(() => compileModule(module), /global/);
  });

  it("reports a compile error as a CodegenError with a line", () => {
    try {
      compileModule(lowerProgram(parse("1 + 1\nzz[0]"), "t.l0p"));
      assert.fail("should not have compiled");
    } catch (e) {
      assert.ok(e instanceof CodegenError, `unexpected: ${e}`);
      // The line is the one that has the bad instruction, not the first line of
      // the program: a build error reported against the wrong line sends whoever
      // is fixing it to the wrong place.
      assert.equal((e as CodegenError).line, 2);
    }
  });
});

// ------------------------------------------------------- the emitted text

describe("the emitted assembly", () => { it("is readable, and says what it is", () => {
  const asm = compileModule(lowerProgram(parse("1 + 2"), "t.l0p"));
  // A disassembly nobody can read is not a debugging aid.  The first line should
  // be a comment explaining the strategy, not a bare instruction.
  assert.match(asm, /^# Generated by the l0puh native backend/);
  assert.match(asm, /stack slot/);
  assert.match(asm, /_l0p_fn_0/);
});

  it("labels every block, so a disassembly can be followed", () => {
    const asm = compileModule(lowerProgram(parse("if 1 < 2:\n    x = 1\nelse:\n    x = 2\nx\n"), "t.l0p"));
    const labels = asm.match(/\.L_l0p_fn_\d+_b\d+:/g) ?? [];
    assert.ok(labels.length >= 4, `expected four blocks:\n${asm}`);
  });

  it("keeps the frame pointer, which is what makes a traceback possible", () => {
    const asm = compileModule(lowerProgram(parse("1 + 2"), "t.l0p"));
    assert.match(asm, /pushq %rbp/);
    assert.match(asm, /movq %rsp, %rbp/);
  });

  it("spills the incoming registers rather than reading above the frame", () => {
    /*
     * 8(%rbp) is the return address and everything above it is the caller's
     * data, so a parameter read from there is the caller's leftover.  It compiles,
     * it runs, and it computes with the wrong number.
     */
    const asm = compileModule(lowerProgram(parse("def f(a):\n    a + 1\nf(1)\n"), "t.l0p"));
    const body = asm.slice(asm.indexOf("_l0p_fn_1:"));
    assert.match(body, /movq %rdi,/);
    assert.match(body, /movq %rdx,/);
    assert.doesNotMatch(body, /movq 32\(%rbp\)/);
  });

  it("writes the result through the return pointer", () => {
    const asm = compileModule(lowerProgram(parse("def f():\n    1\nf()\n"), "t.l0p"));
    const body = asm.slice(asm.indexOf("_l0p_fn_1:"));
    assert.match(body, /\(%r10\)/, "the result must go through the saved ret pointer");
  });
});

/*
 * The M14 surface: lists, strings, dictionaries and the built-ins.
 *
 * These are compared the same way as everything above -- against the interpreter,
 * by running both and comparing what they wrote.  `print` is used throughout so
 * that the comparison is of output rather than of a returned value, which keeps
 * the two sides measured the same way.
 */
describe("the native backend on lists and strings", { skip: SKIP }, () => {

  it("prints strings, including non-ASCII ones", () => {
    agreeOut('print("привет")');
    agreeOut('print("日本語")');
  });

  it("measures strings in characters, not bytes", () => {
    /*
     * `len("привет")` is 6 in this language, and the runtime stores strings as
     * bytes, where it is 12.  Counting bytes would make the native backend
     * disagree with the interpreter on every non-ASCII string -- and would look
     * like a bug in whichever side was wrong.
     */
    agreeOut('print(len("привет"))');
    agreeOut('print(len("ab"))');
    assert.equal(agree('x = "привет"\nlen(x)'), "6");
  });

  it("indexes a string by character", () => {
    agreeOut('print("привет"[0])');
    agreeOut('print("привет"[5])');
  });

  it("concatenates strings with +", () => {
    agreeOut('s = "a" + "b"\nprint(s)');
    agreeOut('print("x" + "y" + "z")');
  });

  it("interpolates into a string", () => {
    agreeOut('n = 7\nprint("n is " + str(n))');
  });

  it("builds a list", () => {
    agreeOut('print([1, 2, 3])');
    agreeOut('print(len([1, 2, 3]))');
  });

  it("reads and writes a list index", () => {
    agreeOut("a = [1, 2, 3]\nprint(a[0])\nprint(a[2])");
    agreeOut("a = [1, 2, 3]\na[1] = 9\nprint(a[1])");
  });

  it("runs a for loop over a list", () => {
    agreeOut("for x in [1, 2, 3]:\n    print(x)");
    agreeOut("t = 0\nfor x in [1, 2, 3]:\n    t = t + x\nprint(t)");
  });

  it("runs nested for loops", () => {
    agreeOut("for i in [1, 2]:\n    for j in [3, 4]:\n        print(i * j)");
  });

  it("breaks out of a for loop", () => {
    agreeOut("for x in [1, 2, 3, 4]:\n    if x == 3:\n        break\n    print(x)");
  });

  it("continues a for loop", () => {
    agreeOut("for x in [1, 2, 3, 4]:\n    if x == 2:\n        continue\n    print(x)");
  });

  it("builds and reads a dictionary", () => {
    agreeOut('d = {"k": 1}\nprint(d["k"])');
    agreeOut('d = {"a": 1, "b": 2}\nprint(d["a"])');
  });

  it("computes with floats", () => {
    agreeOut("print(1.5 + 1)");
    agreeOut("print(0.1 + 0.2)");
    agreeOut("print(7.0 / 2.0)");
    /*
     * The literal's bits have to survive the trip to the machine.  As a JavaScript
     * number a 64-bit pattern above 2^53 loses its low bits, and every double
     * with a large exponent has one -- `1.5` came out as a slightly different
     * double and added up to 1.
     */
    assert.equal(agree("1.5 + 1.5"), "3");
  });

  it("converts between types", () => {
    agreeOut("print(str(42))");
    agreeOut("print(int(\"7\") + 1)");
    agreeOut("print(float(\"1.5\") + 1.0)");
    agreeOut("print(bool(0))");
    agreeOut("print(type(1))");
    agreeOut("print(type(1.5))");
    agreeOut("print(type(\"s\"))");
  });

  it("stops on a conversion that makes no sense", () => {
    // A zero here would be a plausible integer that is simply wrong, and the
    // program would carry on with it.
    const src = 'print(int("not a number"))';
    const built = buildNative(src, "t.l0p");
    assert.throws(() => execFileSync(built.binary, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  });

  it("reports an unknown function at compile time, with its name", () => {
    // Not a build failure in the runtime saying "no such built-in", which arrives
    // with no file and no line.
    assert.throws(() => buildNative("nosuch(1)\n", "t.l0p"), /no such function: nosuch/);
  });
});

describe("arithmetic refuses what the interpreter refuses", { skip: SKIP }, () => {
  /*
   * The strictness is the point.
   *
   * A lenient conversion turns `"a" * 2` into 0 and `true + 1` into 2 -- both
   * plausible numbers, both wrong, and neither pointing at the mistake.  The
   * interpreter raises, so the runtime has to as well, or the two disagree on a
   * program that runs cleanly on both sides.
   */
  const bothFail = (source: string): void => {
    writeFileSync(PRINTED, source);
    assert.throws(() => execFileSync(process.execPath, ["src/cli/main.ts", "run", PRINTED], {
      encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    }), `the interpreter should refuse ${source}`);
    const built = buildNative(source, PRINTED);
    assert.throws(() => execFileSync(built.binary, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }), `the native build should refuse ${source}`);
  };

  it("refuses a string where a number is needed", () => {
    bothFail('"a" + 1');
    bothFail('"a" * 2');
    bothFail('"a" - 1');
  });

  it("refuses a boolean or null where a number is needed", () => {
    bothFail("true + 1");
    bothFail("null + 1");
  });

  it("converts numbers and numeric strings, and refuses the rest", () => {
    agreeOut("print(float(1) + 1.0)");
    agreeOut("print(int(1.5))");
    agreeOut("print(int(\"7\") + 1)");
    agreeOut("print(float(\"1.5\") + 1.0)");
    // `int(true)` is refused by both, and `bool()` is the way to ask.
    bothFail("int(true)");
    bothFail("float(null)");
  });
});
