import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { L0pError } from "../src/errors.ts";
import { buildSearchPath } from "../src/module/fs.ts";
import { ModuleLoader } from "../src/module/loader.ts";
import { localNameFor, Resolver } from "../src/module/resolver.ts";
import { memFs } from "./helpers/memfs.ts";

const TREE = {
  "/app/main.l0p": "let x = 1\n",
  "/app/math.l0p": "let pi = 3\n",
  "/app/os/path.l0p": "let sep = '/'\n",
  "/app/os/": "",
  "/app/pkg/util.l0p": "let slug = 1\n",
  "/app/pkg/sub/inner.l0p": "let deep = 1\n",
  "/app/pkg/sub/x.l0p": "let neighbour = 1\n",
  "/app/pkg/sub/": "",
  "/lib/os/init.l0p": "let name = 'os'\n",
};

const resolver = (searchPath: string[] = ["/app", "/lib"]): Resolver =>
  new Resolver(memFs(TREE), searchPath);

describe("resolution", () => {
  it("finds a top-level module as a file", () => {
    const r = resolver().resolve("math", 0, null);
    assert.ok(r.ok);
    assert.equal(r.resolution.kind, "module");
    assert.equal(r.resolution.path, "/app/math.l0p");
  });

  it("finds a nested module as directory plus file", () => {
    const r = resolver().resolve("os.path", 0, null);
    assert.ok(r.ok);
    assert.equal(r.resolution.path, "/app/os/path.l0p");
  });

  it("finds a bare directory as a package", () => {
    const r = resolver().resolve("os", 0, null);
    assert.ok(r.ok);
    assert.equal(r.resolution.kind, "namespace");
    assert.equal(r.resolution.path, "/app/os");
  });

  it("searches the path in order, first hit wins", () => {
    const r = resolver(["/lib", "/app"]).resolve("os", 0, null);
    assert.ok(r.ok);
    assert.equal(r.resolution.path, "/lib/os"); // the directory, not /app/os
  });

  it("prefers a file over a directory of the same name", () => {
    const fs = memFs({ "/app/thing.l0p": "", "/app/thing/": "" });
    const r = new Resolver(fs, ["/app"]).resolve("thing", 0, null);
    assert.ok(r.ok);
    assert.equal(r.resolution.kind, "module");
  });

  it("reports what it looked for when nothing matches", () => {
    const r = resolver().resolve("nope", 0, null);
    assert.ok(!r.ok);
    assert.equal(r.failure.reason, "not-found");
    assert.deepEqual(r.failure.searched, ["/app/nope.l0p", "/app/nope", "/lib/nope.l0p", "/lib/nope"]);
  });

  it("rejects a path that is not made of names", () => {
    const r = resolver().resolve("a-b", 0, null);
    assert.ok(!r.ok);
    assert.equal(r.failure.reason, "bad-path");
  });

  it("resolves a submodule of a package", () => {
    const first = resolver().resolve("pkg", 0, null);
    assert.ok(first.ok);
    const sub = resolver().resolveSubmodule(first.resolution, "util");
    assert.ok(sub.ok);
    assert.equal(sub.resolution.path, "/app/pkg/util.l0p");
  });
});

describe("relative resolution", () => {
  const from = "/app/pkg/sub/inner.l0p";

  it("one dot means the module's own directory", () => {
    const r = resolver().resolve("x", 1, from);
    assert.ok(r.ok);
    assert.equal(r.resolution.path, "/app/pkg/sub/x.l0p");
  });

  it("two dots climb one level", () => {
    const r = resolver().resolve("util", 2, from);
    assert.ok(r.ok);
    assert.equal(r.resolution.path, "/app/pkg/util.l0p");
  });

  it("an empty path with one dot is the package itself", () => {
    const r = resolver().resolve("", 1, from);
    assert.ok(r.ok);
    assert.equal(r.resolution.kind, "namespace");
    assert.equal(r.resolution.path, "/app/pkg/sub");
  });

  it("a relative import does not consult the search path", () => {
    // `math` exists on the search path but not next to the importer
    const r = resolver().resolve("math", 1, from);
    assert.ok(!r.ok);
  });

  it("reports a relative import from a module with no file", () => {
    const r = resolver().resolve("x", 1, null);
    assert.ok(!r.ok);
    assert.equal(r.failure.reason, "not-found");
  });
});

