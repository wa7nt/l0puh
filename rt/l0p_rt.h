/*
 * l0puh native runtime -- public interface.
 *
 * This is the whole surface the code generator targets, and the whole surface
 * that has to exist before the code generator can be written at all.  Anything
 * a compiled l0puh program needs from the outside world is here or reached
 * through libc by way of these functions.
 *
 * Conventions, and why they are what they are:
 *
 *   - The C ABI is followed exactly.  Arguments arrive in rdi, rsi, rdx, rcx,
 *     r8, r9 and then on the stack, and a result comes back in rax.  That is
 *     what makes every libc function callable from compiled code for free, with
 *     no glue: `malloc` is as reachable as any other name.
 *
 *   - A value is 16 bytes: a 64-bit tag and a 64-bit payload.  It is passed in
 *     memory rather than in a register pair, because the register form is
 *     classified as INTEGER,INTEGER by the ABI and every caller would have to
 *     agree on which half goes where.  Register passing arrives at M15 with the
 *     register allocator, where it is measurable; until then the memory form is
 *     the one that is easy to get right.
 *
 *   - Memory comes from an arena and is never individually freed.  A compiler
 *     run that finishes releases everything by exiting.  `l0p_arena_reset` is
 *     here for the REPL, which has to reclaim between inputs.  This is a
 *     deliberate omission: a collector in the bootstrap path is a month of
 *     debugging spent on something the bootstrap does not need.
 *
 *   - Strings are length-prefixed and not NUL-terminated internally, because
 *     l0puh strings carry their own length.  The `char *` parameters on the
 *     FFI-facing functions are for literals and for libc interop.
 */

#ifndef L0P_RT_H
#define L0P_RT_H

#include <stdint.h>
#include <stddef.h>

/* ------------------------------------------------------------------ values */

enum l0p_tag {
    L0P_NULL   = 0,
    L0P_FALSE  = 1,
    L0P_TRUE   = 2,
    L0P_INT    = 3,   /* payload is int64_t                     */
    L0P_FLOAT  = 4,   /* payload is double                      */
    L0P_STR    = 5,   /* payload is L0pStr *                    */
    L0P_LIST   = 6,   /* payload is L0pList *                   */
    L0P_DICT   = 7,   /* payload is L0pDict *                   */
    L0P_STRUCT = 8,   /* payload is L0pStruct *                 */
    L0P_FN     = 9,   /* payload is L0pFn *                     */
    L0P_UPVAL  = 10,  /* payload is L0pUpval *                  */
    L0P_MODULE = 11,  /* payload is L0pModule *                 */
    L0P_ITER   = 12   /* payload is L0pIter *; a for-loop cursor  */
};

typedef struct L0pStr    L0pStr;
typedef struct L0pList   L0pList;
typedef struct L0pDict   L0pDict;
typedef struct L0pStruct L0pStruct;
typedef struct L0pFn     L0pFn;
typedef struct L0pUpval  L0pUpval;
typedef struct L0pModule L0pModule;

typedef struct L0pValue {
    uint64_t tag;
    union {
        int64_t   i;
        double    d;
        L0pStr   *s;
        L0pList  *list;
        L0pDict  *dict;
        L0pStruct *st;
        L0pFn    *fn;
        L0pUpval *up;
        L0pModule *mod;
    } u;
} L0pValue;

/* A string: length, then the bytes.  No terminator; `len` is the length. */
struct L0pStr {
    uint64_t len;
    char     bytes[];
};

/* A list: length, capacity, then the elements. */
struct L0pList {
    uint64_t len;
    uint64_t cap;
    L0pValue items[];
};

/* A struct: a type name and a field list, plus the field values. */
struct L0pStruct {
    const char *type_name;
    uint64_t    nfields;
    const char **field_names;
    L0pValue    fields[];
};

typedef L0pValue (*l0p_native_fn)(uint64_t argc, const L0pValue *argv, void *env);

