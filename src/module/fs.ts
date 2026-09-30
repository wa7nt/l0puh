/**
 * The filesystem the module system sees.
 *
 * It is an interface so that resolution can be tested against an in-memory tree
 * instead of the real disk.  Path arithmetic lives here too, so the resolver
 * never imports `node:path` and never has to know the separator.
 */

import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export const EXT = ".l0p";

export interface FileSystem {
  isFile(path: string): boolean;
  isDir(path: string): boolean;
  read(path: string): string;
  dirname(path: string): string;
  join(base: string, rel: string): string;
  isAbsolute(path: string): boolean;
  cwd(): string;
}

export const realFs: FileSystem = {
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  isDir: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  read: (path) => readFileSync(path, "utf8"),
  dirname,
  join: (base, rel) => join(base, rel),
  isAbsolute,
  cwd: () => process.cwd(),
};

/**
 * The search path, in the order Python would use it: the importing script's own
 * directory first, then `L0P_PATH`, then the bundled standard library.
 */
export function buildSearchPath(
  env: string | undefined,
  scriptDir: string | null,
  stdDir: string | null,
  fs: FileSystem = realFs,
): string[] {
  const out: string[] = [];
  if (scriptDir !== null) out.push(scriptDir);
  if (env !== undefined && env !== "") {
    for (const part of env.split(delimiter)) {
      if (part === "") continue;
      out.push(fs.isAbsolute(part) ? part : fs.join(fs.cwd(), part));
    }
  }
  if (stdDir !== null) out.push(stdDir);
  // Duplicates would only cost extra stat calls.
  return [...new Set(out)];
}

/**
 * Turns `a.b.c` into `["a", "b", "c"]`, rejecting anything that is not a legal
 * identifier.  The character classes are the lexer's, so a module segment can
 * always be written as a bare name -- which matters, because `a.b` is also how
 * a package is spelled.
 */
export function splitPath(dotted: string): string[] | null {
  if (dotted === "") return [];
  const parts = dotted.split(".");
  for (const part of parts) {
    if (!IDENT.test(part)) return null;
  }
  return parts;
}

const IDENT = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}_]*$/u;
