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

/*
 * M15: integer arithmetic inlined behind a tag check.
 *
 * The point of the shape is that it assumes nothing.  Each test costs one
 * instruction and one branch; the call it replaces costs a frame and a return.
 * On anything the fast path cannot handle -- a float, a string, an integer that
 * leaves int64 -- it falls through to the same runtime helper it always did, so
 * the answer is the answer it was.
 */
describe("inlined integer arithmetic", { skip: SKIP }, () => {
  it("computes without a call when both operands are integers", () => {
    const asm = compileModule(lowerProgram(parse("def f(a, b):\n    a + b\nf(1, 2)\n"), "t.l0p"));
    const body = asm.slice(asm.indexOf("_l0p_fn_1:"));
    // The call still exists -- on the slow path.  What must not exist is a path
    // that *only* calls.
    assert.match(body, /# add, /);
    assert.match(body, /addq/);
    assert.match(body, /callq _l0p_add/);
    assert.match(body, /jne \.L/);
  });

  it("checks the overflow flag, so int64 arithmetic cannot wrap silently", () => {
    /*
     * This branch is the whole reason the inline path is safe.  `l0p_add` widens
     * to a double when the sum leaves int64; a bare `addq` wraps to a negative
     * number that is a perfectly plausible int64 and completely wrong.  The
     * `jo` is what makes the two agree.
     */
    const add = compileModule(lowerProgram(parse("let x = 1\nlet y = 2\nx + y\n"), "t.l0p"));
    assert.match(add, /addq[^\n]*\n\s*jo \.L/, "add must branch on overflow");
    const mul = compileModule(lowerProgram(parse("let x = 2\nlet y = 3\nx * y\n"), "t.l0p"));
    assert.match(mul, /imulq[^\n]*\n\s*jo \.L/, "mul must branch on overflow");
  });

  it("does not need an overflow branch for subtraction", () => {
    // The difference between two int64 values always fits in an int64.
    const asm = compileModule(lowerProgram(parse("let x = 5\nlet y = 2\nx - y\n"), "t.l0p"));
    const line = asm.slice(asm.indexOf("# sub, inline"));
    assert.doesNotMatch(line.slice(0, 400), /\bjo\b/);
  });

  it("agrees with the interpreter on results that overflow int64", () => {
    /*
     * Values chosen so that both sides are exact int64 operands: a literal is
     * read as a double, so `9223372036854775807` is not expressible and rounds
     * to 2^63.  2^62 is the largest power of two that survives, and doubling it
     * is the smallest overflow worth testing.
     */
    const e = 4611686018427387904;
    for (const src of [
      `${e} * 2`, `${e} + ${e}`, `${e} * 4`, `${e} * ${e}`,
      "3037000500 * 3037000500", "9007199254740991 * 2",
    ]) {
      agreeOut(`print(${src})`);
    }
  });

  it("treats a whole literal too large for int64 as a float", () => {
    /*
     * `Number.isInteger(2**63)` is true -- a double is a whole number long before
     * it is a machine integer -- so the natural range check lets it through and
     * the literal gets tagged INT with its payload truncated to 64 bits.  As a bit
     * pattern 2^63 is INT64_MIN, so `9223372036854775807` became a large negative
     * number and everything computed from it was wrong.
     */
    const asm = compileModule(lowerProgram(parse("x = 9223372036854775807\nx"), "t.l0p"));
    // Tag 4 is float; tag 3 would mean the truncated integer.
    assert.match(asm, /movq \$4,/);
    assert.doesNotMatch(asm, /movq \$3,/);
  });

  it("formats a double the way the interpreter does", () => {
    /*
     * `%g` switches to exponential whenever it saves a character, so 2^63 printed
     * as `9.223372036854776e+18` where the interpreter prints
     * `9223372036854776000`.  The same double, and two different answers to
     * `print` -- which every differential test over floating point would blame on
     * the compiler.
     */
    agreeOut("print(9223372036854775808.0)");
    agreeOut("print(0.1 + 0.2)");
    agreeOut("print(1e21)");
    agreeOut("print(1e-7)");
    agreeOut("print(1e-6)");
    agreeOut("print(3.141592653589793)");
    agreeOut("print(12345.6789)");
  });
});

/*
 * How a number is named.
 *
 * The interpreter has one numeric type -- a double -- and decides `int` from the
 * value, with `Number.isInteger`.  It has no separate float type for literals:
 * `type(100.0)` is `int` and `type(7 / 2)` is `float`.  So the question "int or
 * float?" is about the number, never about how it happens to be stored, and any
 * backend that answers it from a tag is answering a different question.
 */
describe("int and float are properties of the value", { skip: SKIP }, () => {
  it("names a whole number an int however it was written", () => {
    agreeOut("print(type(100.0))");      // a float literal, but a whole number
    agreeOut("print(type(1e6))");
    agreeOut("print(type(10 ** 18))");
  });

  it("names a number wider than int64 an int, because it is whole", () => {
    /*
     * 1e20 and 1e21 exceed int64, so the literal cannot be tagged INT and has to
     * be stored as a double.  The tag says `float`; the value has no fractional
     * part, and the interpreter answers `int`.  Asking about the value is what
     * closes the gap.
     */
    agreeOut("print(type(1e20))");
    agreeOut("print(type(1e21))");
  });

  it("names a number with a fractional part a float", () => {
    agreeOut("print(type(7 / 2))");
    agreeOut("print(type(7 - 0.5))");
    agreeOut("print(type(2 ** 0.5))");
    agreeOut("print(type(1e15 + 0.5))");
  });

  it("calls an exact division by -1 an int", () => {
    /*
     * `b != -1` guarded `l0p_div` against INT64_MIN / -1, which traps.  It also
     * excluded the ordinary `6 / -1`, which is exact and safe, and answered
     * `float` -- a float holding a whole number.  The guard had to name the pair
     * that actually traps, not every divisor of -1.
     */
    agreeOut("print(type(6 / -1))");
    agreeOut("print(type(6 / 2))");
    agreeOut("print(type(6 / -2))");
    agreeOut("print(6 / -1)");
  });
});

/*
 * The three operators that divide.
 *
 * These were inlined and are not any more, which is worth recording.
 *
 * `add` and `mul` inline profitably: the call they replace costs a frame and a
 * return, and the guard costs two instructions.  Division looked the same and is
 * not.  x86's `idiv` raises #DE on a zero divisor and on INT64_MIN / -1, and #DE
 * is not catchable -- it ends the process with SIGFPE, so the program dies having
 * printed nothing.  Guarding both costs four more branches, and across seven code
 * alignments the inline version was slower in all seven: 276ms against 348ms on
 * one `//` per iteration.  `%` alone lost as well, at 422 against 468.
 *
 * So the helpers keep the job.  What the attempt leaves behind is the part that
 * has to survive either way: both traps stay handled, and only INT64_MIN / -1 is
 * a trap -- `a / -1` is an ordinary expression and must not be guarded away.
 */
describe("division, through the runtime", { skip: SKIP }, () => {
  it("truncates toward zero, floors, and takes the sign of the dividend", () => {
    // `/` truncates, `//` floors, `%` takes the sign of the dividend.  All three
    // differ from one another on negatives, which is where a shortcut is most
    // likely to pick the wrong one quietly.
    for (const e of [
      "6 / 2", "7 / 2", "-7 / 2", "7 / -2", "-7 / -2", "6 / -1", "0 / 5",
      "6 // 4", "7 // 2", "-7 // 2", "7 // -2", "-7 // -2", "-6 // 4", "6 // -4",
      "6 % 4", "7 % 2", "-7 % 2", "7 % -2", "-7 % -2", "6 % -4", "-6 % 4", "7 % -4",
      "2.5 / 0.5", "7 / 2.0", "1 / 3",
    ]) agreeOut(`print(${e})`);
  });

  it("survives the one pair that traps", () => {
    /*
     * INT64_MIN / -1 is a real division with no int64 answer: the quotient is
     * 2^63.  `idiv` raises #DE rather than returning it, so the helper notices
     * and widens.  `INT64_MIN % -1` traps too, though the remainder is defined
     * and is zero.  If either check went missing the process would take SIGFPE
     * and print nothing at all.
     */
    for (const e of [
      "-9223372036854775808 / -1", "-9223372036854775808 % -1",
      "-9223372036854775808 // -1", "-9223372036854775808 / 1",
      "-9223372036854775808 % 2", "5 / -1", "5 // -1", "5 % -1",
    ]) agreeOut(`print(${e})`);
  });

  it("reports division by zero rather than trapping", () => {
    for (const e of ["1 / 0", "1 // 0", "1 % 0", "0 / 0", "-1 / 0", "1.0 / 0"]) {
      const built = buildNative(`print(${e})\n`, PRINTED);
      let out = "";
      let sig: string | null = null;
      try {
        out = execFileSync(built.binary, { encoding: "utf8" });
      } catch (err) {
        const x = err as { stdout?: string; stderr?: string; signal?: string };
        out = (x.stdout ?? "") + (x.stderr ?? "");
        sig = x.signal ?? null;
      }
      assert.notEqual(sig, "SIGFPE", `${e} trapped instead of reporting the error`);
      assert.match(out, /division by zero/, `${e} did not explain itself`);
    }
  });
});

/*
 * Loops and the names that live across an iteration.
 *
 * Every one of these was miscompiled before loop heads grew phis, and they fail
 * in the way that is hardest to notice: `i = i + 1` compiled to a `copy` that
 * nothing read, so the condition went on testing the value from before the loop.
 * A loop that should have counted to three either returned the pre-loop value or
 * never returned at all -- and the tests that existed passed, because not one of
 * them assigned a `var` inside a loop and then ran the result natively.
 */
describe("loops carry their locals", { skip: SKIP }, () => {
  it("counts a while loop to its bound", () => {
    agreeOut(`
def work(n):
    var acc = 0
    var i = 0
    while i < n:
        acc = acc + i
        i = i + 1
    return acc
print(work(0), work(1), work(10))
`);
  });

  it("reads a loop-carried name after the loop, not before it", () => {
    // The exit is a merge too: the condition failing and a `break` both reach
    // it, and whatever the body last wrote has to arrive there.
    agreeOut(`
def first(n):
    var i = 0
    var found = -1
    while i < n:
        found = i * 10
        i = i + 1
    return found
print(first(0), first(1), first(5))
`);
  });

  it("counts a for loop over its iterable", () => {
    agreeOut(`
def total(xs):
    var acc = 0
    for x in xs:
        acc = acc + x
    return acc
print(total([1, 2, 3]), total([]), total([0]))
`);
  });

  it("leaves a for loop with the last value the body wrote", () => {
    agreeOut(`
def last(xs):
    var out = -1
    for x in xs:
        out = x
    return out
print(last([7, 8, 9]), last([]))
`);
  });

  it("breaks and continues out of a loop with the value intact", () => {
    agreeOut(`
def firstneg(xs):
    var i = 0
    var seen = 0
    while i < len(xs):
        if xs[i] < 0:
            seen = seen + 100
            break
        i = i + 1
    return i * 1000 + seen
print(firstneg([1, 2, -3, 4]), firstneg([1, 2, 3]))

def skips(xs):
    var acc = 0
    var i = 0
    while i < len(xs):
        i = i + 1
        if xs[i - 1] % 2 == 0:
            continue
        acc = acc + xs[i - 1]
    return acc
print(skips([1, 2, 3, 4, 5]))
`);
  });

  it("keeps the inner loop's names out of the outer one", () => {
    // Two loops in sequence over the same name: the second must start from the
    // value the first left, not from whatever the first's head last held.
    agreeOut(`
def two():
    var i = 0
    var a = 0
    while i < 3:
        a = a + i
        i = i + 1
    var b = 0
    while i < 6:
        b = b + i
        i = i + 1
    return a * 100 + b
print(two())
`);
  });

  it("survives nested loops writing the same names", () => {
    agreeOut(`
def grid(n):
    var total = 0
    var i = 0
    while i < n:
        var j = 0
        while j < n:
            total = total + i * 10 + j
            j = j + 1
        i = i + 1
    return total
print(grid(4))
`);
  });

  it("terminates, which is the property that was actually broken", () => {
    // A native binary that loops forever returns nothing at all, so this is a
    // test about the run finishing rather than about the number in it.
    const src = `
def count(n):
    var i = 0
    var seen = 0
    while i < n:
        seen = seen + 1
        i = i + 1
    return seen
print(count(1000))
`;
    const built = buildNative(src, PRINTED);
    const out = execFileSync(built.binary, { encoding: "utf8", timeout: 20000 });
    assert.equal(out.trim(), "1000");
  });
});

/*
 * Tag tests the compiler can prove cannot fail.
 *
 * Inference answers "is this an int64" before anything is emitted, and where it
 * says yes the two `cmpq` per operand are dead.  The saving is small and was
 * measured rather than assumed: 4% on a loop where every operation narrows, 7%
 * on a realistic one, and nothing at all on a loop written with `+`, because `+`
 * never narrows -- the sum of two int64s can leave int64 and the runtime widens
 * it to a float.
 *
 * So what these tests mostly check is that the elision happens where it may and
 * *nowhere else*.  A dropped check that was load-bearing is a wrong answer, not a
 * crash, which is the failure mode this project cannot have.
 */
describe("tag tests inference has already answered", { skip: SKIP }, () => {
  const asmOf = (src: string): string =>
    compileModule(lowerProgram(parse(src), "t.l0p"));

  /** How each inline site describes itself, which is what these tests count. */
  const sites = (src: string): string[] =>
    asmOf(src).split("\n").filter((l) => /^\s+# (add|sub|mul|lt|le|gt|ge), /.test(l)).map((l) => l.trim());

  const untagged = (src: string): number =>
    sites(src).filter((l) => l.includes("no tag test")).length;

  const counts = (src: string): { dropped: number; kept: number } => {
    const lines = asmOf(src).split("\n");
    return {
      dropped: lines.filter((l) => l.includes("no tag test")).length,
      kept: sites(src).length - lines.filter((l) => l.includes("no tag test")).length,
    };
  };

  it("drops the test for a subtraction of two known int64s", () => {
    // `sub` is the operator that can stay int: two int64s always have an int64
    // difference, so the counter is an int at the head and stays one round the
    // loop.
    const c = counts("def w(n):\n    var i = 0\n    while i < n:\n        i = i - 1\n    return i\n");
    assert.equal(c.dropped, 1, "the subtraction should not test tags");
  });

  it("keeps the test for an addition, which can leave int64", () => {
    // The same loop with `+`.  `add(int, int)` is `num`, not `int`, because the
    // sum that overflows becomes a float -- so the operands are only known to be
    // numbers and the runtime still has to decide which path to take.
    const c = counts("def w(n):\n    var i = 0\n    while i < n:\n        i = i + 1\n    return i\n");
    assert.equal(c.dropped, 0, "`+` must not be treated as an int operation");
    assert.equal(c.kept, 2, "the comparison against n and the addition both keep their tests");
  });

  it("keeps the test when either operand is a parameter", () => {
    // Nothing is known about what a caller passed.
    const c = counts("def w(n):\n    return n - 1\n");
    assert.equal(c.dropped, 0);
  });

  it("keeps the overflow branch even with the tag test gone", () => {
    /*
     * This is the one that matters most.  Dropping the tag test says the operands
     * fit int64; it says nothing about the result.  An `add` or `mul` whose result
     * leaves int64 must still branch to the runtime, or a widened float becomes a
     * wrapped negative number that is a perfectly plausible int64.
     */
    const lines = asmOf("def w(n):\n    let a = 1\n    let b = 2\n    a + b\n    a * b\n    a - b\n")
      .split("\n");
    const dropped = lines.filter((l) => l.includes("no tag test"));
    assert.ok(dropped.length > 0, "these operands are all literals, so the tests should go");
    // add and mul both keep `jo`; sub never had one and cannot overflow.
    assert.equal((lines.join("\n").match(/jo \.L/g) ?? []).length, 2,
      "add and mul must keep their overflow branch after the tag test is gone");
  });

  it("still agrees with the interpreter, including on overflow", () => {
    for (const e of ["work(10)", "work(1)"]) agreeOut(`
def work(n):
    var i = 0
    var t = 0
    while i < n:
        t = t - 1
        i = i + 1
    return t
print(${e})
`);
    // Two int64s whose sum leaves int64: the result must be a float, which is
    // what the `jo` is still there for.
    agreeOut("print(4611686018427387904 + 4611686018427387904)");
    agreeOut("print(4611686018427387904 * 4)");
  });
});

/*
 * Constants that never reach the stack.
 *
 * A literal is the one value whose tag is known before the program runs, so it is
 * the one value that never needs a slot: `i = i + 1` was spending a 16-byte slot,
 * a store to fill it and two loads to read it back, on the number 1.
 *
 * The danger is all in `cmp`.  Its operand order decides what the condition byte
 * means -- `setl` after `cmpq %rcx, %rax` is "a < b" -- so a constant on the left
 * does not just need a different instruction, it needs a different *answer*.
 * `cmpq $7, %rcx` computes rcx - 7, and `setl` there would answer "b < a": a
 * correct instruction and the wrong result.  Hence the immediate is only ever used
 * on the right, and the reversed form keeps its operand in a register.
 */
describe("integer constants are immediates", { skip: SKIP }, () => {
  const body = (src: string): string => {
    const lines = asmOf(src).split("\n");
    const start = lines.findIndex((l) => /# (add|sub|mul|lt|le|gt|ge), /.test(l));
    return lines.slice(Math.max(0, start), start + 6).join("\n");
  };
  const asmOf = (src: string): string => compileModule(lowerProgram(parse(src), "t.l0p"));

  it("puts the constant in the instruction, not in a slot", () => {
    const b = body("def w(n):\n    let x = 1\n    x + 2\n");
    assert.match(b, /addq \$2, %rax/);
    assert.doesNotMatch(b, /\(%rbp\), %rcx/, "a constant must not be loaded into a register");
  });

  it("keeps the immediate form signed, or the comparison answers the wrong question", () => {
    /*
     * `0 < -1` is the whole test.  With the constant on the right the comparison
     * is 0 - (-1), which is positive, so the answer is false.  Moved to the left
     * it becomes (-1) - 0, also negative, and `setl` would report true -- which
     * is what a plain `cmpq $a, %rcx` produces.
     */
    agreeOut("print(0 < -1)");
    agreeOut("print(-1 < 0)");
    agreeOut("print(3 < 7)");
    agreeOut("print(7 < 3)");
    agreeOut("print(-1 <= -1)");
    agreeOut("print(-1 >= 0)");
  });

  it("agrees with the interpreter across sign and magnitude", () => {
    for (const e of [
      "5 - 3", "5 + 3", "5 * 3", "-7 - 3", "-7 + 3", "-7 * 3", "7 - -3", "-2 * -3",
      "0 - 1", "1 - 0", "-1 - -1", "2147483647 + 1", "-2147483648 - 1",
      "1 + 2 * 3", "(1 + 2) * 3", "10 - 3 - 2", "2 - 3 - 4",
    ]) agreeOut(`print(${e})`);
  });

  it("leaves a fractional literal alone, since addq $2.5 does not assemble", () => {
    // `2.5` is inside int64 and is not an integer, so a range test alone lets it
    // through and the assembler rejects it.  The test is that the program runs.
    agreeOut("print(1.5 + 2.5)");
    agreeOut("print(2.0 + 2)");
    agreeOut("print(3.5 * 2)");
    for (const e of ["1.5 + 2.5", "3.5 * 2"]) {
      assert.doesNotMatch(body(`def w():\n    let x = ${e.split(" ")[0]}\n    x ${e.split(" ")[1]} ${e.split(" ")[2]}\n`),
        /addq \$2\.5|imulq \$2\.5/, "a fractional literal must not become an integer immediate");
    }
  });

  it("still widens on overflow with both operands constant", () => {
    // Nothing about the immediates changes the overflow rule: the sum of two
    // int64s that leaves int64 is a float, and `jo` is what gets there.
    agreeOut("print(4611686018427387904 + 4611686018427387904)");
    agreeOut("print(4611686018427387904 * 4)");
    agreeOut("print(4611686018427387904 + 4611686018427387904 == 9223372036854776000)");
  });
});
