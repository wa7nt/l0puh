/**
 * The interpreter.
 *
 * One loop, one `switch`, no JavaScript recursion for calls.  That is the
 * decision everything else here follows from.
 *
 * A recursive interpreter would be shorter, but its call stack lives in V8 and
 * cannot be suspended, so a `spawn` could not save its position without an OS
 * thread.  Keeping every frame in an explicit array means a task is just a
 * slice of that array: suspending is remembering where the frames end, and
 * resuming is putting the rest back.  That is the whole basis for the
 * stackful coroutines in M7, and it is also why tail calls here are free.
 *
 * Operand stack and frame stack are both plain arrays reused across calls to
 * `run`, so entering a module does not allocate them.
 */

import type { Binding } from "../ast.ts";
import { constLabel, type Constant, type ImportSpec, type Module, type Proto } from "../bytecode/code.ts";
import { binName, formatCode, OP, OP_NAME, unName, BIN, UN, type Op } from "../bytecode/op.ts";

// The operator indices are frozen here as plain literals on purpose.  A `switch`
// over *imported* constants does not become a jump table in V8 -- it stays a
// chain of comparisons, measured at 274 ms against 122 ms for the same switch
// with literal labels.  `test/vm.test.ts` asserts these still match BIN, so
// they cannot drift.
const BIN_ADD = 0;
const BIN_SUB = 1;
const BIN_MUL = 2;
const BIN_DIV = 3;
const BIN_FLOORDIV = 4;
const BIN_MOD = 5;
const BIN_POW = 6;
const BIN_EQ = 7;
const BIN_NE = 8;
const BIN_LT = 9;
const BIN_LE = 10;
const BIN_GT = 11;
const BIN_GE = 12;
const BIN_AND = 13;
const BIN_OR = 14;
const BIN_XOR = 15;
const BIN_SHL = 16;
const BIN_SHR = 17;
const BIN_IN = 18;
const BIN_NOTIN = 19;
const UN_NEG = 0;
const UN_POS = 1;
const UN_INVERT = 2;
const UN_NOT = 3;
import { L0pError } from "../errors.ts";
import {
  Builtin, Closure, Dict, DONE, ModuleRef, repr, Struct, StructType, toDisplay,
  truthy, type Frame, type Iterator, type Value,
} from "./value.ts";
import { makeBuiltins } from "./builtins.ts";

export interface RunOptions {
  /** Printed by `print`; the default writes to stdout. */
  print?: (text: string) => void;
  /**
   * Module-level names to use instead of a fresh map.  A REPL passes the same
   * map every time so definitions survive; a one-shot run leaves it undefined.
   */
  globals?: Map<string, Value>;
}

export class Vm {
  /** Reused across `run` calls; not reentrant, and it does not need to be. */
  private readonly stack: Value[] = [];
  private readonly frames: Frame[] = [];
  private readonly loader: ModuleLoaderLike | null;
  /*
   * Replaced on every `run`, so that a REPL can redirect output without
   * constructing a VM per line.  Not readonly, for that reason.
   */
  private printed: (text: string) => void;
  /**
   * Retired frames, ready to be reused.  Cleared whenever the stacks are, so a
   * failure cannot leave one holding a live frame.
   */
  private readonly pool: Frame[] = [];
  /** Struct types by name, so a field map is built once and reused. */
  private readonly types = new Map<string, StructType>();
  /** Declared field defaults, by type name, for `Point()`. */
  private readonly defaults = new Map<string, Value[]>();

  constructor(loader: ModuleLoaderLike | null = null, options: RunOptions = {}) {
    this.loader = loader;
    this.printed = options.print ?? ((text) => process.stdout.write(`${text}\n`));
  }

  print(text: string): void {
    this.printed(text);
  }

  /** Runs a module body and returns the value of its last expression. */
  run(module: Module, options: RunOptions = {}): Value {
    if (options.print !== undefined) this.printed = options.print;

    const globals = options.globals ?? new Map<string, Value>();
    // A fresh map needs the builtins.  A carried-over one already has them:
    // seeding again would cost nothing but says nothing either way, so the
    // check is what keeps a REPL's namespace stable.
    if (!globals.has("print")) {
      for (const [name, value] of makeBuiltins()) globals.set(name, value);
    }
    installMeta(globals, module);

    const entry = module.protos[module.entry] as Proto;
    // `escaped` is set on every frame, including this one: a pooled frame is
    // recycled on the assumption the field exists, and a missing field reads as
    // `undefined`, which would be a false "not captured".
    this.frames.push({
      proto: entry,
      closure: new Closure(entry, []),
      slots: new Array<Value>(entry.nslots).fill(null),
      base: 0,
      retIp: 0,
      retFrame: 0,
      module,
      globals,
      escaped: false,
    });

    let result: Value = null;
    try {
      result = this.execute();
    } catch (e) {
      if (e instanceof RangeError && /call stack/i.test(e.message)) {
        throw new L0pError("stack overflow: the recursion is too deep to run", 0, 0, module.file);
      }
      throw e;
    } finally {
      // A program that threw must not leave the shared stacks dirty: the REPL
      // runs many programs through one VM, and the next one would die on the
      // previous failure's leftovers.
      this.frames.length = 0;
      this.stack.length = 0;
      this.pool.length = 0;
    }

    return result;
  }

  // -------------------------------------------------------------- frames

