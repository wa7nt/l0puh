/**
 * AST to bytecode.
 *
 * Scoping is Lua's: every function has a flat slot array for its parameters and
 * locals, and a free variable in a nested function becomes an upvalue that says
 * whether to read it from the enclosing function's slots or from that function's
 * own upvalues.  A name found in neither is a module-level global.
 *
 * Module-level names are globals, not slots, so that a `def` at the top level is
 * visible to every function in the file.  Slots are allocated but never reused
 * when a block ends; the number of slots is bounded by source nesting, which is
 * small, and reuse would cost a free list for no measurable gain.
 */

import type {
  Binding, BinaryOp, Expr, Import, Param, Program, Stmt, UnaryOp,
} from "../ast.ts";
import { L0pError } from "../errors.ts";
import {
  ConstPool, plainValue, type Constant, type ImportSpec, type Module, type Proto, type UpvalueSource,
} from "../bytecode/code.ts";
import { BIN, binIndex, op, OP, UN, unIndex, type Op } from "../bytecode/op.ts";

type VarRef = { kind: "local"; slot: number } | { kind: "upvalue"; index: number };

/**
 * The `b` operand of StoreGlobal.  A declaration creates the binding, so the VM
 * must not hold it to what the name already is; a plain assignment must be.
 */
const DECLARE = 1;

interface Func {
  name: string;
  consts: ConstPool;
  code: Op[];
  params: string[];
  slotKinds: (Binding | "param")[];
  nslots: number;
  protos: number[];
  upvalues: UpvalueSource[];
  scopes: Map<string, VarRef>[];
  isModule: boolean;
}

export interface CompileResult {
  module: Module;
  /** Indices into `module.protos`, one per nested function, in emission order. */
  entry: number;
}

export function compile(program: Program, name: string, file: string | null): CompileResult {
  return new Compiler(name, file).run(program);
}

class Compiler {
  private readonly moduleName: string;
  private readonly file: string | null;
  private readonly protos: Proto[] = [];
  private readonly imports: ImportSpec[] = [];
  private readonly globalKinds = new Map<string, Binding | "def">();

  private funcs: Func[] = [];
  /** Patches waiting for a target, keyed by instruction index. */
  private readonly breaks: number[][] = [];
  private readonly continues: number[][] = [];

  constructor(moduleName: string, file: string | null) {
    this.moduleName = moduleName;
    this.file = file;
  }

  run(program: Program): CompileResult {
    this.beginFunc(this.moduleName, true);
    this.beginScope();

    // Slot 0 of the module frame holds the value of the last expression, which
    // `Halt` has no other way to recover.
    const resultSlot = this.reserveSlot();
    const stmts = program.stmts;
    for (let i = 0; i < stmts.length; i++) {
      const last = i === stmts.length - 1;
      const s = stmts[i] as Stmt;
      if (last && s.kind === "ExprStmt") {
        this.expr(s.expr);
        this.emit(OP.StoreLocal, resultSlot, DECLARE, s.line);
        this.emit(OP.Pop, 0, 0, s.line);
        continue;
      }
      this.stmt(s);
    }
    this.emit(OP.Halt, 0, 0, 1);
    this.endScope();

    // The index is only known here: a nested function is appended to the table
    // before the function that contains it, so the module body is not index 0.
    const entry = this.endFunc();
    const module: Module = {
      name: this.moduleName,
      file: this.file,
      entry,
      resultSlot,
      protos: this.protos,
      imports: this.imports,
      globalKinds: this.globalKinds,
    };
    return { module, entry };
  }

  /** The module body has no locals, so slot 0 can be taken for the result. */
  private reserveSlot(): number {
    const f = this.fn;
    f.nslots = Math.max(f.nslots, 1);
    while (f.slotKinds.length < f.nslots) f.slotKinds.push("var");
    f.slotKinds[0] = "let";
    return 0;
  }

  // ---------------------------------------------------------------- funcs

  private get fn(): Func {
    const f = this.funcs[this.funcs.length - 1];
    if (f === undefined) throw new Error("no active function");
    return f;
  }

