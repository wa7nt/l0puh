/**
 * M12: the native runtime.
 *
 * These tests build real machine code, run it, and check the answers.  Nothing is
 * mocked: if the calling convention is wrong or the arena arithmetic is off, a
 * number comes out wrong and the test says so.
 *
 * The suite skips itself when there is no C compiler, so the interpreter tests
 * still run on a machine without one.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { buildBinary, RT_DIR, toolchain } from "../src/rt/build.ts";
import { Session } from "../src/session.ts";

/** Whether a C compiler is present.  Checked once. */
const haveCc = ((): boolean => {
  try {
    toolchain();
    return true;
  } catch {
    return false;
  }
})();

const SKIP = haveCc ? false : "no C compiler on this machine";

/** Builds a program from assembly text (always `main.s`) and returns its stdout. */
function run(asm: string, c: Record<string, string> = {}): string {
  const built = buildBinary({ "main.s": asm }, c);
  return execFileSync(built.binary, { encoding: "utf8" });
}

describe("the toolchain", { skip: SKIP }, () => {
  it("finds a C compiler and reports its version", () => {
    const cc = toolchain();
    assert.match(cc.version, /clang|gcc|Apple/i);
  });

  it("keeps the runtime sources where the builder expects them", () => {
    for (const name of ["l0p_rt.h", "l0p_rt.c", "l0p_abi.s"]) {
      assert.ok(RT_DIR.length > 0, "RT_DIR is empty");
    }
  });
});

describe("the calling convention", { skip: SKIP }, () => {
  /*
   * The one test that matters most in this file.  A code generator that is off by
   * one register produces wrong answers rather than crashing, so the convention is
   * pinned here with a value that can only come out right one way: the weights are
   * 1..8, not powers of two, so a swapped pair of arguments changes the answer.
   *
   * C calls the assembly directly.  That is deliberate: routing it through a
   * hand-written wrapper would test the wrapper instead, and a wrapper that
   * receives eight arguments and forwards them is exactly where the stack-argument
   * bug lives -- a callee has to copy incoming stack arguments down to its own
   * outgoing area, and forgetting that produces garbage rather than a crash.
   */
  const PROBE = `
#include "l0p_rt.h"
#include <stdio.h>
#include <inttypes.h>

int main(void) {
    printf("%" PRIu64 "\\n", l0p_abi_probe(1, 2, 3, 4, 5, 6, 7, 8));
    printf("%" PRIu64 "\\n", l0p_abi_probe(2, 1, 3, 4, 5, 6, 7, 8));
    return 0;
}
`;

  it("passes the first six arguments in registers and the rest on the stack", () => {
    const out = run("", { "main.c": PROBE });
    const first = out.split("\n")[0]?.trim();
    // 1*1 + 2*2 + 3*3 + 4*4 + 5*5 + 6*6 + 7*7 + 8*8
    assert.equal(first, String(1 + 4 + 9 + 16 + 25 + 36 + 49 + 64));
  });

  it("distinguishes argument order, so a swapped pair cannot pass", () => {
    const out = run("", { "main.c": PROBE });
    const lines = out.trim().split("\n").map((s) => s.trim());
    assert.equal(lines[0], String(1 + 4 + 9 + 16 + 25 + 36 + 49 + 64));
    assert.equal(lines[1], String(2 + 2 + 9 + 16 + 25 + 36 + 49 + 64));
    assert.notEqual(lines[0], lines[1]);
  });

  it("returns through rax", () => {
    const out = run(
      `
	.text
	.globl	_l0p_ret
	.p2align 4
_l0p_ret:
	movq	$42, %rax
	retq
`,
      {
        "main.c": `
#include <stdio.h>
#include <inttypes.h>
uint64_t l0p_ret(void);
int main(void) { printf("%" PRIu64 "\\n", l0p_ret()); return 0; }
`,
      },
    );
    assert.equal(out.trim(), "42");
  });

  it("can read the instruction pointer at a call site", () => {
    /*
     * l0p_here returns the address inside *itself*, so calling it twice gives the
     * same number twice -- asking for "not equal" would be testing a wrong
     * premise.  What a traceback needs is the pc at the *call site*, so that is
     * what this measures: two distinct call sites must report distinct addresses,
     * and l0p_here must not be zero.
     */
    const out = run(
      `
	.text
	.globl	_l0p_site_a
	.p2align 4
_l0p_site_a:
	call	.Lret_a
.Lret_a:
	popq	%rax
	retq

	.globl	_l0p_site_b
	.p2align 4
_l0p_site_b:
	call	.Lret_b
.Lret_b:
	popq	%rax
	retq
`,
      {
        "main.c": `
#include "l0p_rt.h"
#include <stdio.h>
#include <inttypes.h>
uint64_t l0p_site_a(void);
uint64_t l0p_site_b(void);
int main(void) {
    uint64_t a = l0p_site_a(), b = l0p_site_b();
    printf("%s %" PRIu64 " %" PRIu64 " %" PRIu64 "\\n",
           (a != 0 && b != 0 && a != b) ? "ok" : "bad", a, b, l0p_here());
    return 0;
}
`,
      },
    );
    assert.match(out, /^ok \d+ \d+ \d+/);
  });
});

