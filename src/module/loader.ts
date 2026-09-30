/**
 * The module cache.
 *
 * One entry per absolute path, created once and reused, so `import math` twice
 * in one program parses and executes `math.l0p` once -- Python's `sys.modules`
 * rule, and the reason a module can hold state.
 *
 * Imports are *statements*, so nothing here runs any code.  That keeps module
 * loading free of ordering surprises, and it means circular imports only become
 * a problem at execution time -- which is where the VM will report them, with
 * the chain that caused it.  `findCycles` walks the graph ahead of time for
 * tests and for `l0p deps`.
 */

import type { Program } from "../ast.ts";
import type { Import } from "../ast.ts";
import { L0pError } from "../errors.ts";
import { Parser } from "../parser.ts";
import { EXT, realFs, type FileSystem } from "./fs.ts";
import { localNameFor, Resolver, type Resolution } from "./resolver.ts";

export type ModuleKind = "module" | "namespace" | "main";

export interface ModuleRecord {
  readonly name: string;
  readonly kind: ModuleKind;
  /** Absolute path of the `.l0p` file; null for a package directory. */
  readonly file: string | null;
  /** Directory relative imports resolve against. */
  readonly dir: string;
  /** Parsed body; null for a package, which has no code of its own. */
  readonly program: Program | null;
  /** Filled in by the VM as the module executes. */
  readonly exports: Map<string, unknown>;
  /** False while the module is being set up, true once its body has run. */
  executed: boolean;
}

export interface ImportBinding {
  /** Name this import puts into the importing scope; null for a bare `import a`. */
  local: string | null;
  kind: "module" | "submodule" | "attribute";
  module: ModuleRecord;
  /** The name to read off `module`, for `from m import x` on a real export. */
  attribute: string | null;
}

export class ModuleLoader {
  private readonly fs: FileSystem;
  private readonly resolver: Resolver;
  private readonly cache = new Map<string, ModuleRecord>();
  /** In-flight, for cycle reporting.  A module appears here while it executes. */
  private readonly executing: string[] = [];

  private searchPath: string[];

  constructor(fs: FileSystem, searchPath: readonly string[]) {
    this.fs = fs;
    this.searchPath = [...searchPath];
    this.resolver = new Resolver(fs, this.searchPath);
  }

  /**
   * Puts a directory at the front of the search path.
   *
   * The entry point's own directory has to be there: a program is normally run
   * from somewhere other than the directory it lives in, and `import helper`
   * has to find the file next to it.
   */
  unshiftPath(dir: string): void {
    this.searchPath = [dir, ...this.searchPath.filter((p) => p !== dir)];
    this.resolver.setSearchPath(this.searchPath);
  }

  /** Parses `path` (or returns the cached copy) and registers it as the entry. */
  loadEntry(path: string): ModuleRecord {
    const absolute = this.fs.isAbsolute(path) ? path : this.fs.join(this.fs.cwd(), path);
    const cached = this.cache.get(absolute);
    if (cached !== undefined) return cached;

    const record = this.parse(absolute, "__main__", "main");
    if (record === null) {
      throw new L0pError(`no such file: ${absolute}`);
    }
    return record;
  }

  /**
   * Resolves one import statement.  Throws with the searched paths listed when
   * nothing matches, because "module not found" without the search path is the
   * least useful error a module system can produce.
   */
  resolveImport(stmt: Import, from: ModuleRecord): ImportBinding[] {
    const found = this.resolver.resolve(stmt.path, stmt.level, from.file);

    if (stmt.form === "import") {
      if (!found.ok) throw this.failure(stmt, from, found.failure);
      const module = this.adopt(found.resolution, stmt.level > 0);
      const local = localNameFor(stmt.path, stmt.alias);
      return [{ local, kind: "module", module, attribute: null }];
    }

    // `from m import a, b`
    if (!found.ok) throw this.failure(stmt, from, found.failure);
    const parent = this.adopt(found.resolution, stmt.level > 0);

    return stmt.names.map((name): ImportBinding => {
      // A name is a submodule unless the package already exports it, and the
      // export only exists once the parent has run -- so at this point a
      // submodule is the right guess, and the VM falls back to the export.
      const sub = this.resolver.resolveSubmodule(found.resolution, name);
      if (sub.ok) {
        return { local: name, kind: "submodule", module: this.adopt(sub.resolution, false), attribute: null };
      }
      return { local: name, kind: "attribute", module: parent, attribute: name };
    });
  }

