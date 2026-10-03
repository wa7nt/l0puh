# l0puh

A small programming language: Python-shaped syntax, Go-shaped concurrency, and a
compiler that emits real x86-64 machine code.

```
$ l0p run examples/tour.l0p
30
```

**Status: the language runs, and it runs natively.** A bytecode interpreter and an
x86-64 backend share one front end, and every native result is checked against the
interpreter's. `spawn`, `await` and the standard library are parsed but not yet
implemented; the compiler names the ones it has not reached rather than silently
miscompiling them.

| | |
|---|---|
| Tests | 440, all passing, types checked |
| Runtime dependencies | none; `typescript` for checking only |
| Backend | x86-64 machine code, via clang as assembler and linker |

## Speed

Measured on `fib(32)` -- 28 million calls, so dominated by arithmetic -- on an
i5-7360U:

| | time | |
|---|---|---|
| interpreter | ~7.2 s | |
| native, every operation a call into C | ~250 ms | **×29 faster** |
| native, integer arithmetic inlined | ~150 ms | **×48 faster** |
| native, constants inlined as immediates | ~130 ms | **×55 faster** |

Taking the call away is worth ×1.67, and that is the second row to the third.  The
first row to the second is the backend existing at all.

Neither figure is exact and the spread is wide, because **code alignment alone
moves a benchmark by 14%**.  Seven binaries, byte-identical except for one to
eight `nop`s between the prologue and the loop, ranged from 355ms to 403ms on
the same source.  So every number here is the mean of seven such builds:

| alignment (nops) | 0 | 1 | 2 | 3 | 4 | 6 | 8 |
|---|---|---|---|---|---|---|---|
| calling into C | 204 | 205 | 246 | 287 | 265 | 277 | 270 |
| inlined | 138 | 155 | 148 | 159 | 173 | 151 | 128 |

The inline won in seven of seven, from ×1.32 to ×2.10, mean ×1.67.  A single
build is worth about as much as its alignment -- which is why a number measured on
one is only worth the noise.

Inlining does not always pay.  `/`, `//` and `%` looked like the same win and
were a 26% loss: `idiv` raises #DE on a zero divisor and on INT64_MIN / -1,
#DE is not catchable, and guarding both costs four more branches than the call
saves.  Measured across seven alignments, slower in seven of seven.  Those stay
in the runtime.

What is left is the rest of the gap.  Every value still lives in a 16-byte stack
slot, so every operation still loads two slots, stores one, and cannot keep
anything in a register.  Type inference in the IR would let the tag checks go and
halve the slot, and a register allocator would end the loads.  Those are the two
steps that matter, and neither is a trick.

## Running it

No dependencies, no build step. Node 24 strips the types at runtime. A C compiler
is needed only for the native backend.

```
node src/cli/main.ts run FILE      # run a program
node src/cli/main.ts run FILE.l0p  # same, without naming the command
node src/cli/main.ts parse FILE    # print the syntax tree
node src/cli/main.ts lex FILE      # print the token stream
node src/cli/main.ts ir FILE       # print the native intermediate representation
node src/cli/main.ts disasm FILE   # print the compiled bytecode
node src/cli/main.ts repl          # interactive prompt
npm test                          # 440 tests, types checked
node --test "test/*.test.ts"       # tests alone
```

`l0p` also runs the file directly if you pass one as the first argument, and `l0p`
on its own opens the prompt.

## The language

```l0p
import math                       # import a.b as ab
from json import dumps            # from . import sibling
from ..pkg import thing

const LIMIT = 100                 # compile-time constant
let total = 0                     # immutable
var counter = 0                   # mutable

def fib(n):                      # definitions
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

struct Point:                    # a record with defaults
    x = 0
    y = 0

let p = Point(1, 2)             # call to construct; bare `Point` is all-defaults

let add = (a, b = 2) -> a + b     # lambda
let xs = [1, 2, 3]                # list
let m = {"k": 1}                  # dict
let s = "hello, ${name}"          # interpolation

for x in xs:                     # loops
    total += add(x, 2)

while total > 0:                 # conditionals
    total -= 1

let f = a if c else b             # also: c ? a : b
```

### Decisions worth knowing

- **No keyword list.** `let`, `import` and `def` are ordinary identifiers until the
  parser wants them, so they remain usable as variable names.
- **Indentation is significant.** Blank and comment-only lines never affect it.
  Tabs advance to the next multiple of 8. Continuation works inside brackets
  only — there is no backslash continuation, by design.
- **No type annotations.** Inference is future work.
- **`let` is enforced.** Assigning to a `let`, a `const` or a `def` is a runtime
  error, not a convention.
- **Arithmetic is strict.** `"a" * 2` and `true + 1` are type errors rather than
  `0` and `2`. The runtime says so instead of coercing, because a wrong answer of
  the right shape is much harder to notice than a refusal.
- **Strings are counted in characters, not bytes.** `len("привет")` is 6 and
  `"привет"[0]` is `п`, though the runtime stores text as UTF-8 bytes.
- **`await` and `spawn` parse but do not run yet** — they need a task model. The
  parser accepts them so the grammar is settled; the compiler says so by name when
  it meets one.
- **A package is a directory.** There is no `__init__.l0p`, because Python's
  exists only to tell a package from a namespace package and there is no such
  distinction here.
- **`from m import x as y` is not supported** and says so; `import m` then `m.y`
  is the way.
- **String `+` adds two strings and nothing else.** `"a" + 1` is a type error;
  `"a${1}"` is the way to interpolate.

## How it is built