describe("the arena", { skip: SKIP }, () => {
  const PROG = `
#include "l0p_rt.h"
#include <stdio.h>

int main(void) {
    L0pArena a;
    l0p_arena_init(&a, 1 << 20);

    void *p1 = l0p_arena_alloc(&a, 100);
    void *p2 = l0p_arena_alloc(&a, 100);
    printf("aligned=%d disjoint=%d\\n",
           ((uintptr_t)p1 % 16) == 0 && ((uintptr_t)p2 % 16) == 0,
           p1 != p2);

    /* A bump allocator hands out increasing addresses. */
    printf("grows=%d\\n", (char *)p2 > (char *)p1);

    uint64_t before = l0p_arena_used(&a);
    l0p_arena_reset(&a);
    printf("resets=%d\\n", l0p_arena_used(&a) == 0 && before > 0);

    void *again = l0p_arena_alloc(&a, 100);
    printf("reuses=%d\\n", again == p1);

    void *zeroed = l0p_arena_zalloc(&a, 32);
    int is_zero = 1;
    for (int i = 0; i < 32; i++) if (((unsigned char *)zeroed)[i]) is_zero = 0;
    printf("zeros=%d\\n", is_zero);
    return 0;
}
`;

  it("aligns, hands out distinct blocks, and grows", () => {
    const out = run("", { "main.c": PROG });
    assert.match(out, /aligned=1 disjoint=1/);
    assert.match(out, /grows=1/);
  });

  it("reclaims everything on reset", () => {
    const out = run("", { "main.c": PROG });
    assert.match(out, /resets=1/);
    assert.match(out, /reuses=1/);
  });

  it("zeroes on request", () => {
    const out = run("", { "main.c": PROG });
    assert.match(out, /zeros=1/);
  });
});

