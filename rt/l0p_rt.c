/*
 * l0puh native runtime -- the parts that are better in C than in assembly.
 *
 * Arena, strings, lists, value helpers and printing.  Nothing here is clever and
 * everything here is on a hot path, so the code is plain: the compiler that will
 * later call into this is written in l0puh, and the first thing that has to work
 * is that it is *readable* and obviously correct.
 *
 * The two things that are not in C, and are in l0p_abi.s instead:
 *
 *   - knowing the current instruction pointer, for a traceback
 *   - the calling-convention shims the generated code uses
 *
 * both because C has no portable way to do them.
 */

#include "l0p_rt.h"

#include <ctype.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <sys/mman.h>

/* ------------------------------------------------------------------ arena */

void l0p_arena_init(L0pArena *a, uint64_t bytes) {
    /*
     * One big mapping rather than a malloc: the arena is the only allocator in
     * the runtime, and a bump pointer over a single region is the whole
     * implementation.  A bump that would leave the region is a hard error
     * rather than a growth, because growing would mean a second mapping and a
     * copy, and a compiler that runs out of arena is a bug in the compiler, not
     * a condition to handle.
     */
    a->base = (char *)mmap(0, (size_t)bytes, PROT_READ | PROT_WRITE,
                           MAP_PRIVATE | MAP_ANON, -1, 0);
    if (a->base == MAP_FAILED) {
        L0P_ERR("l0puh: cannot reserve arena\n");
        _exit(70);
    }
    a->used = 0;
    a->cap = bytes;
}

void *l0p_arena_alloc(L0pArena *a, uint64_t size) {
    /* 16-byte alignment: every value and every object in the runtime wants it. */
    uint64_t at = (a->used + 15u) & ~UINT64_C(15);
    if (at + size > a->cap) {
        L0P_ERR("l0puh: out of arena\n");
        _exit(71);
    }
    a->used = at + size;
    return a->base + at;
}

void *l0p_arena_zalloc(L0pArena *a, uint64_t size) {
    void *p = l0p_arena_alloc(a, size);
    memset(p, 0, (size_t)size);
    return p;
}

void l0p_arena_reset(L0pArena *a) {
    a->used = 0;
}

uint64_t l0p_arena_used(L0pArena *a) {
    return a->used;
}

/* ---------------------------------------------------------------- strings */

L0pStr *l0p_str_new(L0pArena *a, const char *s, uint64_t n) {
    L0pStr *str = (L0pStr *)l0p_arena_alloc(a, sizeof(L0pStr) + n);
    str->len = n;
    if (n > 0) memcpy(str->bytes, s, (size_t)n);
    return str;
}

L0pStr *l0p_str_cstr(L0pArena *a, const char *s) {
    return l0p_str_new(a, s, (uint64_t)strlen(s));
}

L0pStr *l0p_str_concat(L0pArena *a, L0pStr *x, L0pStr *y) {
    L0pStr *out = (L0pStr *)l0p_arena_alloc(a, sizeof(L0pStr) + x->len + y->len);
    out->len = x->len + y->len;
    memcpy(out->bytes, x->bytes, (size_t)x->len);
    memcpy(out->bytes + x->len, y->bytes, (size_t)y->len);
    return out;
}

int l0p_str_eq(L0pStr *x, L0pStr *y) {
    if (x == y) return 1;
    if (x->len != y->len) return 0;
    return memcmp(x->bytes, y->bytes, (size_t)x->len) == 0;
}

int l0p_str_cmp(L0pStr *x, L0pStr *y) {
    /* Compare the common prefix, then the lengths: byte order, like C. */
    uint64_t n = x->len < y->len ? x->len : y->len;
    int c = n == 0 ? 0 : memcmp(x->bytes, y->bytes, (size_t)n);
    if (c != 0) return c;
    if (x->len == y->len) return 0;
    return x->len < y->len ? -1 : 1;
}

int64_t l0p_str_index_of(L0pStr *hay, L0pStr *needle, int64_t from) {
    if (needle->len == 0) return from <= (int64_t)hay->len ? from : -1;
    if (needle->len > hay->len) return -1;
    for (uint64_t i = (uint64_t)(from < 0 ? 0 : from); i + needle->len <= hay->len; i++) {
        if (memcmp(hay->bytes + i, needle->bytes, (size_t)needle->len) == 0) {
            return (int64_t)i;
        }
    }
    return -1;
}

/*
 * Integer to string, written out rather than snprintf'd.  snprintf is correct and
 * also the slowest thing in the runtime by a wide margin, and this is called once
 * per print of a number, which is the common case in a benchmark.
 */
L0pStr *l0p_str_from_i64(L0pArena *a, int64_t v) {
    char tmp[24];
    uint64_t n = 0;
    int negative = 0;

    if (v < 0) {
        /* Negating INT64_MIN overflows, so it goes through uint64. */
        negative = 1;
        uint64_t u = (uint64_t)(-(v + 1)) + 1u;
        do { tmp[n++] = (char)('0' + (u % 10u)); u /= 10u; } while (u != 0);
    } else {
        uint64_t u = (uint64_t)v;
        do { tmp[n++] = (char)('0' + (u % 10u)); u /= 10u; } while (u != 0);
    }

    L0pStr *out = (L0pStr *)l0p_arena_alloc(a, sizeof(L0pStr) + n + (uint64_t)negative);
    out->len = n + (uint64_t)negative;
    uint64_t at = 0;
    if (negative) out->bytes[at++] = '-';
    while (n > 0) out->bytes[at++] = tmp[--n];
    return out;
}

/*
 * The shortest text that reads back as the same double.
 *
 * The interpreter formats numbers the way JavaScript does, and JavaScript prints
 * the shortest form that round-trips.  `%.17g` always round-trips but prints 0.1
 * as 0.10000000000000001, and `%.6g` is short but prints two different doubles
 * identically.  Increasing precision until the value survives is what makes the two
 * agree: 0.1 + 0.2 has to print as 0.30000000000000004 on both sides, or a
 * differential test fails on arithmetic that was in fact correct.
 */
/*
 * The text the interpreter would print.
 *
 * The interpreter holds numbers in JavaScript doubles and formats them the way
 * JavaScript does, so this has to agree: shortest form that reads back as the
 * same double, and *no exponent* below 1e21.  `%g` switches to exponential as
 * soon as it saves a character, so 2^63 came out as `9.223372036854776e+18` where
 * the interpreter prints `9223372036854776000` -- the same double, and two
 * different answers to `print`.
 */
