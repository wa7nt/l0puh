/**
 * Lowering the AST to the IR.
 *
 * The only interesting decisions are the ones that change what the program
 * *means*, not what it looks like:
 *
 *  - `and`, `or` and the ternary lower to jumps.  The AST separates them from
 *    `Binary` precisely so this is possible; an eager `and` would evaluate
 *    `b()` in `a and b()` even when `a` is false.
 *
 *  - Loops evaluate their header once.  `for i in f():` calls `f` before the loop
 *    head, or it would call it every iteration.
 *
 *  - Scopes are pushed and popped, and a write always allocates a new value.
 *    Nothing is reused, which is what makes the result SSA.
 *
 * Everything is a `call.builtin` for now: the IR describes what must happen, and
 * the backend decides between calling a runtime helper and inlining a machine
 * instruction.  Putting `add` here as a dedicated opcode would be the backend's
 * choice made one layer too early.
 */

import type { Binary, BinaryOp, Call, Expr, Lambda, Program, Stmt, UnaryOp } from "../ast.ts";
import { L0pError } from "../errors.ts";
import { imm, sym, vreg, type IrFunc, type IrModule, type IrOp, type Operand, type VReg } from "./ir.ts";
import { FuncBuilder } from "./build.ts";

/** Runtime helpers the backend knows how to lower. */
const BUILTIN: Record<string, IrOp> = {
  add: "add", sub: "sub", mul: "mul", div: "div",
  floordiv: "floordiv", mod: "mod", pow: "pow",
  eq: "eq", ne: "ne", lt: "lt", le: "le", gt: "gt", ge: "ge",
  neg: "neg", pos: "pos", bitnot: "bitnot", not: "not",
  truthy: "truthy", concat: "concat", in: "in", notin: "notin",
  list_new: "list.new", list_push: "list.push",
  dict_new: "dict.new", dict_get: "dict.get", dict_set: "dict.set",
  struct_new: "struct.new",
  field_get: "load.field", field_set: "store.field",
  index_get: "load.index", index_set: "store.index",
  assert_type: "assert.type",
  panic: "unreachable",
  print: "call.builtin", len: "call.builtin",
  type: "call.builtin", range: "call.builtin",
  iter: "call.builtin", iter_more: "call.builtin", iter_next: "call.builtin",
  values: "call.builtin", has_key: "call.builtin", str: "call.builtin",
  int: "call.builtin", float: "call.builtin", bool: "call.builtin",
  type_of: "call.builtin", repr: "call.builtin", input: "call.builtin",
  spawn: "call.builtin", await: "call.builtin",
};

/*
 * The names the native runtime actually implements.
 *
 * Listed explicitly so that `foo()` is a compile error naming `foo` instead of a
 * build failure in the runtime reporting "no such built-in", which arrives with
 * no file and no line.  Keeping the two lists in step is a test, not a habit.
 */
const KNOWN_BUILTINS = new Set([
  "print", "len", "str", "int", "float", "bool", "type",
  "iter", "iter_more", "iter_next",
]);

/** Python spells some of these; keep one table, not two. */
const PY: Record<BinaryOp, string> = {
  "+": "add", "-": "sub", "*": "mul", "/": "div", "//": "floordiv",
  "%": "mod", "**": "pow",
  "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge",
  "&": "bitand", "|": "bitor", "^": "bitxor", "<<": "shl", ">>": "shr",
  "in": "in", "not in": "notin",
};

class Lowerer {
  /** Function bodies, filled in as they are met.  The module references them by name. */
  readonly funcs: IrFunc[] = [];
  /**
   * The next index a `@func:N` will get.
   *
   * Counted separately from `funcs.length` because index 0 is the module body,
   * which is only finished after the whole file is lowered.  Deriving the index
   * from the array length instead shifted every function by one relative to the
   * `@func:N` already written into the IR, and a closure pointed at the module
   * rather than at the function it named -- a valid pointer to valid code,
   * running the wrong program, with nothing to indicate a problem.
   */
  private nextFunc = 0;
  /** Names a `def` introduced, so a call to one is a global read and not a built-in. */
  private readonly declared = new Set<string>();
  /** Which slot each local occupies, kept for upvalue analysis at M15. */
  private slots = new Map<string, number>();
  private nextSlot = 0;
  private current: FuncBuilder;
  private readonly functionIndex = new Map<string, number>();
  private readonly globalKinds = new Map<string, "def">();
  private temp = 0;