/* A compiled function: its machine code, plus what it captured. */
struct L0pFn {
    void        *code;        /* entry point, or NULL for a builtin */
    l0p_native_fn native;     /* set for a builtin                   */
    const char  *name;
    uint64_t     nargs;
    uint64_t     nslots;
    uint64_t     nupvals;
    L0pValue    *upvals;      /* captured values, from the closure   */
    void        *root;        /* for the collector: this closure     */
};

/* A captured variable.  A cell, because closures see later assignments. */
struct L0pUpval {
    L0pValue value;
    uint64_t open;            /* 1 while a frame still refers to it */
};

/* ---------------------------------------------------------------- functions */

/*
 * A callable value.
 *
 * `code` points at generated machine code with the signature
 *
 *     L0pValue f(L0pValue *ret, uint64_t argc, L0pValue *argv)
 *
 * The result is written through `ret` rather than returned in registers.  That is
 * not the SysV convention for L0pValue, which uses rax:rdx -- the difference is
 * deliberate and it is what lets a generated function be called from hand-written
 * C without a shim, since `ret` is an ordinary pointer argument.
 */
L0pValue l0p_fn_new(void *code, const char *name, uint64_t nargs);
int      l0p_fn_call(L0pValue fn, uint64_t argc, const L0pValue *argv, L0pValue *out);

/* ------------------------------------------------------------------ arena */

typedef struct L0pArena {
    char    *base;
    uint64_t used;
    uint64_t cap;
} L0pArena;

void  l0p_arena_init(L0pArena *a, uint64_t bytes);
void *l0p_arena_alloc(L0pArena *a, uint64_t size);
void *l0p_arena_zalloc(L0pArena *a, uint64_t size);
void  l0p_arena_reset(L0pArena *a);
uint64_t l0p_arena_used(L0pArena *a);

/* ---------------------------------------------------------------- strings */

L0pStr  *l0p_str_new(L0pArena *a, const char *s, uint64_t n);
L0pStr  *l0p_str_cstr(L0pArena *a, const char *s);
L0pStr  *l0p_str_concat(L0pArena *a, L0pStr *x, L0pStr *y);
L0pStr  *l0p_str_from_i64(L0pArena *a, int64_t v);
L0pStr  *l0p_str_from_double(L0pArena *a, double v);
int      l0p_str_eq(L0pStr *x, L0pStr *y);
int      l0p_str_cmp(L0pStr *x, L0pStr *y);
int64_t  l0p_str_index_of(L0pStr *hay, L0pStr *needle, int64_t from);

/* --------------------------------------------- arithmetic and comparison */

/*
 * Integer where the answer fits, double where it does not.
 *
 * The interpreter these have to agree with evaluates in double, so a helper that
 * stayed in int64 would disagree with it exactly where the results start to
 * differ.  Each takes and returns L0pValue by value, which the SysV ABI
 * classifies as two integer registers: the code generator depends on that, and a
 * test pins it rather than trusting anyone's memory of the classification.
 */
L0pValue l0p_add(L0pValue a, L0pValue b);
L0pValue l0p_sub(L0pValue a, L0pValue b);
L0pValue l0p_mul(L0pValue a, L0pValue b);
L0pValue l0p_div(L0pValue a, L0pValue b);
L0pValue l0p_floordiv(L0pValue a, L0pValue b);
L0pValue l0p_mod(L0pValue a, L0pValue b);
L0pValue l0p_pow(L0pValue a, L0pValue b);
L0pValue l0p_neg(L0pValue a);
L0pValue l0p_not(L0pValue a);
L0pValue l0p_lt(L0pValue a, L0pValue b);
L0pValue l0p_le(L0pValue a, L0pValue b);
L0pValue l0p_gt(L0pValue a, L0pValue b);
L0pValue l0p_ge(L0pValue a, L0pValue b);
L0pValue l0p_concat(L0pValue a, L0pValue b);
double   l0p_as_double(L0pValue v);
double   l0p_to_double(L0pValue v);
double   l0p_num(const char *op, L0pValue v);