/*
 * The text the interpreter would print.
 *
 * The interpreter holds numbers in JavaScript doubles and formats them the way
 * JavaScript does.  Two rules have to match or every differential test over
 * floating point fails for a reason that has nothing to do with the compiler:
 *
 *   - shortest digit string that reads back as the same double;
 *   - positional notation between 1e-6 and 1e21, exponential outside.
 *
 * `%g` satisfies neither: it switches to exponential whenever a character is
 * saved, so 2^63 printed as `9.223372036854776e+18` where the interpreter prints
 * `9223372036854776000`.  The same double, and two different answers to `print`.
 *
 * So: find the shortest digits with `%e`, which always uses exponential form and
 * therefore always gives exactly the digits, then lay them out by hand.
 */
static void fmt_double(double d, char *buf, uint64_t cap) {
    if (isnan(d)) { snprintf(buf, cap, "nan"); return; }
    if (isinf(d)) { snprintf(buf, cap, d > 0 ? "inf" : "-inf"); return; }

    char tmp[48];
    int prec = 0;
    for (prec = 0; prec <= 17; prec++) {
        snprintf(tmp, sizeof tmp, "%.*e", prec, d);
        if (strtod(tmp, NULL) == d) break;
    }

    /* Split "-d.dddde+XX" into a sign, the digits, and the exponent. */
    const char *p = tmp;
    int neg = 0;
    if (*p == '-') { neg = 1; p++; }
    char digits[24];
    int nd = 0;
    for (; *p != 0 && *p != 'e'; p++) {
        if (*p == '.') continue;
        digits[nd++] = *p;
    }
    digits[nd] = 0;
    /* The loop stopped at 'e' if there is one; if not, the value had no exponent. */
    int exp10 = (*p == 0) ? 0 : atoi(p + 1);

    /*
     * JavaScript's rule: positional from 1e-6 up to 1e21, exponential below
     * and above.  `exp10` is the power of the first digit, so the number is
     * 0.d1d2... x 10^(exp10+1) and the thresholds translate directly.
     */
    if (exp10 < -6 || exp10 >= 21) {
        if (nd > 1) {
            snprintf(buf, cap, "%s%c.%se%+d", neg ? "-" : "", digits[0], digits + 1, exp10);
        } else {
            snprintf(buf, cap, "%s%ce%+d", neg ? "-" : "", digits[0], exp10);
        }
        return;
    }

    if (exp10 >= 0) {
        /* Whole part is the first exp10+1 digits, padded with zeros. */
        int whole = exp10 + 1;
        int i = 0;
        size_t at = 0;
        if (neg && at + 1 < cap) buf[at++] = '-';
        for (; i < whole; i++) {
            if (at + 1 >= cap) break;
            buf[at++] = i < nd ? digits[i] : '0';
        }
        if (nd > whole && at + 1 < cap) {
            buf[at++] = '.';
            for (i = whole; i < nd; i++) {
                if (at + 1 >= cap) break;
                buf[at++] = digits[i];
            }
        }
        buf[at] = 0;
        return;
    }

    /* 0.000ddd */
    size_t at = 0;
    if (neg && at + 1 < cap) buf[at++] = '-';
    buf[at++] = '0';
    buf[at++] = '.';
    for (int z = 0; z < -exp10 - 1 && at + 1 < cap; z++) buf[at++] = '0';
    for (int i = 0; i < nd && at + 1 < cap; i++) buf[at++] = digits[i];
    buf[at] = 0;
}

L0pStr *l0p_str_from_double(L0pArena *a, double v) {
    /* Shortest round-trip form; %g loses precision, %.17g is unreadable. */
    char tmp[40];
    for (int prec = 1; prec <= 17; prec++) {
        snprintf(tmp, sizeof tmp, "%.*g", prec, v);
        double back = strtod(tmp, NULL);
        if (back == v) break;
    }
    return l0p_str_cstr(a, tmp);
}

/* ----------------------------------------------------------------- values */

L0pValue l0p_null(void)        { L0pValue v; v.tag = L0P_NULL;   v.u.i = 0; return v; }
L0pValue l0p_bool(int b)       { L0pValue v; v.tag = b ? L0P_TRUE : L0P_FALSE; v.u.i = 0; return v; }
L0pValue l0p_int(int64_t x)    { L0pValue v; v.tag = L0P_INT;    v.u.i = x; return v; }
L0pValue l0p_float(double x)   { L0pValue v; v.tag = L0P_FLOAT;  v.u.d = x; return v; }
L0pValue l0p_str(L0pStr *s)    { L0pValue v; v.tag = L0P_STR;    v.u.s = s; return v; }

L0pValue l0p_make_list(L0pArena *a, uint64_t n) {
    L0pList *l = (L0pList *)l0p_arena_alloc(a, sizeof(L0pList) + n * sizeof(L0pValue));
    l->len = n;
    l->cap = n;
    for (uint64_t i = 0; i < n; i++) l->items[i] = l0p_null();
    L0pValue v;
    v.tag = L0P_LIST;
    v.u.list = l;
    return v;
}

int l0p_truthy(L0pValue v) {
    /* Python's rules: empty collections and zero are false. */
    switch (v.tag) {
        case L0P_NULL:  return 0;
        case L0P_FALSE: return 0;
        case L0P_TRUE:  return 1;
        case L0P_INT:   return v.u.i != 0;
        case L0P_FLOAT: return v.u.d != 0.0;
        case L0P_STR:   return v.u.s->len != 0;
        case L0P_LIST:  return v.u.list->len != 0;
        case L0P_DICT:  return 1; /* a dict's emptiness is a v1 gap, not a decision */
        default:        return 1;
    }
}