  /**
   * The loops we are inside, innermost last.
   *
   * `break` and `continue` are jumps, and a jump needs a destination.  Python
   * allows them from anywhere in a loop body, so the destination cannot come from
   * the syntax at the point of the jump -- it comes from the loop that encloses
   * it, which is why this is a stack rather than a pair of fields.
   */
  private readonly loops: { breakTo: Block; continueTo: Block }[] = [];

  /** The last expression statement, so a module body can hand it back. */
  private last: { value: Operand; block: Block } | null = null;

  /**
   * Claims the next function index.
   *
   * Index 0 belongs to the module body, which is only finished once the whole
   * file has been lowered, so it is reserved before anything else is numbered.
   */
  reserveFunction(): number {
    return this.nextFunc++;
  }

  constructor() {
    this.current = new FuncBuilder("<module>", [], true);
  }

  private slot(name: string): number {
    let s = this.slots.get(name);
    if (s === undefined) {
      s = this.nextSlot++;
      this.slots.set(name, s);
    }
    return s;
  }

  // ------------------------------------------------------------ expressions

  /** Lowers an expression to the value holding its result. */
  expr(e: Expr): Operand {
    const b = this.current;
    switch (e.kind) {
      case "Num":
        return vreg(b.define("const", [imm(e.value)], e.line));

      case "Bool":
        return vreg(b.define("const", [imm(e.value)], e.line));

      case "Null":
        return vreg(b.define("const", [imm(null)], e.line));

      case "Str": {
        // Interpolation is `+` in a loop, not a format call: one op per piece,
        // so the backend can skip the runtime helper for all-literal strings.
        if (e.parts.length === 1 && typeof e.parts[0] === "string") {
          return vreg(b.define("const", [imm(e.parts[0] as string)], e.line));
        }
        let acc: Operand = vreg(b.define("const", [imm("")], e.line));
        for (const p of e.parts) {
          const piece = typeof p === "string" ? vreg(b.define("const", [imm(p)], e.line)) : this.expr(p);
          acc = this.call("concat", [acc, piece], e.line);
        }
        return acc;
      }

      case "Ident": {
        const local = b.lookup(e.name);
        if (local !== null) return vreg(local);
        return vreg(b.define("load.global", [], e.line, { name: e.name }));
      }

      case "ListLit":
        return vreg(b.define("list.new", e.items.map((i) => this.expr(i)), e.line));

      case "DictLit": {
        const args: Operand[] = [];
        for (const en of e.entries) args.push(this.expr(en.key), this.expr(en.value));
        return vreg(b.define("dict.new", args, e.line));
      }

      case "Unary":
        return vreg(b.define(BUILTIN[unaryName(e.op)] as IrOp, [this.expr(e.operand)], e.line));

      case "Binary": {
        const name = PY[e.op];
        // Short-circuiting membership tests cannot be eager.
        if (e.op === "in" || e.op === "not in") {
          return vreg(b.define(BUILTIN[name] as IrOp, [this.expr(e.left), this.expr(e.right)], e.line));
        }
        return vreg(b.define(BUILTIN[name] as IrOp, [this.expr(e.left), this.expr(e.right)], e.line));
      }

      case "Logical":
        return this.logical(e.left, e.right, e.op === "and", e.line);

      case "Ternary":
        return this.ternary(e.cond, e.then, e.other, e.line);

      case "Call":
        return this.call1(e);

      case "Attr":
        return vreg(b.define("load.field", [this.expr(e.obj)], e.line, { name: e.name }));

      case "Index":
        return vreg(b.define("load.index", [this.expr(e.obj), this.expr(e.index)], e.line));

      case "Lambda":
        return this.lambda(e);

      case "Spawn":
        return this.call("spawn", [this.expr(e.call.callee), ...e.call.args.map((a) => this.expr(a))], e.line);

      case "Await":
        return this.call("await", [this.expr(e.expr)], e.line);
    }
  }