  /**
   * Opens a function.  The proto index is assigned when the function is closed,
   * not here, because a nested function is appended before its parent.
   */
  private beginFunc(name: string, isModule = false, params: readonly string[] = []): void {
    const f: Func = {
      name,
      consts: new ConstPool(),
      code: [],
      params: [...params],
      slotKinds: params.map(() => "param" as const),
      nslots: params.length,
      protos: [],
      upvalues: [],
      scopes: [new Map()],
      isModule,
    };
    this.funcs.push(f);
    if (params.length > 0) {
      const scope = f.scopes[0] as Map<string, VarRef>;
      params.forEach((p, i) => scope.set(p, { kind: "local", slot: i }));
    }
  }

  /** Finishes the active function and returns its proto index. */
  private endFunc(): number {
    const f = this.fn;
    const index = this.protos.length;
    const consts = f.consts.list();
    this.protos.push({
      name: f.name,
      params: f.params,
      nslots: f.nslots,
      slotKinds: f.slotKinds,
      code: f.code,
      consts,
      constValues: consts.map(plainValue),
      protos: f.protos,
      upvalues: f.upvalues,
      isModule: f.isModule,
    });
    this.funcs.pop();
    return index;
  }

  // --------------------------------------------------------------- scopes

  private beginScope(): void {
    this.fn.scopes.push(new Map());
  }

  private endScope(): void {
    this.fn.scopes.pop();
  }

  private addLocal(name: string, kind: Binding | "param"): number {
    const f = this.fn;
    if (f.isModule) throw new Error(`cannot declare ${name} as a local in the module body`);
    const slot = f.nslots++;
    while (f.slotKinds.length < f.nslots) f.slotKinds.push("var");
    f.slotKinds[slot] = kind;
    (f.scopes[f.scopes.length - 1] as Map<string, VarRef>).set(name, { kind: "local", slot });
    return slot;
  }

  private lookupLocal(name: string): VarRef | null {
    const scopes = this.fn.scopes;
    for (let i = scopes.length - 1; i >= 0; i--) {
      const found = (scopes[i] as Map<string, VarRef>).get(name);
      if (found !== undefined) return found;
    }
    return null;
  }

  /**
   * Resolves a name in the function being compiled.  Not a local here, so look
   * one frame outwards and recurse: every function along the path gains exactly
   * one upvalue, pointing either at a slot of its own enclosing function or at
   * that function's upvalue of the same name.  Hopping a single frame at a time
   * is what makes a name captured three frames up resolve correctly.
   *
   * Returns null when nothing binds the name, which makes it a module global.
   */
  private resolve(name: string): VarRef | null {
    const local = this.lookupLocal(name);
    if (local !== null) return local;

    if (this.fn.isModule || this.funcs.length < 2) return null;

    const saved = this.funcs;
    this.funcs = saved.slice(0, saved.length - 1);
    const inParent = this.resolve(name);
    this.funcs = saved;
    if (inParent === null) return null;

    const f = this.fn;
    const index = f.upvalues.length;
    f.upvalues.push(
      inParent.kind === "local"
        ? { kind: "parent-local", slot: inParent.slot }
        : { kind: "parent-upvalue", index: inParent.index },
    );
    return { kind: "upvalue", index };
  }

  // ------------------------------------------------------------- emission

  private emit(kind: (typeof OP)[keyof typeof OP], a = 0, b = 0, line = 0): number {
    const f = this.fn;
    f.code.push(op(kind, a, b, line));
    return f.code.length - 1;
  }

  private here(): number {
    return this.fn.code.length;
  }

  private patch(at: number, target: number): void {
    const f = this.fn;
    const o = f.code[at];
    if (o !== undefined) o.a = target;
  }

  /** Emits a jump with a placeholder target and returns the slot to patch. */
  private emitJump(kind: (typeof OP)[keyof typeof OP], line: number): number {
    return this.emit(kind, 0, 0, line);
  }

  // ----------------------------------------------------------- statements

  private stmt(s: Stmt): void {
    switch (s.kind) {
      case "ExprStmt":
        this.expr(s.expr);
        this.emit(OP.Pop, 0, 0, s.line);
        return;

      case "Let":
        this.stmtLet(s.binding, s.name, s.init, s.line);
        return;

      case "Assign":
        this.stmtAssign(s.targets, s.op, s.value, s.line);
        return;

      case "Def":
        this.stmtDef(s.name, s.params, s.body, s.line);
        return;

      case "StructDef":
        this.stmtStruct(s.name, s.fields, s.line);
        return;

      case "If":
        this.stmtIf(s.cond, s.then, s.otherwise, s.line);
        return;

      case "While":
        this.stmtWhile(s.cond, s.body, s.line);
        return;

      case "For":
        this.stmtFor(s.name, s.iter, s.body, s.line);
        return;

      case "Return":
        if (s.value === null) this.emit(OP.Const, this.fn.consts.null(), 0, s.line);
        else this.expr(s.value);
        this.emit(OP.Return, 0, 0, s.line);
        return;

      case "Branch":
        this.stmtBranch(s.what, s.line);
        return;

      case "Import":
        this.stmtImport(s, s.line, s.col);
        return;

      case "Defer":
        throw new L0pError("`defer` arrives with the async work (M7)", s.line, s.col, this.file);
    }
  }