int l0p_values_eq(L0pValue a, L0pValue b) {
    if (a.tag != b.tag) {
        /* 1 and 1.0 compare equal, as in every language with one numeric tower. */
        if (a.tag == L0P_INT && b.tag == L0P_FLOAT) return (double)a.u.i == b.u.d;
        if (a.tag == L0P_FLOAT && b.tag == L0P_INT) return a.u.d == (double)b.u.i;
        return 0;
    }
    switch (a.tag) {
        case L0P_NULL:
        case L0P_TRUE:
        case L0P_FALSE:
            return 1;
        case L0P_INT:    return a.u.i == b.u.i;
        case L0P_FLOAT:  return a.u.d == b.u.d;
        case L0P_STR:    return l0p_str_eq(a.u.s, b.u.s);
        case L0P_LIST: {
            if (a.u.list->len != b.u.list->len) return 0;
            for (uint64_t i = 0; i < a.u.list->len; i++) {
                if (!l0p_values_eq(a.u.list->items[i], b.u.list->items[i])) return 0;
            }
            return 1;
        }
        default:
            /* Identity for everything else: two closures are equal only if they
             * are the same closure. */
            return a.u.i == b.u.i;
    }
}

const char *l0p_type_name(L0pValue v) {
    switch (v.tag) {
        case L0P_NULL:   return "null";
        case L0P_TRUE:
        case L0P_FALSE:  return "bool";
        case L0P_INT:    return "int";
        case L0P_FLOAT:  return "float";
        case L0P_STR:    return "str";
        case L0P_LIST:   return "list";
        case L0P_DICT:   return "dict";
        case L0P_STRUCT: return "struct";
        case L0P_FN:     return "fn";
        case L0P_UPVAL:  return "upval";
        case L0P_MODULE: return "module";
        default:         return "object";
    }
}

L0pList *l0p_list_push(L0pArena *a, L0pList *l, L0pValue v) {
    if (l->len == l->cap) {
        /*
         * Growth copies.  A linked list would append in place but then the index
         * and iteration costs a pointer chase each, and l0puh indexes lists as
         * often as it appends to them.
         */
        uint64_t cap = l->cap == 0 ? 4 : l->cap * 2;
        L0pList *grown = (L0pList *)l0p_arena_alloc(a, sizeof(L0pList) + cap * sizeof(L0pValue));
        grown->len = l->len;
        grown->cap = cap;
        memcpy(grown->items, l->items, (size_t)l->len * sizeof(L0pValue));
        for (uint64_t i = l->len; i < cap; i++) grown->items[i] = l0p_null();
        l = grown;
    }
    l->items[l->len++] = v;
    return l;
}

L0pValue l0p_list_get(L0pList *l, int64_t i) {
    if (i < 0) i += (int64_t)l->len;
    if (i < 0 || (uint64_t)i >= l->len) return l0p_null();
    return l->items[i];
}

void l0p_list_set(L0pList *l, int64_t i, L0pValue v) {
    if (i < 0) i += (int64_t)l->len;
    if (i < 0 || (uint64_t)i >= l->len) return;
    l->items[i] = v;
}

/* -------------------------------------------------------------- printing */

void l0p_print_str(const char *s, uint64_t n) {
    uint64_t at = 0;
    while (at < n) {
        ssize_t wrote = write(1, s + at, (size_t)(n - at));
        if (wrote <= 0) {
            if (errno == EINTR) continue;
            return;
        }
        at += (uint64_t)wrote;
    }
}

void l0p_print_l0p_str(L0pStr *s) {
    l0p_print_str(s->bytes, s->len);
}

void l0p_print_i64(int64_t v) {
    char tmp[24];
    uint64_t n = 0;
    if (v < 0) {
        uint64_t u = (uint64_t)(-(v + 1)) + 1u;
        do { tmp[n++] = (char)('0' + (u % 10u)); u /= 10u; } while (u != 0);
        l0p_print_str("-", 1);
    } else {
        uint64_t u = (uint64_t)v;
        do { tmp[n++] = (char)('0' + (u % 10u)); u /= 10u; } while (u != 0);
    }
    for (uint64_t i = n; i > 0; i--) l0p_print_str(tmp + i - 1, 1);
}

void l0p_print_double(double v) {
    char buf[40];
    fmt_double(v, buf, sizeof(buf));
    l0p_print_str(buf, strlen(buf));
}

void l0p_print_newline(void) {
    l0p_print_str("\n", 1);
}

void l0p_print_value(L0pValue v) {
    switch (v.tag) {
        case L0P_NULL:  l0p_print_str("null", 4); break;
        case L0P_TRUE:  l0p_print_str("true", 4); break;
        case L0P_FALSE: l0p_print_str("false", 5); break;
        case L0P_INT:   l0p_print_i64(v.u.i); break;
        case L0P_FLOAT: l0p_print_double(v.u.d); break;
        case L0P_STR:   l0p_print_l0p_str(v.u.s); break;
        case L0P_LIST: {
            l0p_print_str("[", 1);
            for (uint64_t i = 0; i < v.u.list->len; i++) {
                if (i > 0) l0p_print_str(", ", 2);
                l0p_print_value(v.u.list->items[i]);
            }
            l0p_print_str("]", 1);
            break;
        }
        default:
            l0p_print_str("<", 1);
            l0p_print_str(l0p_type_name(v), (uint64_t)strlen(l0p_type_name(v)));
            l0p_print_str(">", 1);
            break;
    }
}

void l0p_print_err(const char *s, uint64_t n) {
    uint64_t at = 0;
    while (at < n) {
        ssize_t wrote = write(2, s + at, (size_t)(n - at));
        if (wrote <= 0) {
            if (errno == EINTR) continue;
            return;
        }
        at += (uint64_t)wrote;
    }
}

/* ------------------------------------------------------------- debugging */

void l0p_dump_trace(uint64_t skip) {
    /* 32 frames is generous for a bootstrap and small enough to always fit. */
    uint64_t frames[32];
    uint64_t depth = 32 - skip;
    if (depth > 32) depth = 32;
    l0p_trace_probe(frames, depth);

    L0P_ERR("l0puh: trace (ip=");
    char tmp[24];
    uint64_t n = 0;
    uint64_t ip = l0p_here();
    do { tmp[n++] = (char)('0' + (ip % 10u)); ip /= 10u; } while (ip != 0);
    for (uint64_t i = n; i > 0; i--) l0p_print_str(tmp + i - 1, 1);
    L0P_ERR(")\n");

    for (uint64_t i = 0; i + skip < 32; i++) {
        L0P_ERR("  frame ");
        n = 0;
        uint64_t v = frames[i];
        do { tmp[n++] = (char)('0' + (v % 10u)); v /= 10u; } while (v != 0);
        for (uint64_t k = n; k > 0; k--) l0p_print_str(tmp + k - 1, 1);
        L0P_ERR("\n");
    }
}

