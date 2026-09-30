/**
 * Wiring the pieces together: source in, running program out.
 *
 * This is the only place that knows the full pipeline -- read, parse, compile,
 * execute -- and the only place a module's compiled form and its loader record
 * are associated.  Everything else takes one stage's output as its input.
 */

import { fileURLToPath } from "node:url";

import { buildSearchPath, realFs, type FileSystem } from "./module/fs.ts";
import { ModuleLoader, type ModuleRecord } from "./module/loader.ts";
import { compile } from "./compile/compiler.ts";
import { L0pError } from "./errors.ts";
import { Parser } from "./parser.ts";
import { Vm, type ModuleLoaderLike, type ModuleRecordLike, type RunOptions } from "./vm/vm.ts";
import { repr, type Value } from "./vm/value.ts";
import type { Module } from "./bytecode/code.ts";

export interface RunResult {
  /** The value of the last expression statement, if any. */
  result: Value;
  /** Module-level names after the body ran. */
  globals: Map<string, Value>;
  /** Modules that were loaded, in the order they first ran. */
  modules: ModuleRecord[];
}

/**
 * Where the bundled standard library lives.
 *
 * `std/` sits next to `src/`, so it is found relative to this file rather than
 * to the working directory -- `l0p` has to work from anywhere.
 */
export function stdDir(): string | null {
  return fileURLToPath(new URL("../std/", import.meta.url));
}

export class Session {
  readonly loader: ModuleLoader;
  private readonly compiled = new WeakMap<ModuleRecord, Module>();
  private readonly records = new WeakMap<Module, ModuleRecord>();
  private readonly vm: Vm;
  /**
   * Module-level names that survive between runs.  A REPL needs this or every
   * line would start from nothing; a one-shot `run` leaves it empty, so each
   * program gets its own namespace.
   */
  private globals = new Map<string, Value>();

  constructor(fs: FileSystem = realFs, options: RunOptions = {}) {
    const searchPath = buildSearchPath(process.env["L0P_PATH"] ?? undefined, process.cwd(), stdDir(), fs);
    this.loader = new ModuleLoader(fs, searchPath);

    // The VM talks to the loader through a small structural interface, so the
    // loader does not have to know about the VM and vice versa.
    const bridge: ModuleLoaderLike = {
      resolveImport: (stmt, from) => this.loader.resolveImport(stmt as never, from as never),
      compileModule: (record) => this.compileRecord(record as ModuleRecord),
      recordFor: (module) => this.recordFor(module),
    };
    this.vm = new Vm(bridge, options);
  }

  private compileRecordImpl(record: ModuleRecord): Module {
    const cached = this.compiled.get(record);
    if (cached !== undefined) return cached;
    if (record.program === null) throw new L0pError(`${record.name} is a package, not a module`);
    const { module } = compile(record.program as never, record.name, record.file);
    this.compiled.set(record, module);
    this.records.set(module, record);
    return module;
  }

  private recordFor(module: Module): ModuleRecordLike {
    const record = this.records.get(module);
    if (record === undefined) {
      throw new L0pError(`no loader record for module ${module.name}`);
    }
    return record as ModuleRecordLike;
  }

  /** Compiles a source string without running it. */
  compileSource(src: string, name = "<string>", file: string | null = null): Module {
    return compile(Parser.fromSource(src, file).parseProgram(), name, file).module;
  }

  /**
   * Runs a module that was compiled already.
   *
   * The benchmark harness needs this: it wants the interpreter's time without the
   * parse and compile in it, and it cannot get that by timing `runFile`.
   */
  runCompiled(module: Module): Value {
    this.globals = new Map<string, Value>();
    return this.vm.run(module, { globals: this.globals });
  }

  /**
   * Compiles a module the loader already parsed.  Public because `l0p disasm`
   * needs it, and because it is the same path the VM takes: one compile per
   * module, no matter how many importers there are.
   */
  compileRecord(record: ModuleRecord): Module {
    return this.compileRecordImpl(record);
  }

  /**
   * Runs a source string.  Names persist unless `fresh` is set.
   *
   * The binding kinds are per-input, not per-session, which is what a REPL
   * needs: each line is a new declaration, so `x = 99` on a later line is a
   * fresh binding rather than a reassignment of the `let` from the first.
   * Within one input the immutability rules still apply in full.
   */
  runSource(src: string, name = "<string>", file: string | null = null, fresh = false): RunResult {
    const module = this.compileSource(src, name, file);
    if (fresh) this.globals = new Map<string, Value>();
    const result = this.vm.run(module, { globals: this.globals });
    return { result, globals: this.globals, modules: this.loader.loaded() };
  }

  /** The names currently in scope, for `.globals` in the REPL. */
  lastGlobals(): Map<string, Value> | null {
    return this.globals.size === 0 ? null : this.globals;
  }

  /** Forgets every name, as `.clear` does. */
  clear(): void {
    this.globals = new Map<string, Value>();
  }

  /** Runs a `.l0p` file, with its directory first on the search path. */
  runFile(path: string, options: RunOptions = {}): RunResult {
    // The entry point's own directory goes in first: a program run from
    // elsewhere still has to find the modules sitting next to it.
    this.loader.unshiftPath(this.loader.dirnameOf(path));
    const record = this.loader.loadEntry(path);
    const module = this.compileRecordImpl(record);
    this.globals = new Map<string, Value>();
    const result = this.vm.run(module, { ...options, globals: this.globals });
    return { result, globals: this.globals, modules: this.loader.loaded() };
  }

  /** The VM, for the REPL. */
  get machine(): Vm {
    return this.vm;
  }

  /** Everything a REPL needs after running something. */
  static show(result: RunResult): string {
    return result.result === null ? "" : repr(result.result);
  }
}
