/**
 * Turning an import statement into a path on disk.
 *
 * The rules are Python's, and deliberately so:
 *
 *   - `mod` is a file `mod.l0p`; `a.b` is `a/b.l0p`, so `a` is a package;
 *   - a package is just a directory.  There is no `__init__.l0p`, because
 *     Python's is a wart that exists only to distinguish a package from a
 *     namespace package, and this language has no such distinction;
 *   - `L0P_PATH` is searched after the importing file's own directory;
 *   - a leading dot means "relative to the importing module's package": one dot
 *     is that package, two is its parent, and so on.
 *
 * Nothing here reads or parses anything.  It answers one question -- "given this
 * statement, which file?" -- and it is pure, so the whole search order is
 * testable against an in-memory tree.
 */

import { EXT, splitPath, type FileSystem } from "./fs.ts";

export type ResolutionKind = "module" | "namespace";

export interface Resolution {
  kind: ResolutionKind;
  /** Absolute path of the `.l0p` file, or of the directory for a package. */
  path: string;
  /** The dotted name this resolves to, e.g. `a.b`.  May be empty. */
  dotted: string;
  /** Directory that relative imports inside this module start from. */
  packageDir: string;
}

export type ResolveFailure =
  | { reason: "bad-path"; detail: string }
  | { reason: "not-found"; searched: string[] };

export type ResolveResult =
  | { ok: true; resolution: Resolution }
  | { ok: false; failure: ResolveFailure };

export class Resolver {
  private readonly fs: FileSystem;
  /*
   * Not readonly: `setSearchPath` exists to supply it after the resolver has
   * been built, since the entry directory is not known until resolution starts.
   * Declaring it readonly contradicted the method three lines below.
   */
  private searchPath: readonly string[];

  constructor(fs: FileSystem, searchPath: readonly string[]) {
    this.fs = fs;
    this.searchPath = searchPath;
  }

  /** Used when the entry point's directory has to be added after the fact. */
  setSearchPath(path: readonly string[]): void {
    this.searchPath = path;
  }

  /**
   * Resolves `path` at `level` dots, as seen from `fromFile`.
   * An empty `path` means the importing package itself (`from . import x`).
   */
  resolve(path: string, level: number, fromFile: string | null): ResolveResult {
    const segments = splitPath(path);
    if (segments === null) {
      return { ok: false, failure: { reason: "bad-path", detail: `${path} is not a module path` } };
    }
    if (level === 0) return this.search(segments, this.searchPath, path);
    return this.searchRelative(segments, level, fromFile);
  }

  /**
   * Resolves `name` as a child of an already-resolved module or package, for
   * `from a import b` when `b` is not something `a` exports.
   *
   * A package's children are searched inside the package itself, so the
   * package's own segments must not be repeated.  A module's children live
   * under the directory that shares its name, which is why the whole dotted
   * path is rebuilt from the parent directory.
   */
  resolveSubmodule(parent: Resolution, name: string): ResolveResult {
    const dotted = parent.dotted === "" ? name : `${parent.dotted}.${name}`;
    if (parent.kind === "namespace") {
      return this.search([name], [parent.path], dotted);
    }
    return this.search([...parent.dotted.split("."), name], [this.fs.dirname(parent.path)], dotted);
  }

  private searchRelative(segments: string[], level: number, fromFile: string | null): ResolveResult {
    if (fromFile === null) {
      return {
        ok: false,
        failure: {
          reason: "not-found",
          searched: [],
        },
      };
    }
    // One dot is the module's own directory; each extra dot climbs one level.
    let dir = this.fs.dirname(fromFile);
    for (let i = 1; i < level; i++) dir = this.fs.dirname(dir);

    if (segments.length === 0) {
      return { ok: true, resolution: { kind: "namespace", path: dir, dotted: "", packageDir: dir } };
    }
    return this.search(segments, [dir], segments.join("."));
  }

  /** The first entry of the search path that has this path wins. */
  private search(segments: string[], roots: readonly string[], dotted: string): ResolveResult {
    if (segments.length === 0) {
      const only = roots[0];
      if (only === undefined) return { ok: false, failure: { reason: "not-found", searched: [] } };
      return {
        ok: true,
        resolution: { kind: "namespace", path: only, dotted, packageDir: only },
      };
    }

    const searched: string[] = [];
    for (const root of roots) {
      const stem = this.fs.join(root, segments.join("/"));

      const file = stem + EXT;
      searched.push(file);
      if (this.fs.isFile(file)) {
        return {
          ok: true,
          resolution: { kind: "module", path: file, dotted, packageDir: this.fs.dirname(file) },
        };
      }

      // A package is a bare directory: there is no __init__ file to look for.
      searched.push(stem);
      if (this.fs.isDir(stem)) {
        return {
          ok: true,
          resolution: { kind: "namespace", path: stem, dotted, packageDir: stem },
        };
      }
    }
    return { ok: false, failure: { reason: "not-found", searched } };
  }
}

/** `import os.path as osp` binds `osp`; `import os.path` binds `path`. */
export function localNameFor(dotted: string, alias: string | null): string {
  if (alias !== null) return alias;
  const idx = dotted.lastIndexOf(".");
  return idx === -1 ? dotted : dotted.slice(idx + 1);
}