  /** `a and b` / `a or b`: evaluate `a`, branch on it, evaluate `b` only if needed. */
  private logical(left: Expr, right: Expr, isAnd: boolean, line: number): Operand {
    const b = this.current;
    const lhs = this.expr(left);

    const rhsBlock = b.newBlock(isAnd ? "and.rhs" : "or.rhs");
    const join = b.newBlock("and.join");
    const short = b.newBlock(isAnd ? "and.short" : "or.short");

    b.branch(lhs, rhsBlock, short, line);

    b.setCurrent(rhsBlock);
    const rhs = this.expr(right);
    b.recordPath(rhsBlock);
    b.jump(join, line);

    b.setCurrent(short);
    b.recordPath(short);
    b.jump(join, line);

    b.setCurrent(join);
    // The result is `lhs` when short-circuiting, `rhs` otherwise -- and a phi is
    // exactly that, so this is the join the AST's separation of Logical from
    // Binary was for.
    const dest = b.newReg();
    b.currentBlock.params.push({
      dest,
      incoming: [
        { from: rhsBlock.id, value: rhs },
        { from: short.id, value: lhs },
      ],
      line,
    });
    return vreg(dest);
  }

  private ternary(cond: Expr, then: Expr, other: Expr, line: number): Operand {
    const b = this.current;
    const c = this.expr(cond);
    const thenBlock = b.newBlock("then");
    const elseBlock = b.newBlock("else");
    const join = b.newBlock("join");

    b.branch(c, thenBlock, elseBlock, line);

    b.setCurrent(thenBlock);
    const a = this.expr(then);
    b.recordPath(thenBlock);
    b.jump(join, line);

    b.setCurrent(elseBlock);
    const o = this.expr(other);
    b.recordPath(elseBlock);
    b.jump(join, line);

    b.setCurrent(join);
    return vreg(this.phiFor(join, [[thenBlock, a], [elseBlock, o]], line));
  }

  /**
   * A phi whose two sides are values rather than a name's history.
   *
   * The value form is what an expression needs: `1 if c else 2` has no name to
   * rebind, so there is no path record to read, and the two arms are simply the
   * two incoming values.
   */
  private phiFor(join: { id: number }, sides: [unknown, Operand][], line: number): VReg {
    const b = this.current;
    const dest = b.newReg();
    const incoming = sides.map(([blk, value]) => ({
      from: (blk as { id: number }).id,
      value: value as Operand,
    }));
    b.currentBlock.params.push({ dest, incoming, line });
    return dest;
  }

  private lambda(e: Lambda): Operand {
    const b = new FuncBuilder("lambda", e.params.map(() => "param" as const));
    const saved = this.current;
    this.current = b;
    const params: VReg[] = [];
    for (const p of e.params) {
      const r = b.newReg();
      params.push(r);
      b.bind(p.name, r);
    }
    b.beginScope();
    b.ret(this.expr(e.body), e.line);
    b.endScope();
    this.current = saved;
    const closure = this.nextFunc++;
    this.funcs.push(b.finish("lambda", params, []));
    return vreg(saved.define("new.closure", [], e.line, { name: `#${closure}` }));
  }

  private call1(e: Call): Operand {
    /*
     * A call to a name the program did not bind locally.
     *
     * `print(x)` and `len(s)` are the ordinary spelling of the built-ins.  A name
     * the module *declared* with `def` is a different case: it is a global, so it
     * goes through the generic call path and reads the global table.  That is also
     * what makes a recursive call work -- inside the body the name is not a local,
     * and refusing it there would break every recursive function in the language.
     *
     * Anything else is a name nobody defined, and saying so at compile time beats
     * a build failure in the runtime with no file and no line.
     */
    if (e.callee.kind === "Ident" && !this.current.isBound(e.callee.name)) {
      if (this.declared.has(e.callee.name)) {
        const callee = this.expr(e.callee);
        return vreg(this.current.define("call", [callee, ...e.args.map((a) => this.expr(a))], e.line, {
          name: e.callee.name,
        }));
      }
      if (!KNOWN_BUILTINS.has(e.callee.name)) {
        throw new L0pError(`no such function: ${e.callee.name}`, e.callee.line, e.callee.col);
      }
      return this.call(e.callee.name, e.args.map((a) => this.expr(a)), e.line);
    }
    const callee = this.expr(e.callee);
    return vreg(this.current.define("call", [callee, ...e.args.map((a) => this.expr(a))], e.line, {
      name: e.callee.kind === "Ident" ? e.callee.name : undefined,
    }));
  }

