#!/usr/bin/env node
/**
 * `l0p` -- the command line entry point.
 *
 *   l0p run <file>    run a program
 *   l0p parse <file>  parse and print the syntax tree
 *   l0p lex <file>    print the token stream
 *   l0p disasm <file> print the compiled bytecode
 *   l0p ir <file>     print the native intermediate representation
 *   l0p repl          interactive prompt
 */

import { readFileSync } from "node:fs";

import { constLabel, type Module, type Proto } from "../bytecode/code.ts";
import { formatCode } from "../bytecode/op.ts";
import { formatProgram } from "../astprint.ts";
import { L0pError } from "../errors.ts";
import { formatTokens, tokenize } from "../lexer.ts";
import { Parser } from "../parser.ts";
import { Session } from "../session.ts";
import { printModule } from "../ir/ir.ts";
import { lowerProgram } from "../ir/lower.ts";
import { verifyModule } from "../ir/verify.ts";
import { repr } from "../vm/value.ts";

const VERSION = "0.2.0";

const USAGE = `l0p ${VERSION} -- a small language

  l0p run <file>      run a program
  l0p parse <file>    parse and print the syntax tree
  l0p lex <file>      print the token stream
  l0p disasm <file>   print the compiled bytecode
  l0p ir <file>       print the native intermediate representation
  l0p repl            interactive prompt
  l0p version         print the version

Files end in .l0p.  Imports search the file's own directory, then L0P_PATH.`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "repl") {
    // Imported here so the other commands do not pay for readline.
    const { repl } = await import("./repl.ts");
    repl();
    return 0;
  }
  if (command === "run" || command === "parse" || command === "lex" || command === "disasm" || command === "ir") {
    const path = rest[0];
    if (path === undefined) {
      process.stderr.write(`error: ${command} needs a file\n`);
      return 2;
    }
    return runFile(command, path);
  }
  // No file given: a bare `l0p` opens the prompt, which is what a person means.
  if (command.endsWith(".l0p") || command.includes("/")) {
    return runFile("run", command);
  }

  process.stderr.write(`error: unknown command ${JSON.stringify(command)}\n\n${USAGE}\n`);
  return 2;
}

function runFile(command: string, path: string): number {
  let src: string;
  try {
    src = readFileSync(path, "utf8");
  } catch (e) {
    process.stderr.write(`error: cannot read ${path}: ${(e as NodeJS.ErrnoException).code ?? String(e)}\n`);
    return 2;
  }

  try {
    if (command === "lex") {
      process.stdout.write(`${formatTokens(tokenize(src, path))}\n`);
      return 0;
    }
    if (command === "parse") {
      const text = formatProgram(Parser.fromSource(src, path).parseProgram());
      if (text !== "") process.stdout.write(`${text}\n`);
      return 0;
    }
    if (command === "disasm") {
      process.stdout.write(`${disassemble(new Session(), path)}\n`);
      return 0;
    }
    if (command === "ir") {
      // Verification runs before printing, so a malformed function is reported
      // with its position instead of being read as a valid listing.
      const ir = lowerToIr(path);
      if (ir.problems.length > 0) {
        process.stderr.write(`${ir.problems.join("\n")}\n`);
        return 1;
      }
      process.stdout.write(`${ir.text}\n`);
      for (const w of ir.warnings) process.stderr.write(`warning: ${w}\n`);
      return 0;
    }
  } catch (e) {
    if (e instanceof L0pError) {
      process.stderr.write(`${e.format(src)}\n`);
      return 1;
    }
    throw e;
  }

  // run
  const session = new Session();
  try {
    const r = session.runFile(path);
    if (r.result !== null && r.result !== undefined) {
      process.stdout.write(`${repr(r.result)}\n`);
    }
    return 0;
  } catch (e) {
    // A runtime error already has a file and a line; the source is re-read so
    // the caret can point at the offending character.
    if (e instanceof L0pError) {
      if (e.line > 0) process.stderr.write(`${e.format(src)}\n`);
      else process.stderr.write(`${e.prefix()}: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

/** A readable listing of every function in a file. */
export function disassemble(session: Session, path: string): string {
  const record = session.loader.loadEntry(path);
  const module = session.compileRecord(record);
  const chunks: string[] = [];

  module.protos.forEach((p: Proto, i) => {
    const consts = p.consts.map(constLabel);
    const protos = module.protos.map((q) => q.name);
    const head = `; ${p.isModule ? "module" : "fn"} ${p.name}  [proto ${i}]  slots=${p.nslots} params=${p.params.length} upvalues=${p.upvalues.length}`;
    chunks.push(`${head}\n${formatCode(p.code, consts, protos)}`);
  });

  if (module.imports.length > 0) {
    chunks.push(
      `; imports\n${module.imports
        .map((im) => `;   ${im.form} ${".".repeat(im.level)}${im.path}${im.local === null ? "" : ` as ${im.local}`}`)
        .join("\n")}`,
    );
  }
  return chunks.join("\n\n");
}

process.exitCode = await main(process.argv.slice(2));

/**
 * The native IR for a file, verified.
 *
 * Verification runs here rather than inside the printer, so a function that is
 * not in SSA is named with its position instead of being shown as if it were a
 * valid listing -- a listing that reads plausibly is worse than no listing.
 */
export function lowerToIr(path: string): { text: string; problems: string[]; warnings: string[] } {
  const src = readFileSync(path, "utf8");
  const module = lowerProgram(Parser.fromSource(src, path).parseProgram(), path);
  const report = verifyModule(module.funcs);
  return { text: printModule(module), problems: report.problems, warnings: report.warnings };
}