  /**
   * Enters a function.
   *
   * The frame comes from a pool rather than being allocated, and its slot array
   * is reused and re-cleared.  Together those are the whole difference between a
   * call costing a few hundred nanoseconds and a few dozen: a million calls that
   * each allocate two objects is a million objects for V8 to trace.
   *
   * A frame a closure captured does not go back into the pool, because the
   * closure is still holding it.
   */
  private pushFrame(
    module: Module,
    closure: Closure,
    globals: Map<string, Value>,
    argCount: number,
  ): void {
    const proto = closure.proto;
    // `base` points at the callee, not at the first argument: dropping the
    // frame's operands has to remove the callee too, or it stays behind and the
    // stack grows by one slot per call.
    const base = this.stack.length - argCount - 1;

    // Slots 0..nparams-1 are the parameters, so the arguments have to be read
    // off the stack whichever frame is used.  Doing this once, before the two
    // paths, is why a fresh frame cannot forget them.
    const n = proto.nslots;
    const given = proto.params.length < argCount ? proto.params.length : argCount;

    const frame = this.pool.pop();
    if (frame === undefined) {
      const slots = new Array<Value>(n).fill(null);
      for (let i = 0; i < given; i++) slots[i] = this.stack[base + 1 + i] as Value;
      this.frames.push({
        proto,
        closure,
        slots,
        base,
        retIp: 0,
        retFrame: 0,
        module,
        globals,
        escaped: false,
      });
      return;
    }

    const slots = frame.slots;
    // Every slot this proto can reach is cleared.  A pooled array may be longer
    // than `n`, but the tail belongs to some other proto and will be cleared
    // when that one is entered.
    for (let i = 0; i < n; i++) slots[i] = null;
    for (let i = 0; i < given; i++) slots[i] = this.stack[base + 1 + i] as Value;

    frame.proto = proto;
    frame.closure = closure;
    frame.base = base;
    frame.retIp = 0;
    frame.retFrame = 0;
    frame.module = module;
    frame.globals = globals;
    this.frames.push(frame);
  }