  private call(name: string, args: Operand[], line: number): Operand {
    return vreg(this.current.define(BUILTIN[name] as IrOp, args, line, { name }));
  }

  // ------------------------------------------------------------- statements

  stmts(list: readonly Stmt[]): void {
    for (const s of list) this.stmt(s);
  }

  private stmt(s: Stmt): void {
    const b = this.current;
    switch (s.kind) {
      case "ExprStmt":
        // Remembered, with the block it was evaluated in.  The block matters:
        // the module returns this value only if it is still in scope at the end,
        // and a value computed inside a loop body is not -- the body may run zero
        // times, so returning it would read a slot that was never written.
        this.last = { value: this.expr(s.expr), block: this.current.currentBlock };
        return;

      case "Let": {
        const value = s.init === null ? vreg(b.define("const", [imm(null)], s.line)) : this.expr(s.init);
        b.bind(s.name, asReg(value));
        this.slot(s.name);
        return;
      }

      case "Assign": {
        // `a, b = b, a` swaps, so every right-hand side is evaluated before any
        // store happens.  Reading them one at a time would read the new `a`.
        if (s.targets.length > 1) {
          const source = s.op === null
            ? this.expr(s.value)
            : this.call(PY[s.op], [this.expr(s.targets[0] as Expr), this.expr(s.value)], s.line);
          s.targets.forEach((t, i) => {
            const part = this.tuplePart(source, i, s.line);
            this.store(t, part, s.line);
          });
          return;
        }
        this.assign1(s.targets[0] as Expr, s.op, s.value);
        return;
      }

      case "Def": {
        // The name is registered *before* the body is lowered, so a call to the
        // function from inside itself resolves.  A one-pass version is the
        // classic mistake here, and it only shows up on the first recursive
        // call -- which is to say, in the first test anyone writes.
        const index = this.nextFunc++;
        this.functionIndex.set(s.name, index);
        this.declared.add(s.name);
        this.globalKinds.set(s.name, "def");

        const fb = new FuncBuilder(s.name, s.params.map(() => "param" as const));
        const saved = this.current;
        const savedSlots = this.slots;
        this.current = fb;
        this.slots = new Map(savedSlots);

        const params: VReg[] = [];
        for (const p of s.params) {
          const r = fb.newReg();
          params.push(r);
          fb.bind(p.name, r);
        }
        this.stmts(s.body);
        if (fb.currentBlock.term === null) fb.ret(null, s.line);

        const built = fb.finish(s.name, params, []);
        this.current = saved;
        this.slots = savedSlots;

        this.funcs.push(built);
        // A reference to the name in the module is a value, so a call through it
        // is a call on a value rather than a lookup at every use.
        const ref = this.current.define("new.closure", [], s.line, { name: `@func:${index}` });
        this.current.bind(s.name, ref);
        // And the same value goes into the global table, which is how a *recursive*
        // call finds it: inside the body the name is not a local, so it lowers to
        // a global read.  Without this the body looked itself up in a slot nothing
        // had written and the program stopped with "not callable".
        this.current.emit("store.global", [vreg(ref)], s.line, { name: s.name });
        return;
      }

      case "StructDef": {
        const args: Operand[] = [];
        for (const f of s.fields) {
          args.push(vreg(b.define("const", [imm(f.name)], s.line)));
          args.push(f.value === null ? vreg(b.define("const", [imm(null)], s.line)) : this.expr(f.value));
        }
        b.define("struct.new", args, s.line, { name: s.name });
        return;
      }

      case "If":
        this.ifStmt(s.cond, s.then, s.otherwise, s.line);
        return;

      case "While":
        this.whileStmt(s.cond, s.body, s.line);
        return;

      case "For":
        this.forStmt(s.name, s.iter, s.body, s.line);
        return;

      case "Return":
        b.ret(s.value === null ? null : this.expr(s.value), s.line);
        return;

      case "Branch": {
        if (s.what === "pass") return;
        const loop = this.loops[this.loops.length - 1];
        if (loop === undefined) {
          throw new L0pError(`${s.what} outside a loop`, s.line, s.col);
        }
        if (s.what === "break") b.jump(loop.breakTo, s.line);
        else b.jump(loop.continueTo, s.line);
        return;
      }

      case "Import":
        this.globalKinds.set(s.alias ?? s.path.split(".").pop() as string, "def");
        b.emit("call.builtin", [sym(`@import:${s.path}`)], s.line, { name: s.alias ?? s.path });
        return;

      case "Defer":
        b.emit("call.builtin", [this.expr(s.call.callee), ...s.call.args.map((a) => this.expr(a))], s.line, { name: "defer" });
        return;
    }
  }