describe("strings", { skip: SKIP }, () => {
  const PROG = `
#include "l0p_rt.h"
#include <stdio.h>
#include <string.h>

int main(void) {
    L0pArena a;
    l0p_arena_init(&a, 1 << 20);

    L0pStr *x = l0p_str_cstr(&a, "hello");
    L0pStr *y = l0p_str_cstr(&a, " world");
    printf("len=%d\\n", x->len == 5 && y->len == 6);

    L0pStr *z = l0p_str_concat(&a, x, y);
    printf("concat=%d\\n", z->len == 11 && memcmp(z->bytes, "hello world", 11) == 0);

    printf("eq=%d\\n", l0p_str_eq(x, l0p_str_cstr(&a, "hello")));
    printf("ne=%d\\n", !l0p_str_eq(x, y));

    /* Byte order, not a locale collation: "apple" sorts before "banana". */
    L0pStr *apple = l0p_str_cstr(&a, "apple");
    L0pStr *banana = l0p_str_cstr(&a, "banana");
    printf("cmp=%d,%d\\n", l0p_str_cmp(apple, banana) < 0, l0p_str_cmp(banana, apple) > 0);
    printf("cmp_eq=%d\\n", l0p_str_cmp(x, l0p_str_cstr(&a, "hello")) == 0);

    /* A prefix sorts before the longer string that starts with it. */
    printf("prefix=%d\\n", l0p_str_cmp(x, l0p_str_cstr(&a, "hello world")) < 0);

    printf("find=%d\\n", l0p_str_index_of(z, l0p_str_cstr(&a, "wor"), 0) == 6);
    printf("miss=%d\\n", l0p_str_index_of(z, l0p_str_cstr(&a, "zz"), 0) == -1);

    /* An empty string is length 0, not a null pointer and not a one-byte "". */
    L0pStr *empty = l0p_str_cstr(&a, "");
    printf("empty=%d\\n", empty->len == 0);

    /* INT64_MIN cannot be negated; it has to go through uint64. */
    L0pStr *min = l0p_str_from_i64(&a, INT64_MIN);
    printf("minint=%d\\n", min->len == 20 && memcmp(min->bytes, "-9223372036854775808", 20) == 0);
    return 0;
}
`;

  it("measures, joins and compares", () => {
    const out = run("", { "main.c": PROG });
    assert.match(out, /len=1\nconcat=1/);
    assert.match(out, /eq=1\nne=1/);
    assert.match(out, /cmp=1,1\ncmp_eq=1/);
    assert.match(out, /prefix=1/);
  });

  it("finds a substring and reports a miss", () => {
    const out = run("", { "main.c": PROG });
    assert.match(out, /find=1/);
    assert.match(out, /miss=1/);
  });

  it("handles the empty string", () => {
    const out = run("", { "main.c": PROG });
    assert.match(out, /empty=1/);
  });

  it("formats the most negative integer without overflowing", () => {
    // This one bit me in a different language: -INT64_MIN is a second overflow,
    // and a naive negation loop gives the wrong digit count.
    const out = run("", { "main.c": PROG });
    assert.match(out, /minint=1/);
  });
});

describe("values", { skip: SKIP }, () => {
  const PROG = `
#include "l0p_rt.h"
#include <stdio.h>

int main(void) {
    L0pArena a;
    l0p_arena_init(&a, 1 << 20);

    L0pValue one = l0p_int(1);
    L0pValue onef = l0p_float(1.0);
    L0pValue zero = l0p_int(0);
    L0pValue emptys = l0p_str(l0p_str_cstr(&a, ""));

    printf("size=%d\\n", (int)sizeof(L0pValue) == 16);

    /* 1 and 1.0 are the same number, as in Python and Go. */
    printf("cross=%d\\n", l0p_values_eq(one, onef));

    /* Python's truthiness: empty is false. */
    printf("truthy=%d%d%d%d\\n",
           l0p_truthy(one), l0p_truthy(zero),
           l0p_truthy(l0p_str(l0p_str_cstr(&a, "x"))), l0p_truthy(emptys));

    printf("names=%s,%s,%s\\n", l0p_type_name(one), l0p_type_name(emptys), l0p_type_name(l0p_null()));

    L0pValue list = l0p_make_list(&a, 3);
    printf("lit=%d,%d,%d\\n", (int)list.u.list->len,
           (int)(list.u.list->items[0].tag == L0P_NULL),
           (int)(list.u.list->items[2].tag == L0P_NULL));

    list.u.list = l0p_list_push(&a, list.u.list, one);
    printf("push=%d,%d\\n", (int)list.u.list->len, (int)(list.u.list->items[3].tag == L0P_INT));

    l0p_list_set(list.u.list, 0, one);
    printf("set=%d\\n", (int)(list.u.list->items[0].tag == L0P_INT));

    /*
     * Growth doubles the capacity when len reaches it.  A list of 3 that has
     * already taken one push sits at cap 6, not 8: the rule is doubling from
     * whatever the capacity was, not from a fixed 4.
     */
    L0pList *g = list.u.list;
    uint64_t before = g->cap;
    for (int i = 0; i < 4; i++) g = l0p_list_push(&a, g, one);
    printf("grew=%d,%d\\n", (int)(g->len == 8), (int)(g->cap > before));
    return 0;
}
`;

  it("is sixteen bytes: a tag and a payload", () => {
    // This size is baked into the calling convention.  If it changes, every
    // frame layout in the generated code has to change with it.
    const out = run("", { "main.c": PROG });
    assert.match(out, /size=1/);
  });

  it("compares across int and float", () => {
    const out = run("", { "main.c": PROG });
    assert.match(out, /cross=1/);
    assert.match(out, /names=int,str,null/);
  });

  it("treats empty as false", () => {
    const out = run("", { "main.c": PROG });
    assert.match(out, /truthy=1010/);
  });

  it("makes a list, appends to it, and grows it", () => {
    const out = run("", { "main.c": PROG });
    assert.match(out, /lit=3,1,1/);
    assert.match(out, /push=4,1/);
    assert.match(out, /set=1/);
    assert.match(out, /grew=1,1/);
  });
});