  /**
   * The interpreter loop.  Returns when the frame it was started for finishes.
   *
   * `baseDepth` is how many frames belong to the caller and must survive: a
   * module body run from inside an import is entered with the importing
   * program's frames already on the stack, and it has to stop when *its* frame
   * is done rather than when the stack is empty.
   *
   * `ip` is hoisted deliberately: the whole point of the `switch` is that V8
   * can compile it into a jump table.
   */
  private execute(baseDepth = 0): Value {
    const stack = this.stack;
    const frames = this.frames;

    let ip = 0;
    // `frame`, `code`, `slots` and `constValues` are hoisted out of the dispatch
    // loop and refreshed only when the frame changes.  Reading four properties
    // per instruction instead of per frame switch was, measurably, most of what
    // was left in the loop: 305 ms for a five-instruction body became 240 ms
    // the moment they moved.
    let frame = frames[frames.length - 1] as Frame;
    let code = frame.proto.code;
    let slots = frame.slots;
    let constValues = frame.proto.constValues;
    let proto = frame.proto;

    for (;;) {
      if (ip >= code.length) {
        if (frames.length <= baseDepth + 1) return this.resultOf(frame);
        this.popFrame();
        frame = frames[frames.length - 1] as Frame;
        proto = frame.proto;
        code = proto.code;
        slots = frame.slots;
        constValues = proto.constValues;
        ip = frame.retIp;
        continue;
      }
      const o = code[ip++] as Op;
      const line = o.line;

      switch (o.op) {
        // ------------------------------------------------------- constants
        case OP.Const:
          // One array read: the value was resolved when the module compiled.
          stack.push(constValues[o.a] as Value);
          break;

        case OP.Pop:
          stack.pop();
          break;

        case OP.Dup:
          stack.push(stack[stack.length - 1] as Value);
          break;

        case OP.Concat: {
          // parts were pushed in order; take the last n and join them
          const n = o.a;
          const at = stack.length - n;
          let out = "";
          for (let i = at; i < stack.length; i++) out += toDisplay(stack[i] as Value);
          stack.length = at;
          stack.push(out);
          break;
        }

        // -------------------------------------------------------- variables
        case OP.LoadLocal:
          stack.push(slots[o.a] as Value);
          break;

        case OP.StoreLocal: {
          const value = stack[stack.length - 1] as Value;
          // b === 1 is a declaration; only a plain assignment is held to the
          // binding kind, the same rule StoreGlobal follows.
          if (o.b === 0) this.checkSlot(frame, o.a, line);
          slots[o.a] = value;
          break;
        }

        case OP.LoadUpval: {
          const up = (frame.closure as Closure).upvalues[o.a];
          if (up === undefined) throw this.error(frame, line, "upvalue is missing");
          stack.push(up.frame.slots[up.slot] as Value);
          break;
        }

        case OP.StoreUpval: {
          const up = (frame.closure as Closure).upvalues[o.a];
          if (up === undefined) throw this.error(frame, line, "upvalue is missing");
          up.frame.slots[up.slot] = stack[stack.length - 1] as Value;
          break;
        }

        case OP.LoadGlobal: {
          const name = (frame.proto.consts[o.a] as Constant & { type: "string" }).value;
          const globals = frame.globals;
          if (!globals.has(name)) {
            throw this.error(frame, line, `no such name: ${name}`);
          }
          stack.push(globals.get(name) as Value);
          break;
        }

        case OP.StoreGlobal: {
          const name = (frame.proto.consts[o.a] as Constant & { type: "string" }).value;
          // b === 1 means this store *creates* the binding, which is what a
          // declaration, a `def` and a for-loop variable all are.  Only a real
          // assignment has to be checked against what the name already is.
          if (o.b === 0) this.checkGlobal(frame, name, line);
          frame.globals.set(name, stack[stack.length - 1] as Value);
          break;
        }

        // --------------------------------------------------------- objects
        case OP.NewList: {
          const n = o.a;
          const items = new Array<Value>(n);
          for (let i = n - 1; i >= 0; i--) items[i] = stack.pop() as Value;
          stack.push(items);
          break;
        }

        case OP.NewDict: {
          const entries: [Value, Value][] = new Array(o.a);
          // Pushed key-first, so the last pair is on top; filling from the end
          // keeps the source order rather than reversing it.
          for (let i = o.a - 1; i >= 0; i--) {
            const value = stack.pop() as Value;
            entries[i] = [stack.pop() as Value, value];
          }
          stack.push(Dict.of(entries));
          break;
        }

        case OP.NewStruct: {
          // Always follows a `StructType`, which has already taken the defaults
          // off the stack and stored them on the type.  Copying them means a
          // later `Point()` cannot be changed by writing to this instance.
          const typeName = (frame.proto.consts[o.a] as Constant & { type: "string" }).value;
          const type = this.types.get(typeName) as StructType;
          const values = [...(this.defaults.get(typeName) ?? new Array<Value>(type.fields.length).fill(null))];
          stack.push(new Struct(type, values));
          break;
        }

        case OP.StructType: {
          // The field defaults are on the stack underneath; the type keeps a
          // copy of them so `Point()` and a bare `Point` both have them, and the
          // next instruction builds the instance.
          const typeName = (frame.proto.consts[o.a] as Constant & { type: "string" }).value;
          const fields = (frame.proto.consts[o.b] as Constant & { type: "fields" }).value;
          const type = this.structType(typeName, fields.map((f) => f.name));
          // The defaults are on the stack now, and this consumes them: they
          // belong to the type, and the instance is built from them next.
          const defaults = new Array<Value>(fields.length);
          for (let i = fields.length - 1; i >= 0; i--) defaults[i] = stack.pop() as Value;
          this.defaults.set(typeName, defaults);
          stack.push(new Closure(type.entry, [], null, typeName, type));
          break;
        }

        case OP.GetIndex: {
          const index = stack.pop() as Value;
          const obj = stack.pop() as Value;
          stack.push(getIndex(obj, index, (m) => this.error(frame, line, m)));
          break;
        }

        case OP.SetIndex: {
          const value = stack.pop() as Value;
          const index = stack.pop() as Value;
          const obj = stack.pop() as Value;
          try {
            setIndex(obj, index, value);
          } catch (e) {
            throw this.error(frame, line, (e as Error).message);
          }
          stack.push(value);
          break;
        }

        case OP.GetAttr: {
          const name = (frame.proto.consts[o.a] as Constant & { type: "string" }).value;
          const obj = stack.pop() as Value;
          stack.push(getAttr(obj, name, (m) => this.error(frame, line, m)));
          break;
        }

        case OP.SetAttr: {
          const name = (frame.proto.consts[o.a] as Constant & { type: "string" }).value;
          const value = stack.pop() as Value;
          const obj = stack.pop() as Value;
          try {
            setAttr(obj, name, value, (m) => new Error(m));
          } catch (e) {
            throw this.error(frame, line, (e as Error).message);
          }
          stack.push(value);
          break;
        }

        // -------------------------------------------------------- operators
        // Arithmetic and comparison dispatch on the operator's *index*, not its
        // name: going through `binName` made a small integer switch a string
        // switch, the same mistake the opcode table was.
        //
        // No try/catch here.  A `try` in a loop body stops V8 optimising the
        // whole block, and it cost more than the error message it wrapped: the
        // type check is done inline and only the failing path builds a message.
        case OP.Bin: {
          const right = stack[stack.length - 1] as Value;
          const left = stack[stack.length - 2] as Value;
          const which = o.a;
          if (typeof left === "number" && typeof right === "number") {
            // Only the three operators that can divide need guarding, and doing
            // it here keeps the hot path free of a try/catch -- which stops V8
            // optimising the whole block.
            if (which === BIN_DIV || which === BIN_FLOORDIV || which === BIN_MOD) {
              if (right === 0) {
                stack.length = stack.length - 2;
                throw this.error(frame, line, "division by zero");
              }
            }
            stack[stack.length - 2] = arithFast(which, left, right);
          } else if (which === BIN_ADD) {
            // `+` is the one operator that is not numeric: two strings join and
            // two lists concatenate, and anything else is a type error.
            if (typeof left === "string" && typeof right === "string") {
              stack[stack.length - 2] = left + right;
            } else if (Array.isArray(left) && Array.isArray(right)) {
              stack[stack.length - 2] = [...left, ...right];
            } else {
              stack.length = stack.length - 2;
              throw this.error(frame, line, typeMessage(binName(which), left, right));
            }
          } else if (which === BIN_EQ || which === BIN_NE) {
            // `==` compares structurally, so two lists or two dicts work
            const same = equals(left, right);
            stack[stack.length - 2] = which === BIN_EQ ? same : !same;
          } else if (which === BIN_IN || which === BIN_NOTIN) {
            const found = contains(right, left);
            stack[stack.length - 2] = which === BIN_IN ? found : !found;
          } else if (isComparison(which) && typeof left === "string" && typeof right === "string") {
            // strings compare too, and are the only non-numeric operands that do
            stack[stack.length - 2] = compareStrings(which, left, right);
          } else {
            stack.length = stack.length - 2;
            throw this.error(frame, line, typeMessage(binName(o.a), left, right));
          }
          stack.length = stack.length - 1;
          break;
        }

        case OP.Un: {
          const operand = stack[stack.length - 1] as Value;
          if (o.a === UN_NOT) {
            // `not` accepts anything; only the three arithmetic ones are numeric
            stack[stack.length - 1] = !truthy(operand);
          } else if (typeof operand === "number") {
            /*
             * `unaryFast`, not `arithFast(UN_NEG + o.a, ...)`.
             *
             * The two opcode spaces overlap: UN_NEG is 0 and BIN_ADD is 0, so
             * `-a` dispatched through the binary table ran `a + 0`.  For a
             * positive literal that is invisible -- `-7 + 0` is `-7` -- and the
             * operand here is the unsigned literal anyway, so the result was the
             * literal itself.  `-7` evaluated to 7, `-7 * 2` to 14, and the only
             * symptom was that every negative number in the language was
             * positive.
             *
             * Found by the native backend's differential tests, which is the
             * argument for having an interpreter to check against rather than a
             * list of expected values.
             */
            stack[stack.length - 1] = unaryFast(o.a, operand);
          } else {
            stack.length = stack.length - 1;
            throw this.error(frame, line, typeMessage(unName(o.a), operand, null));
          }
          break;
        }

        case OP.Not:
          stack.push(!truthy(stack.pop() as Value));
          break;

        // ------------------------------------------------------------ jumps
        case OP.Jump:
          ip = o.a;
          break;

        case OP.JumpIfFalse:
          if (!truthy(stack.pop() as Value)) ip = o.a;
          break;

        case OP.JumpIfTrue:
          if (truthy(stack.pop() as Value)) ip = o.a;
          break;

        // `and`: keep the left value if it is false, else evaluate the right
        case OP.JumpIfFalseOrPop:
          if (!truthy(stack[stack.length - 1] as Value)) ip = o.a;
          break;

        case OP.JumpIfTrueOrPop:
          if (truthy(stack[stack.length - 1] as Value)) ip = o.a;
          break;

        // ------------------------------------------------------------- loops
        case OP.GetIter: {
          const obj = stack.pop() as Value;
          const it = makeIterator(obj, (m) => this.error(frame, line, m));
          stack.push(it as unknown as Value);
          break;
        }

        case OP.ForIter: {
          const it = stack[stack.length - 1] as unknown as Iterator;
          const next = it.next();
          if (next === DONE) {
            stack.pop(); // the iterator is finished
            ip = o.a;
            break;
          }
          stack.push(next);
          break;
        }

        // --------------------------------------------------------- functions
        case OP.Closure: {
          const proto = frame.module.protos[o.a] as Proto;
          stack.push(this.makeClosure(frame, proto));
          break;
        }

        case OP.Call: {
          // The callee sits immediately below its arguments; `at` is where the
          // result will go, so the callee's slot is reused for it.
          const at = stack.length - o.a - 1;
          const callee = stack[at] as Value;

          // A struct type is a callable value, so it has to be handled before
          // the general Closure path below.
          if (callee instanceof Closure && callee.structType !== null) {
            const type = callee.structType;
            if (o.a > type.fields.length) {
              throw this.error(frame, line, `${type.name} takes at most ${type.fields.length} arguments, got ${o.a}`);
            }
            // Fields not passed keep their declared default, so `Point(1)` and
            // `Point(1, 2)` both mean what they look like.
            const fresh = [...(this.defaults.get(type.name) ?? new Array<Value>(type.fields.length).fill(null))];
            for (let i = 0; i < o.a; i++) fresh[i] = stack[at + 1 + i] as Value;
            stack[at] = new Struct(type, fresh);
            stack.length = at + 1;
            break;
          }

          if (callee instanceof Builtin) {
            const args = stack.splice(at + 1, o.a);
            try {
              stack[at] = callee.fn(args, this);
            } catch (e) {
              if (e instanceof L0pError) throw e;
              throw this.error(frame, line, (e as Error).message);
            }
            break;
          }

          if (!(callee instanceof Closure)) {
            throw this.error(frame, line, `${describeCallee(callee)} is not callable`);
          }
          // The arguments stay on the stack; the new frame's base points at them
          // so they are read into slots, not copied.
          frame.retIp = ip;
          frame.retFrame = frames.length - 1;
          this.pushFrame(frame.module, callee, frame.globals, o.a);

          // Enter the callee.  Every hoisted value is refreshed here, because
          // this is the only other place the frame changes.
          frame = frames[frames.length - 1] as Frame;
          proto = frame.proto;
          code = proto.code;
          slots = frame.slots;
          constValues = proto.constValues;
          ip = 0;
          break;
        }

        case OP.Return: {
          if (frames.length <= baseDepth + 1) return stack.pop() as Value;
          const value = stack[stack.length - 1] as Value;
          stack.length = frame.base; // callee, arguments and operands all go
          this.frames.pop();
          if (!frame.escaped) this.pool.push(frame);
          stack.push(value); // the result takes the callee's place

          frame = frames[frames.length - 1] as Frame;
          proto = frame.proto;
          code = proto.code;
          slots = frame.slots;
          constValues = proto.constValues;
          ip = frame.retIp;
          break;
        }

        // ----------------------------------------------------------- modules
        case OP.Import: {
          this.doImport(frame, o.a);
          break;
        }

        case OP.Halt:
          if (frames.length <= baseDepth + 1) return this.resultOf(frame);
          this.popFrame();
          frame = frames[frames.length - 1] as Frame;
          proto = frame.proto;
          code = proto.code;
          slots = frame.slots;
          constValues = proto.constValues;
          ip = frame.retIp;
          break;

        default:
          throw this.error(frame, line, `unimplemented instruction ${OP_NAME[o.op] ?? o.op}`);
      }
    }
  }