  private stmtLet(binding: Binding, name: string, init: Expr | null, line: number): void {
    if (init !== null) this.expr(init);
    else this.emit(OP.Const, this.fn.consts.null(), 0, line);

    if (this.fn.isModule) {
      this.globalKinds.set(name, binding);
      this.emit(OP.StoreGlobal, this.fn.consts.string(name), DECLARE, line);
    } else {
      const slot = this.addLocal(name, binding);
      this.emit(OP.StoreLocal, slot, DECLARE, line);
    }
    // The stores leave the value, and a declaration is a statement.
    this.emit(OP.Pop, 0, 0, line);
  }

  private stmtAssign(targets: readonly Expr[], compound: BinaryOp | null, value: Expr, line: number): void {
    if (targets.length === 0) {
      this.expr(value);
      this.emit(OP.Pop, 0, 0, line);
      return;
    }

    // Several targets can only be plain names, so the value can be kept on the
    // stack and stored repeatedly.
    if (targets.length > 1) {
      for (const t of targets) {
        if (t.kind !== "Ident") {
          throw new L0pError("only names can be chained in one assignment", line, line, this.file);
        }
      }
      this.expr(value);
      for (const t of targets) {
        this.emit(OP.Dup, 0, 0, line);
        this.storeTo(t, null, line);
      }
      this.emit(OP.Pop, 0, 0, line);
      return;
    }

    const target = targets[0] as Expr;
    if (compound === null) {
      this.storeTo(target, value, line);
      this.emit(OP.Pop, 0, 0, line);
      return;
    }

    // Compound: read, combine, write back.  `buf[i] += 1` must evaluate the
    // target once, so the target parts are emitted before the value and reused.
    switch (target.kind) {
      case "Ident": {
        this.loadName(target.name, line);
        this.expr(value);
        this.emit(OP.Bin, binIndex(compound), 0, line);
        this.storeTo(target, null, line);
        this.emit(OP.Pop, 0, 0, line);
        return;
      }
      case "Index": {
        this.expr(target.obj);
        this.expr(target.index);
        this.emit(OP.Dup, 0, 0, line); // the index, for the store
        this.emit(OP.GetIndex, 0, 0, line);
        this.expr(value);
        this.emit(OP.Bin, binIndex(compound), 0, line);
        this.emit(OP.SetIndex, 0, 0, line);
        this.emit(OP.Pop, 0, 0, line);
        return;
      }
      case "Attr": {
        this.expr(target.obj);
        this.emit(OP.Dup, 0, 0, line);
        this.emit(OP.GetAttr, this.fn.consts.string(target.name), 0, line);
        this.expr(value);
        this.emit(OP.Bin, binIndex(compound), 0, line);
        this.emit(OP.SetAttr, this.fn.consts.string(target.name), 0, line);
        this.emit(OP.Pop, 0, 0, line);
        return;
      }
      default:
        throw new L0pError("cannot assign to this expression", line, line, this.file);
    }
  }

  /** Compiles `value` (or reuses the top of stack) and stores it into `target`. */
  private storeTo(target: Expr, value: Expr | null, line: number): void {
    switch (target.kind) {
      case "Ident": {
        if (value !== null) this.expr(value);
        const ref = this.resolve(target.name);
        if (ref === null) {
          this.emit(OP.StoreGlobal, this.fn.consts.string(target.name), 0, line);
          return;
        }
        if (ref.kind === "local") this.emit(OP.StoreLocal, ref.slot, 0, line);
        else this.emit(OP.StoreUpval, ref.index, 0, line);
        return;
      }
      case "Index": {
        this.expr(target.obj);
        this.expr(target.index);
        if (value !== null) this.expr(value);
        this.emit(OP.SetIndex, 0, 0, line);
        return;
      }
      case "Attr": {
        this.expr(target.obj);
        if (value !== null) this.expr(value);
        this.emit(OP.SetAttr, this.fn.consts.string(target.name), 0, line);
        return;
      }
      default:
        throw new L0pError("cannot assign to this expression", line, line, this.file);
    }
  }