/* ------------------------------------------------------- global arena */

/*
 * The one arena a compiled program allocates from.
 *
 * Generated code has no place to keep an arena: every helper that allocates
 * needs one, and threading a pointer through every operation would put a
 * compiler's bookkeeping in the calling convention.  One global is the simpler
 * arrangement, and it is the reason a compiled program has one heap rather than
 * several.
 */
static L0pArena g_arena;
static uint64_t g_arena_ready;

/*
 * A runtime fault the program cannot continue from.
 *
 * `abort` rather than `exit`: the message is already on the descriptor, and
 * abort is the only termination that a shell and a test runner agree on as a
 * failure.  The alternative -- returning a default -- would let a program
 * compute a wrong answer, which is far harder to diagnose than a crash.
 */
void l0p_abort(void) {
    abort();
}

void l0p_boot(void) {
    if (!g_arena_ready) {
        l0p_arena_init(&g_arena, (uint64_t)256 << 20);
        g_arena_ready = 1;
    }
}

L0pArena *l0p_heap(void) {
    if (!g_arena_ready) l0p_boot();
    return &g_arena;
}

/* ------------------------------------------------------------ arithmetic */

/*
 * Integer when both sides are integers and the answer fits; double otherwise.
 *
 * The interpreter this has to agree with evaluates in double, so a helper that
 * always stayed in int64 would *disagree* with it on overflow rather than agree
 * with it.  Going to double on overflow makes the two implementations match on
 * every input, which is what lets the differential tests mean anything.
 */
static int both_int(L0pValue a, L0pValue b) {
    return a.tag == L0P_INT && b.tag == L0P_INT;
}

/*
 * Narrow a double back to an int when that is exact, and keep it a float when
 * it is not.
 *
 * The integrality test is the whole point of this function.  Casting
 * `(int64_t)0.5` is not an error in C -- it is zero -- so a helper that narrows
 * unconditionally turns every fractional result into a whole number.  That is
 * silent: the value keeps the right type and the wrong number, which is the
 * hardest kind of bug to find from a failing test.
 */
static L0pValue num_from_double(double d) {
    if (isnan(d) || isinf(d)) return l0p_float(d);
    /* -2^63 is representable, +2^63 is not, hence the half-open range. */
    if (d >= -9223372036854775808.0 && d < 9223372036854775808.0 && d == trunc(d)) {
        return l0p_int((int64_t)d);
    }
    return l0p_float(d);
}

static int fits_i64(double d) {
    return d >= -9223372036854775808.0 && d < 9223372036854775808.0 && d == trunc(d);
}

/*
 * Whether `x op y` fits in int64.
 *
 * Written out rather than generated, because the overflow builtins are named
 * after the *operation*, not the operator: there is no `__builtin_+_overflow`,
 * and a macro that pastes the operator into the name does not compile.  The
 * explicit form also states the boundary conditions, which is where a macro
 * would hide them.
 */
static int no_ovf_add(int64_t x, int64_t y, int64_t *r) {
    *r = (int64_t)((uint64_t)x + (uint64_t)y);
    return !(((x ^ *r) & (y ^ *r)) < 0);
}

static int no_ovf_sub(int64_t x, int64_t y, int64_t *r) {
    *r = (int64_t)((uint64_t)x - (uint64_t)y);
    return !(((x ^ y) & (x ^ *r)) < 0);
}

static int no_ovf_mul(int64_t x, int64_t y, int64_t *r) {
    if (x == 0 || y == 0) { *r = 0; return 1; }
    *r = (int64_t)((uint64_t)x * (uint64_t)y);
    if (x == -1) return y == INT64_MIN ? 0 : 1;
    if (y == -1) return x == INT64_MIN ? 0 : 1;
    int64_t q = *r / x;
    return q == y;
}

#define ARITH(name, c_op, ovf, OPNAME)                                           \
    L0pValue l0p_##name(L0pValue a, L0pValue b) {                      \
        if (both_int(a, b)) {                                          \
            int64_t r;                                                 \
            if (ovf(a.u.i, b.u.i, &r)) return l0p_int(r);              \
        }                                                              \
        double d = l0p_num(OPNAME, a) c_op l0p_num(OPNAME, b);        \
        return num_from_double(d);                                    \
    }

/*
 * `+` is three operations, and the interpreter treats it as one.
 *
 * Two strings join; two lists extend; anything else is arithmetic.  Splitting
 * this into a separate `concat` opcode would require the backend to know the
 * operand types before it could pick an operation -- and this language has no
 * type annotations, so there is nothing to know them from.  `l0p_concat` is still
 * what string interpolation calls.
 */
L0pValue l0p_add(L0pValue a, L0pValue b) {
    if (a.tag == L0P_STR && b.tag == L0P_STR) return l0p_concat(a, b);
    if (both_int(a, b)) {
        int64_t r;
        if (no_ovf_add(a.u.i, b.u.i, &r)) return l0p_int(r);
    }
    return num_from_double(l0p_num("+", a) + l0p_num("+", b));
}
ARITH(sub, -, no_ovf_sub, "-")
ARITH(mul, *, no_ovf_mul, "*")

/*
 * "this operator needs a number", with the offending types named.
 *
 * Written once because getting it wrong costs an afternoon: a helper that
 * returned a default here would let a program compute on a string and produce a
 * wrong answer, which is much harder to diagnose than a crash.
 */
void l0p_err_cstr(const char *s) {
    l0p_print_err(s, strlen(s));
}

void l0p_type_error(const char *op, const L0pValue *a, const L0pValue *b) {
    /*
     * All of it to stderr.  Mixing streams here is worse than it sounds: a test
     * that captures stderr sees half a message, and a program whose output is
     * piped gets the diagnostic interleaved into its results.
     */
    L0P_ERR("l0puh: ");
    l0p_err_cstr(op);
    L0P_ERR(" needs a number, got ");
    l0p_err_cstr(l0p_type_name(*a));
    if (b != NULL) {
        L0P_ERR(" and ");
        l0p_err_cstr(l0p_type_name(*b));
    }
    L0P_ERR("\n");
    l0p_abort();
}

void l0p_div_zero(void) {
    L0P_ERR("l0puh: division by zero\n");
    l0p_abort();
}