  private popFrame(): void {
    const dead = this.frames.pop() as Frame;
    this.stack.length = dead.base;
    // A captured frame is still reachable from a closure, so recycling it would
    // make that closure see another call's locals.
    if (!dead.escaped) this.pool.push(dead);
  }

  /**
   * The name-to-slot map is built once per type, not once per instance: an
   * attribute lookup is a map read instead of a search over the field names.
   */
  private structType(name: string, fields: readonly string[]): StructType {
    const cached = this.types.get(name);
    if (cached !== undefined) return cached;
    const index = new Map<string, number>();
    fields.forEach((f, i) => index.set(f, i));
    const type = new StructType(name, fields, index);
    this.types.set(name, type);
    return type;
  }

  /**
   * What the module body evaluated to.  The compiler parks the last expression
   * in a reserved slot, because `Halt` runs after the value has been popped.
   */
  private resultOf(frame: Frame): Value {
    const slot = (frame.module as Module).resultSlot;
    if (slot === null) return null;
    return (frame.slots[slot] ?? null) as Value;
  }

  private makeClosure(frame: Frame, proto: Proto): Closure {
    const closure = frame.closure;
    // A closure holds the frame it was made in, so that frame is now reachable
    // from outside and must never be recycled.
    let ownsFrame = false;
    const upvalues = proto.upvalues.map((spec) => {
      if (closure === null) {
        throw this.error(frame, 0, `closure of ${proto.name} has no enclosing frame`);
      }
      if (spec.kind === "parent-local") {
        if (!frame.escaped) {
          frame.escaped = true;
          ownsFrame = true;
        }
        return { frame, slot: spec.slot };
      }
      const inherited = closure.upvalues[spec.index];
      if (inherited === undefined) throw this.error(frame, 0, `upvalue ${spec.index} is missing`);
      return inherited;
    });
    return new Closure(proto, upvalues);
  }