/* ---------------------------------------------------------------- the heap */

/*
 * One global arena, not a parameter.
 *
 * Generated code has nowhere to keep an arena, and threading one through every
 * allocating operation would put a compiler's bookkeeping into the calling
 * convention.  One heap per program is the simpler arrangement, and the one the
 * bootstrap wants anyway.
 */
void      l0p_boot(void);
L0pArena *l0p_heap(void);
void      l0p_abort(void);
void      l0p_type_error(const char *op, const L0pValue *a, const L0pValue *b);
void      l0p_div_zero(void);

/* ----------------------------------------------------------------- values */

L0pValue l0p_null(void);
L0pValue l0p_bool(int b);
L0pValue l0p_int(int64_t v);
L0pValue l0p_float(double v);
L0pValue l0p_str(L0pStr *s);
L0pValue l0p_make_list(L0pArena *a, uint64_t n);
int      l0p_truthy(L0pValue v);
int      l0p_values_eq(L0pValue a, L0pValue b);
const char *l0p_type_name(L0pValue v);

L0pList  *l0p_list_push(L0pArena *a, L0pList *l, L0pValue v);
L0pValue l0p_list_get(L0pList *l, int64_t i);
void     l0p_list_set(L0pList *l, int64_t i, L0pValue v);

/* -------------------------------------------------------------- printing */

/*
 * Writing goes through write(2) on a raw descriptor, not through stdio.  stdio
 * buffers, and a program that writes a lot then exits can lose the tail; this
 * cannot.  `l0p_print_*` are the primitives the REPL and the benchmarks use.
 */
void l0p_print_str(const char *s, uint64_t n);
void l0p_print_l0p_str(L0pStr *s);
void l0p_print_i64(int64_t v);
void l0p_print_double(double v);
void l0p_print_newline(void);
void l0p_print_value(L0pValue v);
void l0p_print_err(const char *s, uint64_t n);

/*
 * Write a literal to stderr, length computed rather than counted.
 *
 * Every call site of `l0p_print_err` with a hand-written length was a chance to
 * be off by one, and several were: a length one too long writes the literal's
 * own NUL terminator, and one too short truncates the message.  Neither shows up
 * as a crash -- stderr just comes out slightly wrong, which is exactly the kind
 * of defect that survives review.  `sizeof(literal) - 1` cannot be miscounted.
 */
#define L0P_ERR(s) l0p_print_err((s), sizeof(s) - 1)

/*
 * Write a C string to stderr, length taken with strlen.
 *
 * For text that is not a literal at the call site -- a type name, an operator
 * -- where `sizeof` would measure the pointer rather than the string.
 */
void l0p_err_cstr(const char *s);

/* ------------------------------------------------------------- debugging */

/*
 * Two halves of one operation, so a fault can say where it was.  The C side
 * captures the frame pointer chain; the assembly side knows the instruction
 * pointer, which C cannot portably read.
 */
uint64_t l0p_here(void);
void     l0p_trace_probe(const uint64_t *out, uint64_t depth);

/*
 * uint64_t l0p_abi_probe(a, b, c, d, e, f, g, h)
 *
 * Returns a*1 + b*2 + ... + h*8 from assembly.  Exists so a test can assert that
 * the calling convention the code generator emits is the one it was written
 * against, rather than discovering it as a wrong answer much later.
 */
uint64_t l0p_abi_probe(uint64_t, uint64_t, uint64_t, uint64_t,
                       uint64_t, uint64_t, uint64_t, uint64_t);

#endif /* L0P_RT_H */

/* ------------------------------------------------------- lists and dicts */

/*
 * A list built from an argument array.
 *
 * Generated code always has its arguments in one contiguous array, so this is
 * the shape the backend actually wants; `l0p_make_list` alone would leave the
 * code to fill the slots one call at a time.
 */
