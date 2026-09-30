/**
 * Runs one l0puh benchmark file and prints the elapsed milliseconds.
 *
 * Only the interpreter is timed.  Reading the file, parsing and compiling are
 * all done first, because they are startup cost: a Go binary needs about 2 ms of
 * process start and a node process about 40, and timing those together made
 * every Go number look two orders of magnitude worse than it is.
 *
 * A fresh process per measurement, so nothing is measured on a warm JIT; the
 * harness discards the first run of each case for that reason.
 */

import { readFileSync } from "node:fs";

import { Session } from "../src/session.ts";

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write("usage: one.mjs FILE\n");
  process.exit(2);
}

const src = readFileSync(path, "utf8");
const session = new Session();
const module = session.compileSource(src, "bench", path);

const start = process.hrtime.bigint();
const result = session.runCompiled(module);
const ms = Number(process.hrtime.bigint() - start) / 1e6;

process.stdout.write(`${ms.toFixed(1)} ${String(result)}\n`);