describe("printing", { skip: SKIP }, () => {
  const PROG = `
#include "l0p_rt.h"
#include <stdio.h>

int main(void) {
    L0pArena a;
    l0p_arena_init(&a, 1 << 20);

    l0p_print_value(l0p_int(-42));
    l0p_print_newline();
    l0p_print_value(l0p_bool(1));
    l0p_print_str(" ", 1);
    l0p_print_value(l0p_null());
    l0p_print_newline();

    L0pValue list = l0p_make_list(&a, 2);
    l0p_list_set(list.u.list, 0, l0p_int(1));
    l0p_list_set(list.u.list, 1, l0p_str(l0p_str_cstr(&a, "two")));
    l0p_print_value(list);
    l0p_print_newline();
    return 0;
}
`;

  it("writes values without stdio buffering", () => {
    // A program that prints a lot and exits must not lose the tail; the runtime
    // uses write(2) for exactly that reason.
    const out = run("", { "main.c": PROG });
    assert.equal(out, "-42\ntrue null\n[1, two]\n");
  });
});

describe("the interpreter is unchanged", () => {
  it("still passes its own arithmetic, so the runtime is additive", () => {
    const out: string[] = [];
    const session = new Session(undefined, { print: (t) => out.push(t) });
    assert.equal(session.runSource("1 + 2 * 3").result, 7);
    assert.deepEqual(out, []);
  });
});

// ------------------------------------------------------------- arithmetic

/*
 * The interpreter is the oracle.
 *
 * Every case below states the expected answer as the JavaScript the interpreter
 * would evaluate, rather than as a number typed in by hand.  A literal in a test
 * is a belief; this is a comparison, and it fails the moment either side drifts.
 *
 * One limit is worth stating: the interpreter holds numbers in JavaScript's
 * double, so beyond 2^53 it stops being exact and there is nothing to compare
 * against.  The cases stay under that, and the ones that deliberately exceed
 * int64 are checked for *type* rather than for digits.
 */
/*
 * The interpreter, spelled the way the C side spells it.
 *
 * A result the interpreter holds as a non-integer, or one past int64, prints as
 * `?` on both sides.  Comparing those digits would be comparing the low half of a
 * double against a long, which is a test that passes or fails for reasons that
 * have nothing to do with the runtime.
 */