  /**
   * Fills in a parameter the caller left out.
   *
   * A missing argument arrives as null, so the default only runs when the slot
   * is null -- otherwise `f(1, 2)` with `def f(a, b = 9)` would still see 9.
   * The default is compiled inside the function, which means it can refer to
   * earlier parameters.
   */
  private emitParamDefaults(params: readonly { name: string; default: Expr | null }[], line: number): void {
    for (const p of params) {
      if (p.default === null) continue;
      const ref = this.lookupLocal(p.name);
      if (ref === null || ref.kind !== "local") continue;
      this.emit(OP.LoadLocal, ref.slot, 0, line);
      this.emit(OP.Dup, 0, 0, line);
      const skip = this.emitJump(OP.JumpIfTrue, line);
      this.emit(OP.Pop, 0, 0, line);
      this.expr(p.default);
      this.emit(OP.StoreLocal, ref.slot, 0, line);
      this.patch(skip, this.here());
    }
  }

  /*
   * `params` is `Param[]`, not a list of names.
   *
   * The narrower signature said `{name: string}` while `emitParamDefaults` reads
   * each parameter's `default` -- so the type claimed the defaults were not there
   * and the code reading them was, strictly, impossible.  Spelled as `Param` because
   * that is what the caller passes.
   */
  private stmtDef(name: string, params: readonly Param[], body: readonly Stmt[], line: number): void {
    // The name is bound in the enclosing scope *before* the body is compiled, so
    // that a nested `def` can see itself and recurse.  The slot holds a cell, so
    // the closure sees the assignment that happens after the Closure op.
    let slot = -1;
    if (this.fn.isModule) this.globalKinds.set(name, "def");
    else slot = this.addLocal(name, "let");

    // The parameter *objects*, not their names: emitParamDefaults reads each
    // one's default.  Passing `params.map(p => p.name)` would drop it, and the
    // default would silently never be emitted.
    this.beginFunc(name, false, params.map((p) => p.name));
    this.beginScope();
    this.emitParamDefaults(params, line);
    for (const s of body) this.stmt(s);
    // A function that falls off the end returns null, like Python.
    this.emit(OP.Const, this.fn.consts.null(), 0, line);
    this.emit(OP.Return, 0, 0, line);
    this.endScope();
    const proto = this.endFunc();
    (this.fn.protos as number[]).push(proto);

    this.emit(OP.Closure, proto, 0, line);
    if (this.fn.isModule) this.emit(OP.StoreGlobal, this.fn.consts.string(name), DECLARE, line);
    else this.emit(OP.StoreLocal, slot, DECLARE, line);
    this.emit(OP.Pop, 0, 0, line);
  }

  private stmtStruct(
    name: string,
    fields: readonly { name: string; value: Expr | null }[],
    line: number,
  ): void {
    const list = fields.map((f, i) => ({ name: f.name, slot: i }));
    // Every field contributes a value, including the ones with no default, so
    // the VM can pop exactly `fields.length` slots and never read a neighbour.
    for (const f of fields) {
      if (f.value === null) this.emit(OP.Const, this.fn.consts.null(), 0, line);
      else this.expr(f.value);
    }
    // Every field contributes a value, including the ones with no default, so
    // the VM can pop exactly `fields.length` slots and never read a neighbour.
    for (const f of fields) {
      if (f.value === null) this.emit(OP.Const, this.fn.consts.null(), 0, line);
      else this.expr(f.value);
    }
    const fieldsIndex = this.fn.consts.fields(list);

    // The type comes first and takes the defaults off the stack, storing them on
    // the type; `NewStruct` then builds the all-defaults instance from that copy
    // and leaves the callable type on top for the binding.  Both are needed: a
    // type lets `Point(1, 2)` build a value, and a bare `Point` stays usable,
    // which matters because this language has no constructors.
    this.emit(OP.StructType, this.fn.consts.string(name), fieldsIndex, line);
    this.emit(OP.NewStruct, this.fn.consts.string(name), fieldsIndex, line);
    this.emit(OP.Pop, 0, 0, line); // the instance; the type is what gets bound

    if (this.fn.isModule) {
      this.globalKinds.set(name, "let");
      this.emit(OP.StoreGlobal, this.fn.consts.string(name), DECLARE, line);
    } else {
      const slot = this.addLocal(name, "let");
      this.emit(OP.StoreLocal, slot, DECLARE, line);
    }
    this.emit(OP.Pop, 0, 0, line);
  }