L0pValue l0p_list_from(const L0pValue *items, uint64_t n);
L0pValue l0p_list_push_val(L0pList *l, L0pValue v);
uint64_t l0p_list_len(L0pList *l);

/* A cursor over a list.  Owned by the arena; there is nothing to free. */
typedef struct L0pIter {
    L0pList *list;
    uint64_t at;
} L0pIter;

L0pIter *l0p_iter_new(L0pValue seq);
L0pValue  l0p_iter_value(L0pIter *it);
/* 1 while there is another element, 0 when the sequence is exhausted. */
int      l0p_iter_more(L0pIter *it);
/* The next element, and advances.  Undefined once `more` is false. */
L0pValue l0p_iter_next(L0pIter *it);

/* A dictionary.  Keys are strings, which is all the language's literals produce. */
struct L0pDict {
    uint64_t    len;
    uint64_t    cap;
    const char **keys;
    L0pValue    *vals;
};

L0pValue l0p_dict_from(const L0pValue *items, uint64_t pairs);
L0pValue l0p_dict_get(L0pDict *d, L0pStr *key);
void     l0p_dict_set(L0pDict *d, L0pStr *key, L0pValue v);
uint64_t l0p_dict_len(L0pDict *d);

/* ------------------------------------------------------ strings and types */

L0pValue l0p_str_new_value(const char *s, uint64_t n);
L0pValue l0p_str_len(L0pStr *s);
uint64_t l0p_utf8_len(const char *s, uint64_t bytes);
int64_t  l0p_utf8_at(const char *s, uint64_t bytes, int64_t index);
L0pValue l0p_to_str(L0pValue v);
L0pValue l0p_to_int(L0pValue v);
L0pValue l0p_to_float(L0pValue v);
L0pValue l0p_type_of(L0pValue v);

/* A variadic built-in, called through `L0pFn::native`. */
L0pValue l0p_bi_print(uint64_t argc, const L0pValue *argv, void *env);
L0pValue l0p_bi_len(uint64_t argc, const L0pValue *argv, void *env);
L0pValue l0p_bi_str(uint64_t argc, const L0pValue *argv, void *env);
L0pValue l0p_bi_int(uint64_t argc, const L0pValue *argv, void *env);
L0pValue l0p_bi_float(uint64_t argc, const L0pValue *argv, void *env);
L0pValue l0p_bi_bool(uint64_t argc, const L0pValue *argv, void *env);
L0pValue l0p_bi_type(uint64_t argc, const L0pValue *argv, void *env);

/*
 * A built-in looked up by name, returning a callable value.
 *
 * The backend resolves the name once per call site rather than emitting a static
 * table of function descriptors.  Binding them statically is worth doing and
 * belongs with the register allocator, where binding is a matter of knowing the
 * address; doing it here would add a data section for no measurable gain.
 */
L0pValue l0p_builtin(const char *name);

/* The for-loop cursor, exposed so generated code can hold one in a slot. */
L0pValue l0p_bi_iter(uint64_t argc, const L0pValue *argv, void *env);
L0pValue l0p_bi_iter_more(uint64_t argc, const L0pValue *argv, void *env);
L0pValue l0p_bi_iter_next(uint64_t argc, const L0pValue *argv, void *env);

/* ------------------------------------------------------ indexing and fields */

/*
 * Reading and writing a subscript.
 *
 * One function for lists and dictionaries rather than two code paths in the
 * backend: the index expression is the same either way, and deciding here means
 * the difference in what `d['k']` and `a[0]` mean lives in one place.
 */
L0pValue l0p_index_get(L0pValue seq, L0pValue key);
void     l0p_index_set(L0pValue seq, L0pValue key, L0pValue v);
L0pValue l0p_field_get(L0pValue obj, const char *name);
void     l0p_field_set(L0pValue obj, const char *name, L0pValue v);