  private assign1(target: Expr, op: BinaryOp | null, value: Expr): void {
    const b = this.current;
    if (op !== null) {
      // `a[i] += 1` must evaluate `a` and `i` once.  Desugaring to `a[i] = a[i] + 1`
      // would evaluate them twice, which is why Assign keeps its operator.
      const combined = this.call(PY[op], [this.expr(target), this.expr(value)], target.line);
      this.store(target, combined, target.line);
      return;
    }
    this.store(target, this.expr(value), target.line);
  }

  /**
   * The i-th element of a value being unpacked, bound to a fresh name.
   *
   * `a, b = f()` needs somewhere to put `f()`'s result, and reusing a name would
   * be visible to a nested unpack.  A generated name keeps the temporary out of
   * the source's way, and the binding is rebound as each part is read.
   */
  private tuplePart(source: Operand, i: number, line: number): Operand {
    const name = `#t${this.temp++}`;
    const held = asReg(source);
    this.current.bind(name, held);
    const part = this.current.define("load.index", [vreg(held), vreg(this.current.define("const", [imm(i)], line))], line);
    return vreg(part);
  }

  /**
   * A write to a name.
   *
   * The old value stays valid for whoever already read it, and the name moves to
   * a fresh one.  That single `copy` is the whole difference between SSA and
   * something a register allocator would have to repair.
   */
  private store(target: Expr, value: Operand, line: number): void {
    const b = this.current;
    if (target.kind === "Ident") {
      const local = b.lookup(target.name);
      if (local !== null) {
        const fresh = b.define("copy", [value], line);
        b.bind(target.name, fresh);
        return;
      }
      b.emit("store.global", [value], line, { name: target.name });
      /*
       * A write to a name that is not a local defines a global, so it has to be
       * registered.  The backend builds its global table from this list, and a
       * name that is missing from it is a compile error rather than a silent read
       * of whatever the previous function left in that slot.
       */
      this.globalKinds.set(target.name, "def");
      return;
    }
    if (target.kind === "Index") {
      b.emit("store.index", [this.expr(target.obj), this.expr(target.index), value], line);
      return;
    }
    if (target.kind === "Attr") {
      b.emit("store.field", [this.expr(target.obj), value], line, { name: target.name });
      return;
    }
    if (target.kind === "ListLit" || target.kind === "DictLit") {
      b.emit("store.index", [this.expr(target), value], line);
      return;
    }
    throw new L0pError("cannot assign to this expression", target.line, target.col);
  }

  private ifStmt(cond: Expr, then: readonly Stmt[], otherwise: readonly Stmt[] | null, line: number): void {
    const b = this.current;
    const c = this.expr(cond);
    const thenBlock = b.newBlock("then");
    const elseBlock = b.newBlock("else");
    // Created empty, filled in once both arms have said what they left behind.
    // It has to exist first because both arms jump to it.
    const join = b.newBlock("join");

    b.branch(c, thenBlock, elseBlock, line);

    b.beginScope();
    b.setCurrent(thenBlock);
    this.stmts(then);
    if (b.currentBlock.term === null) b.jump(join, line);
    b.recordPath(thenBlock);
    b.endScope();

    b.beginScope();
    b.setCurrent(elseBlock);
    if (otherwise !== null) this.stmts(otherwise);
    if (b.currentBlock.term === null) b.jump(join, line);
    b.recordPath(elseBlock);
    b.endScope();

    b.setCurrent(join);
    join.params = b.joinParams(join, thenBlock, elseBlock, line);
  }