  // ------------------------------------------------------------- checking

  private checkSlot(frame: Frame, slot: number, line: number): void {
    const kind = frame.proto.slotKinds[slot];
    if (kind === "let" || kind === "const") {
      const name = frame.proto.params[slot] ?? `slot ${slot}`;
      throw this.error(frame, line, `cannot assign to ${name}: it is ${kind === "const" ? "a constant" : "immutable"}`);
    }
  }

  private checkGlobal(frame: Frame, name: string, line: number): void {
    const module = frame.module;
    const kind = module.globalKinds.get(name);
    if (kind === "let" || kind === "const" || kind === "def") {
      const what = kind === "def" ? "a function" : kind === "const" ? "a constant" : "immutable";
      throw this.error(frame, line, `cannot assign to ${name}: it is ${what}`);
    }
  }

  /**
   * A runtime error.  Only the line is known: the VM keeps line numbers on
   * instructions, not columns, so the caret goes to the start of the line.
   */
  private error(frame: Frame | undefined, line: number, message: string): L0pError {
    const module = frame?.module as Module | undefined;
    return new L0pError(message, line, 1, module?.file ?? null);
  }

  // -------------------------------------------------------------- modules

  private doImport(frame: Frame, specIndex: number): void {
    const loader = this.loader;
    if (loader === null) {
      throw this.error(frame, 0, "this program imports modules but has no module loader");
    }
    const module = frame.module;
    /*
     * The index comes from the bytecode, so it is not a value this code can trust.
     * Reading past the end gives `undefined`, and handing that to the loader would
     * be a fault inside the module system, far from the instruction that caused
     * it.  Checked here, where the position is still known.
     */
    const spec = module.imports[specIndex];
    if (spec === undefined) {
      throw this.error(frame, 0, `import instruction refers to statement ${specIndex}, which this module does not have`);
    }
    const current = currentModuleRecord(loader, module);
    const bindings = loader.resolveImport(spec, current);

    for (const binding of bindings) {
      if (binding.local === null) continue;
      frame.globals.set(binding.local, this.exportValue(binding.module, binding.attribute));
    }
  }

  /**
   * The value an import binds.
   *
   * The module runs first in both cases, as it does in Python: `import m` has
   * to leave `m` ready to use, and `from m import x` cannot read `x` out of a
   * module whose body has not run.  A package has no body and costs nothing.
   */
  private exportValue(module: ModuleRecordLike, attribute: string | null): Value {
    if (!module.executed) this.runModuleRecord(module);
    if (attribute === null) {
      return new ModuleRef(module.name, module.file, module.exports as Map<string, Value>);
    }
    if (!module.exports.has(attribute)) {
      const have = [...module.exports.keys()].join(", ") || "nothing";
      throw new L0pError(`module ${module.name} has no name ${attribute}; it has ${have}`);
    }
    return module.exports.get(attribute) as Value;
  }

  private runModuleRecord(record: ModuleRecordLike): void {
    if (record.executed) return;
    const loader = this.loader as ModuleLoaderLike;
    record.executed = true;
    if (record.program === null) return;

    const nested = loader.compileModule(record);
    const entry = nested.protos[nested.entry] as Proto;
    const globals = new Map<string, Value>();
    for (const [name, value] of makeBuiltins()) globals.set(name, value);
    installMeta(globals, nested);

    // Run the body over the shared stacks, starting from the current depth, then
    // publish its names.  `executed` is set before the body runs so that a
    // module importing itself is reported as a cycle rather than looping.
    const depth = this.frames.length;
    this.frames.push({
      proto: entry,
      closure: new Closure(entry, []),
      slots: new Array<Value>(entry.nslots).fill(null),
      base: this.stack.length,
      retIp: 0,
      retFrame: depth,
      module: nested,
      globals,
      /*
       * A module body captures nothing, so its frame is poolable.  Said
       * explicitly rather than left undefined: the pooling test reads this field
       * on every frame, and `!undefined` happens to be true, which is the same
       * answer for the wrong reason -- and would stop being the right answer the
       * day the test were written as `=== false`.
       */
      escaped: false,
    });
    try {
      this.execute(depth);
    } finally {
      this.frames.length = depth;
      this.stack.length = this.frames[depth - 1]?.base ?? 0;
    }

    // Export what the module itself declared, not everything reachable in its
    // scope: the builtins are visible to every module and are not the module's
    // to export.  `__name__` and `__file__` are metadata rather than
    // declarations, so they are added explicitly.
    const declared = (nested as Module).globalKinds;
    record.exports.clear();
    for (const name of declared.keys()) {
      if (globals.has(name)) record.exports.set(name, globals.get(name) as Value);
    }
    for (const meta of ["__name__", "__file__"] as const) {
      if (globals.has(meta)) record.exports.set(meta, globals.get(meta) as Value);
    }
  }
}

// --------------------------------------------------------------- helpers

function describeCallee(v: Value): string {
  if (v === null) return "null";
  return repr(v);
}

/** `__name__` and `__file__` are ordinary names, not special opcodes. */
function installMeta(globals: Map<string, Value>, module: Module): void {
  globals.set("__name__", module.name);
  globals.set("__file__", module.file);
}

// The loader's record shape, kept structural so the VM does not import it.
export interface ModuleRecordLike {
  name: string;
  file: string | null;
  program: unknown;
  exports: Map<string, unknown>;
  executed: boolean;
  dir: string;
}