  private stmtIf(cond: Expr, then: readonly Stmt[], otherwise: readonly Stmt[] | null, line: number): void {
    this.expr(cond);
    const toElse = this.emitJump(OP.JumpIfFalse, line);

    this.beginScope();
    for (const s of then) this.stmt(s);
    this.endScope();

    if (otherwise === null) {
      this.patch(toElse, this.here());
      return;
    }
    const toEnd = this.emitJump(OP.Jump, line);
    this.patch(toElse, this.here());

    this.beginScope();
    for (const s of otherwise) this.stmt(s);
    this.endScope();

    this.patch(toEnd, this.here());
  }

  private stmtWhile(cond: Expr, body: readonly Stmt[], line: number): void {
    const top = this.here();
    this.expr(cond);
    const toEnd = this.emitJump(OP.JumpIfFalse, line);

    const exits = this.loopBody(body);
    // The back edge goes in first: `break` has to land *after* it, or it jumps
    // back to the top of the loop and behaves like `continue`.
    this.emit(OP.Jump, top, 0, line);
    const end = this.here();
    for (const at of exits.continues) this.patch(at, top);
    for (const at of exits.breaks) this.patch(at, end);
    this.patch(toEnd, end);
  }

  private stmtFor(name: string, iter: Expr, body: readonly Stmt[], line: number): void {
    this.expr(iter);
    this.emit(OP.GetIter, 0, 0, line);

    const top = this.here();
    const toEnd = this.emitJump(OP.ForIter, line);

    this.beginScope();
    // ForIter left the value on the stack; the loop variable holds it.  A
    // module-level loop binds a global, so the name outlives the loop.
    if (this.fn.isModule) {
      this.globalKinds.set(name, "var");
      this.emit(OP.StoreGlobal, this.fn.consts.string(name), DECLARE, line);
    } else {
      const slot = this.addLocal(name, "var");
      this.emit(OP.StoreLocal, slot, DECLARE, line);
    }
    this.emit(OP.Pop, 0, 0, line);

    const exits = this.loopBody(body);
    this.emit(OP.Jump, top, 0, line);
    const end = this.here();
    for (const at of exits.continues) this.patch(at, top);
    for (const at of exits.breaks) this.patch(at, end);
    this.patch(toEnd, end);
  }

  /** Compiles a loop body and collects the jumps its `break`s left behind. */
  private loopBody(body: readonly Stmt[]): { breaks: number[]; continues: number[] } {
    this.breaks.push([]);
    this.continues.push([]);
    this.beginScope();
    for (const s of body) this.stmt(s);
    this.endScope();
    return { breaks: this.breaks.pop() ?? [], continues: this.continues.pop() ?? [] };
  }

  private stmtBranch(what: "break" | "continue" | "pass", line: number): void {
    if (what === "pass") return;
    const at = this.emitJump(OP.Jump, line);
    if (what === "break") {
      const list = this.breaks[this.breaks.length - 1];
      if (list === undefined) throw new L0pError(`\`break\` outside a loop`, line, line, this.file);
      list.push(at);
    } else {
      const list = this.continues[this.continues.length - 1];
      if (list === undefined) throw new L0pError(`\`continue\` outside a loop`, line, line, this.file);
      list.push(at);
    }
  }

  private stmtImport(s: Import, line: number, col: number): void {
    const local =
      s.form === "import"
        ? (s.alias ?? s.path.slice(s.path.lastIndexOf(".") + 1))
        : null;
    this.imports.push({
      form: s.form,
      path: s.path,
      alias: s.alias,
      names: s.names,
      level: s.level,
      local,
      line,
      col,
    });
    this.emit(OP.Import, this.imports.length - 1, 0, line);
  }

  // ---------------------------------------------------------- expressions

