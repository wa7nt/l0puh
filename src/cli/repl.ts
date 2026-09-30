/**
 * The interactive prompt.
 *
 * Uses the callback API of readline rather than the promise one: the promise
 * version leaves `question()` pending forever when stdin closes, which shows up
 * as "unsettled top-level await" and a truncated session.
 *
 * State carries across lines, so a `def` can be typed over several lines and a
 * name defined in one input is visible in the next.  Each input is compiled and
 * run on its own; a name that already exists is a fresh declaration in the same
 * scope, not a reassignment, which is what makes re-entering a definition work.
 */

import { createInterface } from "node:readline";

import { L0pError } from "../errors.ts";
import { Session } from "../session.ts";
import { repr, type Value } from "../vm/value.ts";

/** Error shapes that mean "keep typing", not "this is wrong". */
const INCOMPLETE = /end of input|end of line|an indented block|end of block/;

const BANNER = `l0puh -- ctrl-d to exit, .globals to see names, .clear to reset`;

export function repl(): void {
  const session = new Session();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  process.stdout.write(`${BANNER}\n`);
  rl.prompt();

  let buffer = "";

  rl.on("line", (line) => {
    if (buffer === "" && line.trim() === "") {
      rl.prompt();
      return;
    }
    buffer += (buffer === "" ? "" : "\n") + line;

    if (buffer.trim() === ".globals") {
      printNames(session);
      buffer = "";
      rl.prompt();
      return;
    }
    if (buffer.trim() === ".clear") {
      buffer = "";
      process.stdout.write("(names are reset next time you define them)\n");
      rl.prompt();
      return;
    }

    let result: Value;
    try {
      // `.result` is the program's value; the wrapper is a RunResult
      result = session.runSource(buffer, "<repl>").result;
    } catch (e) {
      if (e instanceof L0pError && INCOMPLETE.test(e.message)) {
        rl.setPrompt("| ");
        rl.prompt();
        return;
      }
      if (e instanceof L0pError) process.stderr.write(`${e.format(buffer)}\n`);
      else process.stderr.write(`${String(e)}\n`);
      buffer = "";
      rl.setPrompt("> ");
      rl.prompt();
      return;
    }

    if (result !== null) process.stdout.write(`${show(result)}\n`);
    buffer = "";
    rl.setPrompt("> ");
    rl.prompt();
  });

  rl.on("close", () => {
    process.stdout.write("\n");
    if (buffer.trim() !== "") process.stdout.write("(incomplete input discarded)\n");
  });
}

/**
 * A result is shown the way a language prompt usually shows one: strings
 * without quotes, everything else with them, so `[1, 2]` looks like a list
 * rather than a piece of source.
 */
function show(v: Value): string {
  if (typeof v === "string") return v;
  return repr(v);
}

function printNames(session: Session): void {
  const last = session.lastGlobals();
  if (last === null) {
    process.stdout.write("(nothing yet)\n");
    return;
  }
  const names = [...last.keys()].filter((n) => !n.startsWith("__") && !isBuiltin(last, n));
  if (names.length === 0) {
    process.stdout.write("(no names yet)\n");
    return;
  }
  for (const name of names.sort()) {
    process.stdout.write(`  ${name} = ${show(last.get(name) as Value)}\n`);
  }
}

const BUILTIN_NAMES = new Set([
  "print", "len", "str", "repr", "bool", "int", "float", "type", "range", "abs",
  "min", "max", "list", "dict", "keys", "values", "get", "push", "has", "delete", "assert",
]);

function isBuiltin(globals: Map<string, Value>, name: string): boolean {
  return BUILTIN_NAMES.has(name);
}