  private whileStmt(cond: Expr, body: readonly Stmt[], line: number): void {
    const b = this.current;
    const head = b.newBlock("loop.head");
    const bodyBlock = b.newBlock("loop.body");
    const exit = b.newBlock("loop.exit");

    b.jump(head, line);
    b.setCurrent(head);
    const c = this.expr(cond);
    b.branch(c, bodyBlock, exit, line);

    b.beginScope();
    b.setCurrent(bodyBlock);
    // `continue` goes to the head, so the condition is re-tested; `break` goes to
    // the exit.  Both are plain jumps from wherever in the body they appear.
    this.loops.push({ breakTo: exit, continueTo: head });
    this.stmts(body);
    this.loops.pop();
    if (b.currentBlock.term === null) b.jump(head, line);
    b.endScope();

    b.setCurrent(exit);
  }

  private forStmt(name: string, iter: Expr, body: readonly Stmt[], line: number): void {
    const b = this.current;
    // The iterable is evaluated here, once, before the loop head.  Inside the
    // loop it is read from a value, so `for i in f():` calls `f` a single time.
    const seq = this.expr(iter);

    const head = b.newBlock("loop.head");
    const bodyBlock = b.newBlock("loop.body");
    const step = b.newBlock("loop.step");
    const exit = b.newBlock("loop.exit");

    b.jump(head, line);

    /*
     * The cursor is made once, before the loop.
     *
     * The obvious shape -- ask the sequence whether it has another element at
     * the top, then take it -- re-creates the cursor on every pass, because the
     * head block runs each iteration.  `for x in [1,2,3]` then yields 1 forever,
     * or exits immediately, depending on where the fresh cursor starts.
     */
    const cursor = this.call("iter", [seq], line);
    const cursorName = `#it${this.temp++}`;
    b.bind(cursorName, asReg(cursor));

    b.setCurrent(head);
    const more = this.call("iter_more", [vreg(b.lookup(cursorName) as VReg)], line);
    b.branch(more, bodyBlock, exit, line);

    b.beginScope();
    b.setCurrent(bodyBlock);
    const item = this.call("iter_next", [vreg(b.lookup(cursorName) as VReg)], line);
    b.bind(name, asReg(item));
    // In a `for`, `continue` must still advance the iterator, so it goes to the
    // step block rather than the head.  Sending it to the head would loop on the
    // same element forever.
    this.loops.push({ breakTo: exit, continueTo: step });
    this.stmts(body);
    if (b.currentBlock.term === null) b.jump(step, line);
    this.loops.pop();
    b.endScope();

    b.setCurrent(step);
    b.jump(head, line);

    b.setCurrent(exit);
  }
}

function asReg(o: Operand): VReg {
  if (o.t !== "vreg") throw new L0pError("expected a value");
  return o.v;
}

function unaryName(op: UnaryOp): string {
  if (op === "-") return "neg";
  if (op === "+") return "pos";
  if (op === "~") return "bitnot";
  return "not";
}

export function lowerProgram(p: Program, file: string | null = null): IrModule {
  const l = new Lowerer();
  /*
   * Index 0 is the module body, reserved before anything else is numbered.
   *
   * The alternative -- appending the module at the end -- shifted every function
   * index by one relative to the `@func:N` the lowering had already emitted, and
   * a closure pointed at the module instead of the function it named.  That is
   * silent: a valid pointer to valid code, running the wrong program.
   */
  const moduleBuilder = l.current;
  l.reserveFunction();
  l.stmts(p.stmts);
  /*
   * A script's value is its last expression, the way the interpreter and the REPL
   * both treat it.
   *
   * The return goes on whatever block that expression landed in, which is not the
   * entry block when the expression was a ternary or followed a branch.  Pinning
   * it to the entry left the join block terminated with `unreachable`, so control
   * ran off the end of the function and the program returned a garbage tag, which
   * printed as `<object>`.
   */
  moduleBuilder.returnModuleValue(l.last, p.stmts[p.stmts.length - 1]?.line ?? 0);
  const module_ = moduleBuilder.finish("<module>", [], []);  return {
    name: file === null ? "<stdin>" : file,
    file,
    entry: 0,
    funcs: [module_, ...l.funcs],
    globalNames: [...l.globalKinds.keys()],
    globalKinds: l.globalKinds,
  };
}
