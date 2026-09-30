import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

interface Result {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI on a source string and collects its exit code and streams. */
async function l0p(args: string[], src?: string): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), "l0p-"));
  const path = join(dir, "prog.l0p");
  if (src !== undefined) writeFileSync(path, src, "utf8");
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args, path], { encoding: "utf8" });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: err.stdout ?? "", err: err.stderr ?? "" };
  }
}

describe("l0p cli", () => {
  it("prints the version and the usage", async () => {
    const v = await l0p(["version"], "");
    assert.equal(v.code, 0);
    assert.match(v.out, /^\d+\.\d+\.\d+/m);

    const h = await l0p(["help"], "");
    assert.match(h.out, /l0p run <file>/);
  });

  it("rejects an unknown command with exit 2", async () => {
    const r = await l0p(["bogus"], "");
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown command "bogus"/);
  });

  it("parses a file and prints the tree", async () => {
    const r = await l0p(["parse"], "def f(n):\n    if n < 2:\n        return n\n    return n\n");
    assert.equal(r.code, 0);
    assert.equal(r.out, "def f(n)\n  if n < 2\n    return n\n  return n\n");
  });

  it("runs a program and prints the value of its last expression", async () => {
    const r = await l0p(["run"], "var t = 0\nfor i in range(4):\n    t = t + i\nt\n");
    assert.equal(r.code, 0);
    assert.equal(r.out, "6\n");
  });

  it("prints what the program prints, then the result", async () => {
    const r = await l0p(["run"], 'print("hi")\n1 + 1\n');
    assert.equal(r.code, 0);
    assert.equal(r.out, "hi\n2\n");
  });

  it("prints nothing extra when the program ends in a declaration", async () => {
    const r = await l0p(["run"], "let x = 1\n");
    assert.equal(r.out, "");
  });

  it("reports a runtime error with the line and returns 1", async () => {
    const r = await l0p(["run"], "let x = 1\nx = 2\n");
    assert.equal(r.code, 1);
    assert.match(r.err, /cannot assign to x/);
    assert.match(r.err, /prog\.l0p:2:1/);
  });

  it("reports a missing module with where it looked", async () => {
    const r = await l0p(["run"], "import nowhere\n");
    assert.equal(r.code, 1);
    assert.match(r.err, /cannot import nowhere/);
  });

  it("disassembles to something readable", async () => {
    const r = await l0p(["disasm"], "def f(n):\n    return n + 1\nf(1)\n");
    assert.equal(r.code, 0);
    assert.match(r.out, /; fn f/);
    assert.match(r.out, /bin \+/);
  });

  it("dumps tokens", async () => {
    const r = await l0p(["lex"], "x = 1\n");
    assert.equal(r.code, 0);
    assert.match(r.out, /Ident\s+"x"/);
    assert.match(r.out, /Number\s+1/);
  });

  it("reports a parse error with a caret and exit 1", async () => {
    const r = await l0p(["parse"], "let x = 1\nlet = 2\n");
    assert.equal(r.code, 1);
    assert.match(r.err, /prog\.l0p:2:5/);
    assert.match(r.err, /expected a name after the binding/);
    assert.match(r.err, /\^/);
  });

  it("names the file in the error position", async () => {
    const r = await l0p(["parse"], "x = (1 +\n");
    assert.equal(r.code, 1);
    assert.match(r.err, /prog\.l0p:/);
  });

  it("reports a missing file rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "l0p-"));
    const missing = join(dir, "nope.l0p");
    try {
      await run(process.execPath, [CLI, "parse", missing], { encoding: "utf8" });
      assert.fail("expected a non-zero exit");
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /cannot read .*nope\.l0p/);
    }
  });
});