export interface ModuleLoaderLike {
  resolveImport(stmt: ImportSpec, from: ModuleRecordLike): ImportBindingLike[];
  compileModule(record: ModuleRecordLike): Module;
  recordFor(module: Module): ModuleRecordLike;
}

export interface ImportBindingLike {
  local: string | null;
  kind: "module" | "submodule" | "attribute";
  module: ModuleRecordLike;
  attribute: string | null;
}

function currentModuleRecord(loader: ModuleLoaderLike, module: Module): ModuleRecordLike {
  return loader.recordFor(module);
}

// ------------------------------------------------------------ operations

export function getIndex(obj: Value, index: Value, fail: (m: string) => Error): Value {
  if (Array.isArray(obj)) {
    const at = arrayIndex(index, obj.length, fail);
    return obj[at] as Value;
  }
  if (typeof obj === "string") {
    const at = arrayIndex(index, obj.length, fail);
    return obj.charAt(at);
  }
  if (obj instanceof Dict) {
    const got = obj.get(index);
    if (got === undefined && !obj.has(index)) throw fail(`key not found: ${repr(index)}`);
    return got as Value;
  }
  if (obj instanceof Struct) {
    throw fail(`cannot index a ${obj.type.name}; use .field`);
  }
  throw fail(`cannot index ${describeCallee(obj)}`);
}

export function setIndex(obj: Value, index: Value, value: Value): void {
  if (Array.isArray(obj)) {
    if (typeof index !== "number" || !Number.isInteger(index)) {
      throw new Error(`list index must be an integer, got ${describeCallee(index)}`);
    }
    if (index < 0 || index >= obj.length) throw new Error(`list index out of range: ${index}`);
    obj[index] = value;
    return;
  }
  if (obj instanceof Dict) {
    obj.set(index, value);
    return;
  }
  throw new Error(`cannot assign into ${describeCallee(obj)}`);
}

export function getAttr(obj: Value, name: string, fail: (m: string) => Error): Value {
  if (obj instanceof Struct) {
    const got = obj.field(name);
    if (got === undefined) {
      const have = obj.type.fields.join(", ");
      throw fail(`${obj.type.name} has no field ${name}; it has ${have}`);
    }
    return got;
  }
  if (obj instanceof ModuleRef) {
    if (!obj.exports.has(name)) {
      const have = [...obj.exports.keys()].join(", ") || "nothing";
      throw fail(`module ${obj.name} has no name ${name}; it has ${have}`);
    }
    return obj.exports.get(name) as Value;
  }
  if (obj instanceof Dict) {
    if (obj.has(name)) return obj.get(name) as Value;
    const method = DICT_METHODS[name];
    if (method !== undefined) return new Builtin(name, (args) => method(obj, args));
    throw fail(`no key ${name}`);
  }
  if (Array.isArray(obj)) {
    const method = LIST_METHODS[name];
    if (method !== undefined) return new Builtin(name, (args) => method(obj, args));
  }
  if (typeof obj === "string") {
    const method = STRING_METHODS[name];
    if (method !== undefined) return new Builtin(name, (args) => method(obj, args));
  }
  throw fail(`${describeCallee(obj)} has no attribute ${name}`);
}

export function setAttr(obj: Value, name: string, value: Value, fail: (m: string) => Error): void {
  if (obj instanceof Struct) {
    const at = obj.type.index.get(name);
    if (at === undefined) throw fail(`${obj.type.name} has no field ${name}`);
    obj.values[at] = value;
    return;
  }
  throw fail(`cannot set ${name} on ${describeCallee(obj)}`);
}

function arrayIndex(index: Value, length: number, fail: (m: string) => Error): number {
  if (typeof index !== "number" || !Number.isInteger(index)) {
    throw fail(`index must be an integer, got ${describeCallee(index)}`);
  }
  const at = index < 0 ? length + index : index;
  if (at < 0 || at >= length) throw fail(`index out of range: ${index}`);
  return at;
}

export function makeIterator(obj: Value, fail: (m: string) => Error): Iterator {
  if (Array.isArray(obj)) {
    let i = 0;
    return { next: () => (i < obj.length ? (obj[i++] as Value) : DONE) };
  }
  if (typeof obj === "string") {
    let i = 0;
    return { next: () => (i < obj.length ? obj.charAt(i++) : DONE) };
  }
  if (obj instanceof Dict) {
    const keys = obj.keys();
    let i = 0;
    return { next: () => (i < keys.length ? (keys[i++] as Value) : DONE) };
  }
  // A lazy range, or anything else that speaks the iterator protocol.
  if (obj !== null && typeof obj === "object" && typeof (obj as { next?: unknown }).next === "function") {
    return obj as unknown as Iterator;
  }
  throw fail(`cannot iterate over ${describeCallee(obj)}`);
}

const DICT_METHODS: Record<string, (self: Dict, args: Value[]) => Value> = {
  len: (self) => self.size,
  keys: (self) => self.keys(),
  values: (self) => self.entries().map(([, v]) => v),
  get: (self, args) => {
    const got = self.get(args[0] as Value);
    return got === undefined && !self.has(args[0] as Value) ? ((args[1] ?? null) as Value) : (got as Value);
  },
  has: (self, args) => self.has(args[0] as Value),
  delete: (self, args) => self.delete(args[0] as Value),
  clear: (self) => {
    self.map.clear();
    return null;
  },
};