/*
 * The value as a double, or a type error.
 *
 * Strict on purpose.  Returning zero for anything unrecognised would make
 * `"a" * 2` evaluate to 0 and `true + 1` to 2 -- both plausible numbers, both
 * wrong, and neither pointing at the mistake.  The interpreter raises here, and
 * the two have to agree: a native result that differs from the reference is a
 * silent miscompilation, which is the failure mode this project works hardest to
 * avoid.
 *
 * `bool` and `null` are numbers to neither.  `float(True)` is the way to say so
 * when that is what is meant.
 */
double l0p_as_double(L0pValue v) {
    switch (v.tag) {
        case L0P_INT:   return (double)v.u.i;
        case L0P_FLOAT: return v.u.d;
        default:
            l0p_type_error("arithmetic", &v, NULL);
            return 0.0;
    }
}

/*
 * The lenient form, for the places that mean to convert.
 *
 * Separate from the strict one on purpose: having a single "to double" that
 * sometimes raises and sometimes does not is how the strict version gets
 * weakened in a hurry.
 */
/*
 * The value as a double, naming the operator that wanted one.
 *
 * The message is the interpreter's, so that a divergence shows up as the same
 * sentence on both sides instead of one of them quietly coercing.
 */
double l0p_num(const char *op, L0pValue v) {
    if (v.tag == L0P_INT) return (double)v.u.i;
    if (v.tag == L0P_FLOAT) return v.u.d;
    l0p_type_error(op, &v, NULL);
    return 0.0;
}

double l0p_to_double(L0pValue v) {
    switch (v.tag) {
        case L0P_INT:   return (double)v.u.i;
        case L0P_FLOAT: return v.u.d;
        case L0P_TRUE:  return 1.0;
        case L0P_FALSE:
        case L0P_NULL:  return 0.0;
        default:        return 0.0;
    }
}

/*
 * True division always produces a double when it does not divide evenly, and an
 * int when it does -- which is what the interpreter does and what makes `6/2`
 * print `3` rather than `3.0`.
 */
L0pValue l0p_div(L0pValue a, L0pValue b) {
    double y = l0p_as_double(b);
    if (y == 0.0) {
        L0P_ERR("l0puh: division by zero\n");
        l0p_abort();
    }
    if (both_int(a, b) && b.u.i != -1 && (a.u.i % b.u.i) == 0) return l0p_int(a.u.i / b.u.i);
    return l0p_float(l0p_num("/", a) / y);
}

L0pValue l0p_floordiv(L0pValue a, L0pValue b) {
    double y = l0p_num("//", b);
    if (y == 0.0) l0p_div_zero();
    if (both_int(a, b)) {
        int64_t x = a.u.i, yi = b.u.i;
        /*
         * INT64_MIN / -1 overflows: the true quotient is 2^63, which is not a
         * value int64 can hold, and x86 `idiv` raises #DE on it -- the program
         * dies with SIGFPE rather than returning a wrong number.  C leaves this
         * undefined, so it has to be handled before the division happens.
         */
        if (x == INT64_MIN && yi == -1) return l0p_float(-(double)INT64_MIN);
        int64_t q = x / yi, r = x % yi;
        /* C truncates toward zero; floor goes down.  They differ on negatives. */
        if (r != 0 && ((r < 0) != (yi < 0))) q--;
        return l0p_int(q);
    }
    double d = floor(l0p_as_double(a) / y);
    return fits_i64(d) ? l0p_int((int64_t)d) : l0p_float(d);
}

L0pValue l0p_mod(L0pValue a, L0pValue b) {
    double y = l0p_num("%", b);
    if (y == 0.0) l0p_div_zero();
    if (both_int(a, b)) {
        int64_t x = a.u.i, yi = b.u.i;
        /* Same trap as above; the remainder is defined, and is simply zero. */
        if (x == INT64_MIN && yi == -1) return l0p_int(0);
        /*
         * The remainder takes the sign of the *dividend*, which is what C and
         * JavaScript do and therefore what the interpreter does.
         *
         * This is not Python's rule, which normalises to the divisor's sign
         * (`7 % -3` is -2 there, 1 here).  Matching the interpreter is the point:
         * a native result that disagreed with the reference on negative modulo
         * would make every differential test on those inputs a false alarm.
         */
        return l0p_int(x % yi);
    }
    return num_from_double(fmod(l0p_num("%", a), y));
}

L0pValue l0p_pow(L0pValue a, L0pValue b) {
    double d = pow(l0p_as_double(a), l0p_as_double(b));
    return fits_i64(d) ? l0p_int((int64_t)d) : l0p_float(d);
}

L0pValue l0p_neg(L0pValue a) {
    if (a.tag == L0P_INT) {
        if (a.u.i == INT64_MIN) return l0p_float(-(double)a.u.i);
        return l0p_int(-a.u.i);
    }
    if (a.tag == L0P_FLOAT) return l0p_float(-a.u.d);
    l0p_type_error("-", &a, NULL);
    return l0p_null();   /* unreachable; the error above does not return */
}

L0pValue l0p_not(L0pValue a) { return l0p_bool(!l0p_truthy(a)); }

/* ---------------------------------------------------------- comparison */

static int cmp_values(L0pValue a, L0pValue b) {
    if (both_int(a, b)) return a.u.i < b.u.i ? -1 : (a.u.i > b.u.i ? 1 : 0);
    if (a.tag == L0P_STR && b.tag == L0P_STR) return l0p_str_cmp(a.u.s, b.u.s);
    double x = l0p_as_double(a), y = l0p_as_double(b);
    return x < y ? -1 : (x > y ? 1 : 0);
}

L0pValue l0p_lt(L0pValue a, L0pValue b) { return l0p_bool(cmp_values(a, b) <  0); }
L0pValue l0p_le(L0pValue a, L0pValue b) { return l0p_bool(cmp_values(a, b) <= 0); }
L0pValue l0p_gt(L0pValue a, L0pValue b) { return l0p_bool(cmp_values(a, b) >  0); }
L0pValue l0p_ge(L0pValue a, L0pValue b) { return l0p_bool(cmp_values(a, b) >= 0); }

L0pValue l0p_concat(L0pValue a, L0pValue b) {
    L0pStr *x = l0p_str_cstr(l0p_heap(), "");
    L0pStr *t = l0p_str_concat(l0p_heap(), x, a.u.s);
    return l0p_str(l0p_str_concat(l0p_heap(), t, b.u.s));
}
/* --------------------------------------------------------------- functions */

