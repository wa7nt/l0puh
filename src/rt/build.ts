/**
 * Assembling and linking.
 *
 * The compiler generates *assembly text* and lets clang turn it into an object
 * file.  Writing an assembler and a linker as well would be another couple of
 * thousand lines and a month of debugging through a disassembler, for a result
 * that is byte-for-byte the same.  The compiler is still a compiler: what comes
 * out of it is machine code, and nothing reads it on the way.
 *
 * What is owned here, and what is delegated:
 *
 *   ours:      the instruction sequences, the layout, the data
 *   clang's:   turning mnemonics into bytes, the ELF/Mach-O container, symbols
 *
 * The flags matter and are not defaults.  `-fno-omit-frame-pointer` because a
 * traceback walks the rbp chain, and without it the chain is whatever happened
 * to be on the stack.  `-fno-optimize-sibling-calls` for the same reason: a tail
 * call elides the frame the trace wanted.  A compiler that drops its own frames
 * cannot be debugged.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { L0pError } from "../errors.ts";
import { Parser } from "../parser.ts";
import { compileModule } from "../ir/codegen.ts";
import { lowerProgram } from "../ir/lower.ts";
import { verifyModule } from "../ir/verify.ts";

/** Where the runtime sources live, relative to this file. */
export const RT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../rt");

export interface BuildOptions {
  /** Extra clang flags, appended after the ones set here. */
  extraFlags?: readonly string[];
  /** Keep the temporary directory instead of deleting it. */
  keepBuild?: boolean;
}

export interface BuildResult {
  /** The executable. */
  binary: string;
  /** The directory it lives in; only useful with `keepBuild`. */
  dir: string;
  /** The exact clang command lines, for a failing build. */
  commands: readonly string[];
}

let cachedToolchain: { clang: string; version: string } | null = null;

/** Locates clang once and remembers the answer. */
export function toolchain(): { clang: string; version: string } {
  if (cachedToolchain !== null) return cachedToolchain;
  for (const candidate of ["/usr/bin/clang", "clang", "cc"]) {
    try {
      const out = execFileSync(candidate, ["--version"], { encoding: "utf8" });
      cachedToolchain = { clang: candidate, version: out.split("\n")[0] ?? "unknown" };
      return cachedToolchain;
    } catch {
      continue;
    }
  }
  throw new Error("no C compiler found: install clang, or set one in the toolchain");
}

/** Per-invocation flags: the runtime's own directory has to be includable. */
function cflags(extra: readonly string[] = []): string[] {
  return [...CFLAGS, `-I${RT_DIR}`, ...extra];
}

const CFLAGS = [
  "-c",
  "-std=c11",
  // The runtime is the root of trust for generated code: if it can be
  // miscompiled, every number the compiler produces is suspect.
  "-fno-omit-frame-pointer",
  "-fno-optimize-sibling-calls",
  "-fno-strict-aliasing",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
] as const;

const LDFLAGS = [
  "-fno-omit-frame-pointer",
  "-fno-optimize-sibling-calls",
] as const;

/**
 * Assembles, compiles and links an executable.
 *
 * `asmSources` is assembly text keyed by file name, `cSources` likewise.  The
 * runtime's own sources are added automatically, because a program that does not
 * link the runtime has no arena and no way to print.
 */
export function buildBinary(
  asmSources: Record<string, string>,
  cSources: Record<string, string> = {},
  options: BuildOptions = {},
): BuildResult {
  const { clang } = toolchain();
  const dir = mkdtempSync(join(tmpdir(), "l0p-build-"));
  const objects: string[] = [];
  const commands: string[] = [];

  const compileOne = (name: string, source: string, flags: readonly string[]): string => {
    const path = join(dir, name);
    writeFileSync(path, source, "utf8");
    // The extension stays in the object name: `main.s` and `main.c` both want to
    // become `main.o`, and the second silently overwrites the first.
    const object = `${path}.o`;
    const argv = [...flags, path, "-o", object];
    commands.push(`${clang} ${argv.join(" ")}`);
    execFileSync(clang, argv, { stdio: ["ignore", "pipe", "pipe"] });
    objects.push(object);
    return object;
  };

  for (const [name, source] of Object.entries(asmSources)) {
    if (!name.endsWith(".s")) throw new Error(`assembly source must end in .s: ${name}`);
    compileOne(name, source, ["-c"]);
  }
  for (const [name, source] of Object.entries(cSources)) {
    if (!name.endsWith(".c")) throw new Error(`C source must end in .c: ${name}`);
    compileOne(name, source, cflags(options.extraFlags));
  }

  // The runtime, unless the caller supplied its own.
  if (!("l0p_rt.c" in cSources)) {
    for (const name of ["l0p_rt.c", "l0p_abi.s"]) {
      const path = join(RT_DIR, name);
      if (!existsSync(path)) throw new Error(`runtime source missing: ${path}`);
      compileOne(name, readFileSync(path, "utf8"), name.endsWith(".s") ? ["-c"] : cflags(options.extraFlags));
    }
  }

  const binary = join(dir, "prog");
  const link = [...LDFLAGS, ...objects, "-o", binary];
  commands.push(`${clang} ${link.join(" ")}`);
  execFileSync(clang, link, { stdio: ["ignore", "pipe", "pipe"] });

  return { binary, dir, commands };
}

/** Assembles a single file to an object, for a test that only needs one step. */
export function assembleOnly(name: string, source: string, outDir?: string): string {
  const { clang } = toolchain();
  const dir = outDir ?? mkdtempSync(join(tmpdir(), "l0p-asm-"));
  const path = join(dir, name);
  writeFileSync(path, source, "utf8");
  const object = `${path}.o`;
  execFileSync(clang, ["-c", path, "-o", object], { stdio: ["ignore", "pipe", "pipe"] });
  return object;
}

/**
 * Compiles a l0puh source file all the way to a runnable program.
 *
 * The whole native path in one call: parse, lower, verify, emit assembly, and
 * hand it to clang.  Verification is not optional here -- a function that is not
 * in SSA produces code that assembles cleanly and misbehaves later, and this is
 * the last point at which the compiler can still say so in terms of a line
 * number.
 */
export function buildNative(
  source: string,
  filename: string,
  options: BuildOptions = {},
): BuildResult {
  const program = Parser.fromSource(source, filename).parseProgram();
  const module = lowerProgram(program, filename);
  const report = verifyModule(module.funcs);
  if (report.problems.length > 0) {
    throw new L0pError(
      `the native backend cannot compile this program:\n  ${report.problems.join("\n  ")}`,
      0, 0, filename,
    );
  }
  return buildBinary({ "program.s": compileModule(module) }, {}, options);
}