const LIST_METHODS: Record<string, (self: Value[], args: Value[]) => Value> = {
  len: (self) => self.length,
  push: (self, args) => {
    for (const a of args) self.push(a);
    return null;
  },
  pop: (self) => {
    if (self.length === 0) throw new Error("pop from an empty list");
    return self.pop() as Value;
  },
  first: (self) => (self.length === 0 ? null : (self[0] as Value)),
  last: (self) => (self.length === 0 ? null : (self[self.length - 1] as Value)),
  reverse: (self) => {
    self.reverse();
    return self;
  },
  contains: (self, args) => self.includes(args[0] as Value),
  index: (self, args) => {
    const at = self.indexOf(args[0] as Value);
    if (at === -1) throw new Error("value is not in the list");
    return at;
  },
  slice: (self, args) => {
    const [from, to] = args;
    return self.slice(from === undefined ? 0 : (from as number), to === undefined ? self.length : (to as number));
  },
};

const STRING_METHODS: Record<string, (self: string, args: Value[]) => Value> = {
  len: (self) => self.length,
  upper: (self) => self.toUpperCase(),
  lower: (self) => self.toLowerCase(),
  strip: (self) => self.trim(),
  starts: (self, args) => self.startsWith(String(args[0])),
  ends: (self, args) => self.endsWith(String(args[0])),
  split: (self, args) => (args[0] === undefined ? [self] : self.split(String(args[0]))),
  contains: (self, args) => self.includes(String(args[0])),
  replace: (self, args) => self.split(String(args[0])).join(String(args[1])),
  repeat: (self, args) => self.repeat((args[0] as number) | 0),
  index: (self, args) => {
    const at = self.indexOf(String(args[0]));
    if (at === -1) throw new Error("substring is not present");
    return at;
  },
  slice: (self, args) => {
    const [from, to] = args;
    return self.slice(from === undefined ? 0 : (from as number), to === undefined ? self.length : (to as number));
  },
};

// ------------------------------------------------------------- operators

/**
 * The numeric operators, by index, on two numbers already known to be numbers.
 *
 * This is the hot path: the dispatch loop has checked the types, so there is no
 * error handling here at all.  Anything that can fail with a bad operand is
 * caught by the type check in the loop and reported from there.
 */
export function arithFast(which: number, a: number, b: number): Value {
  switch (which) {
    case BIN_ADD:
      return a + b;
    case BIN_SUB:
      return a - b;
    case BIN_MUL:
      return a * b;
    case BIN_DIV:
      if (b === 0) throw new Error("division by zero");
      return a / b;
    case BIN_FLOORDIV:
      if (b === 0) throw new Error("division by zero");
      return Math.floor(a / b);
    case BIN_MOD:
      if (b === 0) throw new Error("division by zero");
      return a % b;
    case BIN_POW:
      return a ** b;
    case BIN_EQ:
      return a === b;
    case BIN_NE:
      return a !== b;
    case BIN_LT:
      return a < b;
    case BIN_LE:
      return a <= b;
    case BIN_GT:
      return a > b;
    case BIN_GE:
      return a >= b;
    case BIN_AND:
      return a & b;
    case BIN_OR:
      return a | b;
    case BIN_XOR:
      return a ^ b;
    case BIN_SHL:
      return a << b;
    case BIN_SHR:
      return a >> b;
    default:
      /*
       * No unary cases here, and deliberately so.
       *
       * UN_NEG is 0 and BIN_ADD is 0, so a `case UN_NEG: return -a` in this
       * switch would be dead the moment anyone read it as a separate case -- and
       * in JavaScript the *first* matching case wins, so the earlier BIN_ADD
       * would quietly take every 0.  Unary operators have their own function.
       */
      throw new Error(`unknown operator ${binName(which)}`);
  }
}

/** True when the frozen indices above still match the opcode's own list. */
export function operatorIndicesAgree(): boolean {
  const frozen = [BIN_ADD, BIN_SUB, BIN_MUL, BIN_DIV, BIN_FLOORDIV, BIN_MOD, BIN_POW,
    BIN_EQ, BIN_NE, BIN_LT, BIN_LE, BIN_GT, BIN_GE, BIN_AND, BIN_OR, BIN_XOR,
    BIN_SHL, BIN_SHR, BIN_IN, BIN_NOTIN];
  if (frozen.length !== BIN.length) return false;
  for (let i = 0; i < frozen.length; i++) if (frozen[i] !== i) return false;
  return UN_NEG === 0 && UN_POS === 1 && UN_INVERT === 2 && UN_NOT === 3 && UN.length === 4;
}

/** The four ordering comparisons, which accept strings as well as numbers. */
function isComparison(which: number): boolean {
  return which === BIN_LT || which === BIN_LE || which === BIN_GT || which === BIN_GE;
}

function compareStrings(which: number, a: string, b: string): boolean {
  if (which === BIN_LT) return a < b;
  if (which === BIN_LE) return a <= b;
  if (which === BIN_GT) return a > b;
  return a >= b;
}

/** The message for a binary operator that got something other than numbers. */
export function typeMessage(op: string, a: Value, b: Value | null): string {
  if (op === "==" || op === "!=") return `cannot compare ${describeCallee(a)} with ${describeCallee(b as Value)}`;
  if (op === "<" || op === "<=" || op === ">" || op === ">=") {
    return `cannot compare ${describeCallee(a)} with ${describeCallee(b as Value)}`;
  }
  return `${op} needs a number, got ${describeCallee(a)}`;
}