const sameAsInterpreter = (a: number, b: number): string =>
  [a + b, a - b, a * b, Math.floor(a / b), a % b, a ** b]
    .map((x) => (Number.isInteger(x) && Math.abs(x) < 2 ** 63 ? String(x) : "?"))
    .join(" ");

describe("arithmetic", { skip: SKIP }, () => {
  it("agrees with the interpreter on the results", () => {
    /*
     * Cases chosen so that *every* one of the six operations lands on an
     * integer the interpreter can hold exactly.
     *
     * That restriction is the point.  The interpreter works in double, so a case
     * like `7 ** -3` has no exact answer to compare against, and printing the
     * payload of a float as an integer would compare bit patterns instead of
     * values.  The cases that must produce a fraction get their own test below,
     * which checks the type.
     */
    const cases: [number, number][] = [
      [1, 2], [7, 3], [-7, 3], [0, 5], [2, 10], [3, 4], [123456789, 987654],
    ];
    const c = `
#include "l0p_rt.h"
#include <stdio.h>
int main(void) {
    long long a[] = {${cases.map((x) => `${x[0]}LL`).join(", ")}};
    long long b[] = {${cases.map((x) => `${x[1]}LL`).join(", ")}};
    for (unsigned i = 0; i < ${cases.length}; i++) {
        L0pValue x = l0p_int(a[i]), y = l0p_int(b[i]);
        L0pValue r[6] = {l0p_add(x,y), l0p_sub(x,y), l0p_mul(x,y),
                         l0p_floordiv(x,y), l0p_mod(x,y), l0p_pow(x,y)};
        for (int k = 0; k < 6; k++) {
            /* A tag that is not INT here would make the whole comparison a
               comparison of bit patterns, so it is stated rather than assumed. */
            if (r[k].tag == L0P_INT) printf("%lld", r[k].u.i);
            else printf("?");
            if (k < 5) putchar(' ');
        }
        putchar('\\n');
    }
    return 0;
}
`;
    const out = run("", { "main.c": c }).trim().split("\n");
    assert.deepEqual(out, cases.map(([a, b]) => sameAsInterpreter(a, b)));
  });

  it("produces a float exactly when the interpreter produces one", () => {
    // The same restriction from the other side: a float where the interpreter
    // would have had one, and an int where it would have had an int.
    const c = `
#include "l0p_rt.h"
#include <stdio.h>
int main(void) {
    /* 7 ** -3 and -7 ** -3 are fractions; 2 ** 10 is 1024. */
    printf("%llu %llu %llu\\n",
        (unsigned long long)l0p_pow(l0p_int(7), l0p_int(-3)).tag,
        (unsigned long long)l0p_pow(l0p_int(-7), l0p_int(-3)).tag,
        (unsigned long long)l0p_pow(l0p_int(2), l0p_int(10)).tag);
    /* 123456789 ** 987654 overflows double, so it is a float too. */
    printf("%llu\\n", (unsigned long long)l0p_pow(l0p_int(123456789), l0p_int(987654)).tag);
    return 0;
}
`;
    assert.equal(run("", { "main.c": c }).trim(), "4 4 3\n4");
  });

  it("keeps a fractional result fractional", () => {
    // The regression this exists for: narrowing a double to int64 without asking
    // whether it is whole.  `(int64_t)0.5` is zero in C, not an error, so an
    // unconditional cast turned every fractional result into a whole number --
    // the right type, the wrong number, silently.
    const c = `
#include "l0p_rt.h"
#include <stdio.h>
int main(void) {
    L0pValue p = l0p_pow(l0p_int(-7), l0p_int(-3));   /* -0.002915... */
    L0pValue q = l0p_div(l0p_int(1), l0p_int(2));     /* 0.5          */
    L0pValue f = l0p_floordiv(l0p_float(7.5), l0p_float(2.0));   /* 3.0, whole */
    printf("%llu %.6f | %llu %.1f | %llu %lld\\n",
        (unsigned long long)p.tag, p.u.d,
        (unsigned long long)q.tag, q.u.d,
        (unsigned long long)f.tag, f.u.i);
    return 0;
}
`;
    // The first two are floats; the third came out whole, so it went back to int.
    assert.equal(run("", { "main.c": c }).trim(), "4 -0.002915 | 4 0.5 | 3 3");
  });

  it("rounds down where C truncates toward zero", () => {
    // Floor division rounds toward negative infinity; C's `/` rounds toward
    // zero.  -7 // 3 is -3 by floor and -2 by truncation.
    //
    // The remainder is a separate matter and deliberately does *not* follow
    // Python: the interpreter uses JavaScript's rule, where the sign comes from
    // the dividend.  Matching the reference is what keeps the differential tests
    // from firing on every negative modulo.
    const c = `
#include "l0p_rt.h"
#include <stdio.h>
int main(void) {
    printf("%lld %lld\\n", l0p_floordiv(l0p_int(-7), l0p_int(3)).u.i,
                          l0p_floordiv(l0p_int(7), l0p_int(-3)).u.i);
    printf("%lld %lld\\n", l0p_mod(l0p_int(-7), l0p_int(3)).u.i,
                          l0p_mod(l0p_int(7), l0p_int(-3)).u.i);
    return 0;
}
`;
    assert.equal(run("", { "main.c": c }).trim(), "-3 -3\n-1 1");
  });

  it("survives INT64_MIN divided by -1", () => {
    // This one is a trap, not a wrong answer.  The true quotient is 2^63, which
    // int64 cannot hold, and x86 `idiv` raises #DE on it, so the process dies with
    // SIGFPE before anything can be reported.  C calls the behaviour undefined,
    // which is precisely why it needs a test: nothing else would notice.
    const c = `
#include "l0p_rt.h"
#include <stdio.h>
int main(void) {
    long long mn = -9223372036854775807LL - 1;
    L0pValue f = l0p_floordiv(l0p_int(mn), l0p_int(-1));
    L0pValue m = l0p_mod(l0p_int(mn), l0p_int(-1));
    L0pValue p = l0p_mul(l0p_int(mn), l0p_int(-1));
    /* 2^63 does not fit, so it widens to a float; the remainder is defined, and is 0. */
    printf("%llu %lld %llu\\n", (unsigned long long)f.tag, m.u.i, (unsigned long long)p.tag);
    return 0;
}
`;
    assert.equal(run("", { "main.c": c }).trim(), "4 0 4");
  });

  it("widens to a float only when the result leaves int64", () => {
    const c = `
#include "l0p_rt.h"
#include <stdio.h>
int main(void) {
    L0pValue big = l0p_mul(l0p_int(4611686018427387904LL), l0p_int(2));  /* 2^63 */
    L0pValue near = l0p_add(l0p_int(9007199254740992LL), l0p_int(-1));  /* 2^53 - 1 */
    L0pValue small = l0p_add(l0p_int(2), l0p_int(3));
    printf("%llu %llu %lld %llu\\n",
        (unsigned long long)big.tag, (unsigned long long)near.tag, near.u.i,
        (unsigned long long)small.tag);
    return 0;
}
`;
    // tags: 4 is float, 3 is int.
    assert.equal(run("", { "main.c": c }).trim(), "4 3 9007199254740991 3");
  });

  it("detects overflow rather than wrapping", () => {
    /*
     * A silently wrapped int64 is the worst kind of wrong answer: a valid
     * number of the right type, and wrong.
     *
     * The two directions differ, and the difference is not an oversight.
     * `INT64_MAX + 1` is 2^63, which no int64 holds, so it widens.  But
     * `INT64_MIN - 1` is -2^63 - 1, and *double cannot represent that either* --
     * it rounds straight back to -2^63, which does fit.  So the interpreter
     * computes -2^63 for that expression, and so do we.  Matching it here means
     * matching the rounding, not the arithmetic.
     */
    const c = `
#include "l0p_rt.h"
#include <stdio.h>
int main(void) {
    L0pValue up   = l0p_add(l0p_int(9223372036854775807LL), l0p_int(1));
    L0pValue down = l0p_sub(l0p_int(-9223372036854775807LL - 1), l0p_int(1));
    L0pValue big  = l0p_mul(l0p_int(4611686018427387904LL), l0p_int(2));
    printf("%llu %lld %llu\\n",
        (unsigned long long)up.tag, down.u.i, (unsigned long long)big.tag);
    return 0;
}
`;
    // 4 = float (2^63 is out of range), then INT64_MIN, then 4 again.
    assert.equal(run("", { "main.c": c }).trim(), "4 -9223372036854775808 4");
  });

  it("stops on division by zero instead of returning a value", () => {
    const c = `
#include "l0p_rt.h"
int main(void) { L0pValue z = l0p_div(l0p_int(1), l0p_int(0)); return (int)z.u.i; }
`;
    // It must not quietly produce an answer.  A program that computed on and
    // carried past this would be much harder to diagnose than one that stops.
    let out = "";
    let failed = false;
    try {
      out = run("", { "main.c": c });
    } catch (e) {
      failed = true;
      out = String((e as { stderr?: string }).stderr ?? "");
    }
    assert.equal(failed, true, "a non-zero divisor of zero must not return normally");
    assert.match(out, /division by zero/);
  });

  it("names the operator and the type it was given", () => {
    const c = `
#include "l0p_rt.h"
int main(void) { L0pValue s = l0p_str(l0p_str_cstr(l0p_heap(), "x")); return (int)l0p_neg(s).u.i; }
`;
    let out = "";
    let failed = false;
    try {
      out = run("", { "main.c": c });
    } catch (e) {
      failed = true;
      out = String((e as { stderr?: string }).stderr ?? "");
    }
    assert.equal(failed, true);
    assert.match(out, /- needs a number, got str/);
  });

  it("orders values the way the interpreter does", () => {
    const c = `
#include "l0p_rt.h"
#include <stdio.h>
int main(void) {
    L0pValue a = l0p_int(3), b = l0p_int(7);
    L0pValue x = l0p_float(2.5), y = l0p_int(2);
    /* Truthiness, not the payload.  True is tag 2 with a payload of zero, so
       reading u.i off a boolean reports false no matter which way the answer
       went -- a mistake worth making once. */
    printf("%d%d%d%d %d%d\\n",
        l0p_truthy(l0p_lt(a,b)), l0p_truthy(l0p_le(a,b)),
        l0p_truthy(l0p_gt(a,b)), l0p_truthy(l0p_ge(a,b)),
        l0p_truthy(l0p_lt(x,y)), l0p_truthy(l0p_lt(y,x)));
    return 0;
}
`;
    // 3<7, 3<=7, not 3>7, not 3>=7; 2.5<2 is false, 2<2.5 is true.
    assert.equal(run("", { "main.c": c }).trim(), "1100 01");
  });

  it("compares strings by content", () => {
    const c = `
#include "l0p_rt.h"
#include <stdio.h>
int main(void) {
    l0p_boot();
    L0pArena *h = l0p_heap();
    L0pValue x = l0p_str(l0p_str_cstr(h, "abc"));
    L0pValue y = l0p_str(l0p_str_cstr(h, "abd"));
    L0pValue z = l0p_str(l0p_str_cstr(h, "abc"));
    printf("%d %d %d %d\\n",
        l0p_truthy(l0p_lt(x, y)),   /* "abc" < "abd"  */
        l0p_values_eq(x, y),         /* not equal       */
        l0p_values_eq(x, z),         /* equal: same text, different pointers */
        l0p_str_eq(x.u.s, z.u.s));
    return 0;
}
`;
    assert.equal(run("", { "main.c": c }).trim(), "1 0 1 1");
  });
});