L0pValue l0p_fn_new(void *code, const char *name, uint64_t nargs) {
    l0p_boot();
    L0pFn *f = (L0pFn *)l0p_arena_zalloc(l0p_heap(), sizeof(L0pFn));
    f->code = code;
    f->native = NULL;
    f->name = name;
    f->nargs = nargs;
    f->nslots = 0;
    f->nupvals = 0;
    f->upvals = NULL;
    L0pValue v;
    v.tag = L0P_FN;
    v.u.fn = f;
    return v;
}

int l0p_fn_call(L0pValue fn, uint64_t argc, const L0pValue *argv, L0pValue *out) {
    if (fn.tag != L0P_FN || fn.u.fn == NULL) {
        L0P_ERR("l0puh: this value is not callable\n");
        l0p_abort();
    }
    /*
     * `native` first.
     *
     * A built-in has no machine code at all -- `code` is null by definition and
     * `native` is the whole implementation.  Checking `code` before `native`
     * therefore rejects every built-in with "not callable", which is a strange
     * way to learn that the two kinds of callable share a struct.
     */
    if (fn.u.fn->native != NULL) {
        *out = fn.u.fn->native(argc, argv, (void *)fn.u.fn->upvals);
        return 1;
    }
    if (fn.u.fn->code == NULL) {
        L0P_ERR("l0puh: this value is not callable\n");
        l0p_abort();
    }
    L0pValue (*entry)(L0pValue *, uint64_t, const L0pValue *) =
        (L0pValue (*)(L0pValue *, uint64_t, const L0pValue *))fn.u.fn->code;
    entry(out, argc, argv);
    return 1;
}

/* ------------------------------------------------------- lists and dicts */

L0pValue l0p_list_from(const L0pValue *items, uint64_t n) {
    L0pArena *a = l0p_heap();
    L0pValue l = l0p_make_list(a, n);
    for (uint64_t i = 0; i < n; i++) l.u.list->items[i] = items[i];
    l.u.list->len = n;
    return l;
}

L0pValue l0p_list_push_val(L0pList *l, L0pValue v) {
    L0pValue out;
    out.tag = L0P_LIST;
    out.u.list = l0p_list_push(l0p_heap(), l, v);
    return out;
}

uint64_t l0p_list_len(L0pList *l) { return l == NULL ? 0 : l->len; }

L0pIter *l0p_iter_new(L0pValue seq) {
    L0pIter *it = (L0pIter *)l0p_arena_zalloc(l0p_heap(), sizeof(L0pIter));
    it->list = seq.tag == L0P_LIST ? seq.u.list : NULL;
    it->at = 0;
    return it;
}

int l0p_iter_more(L0pIter *it) {
    return it->list != NULL && it->at < it->list->len;
}

L0pValue l0p_iter_next(L0pIter *it) {
    if (!l0p_iter_more(it)) return l0p_null();
    return it->list->items[it->at++];
}

L0pValue l0p_dict_from(const L0pValue *items, uint64_t pairs) {
    L0pArena *a = l0p_heap();
    L0pDict *d = (L0pDict *)l0p_arena_zalloc(a, sizeof(L0pDict));
    d->cap = pairs;
    d->keys = pairs ? (const char **)l0p_arena_zalloc(a, pairs * sizeof(char *)) : NULL;
    d->vals = pairs ? (L0pValue *)l0p_arena_zalloc(a, pairs * sizeof(L0pValue)) : NULL;
    for (uint64_t i = 0; i < pairs; i++) {
        L0pValue k = items[i * 2], v = items[i * 2 + 1];
        L0pStr *key = k.tag == L0P_STR ? k.u.s : l0p_str_from_i64(a, k.u.i);
        d->keys[d->len] = (const char *)key->bytes;
        d->vals[d->len] = v;
        d->len++;
    }
    L0pValue out;
    out.tag = L0P_DICT;
    out.u.dict = d;
    return out;
}

L0pValue l0p_dict_get(L0pDict *d, L0pStr *key) {
    if (d == NULL || key == NULL) return l0p_null();
    for (uint64_t i = 0; i < d->len; i++) {
        L0pStr *k = (L0pStr *)(d->keys[i] - offsetof(L0pStr, bytes));
        if (l0p_str_eq(k, key)) return d->vals[i];
    }
    return l0p_null();
}

void l0p_dict_set(L0pDict *d, L0pStr *key, L0pValue v) {
    if (d == NULL || key == NULL) return;
    for (uint64_t i = 0; i < d->len; i++) {
        L0pStr *k = (L0pStr *)(d->keys[i] - offsetof(L0pStr, bytes));
        if (l0p_str_eq(k, key)) { d->vals[i] = v; return; }
    }
    d->keys[d->len] = (const char *)key->bytes;
    d->vals[d->len] = v;
    d->len++;
}

uint64_t l0p_dict_len(L0pDict *d) { return d == NULL ? 0 : d->len; }

/* ------------------------------------------------------ strings and types */

L0pValue l0p_str_new_value(const char *s, uint64_t n) {
    return l0p_str(l0p_str_new(l0p_heap(), s, n));
}

L0pValue l0p_str_len(L0pStr *s) {
    /* Characters, not bytes: see the utf-8 note below. */
    return l0p_int(s == NULL ? 0 : (int64_t)l0p_utf8_len(s->bytes, s->len));
}

/*
 * `str` of anything.
 *
 * Rendered here rather than by the caller so that `str`, string interpolation and
 * `print` all agree.  A value's own text form is what a user means by "this value",
 * and three code paths that disagreed would be three answers.
 */
L0pValue l0p_to_str(L0pValue v) {
    L0pArena *a = l0p_heap();
    switch (v.tag) {
        case L0P_STR:   return v;
        case L0P_INT:   return l0p_str(l0p_str_from_i64(a, v.u.i));
        case L0P_FLOAT: {
            char buf[40];
            fmt_double(v.u.d, buf, sizeof(buf));
            return l0p_str_new_value(buf, strlen(buf));
        }
        case L0P_TRUE:  return l0p_str(l0p_str_cstr(a, "true"));
        case L0P_FALSE: return l0p_str(l0p_str_cstr(a, "false"));
        case L0P_NULL:  return l0p_str(l0p_str_cstr(a, "null"));
        default:        return l0p_str(l0p_str_cstr(a, l0p_type_name(v)));
    }
}