export function binaryFast(which: number, a: Value, b: Value): Value {
  switch (which) {
    case BIN_ADD:
      // `+` is the only operator with three cases, so it earns its own branch.
      if (typeof a === "string" && typeof b === "string") return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      return num(BIN_ADD, a) + num(BIN_ADD, b);
    case BIN_SUB:
      return num(BIN_SUB, a) - num(BIN_SUB, b);
    case BIN_MUL:
      return num(BIN_MUL, a) * num(BIN_MUL, b);
    case BIN_DIV: {
      const y = num(BIN_DIV, b);
      if (y === 0) throw new Error("division by zero");
      return num(BIN_DIV, a) / y;
    }
    case BIN_FLOORDIV: {
      const y = num(BIN_FLOORDIV, b);
      if (y === 0) throw new Error("division by zero");
      return Math.floor(num(BIN_FLOORDIV, a) / y);
    }
    case BIN_MOD: {
      const y = num(BIN_MOD, b);
      if (y === 0) throw new Error("division by zero");
      return num(BIN_MOD, a) % y;
    }
    case BIN_POW:
      return num(BIN_POW, a) ** num(BIN_POW, b);
    case BIN_EQ:
      return equals(a, b);
    case BIN_NE:
      return !equals(a, b);
    case BIN_LT:
      return comparable("<", a, b);
    case BIN_LE:
      return comparable("<=", a, b);
    case BIN_GT:
      return comparable(">", a, b);
    case BIN_GE:
      return comparable(">=", a, b);
    case BIN_AND:
      return num(BIN_AND, a) & num(BIN_AND, b);
    case BIN_OR:
      return num(BIN_OR, a) | num(BIN_OR, b);
    case BIN_XOR:
      return num(BIN_XOR, a) ^ num(BIN_XOR, b);
    case BIN_SHL:
      return num(BIN_SHL, a) << num(BIN_SHL, b);
    case BIN_SHR:
      return num(BIN_SHR, a) >> num(BIN_SHR, b);
    case BIN_IN:
      return contains(b, a);
    case BIN_NOTIN:
      return !contains(b, a);
    default:
      throw new Error(`unknown operator ${binName(which)}`);
  }
}

export function unaryFast(which: number, a: Value): Value {
  switch (which) {
    case UN_NEG:
      return -num(UN_NEG, a);
    case UN_POS:
      return num(UN_POS, a);
    case UN_INVERT:
      return ~num(UN_INVERT, a);
    case UN_NOT:
      return !truthy(a);
    default:
      throw new Error(`unknown operator ${unName(which)}`);
  }
}

/** A number operand, or a message naming what arrived instead. */
function num(which: number, v: Value): number {
  if (typeof v !== "number") {
    throw new Error(`${binName(which)} needs a number, got ${describeCallee(v)}`);
  }
  return v;
}

function comparable(op: "<" | "<=" | ">" | ">=", a: Value, b: Value): boolean {
  if (typeof a !== typeof b || (typeof a !== "number" && typeof a !== "string")) {
    throw new Error(`cannot compare ${describeCallee(a)} with ${describeCallee(b)}`);
  }
  const x = a as number | string;
  const y = b as number | string;
  if (op === "<") return x < y;
  if (op === "<=") return x <= y;
  if (op === ">") return x > y;
  return x >= y;
}

export function binary(op: string, a: Value, b: Value): Value {
  switch (op) {
    case "+":
      if (typeof a === "string" && typeof b === "string") return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      return arith("+", a, b);
    case "-":
    case "*":
    case "/":
    case "//":
    case "%":
    case "**":
      return arith(op, a, b);

    case "==":
      return equals(a, b);
    case "!=":
      return !equals(a, b);
    case "<":
      return compare("<", a, b);
    case "<=":
      return compare("<=", a, b);
    case ">":
      return compare(">", a, b);
    case ">=":
      return compare(">=", a, b);

    case "&":
    case "|":
    case "^":
    case "<<":
    case ">>":
      return bitwise(op, a, b);

    case "in":
      return contains(b, a);
    case "not in":
      return !contains(b, a);
    default:
      throw new Error(`unknown operator ${op}`);
  }
}

function needNumber(op: string, v: Value): number {
  if (typeof v !== "number") throw new Error(`${op} needs a number, got ${describeCallee(v)}`);
  return v;
}

function arith(op: string, a: Value, b: Value): Value {
  const x = needNumber(op, a);
  const y = needNumber(op, b);
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      if (y === 0) throw new Error("division by zero");
      return x / y;
    case "//":
      if (y === 0) throw new Error("division by zero");
      return Math.floor(x / y);
    case "%":
      if (y === 0) throw new Error("division by zero");
      return x % y;
    case "**":
      return x ** y;
    default:
      throw new Error(`unknown operator ${op}`);
  }
}

function bitwise(op: string, a: Value, b: Value): Value {
  const x = needNumber(op, a);
  const y = needNumber(op, b);
  switch (op) {
    case "&":
      return x & y;
    case "|":
      return x | y;
    case "^":
      return x ^ y;
    case "<<":
      return x << y;
    case ">>":
      return x >> y;
    default:
      throw new Error(`unknown operator ${op}`);
  }
}

export function equals(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equals(v, b[i] as Value));
  }
  if (a instanceof Dict && b instanceof Dict) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a.map) {
      if (!b.has(k)) return false;
      if (!equals(v, b.get(k) as Value)) return false;
    }
    return true;
  }
  // 1 and 1.0 are the same number, as in every language with one numeric type.
  return false;
}

function compare(op: string, a: Value, b: Value): boolean {
  if (typeof a !== typeof b || (typeof a !== "number" && typeof a !== "string")) {
    throw new Error(`cannot compare ${describeCallee(a)} with ${describeCallee(b)}`);
  }
  const x = a as number | string;
  const y = b as number | string;
  switch (op) {
    case "<":
      return x < y;
    case "<=":
      return x <= y;
    case ">":
      return x > y;
    case ">=":
      return x >= y;
    default:
      throw new Error(`unknown comparison ${op}`);
  }
}

function contains(haystack: Value, needle: Value): boolean {
  if (typeof haystack === "string") return haystack.includes(String(needle));
  if (Array.isArray(haystack)) return haystack.some((v) => equals(v, needle));
  if (haystack instanceof Dict) return haystack.has(needle);
  throw new Error(`cannot test membership in ${describeCallee(haystack)}`);
}

export function unary(op: string, a: Value): Value {
  switch (op) {
    case "-":
      return -needNumber(op, a);
    case "+":
      return needNumber(op, a);
    case "~":
      return ~needNumber(op, a);
    case "not":
      return !truthy(a);
    default:
      throw new Error(`unknown operator ${op}`);
  }
}

export { formatCode, constLabel };
export type { Binding };