describe("local names", () => {
  it("binds the last segment", () => {
    assert.equal(localNameFor("os.path", null), "path");
    assert.equal(localNameFor("math", null), "math");
  });

  it("prefers an explicit alias", () => {
    assert.equal(localNameFor("os.path", "osp"), "osp");
  });
});

describe("search path", () => {
  it("puts the script directory first and deduplicates", () => {
    const fs = memFs(TREE);
    const path = buildSearchPath("/app:/lib", "/app", "/lib", fs);
    assert.deepEqual(path, ["/app", "/lib"]);
  });

  it("makes a relative entry absolute against the working directory", () => {
    const fs = memFs(TREE, "/work");
    const path = buildSearchPath("sub:/abs", null, null, fs);
    assert.deepEqual(path, ["/work/sub", "/abs"]);
  });

  it("ignores empty pieces", () => {
    const fs = memFs(TREE);
    assert.deepEqual(buildSearchPath("::/lib::", null, null, fs), ["/lib"]);
  });
});

describe("loader", () => {
  it("parses an entry point and calls it __main__", () => {
    const loader = new ModuleLoader(memFs(TREE), ["/app", "/lib"]);
    const entry = loader.loadEntry("/app/main.l0p");
    assert.equal(entry.name, "__main__");
    assert.equal(entry.kind, "main");
    assert.equal(entry.file, "/app/main.l0p");
    assert.equal(entry.program?.stmts.length, 1);
    assert.equal(entry.executed, false);
  });

  it("executes each module once, however many times it is imported", () => {
    const loader = new ModuleLoader(memFs(TREE), ["/app", "/lib"]);
    loader.loadEntry("/app/main.l0p");
    const entry = loader.loaded().find((m) => m.name === "__main__");
    assert.ok(entry);

    const first = loader.resolveImport(
      { kind: "Import", form: "import", path: "math", alias: null, names: [], level: 0, line: 1, col: 1 },
      entry,
    );
    const second = loader.resolveImport(
      { kind: "Import", form: "import", path: "math", alias: null, names: [], level: 0, line: 1, col: 1 },
      entry,
    );
    assert.equal(first[0]?.module, second[0]?.module);
  });

  it("gives a package an empty record, so no __init__ file is needed", () => {
    const loader = new ModuleLoader(memFs(TREE), ["/app", "/lib"]);
    const entry = loader.loadEntry("/app/main.l0p");
    const bindings = loader.resolveImport(
      { kind: "Import", form: "import", path: "os", alias: null, names: [], level: 0, line: 1, col: 1 },
      entry,
    );
    const pkg = bindings[0]?.module;
    assert.equal(pkg?.kind, "namespace");
    assert.equal(pkg?.file, null);
    assert.equal(pkg?.program, null);
    assert.equal(pkg?.dir, "/app/os");
  });

  it("resolves `from a import b` to a submodule when b is a file", () => {
    const loader = new ModuleLoader(memFs(TREE), ["/app", "/lib"]);
    const entry = loader.loadEntry("/app/main.l0p");
    const bindings = loader.resolveImport(
      { kind: "Import", form: "from", path: "pkg", alias: null, names: ["util"], level: 0, line: 1, col: 1 },
      entry,
    );
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]?.local, "util");
    assert.equal(bindings[0]?.kind, "submodule");
    assert.equal(bindings[0]?.module.file, "/app/pkg/util.l0p");
  });

  it("resolves `from a import b` to an attribute when b is not a submodule", () => {
    const loader = new ModuleLoader(memFs(TREE), ["/app", "/lib"]);
    const entry = loader.loadEntry("/app/main.l0p");
    const bindings = loader.resolveImport(
      { kind: "Import", form: "from", path: "math", alias: null, names: ["pi"], level: 0, line: 1, col: 1 },
      entry,
    );
    assert.equal(bindings[0]?.kind, "attribute");
    assert.equal(bindings[0]?.attribute, "pi");
    assert.equal(bindings[0]?.module.file, "/app/math.l0p");
  });

  it("names a module reached relatively by its basename", () => {
    const loader = new ModuleLoader(memFs(TREE), ["/app", "/lib"]);
    const entry = loader.loadEntry("/app/main.l0p");
    const bindings = loader.resolveImport(
      { kind: "Import", form: "from", path: "util", alias: null, names: [], level: 1, line: 1, col: 1 },
      { ...entry, file: "/app/pkg/mod.l0p" },
    );
    // `from util import ...` with no names binds nothing on its own
    assert.deepEqual(bindings, []);
  });

  it("lists where it looked when an import fails", () => {
    const loader = new ModuleLoader(memFs(TREE), ["/app"]);
    const entry = loader.loadEntry("/app/main.l0p");
    assert.throws(
      () =>
        loader.resolveImport(
          { kind: "Import", form: "import", path: "missing", alias: null, names: [], level: 0, line: 1, col: 1 },
          entry,
        ),
      (e: L0pError) => {
        assert.match(e.message, /cannot import missing/);
        assert.match(e.message, /\/app\/missing\.l0p/);
        return true;
      },
    );
  });

  it("reports a missing entry file", () => {
    const loader = new ModuleLoader(memFs(TREE), ["/app"]);
    assert.throws(() => loader.loadEntry("/app/nope.l0p"), (e: L0pError) => /no such file/.test(e.message));
  });
});

