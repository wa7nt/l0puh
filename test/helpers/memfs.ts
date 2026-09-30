/**
 * An in-memory filesystem, so the module tests can lay out a package tree in one
 * object literal and never touch the disk.
 *
 * Directories are implied by file paths, and any key ending in `/` declares an
 * empty directory -- which is how a package with no `__init__` (there is no such
 * thing here) gets tested.
 */

import type { FileSystem } from "../../src/module/fs.ts";

export interface MemFs extends FileSystem {
  /** Every directory known, for assertions. */
  dirs(): string[];
  files(): string[];
}

export function memFs(spec: Record<string, string>, cwd = "/app"): MemFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>(["/", cwd]);

  const addParents = (path: string): void => {
    let dir = dirOf(path);
    while (dir !== "/" && dir !== "") {
      dirs.add(dir);
      dir = dirOf(dir);
    }
    dirs.add("/");
  };

  for (const [path, content] of Object.entries(spec)) {
    if (path.endsWith("/")) {
      dirs.add(path.replace(/\/$/, ""));
      addParents(path.replace(/\/$/, ""));
      continue;
    }
    files.set(normalise(path), content);
    addParents(path);
  }

  return {
    cwd: () => cwd,
    isFile: (path) => files.has(normalise(path)),
    isDir: (path) => dirs.has(normalise(path)) && !files.has(normalise(path)),
    read: (path) => {
      const content = files.get(normalise(path));
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
    dirname: dirOf,
    join: (base, rel) => normalise(`${base}/${rel}`),
    isAbsolute: (path) => path.startsWith("/"),
    dirs: () => [...dirs].sort(),
    files: () => [...files.keys()].sort(),
  };
}

const normalise = (path: string): string => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
};

const dirOf = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
};