L0pValue l0p_to_int(L0pValue v) {
    switch (v.tag) {
        case L0P_INT:   return v;
        case L0P_STR: {
            /*
             * Parse, and say so when there is nothing to parse.
             *
             * Returning zero for "abc" would be a plausible integer that is
             * simply wrong, and a program would carry on with it.
             */
            L0pStr *s = v.u.s;
            char buf[64];
            if (s->len >= sizeof(buf)) {
                L0P_ERR("l0puh: int() of a string that is too long\n");
                l0p_abort();
                return l0p_int(0);
            }
            memcpy(buf, s->bytes, s->len);
            buf[s->len] = 0;
            char *end = NULL;
            long long got = strtoll(buf, &end, 10);
            while (isspace((unsigned char)*end)) end++;
            if (end == buf || *end != 0) {
                L0P_ERR("l0puh: int() of ");
                l0p_err_cstr(buf);
                l0p_abort();
                return l0p_int(0);
            }
            return l0p_int((int64_t)got);
        }
        /*
         * Toward zero, and then always an integer.
         *
         * Reusing `num_from_double` here would return 1.5 from `int(1.5)` --
         * a float where the name promised an int, and the one conversion whose
         * result type has to change.
         */
        case L0P_FLOAT: {
            double d = v.u.d;
            if (isnan(d) || isinf(d)) { l0p_type_error("int()", &v, NULL); return l0p_int(0); }
            if (d >= -9223372036854775808.0 && d < 9223372036854775808.0) {
                return l0p_int((int64_t)d);
            }
            l0p_type_error("int()", &v, NULL);
            return l0p_int(0);
        }
        /*
         * A boolean is not a number here, and the interpreter says so.  Accepting
         * it would make `int(true)` and arithmetic disagree about what `true` is,
         * in the same language, on the same day.
         */
        default:
            l0p_type_error("int()", &v, NULL);
            return l0p_int(0);
    }
}

L0pValue l0p_to_float(L0pValue v) {
    switch (v.tag) {
        case L0P_INT:   return l0p_float((double)v.u.i);
        case L0P_STR: {
            L0pStr *s = v.u.s;
            char buf[64];
            if (s->len >= sizeof(buf)) { l0p_abort(); return l0p_float(0.0); }
            memcpy(buf, s->bytes, s->len);
            buf[s->len] = 0;
            char *end = NULL;
            double got = strtod(buf, &end);
            while (isspace((unsigned char)*end)) end++;
            if (end == buf || *end != 0) {
                L0P_ERR("l0puh: float() of ");
                l0p_err_cstr(buf);
                l0p_abort();
                return l0p_float(0.0);
            }
            return num_from_double(got);
        }
        case L0P_FLOAT: return v;
        /* As with int(): `bool()` is how you ask, not `float()`. */
        default:
            l0p_type_error("float()", &v, NULL);
            return l0p_float(0.0);
    }
}

L0pValue l0p_type_of(L0pValue v) {
    return l0p_str(l0p_str_cstr(l0p_heap(), l0p_type_name(v)));
}

/* --------------------------------------------------------- the built-ins */

/*
 * `print` writes through the same raw-descriptor path as everything else, so it
 * cannot lose its output to a buffer that is never flushed.
 */
L0pValue l0p_bi_print(uint64_t argc, const L0pValue *argv, void *env) {
    (void)env;
    for (uint64_t i = 0; i < argc; i++) {
        l0p_print_value(argv[i]);
        if (i + 1 < argc) l0p_print_str(" ", 1);
    }
    l0p_print_newline();
    return l0p_null();
}

L0pValue l0p_bi_len(uint64_t argc, const L0pValue *argv, void *env) {
    (void)env;
    if (argc < 1) return l0p_int(0);
    switch (argv[0].tag) {
        case L0P_STR:   return l0p_str_len(argv[0].u.s);
        case L0P_LIST:  return l0p_int((int64_t)l0p_list_len(argv[0].u.list));
        case L0P_DICT:  return l0p_int((int64_t)l0p_dict_len(argv[0].u.dict));
        default:
            l0p_type_error("len", &argv[0], NULL);
            return l0p_int(0);
    }
}

L0pValue l0p_iter_value(L0pIter *it) {
    L0pValue v;
    v.tag = L0P_ITER;
    v.u.list = NULL;
    v.u.st = (L0pStruct *)it;   /* a pointer either way; the tag says what it is */
    return v;
}

L0pValue l0p_bi_iter(uint64_t argc, const L0pValue *argv, void *env) {
    (void)env;
    return l0p_iter_value(l0p_iter_new(argc > 0 ? argv[0] : l0p_null()));
}

L0pValue l0p_bi_iter_more(uint64_t argc, const L0pValue *argv, void *env) {
    (void)env;
    if (argc < 1 || argv[0].tag != L0P_ITER) return l0p_bool(0);
    return l0p_bool(l0p_iter_more((L0pIter *)argv[0].u.st));
}

L0pValue l0p_bi_iter_next(uint64_t argc, const L0pValue *argv, void *env) {
    (void)env;
    if (argc < 1 || argv[0].tag != L0P_ITER) return l0p_null();
    return l0p_iter_next((L0pIter *)argv[0].u.st);
}

/* ------------------------------------------------------ the name table */

typedef struct L0pBi {
    const char *name;
    l0p_native_fn fn;
} L0pBi;

static const L0pBi BUILTINS[] = {
    { "print", l0p_bi_print },
    { "len", l0p_bi_len },
    { "str", (l0p_native_fn)l0p_bi_str },
    { "int", (l0p_native_fn)l0p_bi_int },
    { "float", (l0p_native_fn)l0p_bi_float },
    { "bool", (l0p_native_fn)l0p_bi_bool },
    { "type", (l0p_native_fn)l0p_bi_type },
    { "iter", l0p_bi_iter },
    { "iter_more", l0p_bi_iter_more },
    { "iter_next", l0p_bi_iter_next },
    { NULL, NULL },
};