describe("import cycles", () => {
  const cyclic = {
    "/app/a.l0p": "import b\n",
    "/app/b.l0p": "import a\n",
  };

  it("finds a cycle before anything runs", () => {
    const loader = new ModuleLoader(memFs(cyclic), ["/app"]);
    // a.l0p is the entry point, so it is __main__ -- the cycle is on the file,
    // but the name it is reported under is the one the program knows it by
    const cycle = loader.findCycles(loader.loadEntry("/app/a.l0p"));
    assert.ok(cycle);
    assert.equal(cycle[0], "__main__");
    assert.equal(cycle[cycle.length - 1], "__main__");
    assert.ok(cycle.includes("b"), cycle.join(" -> "));
  });

  it("finds none in a diamond", () => {
    const diamond = {
      "/app/root.l0p": "import left\nimport right\n",
      "/app/left.l0p": "import shared\n",
      "/app/right.l0p": "import shared\n",
      "/app/shared.l0p": "let v = 1\n",
    };
    const loader = new ModuleLoader(memFs(diamond), ["/app"]);
    const entry = loader.loadEntry("/app/root.l0p");
    assert.equal(loader.findCycles(entry), null);
  });

  it("finds a three-module cycle", () => {
    const three = {
      "/app/x.l0p": "import y\n",
      "/app/y.l0p": "import z\n",
      "/app/z.l0p": "import x\n",
    };
    const loader = new ModuleLoader(memFs(three), ["/app"]);
    const cycle = loader.findCycles(loader.loadEntry("/app/x.l0p"));
    assert.deepEqual(cycle, ["__main__", "y", "z", "__main__"]);
  });

  it("ignores imports it cannot resolve", () => {
    const broken = { "/app/p.l0p": "import gone\n" };
    const loader = new ModuleLoader(memFs(broken), ["/app"]);
    assert.equal(loader.findCycles(loader.loadEntry("/app/p.l0p")), null);
  });
});