  private expr(e: Expr): void {
    switch (e.kind) {
      case "Num":
        this.emit(OP.Const, this.fn.consts.number(e.value), 0, e.line);
        return;

      case "Bool":
        this.emit(OP.Const, this.fn.consts.bool(e.value), 0, e.line);
        return;

      case "Null":
        this.emit(OP.Const, this.fn.consts.null(), 0, e.line);
        return;

      case "Str":
        this.exprStr(e.parts, e.line);
        return;

      case "Ident":
        this.loadName(e.name, e.line);
        return;

      case "ListLit":
        for (const item of e.items) this.expr(item);
        this.emit(OP.NewList, e.items.length, 0, e.line);
        return;

      case "DictLit":
        for (const en of e.entries) {
          this.expr(en.key);
          this.expr(en.value);
        }
        this.emit(OP.NewDict, e.entries.length, 0, e.line);
        return;

      case "Unary":
        this.expr(e.operand);
        this.emit(OP.Un, unIndex(e.op), 0, e.line);
        return;

      case "Binary":
        this.expr(e.left);
        this.expr(e.right);
        this.emit(OP.Bin, binIndex(e.op), 0, e.line);
        return;

      case "Logical":
        this.exprLogical(e);
        return;

      case "Ternary":
        this.exprTernary(e);
        return;

      case "Call":
        this.expr(e.callee);
        for (const a of e.args) this.expr(a);
        this.emit(OP.Call, e.args.length, 0, e.line);
        return;

      case "Attr":
        this.expr(e.obj);
        this.emit(OP.GetAttr, this.fn.consts.string(e.name), 0, e.line);
        return;

      case "Index":
        this.expr(e.obj);
        this.expr(e.index);
        this.emit(OP.GetIndex, 0, 0, e.line);
        return;
      case "Lambda": {
        this.beginFunc("lambda", false, e.params.map((p) => p.name));
        this.beginScope();
        this.emitParamDefaults(e.params, e.line);
        this.expr(e.body);
        this.emit(OP.Return, 0, 0, e.line);
        this.endScope();
        const proto = this.endFunc();
        (this.fn.protos as number[]).push(proto);
        this.emit(OP.Closure, proto, 0, e.line);
        return;
      }
      case "Spawn":
        throw new L0pError("`spawn` arrives with the async work (M7)", e.line, e.col, this.file);

      case "Await":
        throw new L0pError("`await` arrives with the async work (M7)", e.line, e.col, this.file);
    }
  }

  private exprStr(parts: readonly (string | Expr)[], line: number): void {
    if (parts.length === 1 && typeof parts[0] === "string") {
      this.emit(OP.Const, this.fn.consts.string(parts[0]), 0, line);
      return;
    }
    // Each part is stringified by Concat, not by `+`, so `"a" + 1` stays a type
    // error while `"a${1}"` does what it looks like.
    for (const p of parts) {
      if (typeof p === "string") this.emit(OP.Const, this.fn.consts.string(p), 0, line);
      else this.expr(p);
    }
    this.emit(OP.Concat, parts.length, 0, line);
  }

  private exprLogical(e: Expr & { kind: "Logical" }): void {
    this.expr(e.left);
    if (e.op === "and") {
      // keep the value when it is false, otherwise fall through to the right
      this.emit(OP.Dup, 0, 0, e.line);
      const toEnd = this.emitJump(OP.JumpIfFalseOrPop, e.line);
      this.emit(OP.Pop, 0, 0, e.line);
      this.expr(e.right);
      this.patch(toEnd, this.here());
      return;
    }
    this.emit(OP.Dup, 0, 0, e.line);
    const toEnd = this.emitJump(OP.JumpIfTrueOrPop, e.line);
    this.emit(OP.Pop, 0, 0, e.line);
    this.expr(e.right);
    this.patch(toEnd, this.here());
  }

  private exprTernary(e: Expr & { kind: "Ternary" }): void {
    this.expr(e.cond);
    const toElse = this.emitJump(OP.JumpIfFalse, e.line);
    this.expr(e.then);
    const toEnd = this.emitJump(OP.Jump, e.line);
    this.patch(toElse, this.here());
    this.expr(e.other);
    this.patch(toEnd, this.here());
  }

  private loadName(name: string, line: number): void {
    const ref = this.resolve(name);
    if (ref === null) {
      this.emit(OP.LoadGlobal, this.fn.consts.string(name), 0, line);
      return;
    }
    if (ref.kind === "local") this.emit(OP.LoadLocal, ref.slot, 0, line);
    else this.emit(OP.LoadUpval, ref.index, 0, line);
  }
}

export { BIN, UN, binIndex, unIndex, type BinaryOp, type UnaryOp, type Constant };