  /**
   * Gets or creates the record for a resolution.  A package directory gets an
   * empty record, which is exactly what makes `import a.b` able to bind `a` as
   * a namespace without any `__init__` file.
   */
  private adopt(resolution: Resolution, isRelative: boolean): ModuleRecord {
    if (resolution.kind === "namespace") {
      const key = resolution.path;
      const existing = this.cache.get(key);
      if (existing !== undefined) return existing;
      const name = resolution.dotted === "" ? "" : resolution.dotted;
      const record: ModuleRecord = {
        name,
        kind: "namespace",
        file: null,
        dir: resolution.path,
        program: null,
        exports: new Map(),
        executed: true,
      };
      this.cache.set(key, record);
      return record;
    }

    const key = resolution.path;
    const existing = this.cache.get(key);
    if (existing !== undefined) return existing;

    // The dotted name is best-effort: a module reached by a relative import is
    // named by where it sits, not by how it was spelled at the import site.
    const name = isRelative ? basenameOf(resolution.path) : resolution.dotted;
    const record = this.parse(resolution.path, name, "module");
    if (record === null) throw new L0pError(`no such file: ${resolution.path}`);
    return record;
  }

  private parse(path: string, name: string, kind: ModuleKind): ModuleRecord | null {
    if (!this.fs.isFile(path)) return null;
    const src = this.fs.read(path);
    const program = Parser.fromSource(src, path).parseProgram();
    const record: ModuleRecord = {
      name,
      kind,
      file: path,
      dir: this.fs.dirname(path),
      program,
      exports: new Map(),
      executed: false,
    };
    this.cache.set(path, record);
    return record;
  }

  private failure(stmt: Import, from: ModuleRecord, failure: { reason: string; detail?: string; searched?: string[] }): L0pError {
    const spelling = `${".".repeat(stmt.level)}${stmt.path}${stmt.form === "from" ? ` import ${stmt.names.join(", ")}` : ""}`;
    const where = from.file ?? "<stdin>";
    if (failure.reason === "bad-path") {
      return new L0pError(`not a module path: ${failure.detail}`, 0, 0, where);
    }
    const searched = failure.searched ?? [];
    const lines = [`cannot import ${spelling} from ${where}`];
    if (searched.length > 0) lines.push(`  looked in:\n    ${searched.join("\n    ")}`);
    return new L0pError(lines.join("\n"), 0, 0, where);
  }

  // ------------------------------------------------------------- analysis

  /** Every module the cache currently holds, for diagnostics. */
  loaded(): ModuleRecord[] {
    return [...this.cache.values()];
  }

  /** The directory a file sits in, for putting it on the search path. */
  dirnameOf(path: string): string {
    return this.fs.dirname(this.fs.isAbsolute(path) ? path : this.fs.join(this.fs.cwd(), path));
  }

  /**
   * The cycle through `entry`, or null.  Purely static: it follows `import`
   * statements without running anything, so a cycle is visible before it turns
   * into a half-initialised module at run time.
   */
  findCycles(entry: ModuleRecord): string[] | null {
    const seen = new Set<string>();
    const stack: { key: string; name: string }[] = [];
    const onStack = new Set<string>();
    const found = this.walk(entry, seen, stack, onStack);
    return found;
  }

  private walk(
    module: ModuleRecord,
    seen: Set<string>,
    stack: { key: string; name: string }[],
    onStack: Set<string>,
  ): string[] | null {
    if (module.program === null || module.file === null) return null;
    if (onStack.has(module.file)) {
      const start = stack.findIndex((f) => f.key === module.file);
      const cycle = stack.slice(start === -1 ? 0 : start).map((f) => f.name);
      cycle.push(module.name);
      return cycle;
    }
    if (seen.has(module.file)) return null;

    seen.add(module.file);
    onStack.add(module.file);
    stack.push({ key: module.file, name: module.name });

    for (const stmt of module.program.stmts) {
      if (stmt.kind !== "Import") continue;
      for (const binding of this.tryResolveImport(stmt, module)) {
        const hit = this.walk(binding.module, seen, stack, onStack);
        if (hit !== null) return hit;
      }
    }

    stack.pop();
    onStack.delete(module.file);
    return null;
  }

  private tryResolveImport(stmt: Import, from: ModuleRecord): ImportBinding[] {
    try {
      return this.resolveImport(stmt, from);
    } catch {
      return []; // a broken import is reported when it runs, not by this walk
    }
  }
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1, path.endsWith(EXT) ? -EXT.length : undefined);
}