Two backends, one front end. The interpreter is kept deliberately: it is the
reference the native one is checked against, and the REPL needs it.

```
                     ┌→ bytecode → VM                    (reference, REPL)
source → lexer → parser → AST → lower → SSA IR → x86-64  (native)
                     │
                     └→ compiler → bytecode
```

The native path goes through SSA because register allocation is impossible
without it: two writes to one variable have to become two distinct values before a
register can be handed to each, and only SSA says which two.

| | |
|---|---|
| `src/token.ts` | token types, the operator table |
| `src/errors.ts` | one error type carrying a position |
| `src/lexer.ts` | line-oriented, so indentation works |
| `src/ast.ts` `src/parser.ts` | the tree and the Pratt parser |
| `src/ir/ir.ts` | the intermediate representation: values, blocks, phis |
| `src/ir/build.ts` | SSA construction, by building rather than by analysis |
| `src/ir/lower.ts` | AST to IR |
| `src/ir/verify.ts` | checks the function really is in SSA |
| `src/ir/codegen.ts` | IR to x86-64 assembly |
| `src/bytecode/` `src/compile/` `src/vm/` | the interpreter's own pipeline |
| `src/module/` | resolution, caching, cycle detection |
| `rt/l0p_rt.c` `rt/l0p_rt.h` | arena, values, lists, dicts, strings, utf-8 |
| `rt/l0p_abi.s` | the two things C cannot do: the instruction pointer, frame walks |
| `src/rt/build.ts` | assembly and runtime to an executable |
| `src/session.ts` | the only place that knows the whole pipeline |

### Five decisions that are load-bearing

**The VM does not recurse into JavaScript for calls.** Every frame lives in one
explicit array. A recursive interpreter is shorter, but its call stack lives in V8
and cannot be suspended, so `spawn` could not save its position without an OS
thread. With explicit frames, a task is a slice of that array and suspending is
remembering where the frames end. This is also why tail calls are free here.
Getting this wrong would mean rewriting the VM when async arrives.

**An upvalue is a `{frame, slot}` pair, not a copied value.** The frame is the
container, so a closure reads and writes the same storage the enclosing function
does, and `var` inside a closure behaves without a separate cell array.

**SSA is built by construction, not by analysis.** The IR builder keeps a map from
each bound name to the value currently holding it, and a write allocates a new
virtual register. That yields SSA directly, with no dominator tree and no second
pass.

**A local is a value, not a frame slot.** There is deliberately no `load.local` in
the IR. Deciding whether a value lives in a register or on the stack is the
backend's job, and putting frame slots in the front end would make every later
spill a change to the wrong layer.

**The native backend returns through a pointer.** The SysV convention for a
16-byte value is `rax:rdx`, but generated code takes `(L0pValue *ret, uint64_t
argc, L0pValue *argv)` instead — so a compiled function can be called from
hand-written C with no shim, and a shim is exactly where argument-order bugs hide.

## How the native backend is tested

Every native result is compared against the interpreter's, by running both and
comparing what they wrote. A list of expected values would be a list of beliefs
about what the program should do; this is a comparison, and it fails the moment
either side drifts.

That has already paid for itself. Differential testing found a bug in the
interpreter itself: `UN_NEG` and `BIN_ADD` were both opcode 0, so `-a` dispatched
through the binary table ran `a + 0`. Every negative number in the language was
positive, and 270 tests had not noticed because binary subtraction was correct.

It also found a UTF-16 length used where UTF-8 bytes were needed, a double literal
whose bits were truncated by a trip through a JavaScript `number`, and a value
whose tag and payload were written the wrong way round. Each produced a plausible
wrong answer rather than a crash, which is why the comparison is the check.

## Roadmap

| | |
|---|---|
| M0–M2 | skeleton, lexer, parser — done |
| M3 | modules: resolution, cache, `__name__`, cycle detection — done |
| M4–M6 | bytecode compiler, the VM, functions, closures, `struct`, dicts — done |
| M11 | the IR, in SSA form, with a verifier that checks dominance — done |
| M12 | the native runtime: arena, values, the C ABI — done |
| M13 | x86-64 code generation, the calling convention, recursion — done |
| M14 | lists, dicts, strings, `for`, the built-ins — done |
| M15 | TREE for recursion, and a register allocator |
| M16–M17 | compile the compiler with itself, to a fixpoint |
| M7 | async: channels, `spawn`, `select`, cancellation |
| M10 | standard library, `fmt`, LSP |

### On speed, and why not WASM

The plan originally had WASM as the second backend, because a bytecode VM reaches
maybe ×1.5–3 of compiled Go and WASM gets part of the way back. Writing an x86-64
backend directly reaches ×26 now, and the IR it reads is not a bytecode — it is
SSA, which is what a register allocator needs and a bytecode is not.

Every value currently lives in a stack slot and every operation is a call into C.
Two changes account for most of what is left, and both are in M15: a register
allocator, and inlining the integer fast path so `a + b` on two ints is two
instructions instead of a call.

### On self-hosting

M16 compiles the compiler with itself, and M17 iterates to a fixpoint. That is the
part that makes the rest worth having: a compiler whose output is checked by a
different implementation of the same language is a compiler whose bugs have to
survive two independent readings. The arena with no collector is chosen for the
bootstrap specifically — a collector in the startup path is a month of debugging
spent on something the bootstrap does not need.

Two decisions that only pay off later: `buf` is meant to be a byte buffer over
`Uint8Array` with direct indexed access, and `u64` is a pair of `i32` halves
rather than a `BigInt` — V8 handles `BigInt` badly, and the same trick had to be
used by hand in the Go code this is measured against.