L0pValue l0p_builtin(const char *name) {
    for (const L0pBi *b = BUILTINS; b->name != NULL; b++) {
        if (strcmp(b->name, name) != 0) continue;
        L0pFn *f = (L0pFn *)l0p_arena_zalloc(l0p_heap(), sizeof(L0pFn));
        f->code = NULL;
        f->native = b->fn;
        f->name = b->name;
        f->nargs = 0;
        L0pValue v;
        v.tag = L0P_FN;
        v.u.fn = f;
        return v;
    }
    L0P_ERR("l0puh: no such built-in: ");
    l0p_err_cstr(name);
    l0p_abort();
    return l0p_null();   /* unreachable; the abort above does not return */
}

/*
 * The one-argument conversions.
 *
 * They take the same shape as the variadic built-ins so one calling convention
 * covers all of them; casting a variadic function pointer to this one is safe
 * because the ABI passes the first three arguments identically.
 */
L0pValue l0p_bi_str(uint64_t argc, const L0pValue *argv, void *env) {
    (void)env;
    return l0p_to_str(argc > 0 ? argv[0] : l0p_null());
}

L0pValue l0p_bi_int(uint64_t argc, const L0pValue *argv, void *env) {
    (void)env;
    return l0p_to_int(argc > 0 ? argv[0] : l0p_null());
}

L0pValue l0p_bi_float(uint64_t argc, const L0pValue *argv, void *env) {
    (void)env;
    return l0p_to_float(argc > 0 ? argv[0] : l0p_null());
}

L0pValue l0p_bi_bool(uint64_t argc, const L0pValue *argv, void *env) {
    (void)env;
    return l0p_bool(l0p_truthy(argc > 0 ? argv[0] : l0p_null()));
}

L0pValue l0p_bi_type(uint64_t argc, const L0pValue *argv, void *env) {
    (void)env;
    return l0p_type_of(argc > 0 ? argv[0] : l0p_null());
}

static uint64_t utf8_seq_len(unsigned char c) {
    if (c < 0x80) return 1;
    if ((c & 0xe0) == 0xc0) return 2;
    if ((c & 0xf0) == 0xe0) return 3;
    if ((c & 0xf8) == 0xf0) return 4;
    return 1;   /* a stray byte counts as one character rather than looping */
}

/* ------------------------------------------------------ indexing and fields */

L0pValue l0p_index_get(L0pValue seq, L0pValue key) {
    switch (seq.tag) {
        case L0P_LIST:
            if (key.tag != L0P_INT) {
                l0p_type_error("a list index", &key, NULL);
                return l0p_null();
            }
            return l0p_list_get(seq.u.list, key.u.i);
        case L0P_STR: {
            /* A subscript yields one *character*, which may be several bytes. */
            if (key.tag != L0P_INT) {
                l0p_type_error("a string index", &key, NULL);
                return l0p_null();
            }
            L0pStr *s = seq.u.s;
            int64_t at = l0p_utf8_at(s->bytes, s->len, key.u.i);
            if (at < 0) {
                L0P_ERR("l0puh: string index out of range\n");
                l0p_abort();
                return l0p_null();
            }
            uint64_t n = utf8_seq_len((unsigned char)s->bytes[at]);
            if ((uint64_t)at + n > s->len) n = s->len - (uint64_t)at;
            return l0p_str(l0p_str_new(l0p_heap(), s->bytes + at, n));
        }
        case L0P_DICT:
            return l0p_dict_get(seq.u.dict, key.tag == L0P_STR ? key.u.s : NULL);
        default:
            l0p_type_error("a subscript of", &seq, NULL);
            return l0p_null();
    }
}

void l0p_index_set(L0pValue seq, L0pValue key, L0pValue v) {
    if (seq.tag == L0P_LIST) {
        l0p_list_set(seq.u.list, key.u.i, v);
        return;
    }
    if (seq.tag == L0P_DICT) {
        l0p_dict_set(seq.u.dict, key.tag == L0P_STR ? key.u.s : NULL, v);
        return;
    }
    l0p_type_error("an assignment to", &seq, NULL);
}

L0pValue l0p_field_get(L0pValue obj, const char *name) {
    if (obj.tag != L0P_STRUCT || obj.u.st == NULL) {
        l0p_type_error("a field of", &obj, NULL);
        return l0p_null();
    }
    L0pStruct *st = obj.u.st;
    for (uint64_t i = 0; i < st->nfields; i++) {
        if (strcmp(st->field_names[i], name) == 0) return st->fields[i];
    }
    L0P_ERR("l0puh: no such field: ");
    l0p_err_cstr(name);
    l0p_abort();
    return l0p_null();   /* unreachable; the abort above does not return */
}

void l0p_field_set(L0pValue obj, const char *name, L0pValue v) {
    if (obj.tag != L0P_STRUCT || obj.u.st == NULL) {
        l0p_type_error("a field of", &obj, NULL);
        return;
    }
    L0pStruct *st = obj.u.st;
    for (uint64_t i = 0; i < st->nfields; i++) {
        if (strcmp(st->field_names[i], name) == 0) { st->fields[i] = v; return; }
    }
    L0P_ERR("l0puh: no such field: ");
    l0p_err_cstr(name);
    l0p_abort();
}

/* ------------------------------------------------------------------- utf-8 */

/*
 * Characters, not bytes.
 *
 * `len("привет")` is 6 and `s[0]` is "п".  The runtime stores strings as bytes,
 * which is right for arithmetic and wrong for the two operations a person means
 * by length and by index.  The interpreter counts characters, and the native
 * backend has to agree with it or the same program means two different things.
 *
 * The cost is a short scan, and it is the same scan the interpreter does, so
 * this buys agreement rather than speed.
 */

uint64_t l0p_utf8_len(const char *s, uint64_t bytes) {
    uint64_t at = 0, n = 0;
    while (at < bytes) {
        at += utf8_seq_len((unsigned char)s[at]);
        n++;
    }
    return n;
}

/* Byte offset of character `index`, or -1 when the string is shorter. */
int64_t l0p_utf8_at(const char *s, uint64_t bytes, int64_t index) {
    if (index < 0) index += (int64_t)l0p_utf8_len(s, bytes);
    if (index < 0) return -1;
    uint64_t at = 0;
    for (int64_t i = 0; i < index; i++) {
        if (at >= bytes) return -1;
        at += utf8_seq_len((unsigned char)s[at]);
    }
    if (at >= bytes) return -1;
    return (int64_t)at;
}
