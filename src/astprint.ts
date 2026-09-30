/**
 * A readable dump of the tree, for the REPL and for debugging a parse.
 *
 * This exists until M5.  Once the VM is in place the REPL will run code instead
 * of printing syntax, but the dump is worth keeping: it is the quickest way to
 * see what a precedence rule actually produced.
 */

import type { Expr, Program, Stmt } from "./ast.ts";

const INDENT = "  ";

export function formatProgram(program: Program): string {
  return program.stmts.map((s) => formatStmt(s, 0)).join("\n");
}

export function formatStmts(stmts: readonly Stmt[], depth: number): string {
  return stmts.map((s) => formatStmt(s, depth)).join("\n");
}

export function formatStmt(s: Stmt, depth: number): string {
  const pad = INDENT.repeat(depth);
  switch (s.kind) {
    case "ExprStmt":
      return `${pad}${formatExpr(s.expr)}`;

    case "Let":
      return s.init === null
        ? `${pad}${s.binding} ${s.name}`
        : `${pad}${s.binding} ${s.name} = ${formatExpr(s.init)}`;

    case "Assign": {
      const targets = s.targets.map(formatExpr).join(", ");
      const op = s.op === null ? "=" : `${s.op}=`;
      return `${pad}${targets} ${op} ${formatExpr(s.value)}`;
    }

    case "Def": {
      const params = s.params.map(formatParam).join(", ");
      const head = `${pad}def ${s.name}(${params})`;
      return s.body.length === 0 ? head : `${head}\n${formatStmts(s.body, depth + 1)}`;
    }

    case "StructDef": {
      const fields = s.fields
        .map((f) => `${INDENT.repeat(depth + 1)}${f.name}${f.value === null ? "" : ` = ${formatExpr(f.value)}`}`)
        .join("\n");
      return `${pad}struct ${s.name}\n${fields}`;
    }

    case "If": {
      let out = `${pad}if ${formatExpr(s.cond)}\n${formatStmts(s.then, depth + 1)}`;
      if (s.otherwise !== null) {
        out += `\n${pad}else\n${formatStmts(s.otherwise, depth + 1)}`;
      }
      return out;
    }

    case "While":
      return `${pad}while ${formatExpr(s.cond)}\n${formatStmts(s.body, depth + 1)}`;

    case "For":
      return `${pad}for ${s.name} in ${formatExpr(s.iter)}\n${formatStmts(s.body, depth + 1)}`;

    case "Return":
      return s.value === null ? `${pad}return` : `${pad}return ${formatExpr(s.value)}`;

    case "Branch":
      return `${pad}${s.what}`;

    case "Import": {
      const dots = ".".repeat(s.level);
      if (s.form === "import") {
        return `${pad}import ${dots}${s.path}${s.alias === null ? "" : ` as ${s.alias}`}`;
      }
      return `${pad}from ${dots}${s.path} import ${s.names.join(", ")}`;
    }

    case "Defer":
      return `${pad}defer ${formatExpr(s.call)}`;
  }
}

function formatParam(p: { name: string; default: Expr | null }): string {
  return p.default === null ? p.name : `${p.name} = ${formatExpr(p.default)}`;
}

/** Operators whose operands get parentheses, so the tree is unambiguous. */
const WRAPS = new Set<Expr["kind"]>(["Binary", "Logical", "Ternary"]);

export function formatExpr(e: Expr): string {
  switch (e.kind) {
    case "Num":
      return String(e.value);
    case "Bool":
      return String(e.value);
    case "Null":
      return "null";
    case "Str":
      return formatStr(e.parts);
    case "Ident":
      return e.name;
    case "ListLit":
      return `[${e.items.map(formatExpr).join(", ")}]`;
    case "DictLit":
      return `{${e.entries.map((en) => `${formatExpr(en.key)}: ${formatExpr(en.value)}`).join(", ")}}`;

    case "Unary":
      return `${e.op === "not" ? "not " : e.op}${formatExpr(e.operand)}`;

    case "Binary":
      return `${paren(e.left)} ${e.op} ${paren(e.right)}`;

    case "Logical":
      return `${paren(e.left)} ${e.op} ${paren(e.right)}`;

    case "Ternary":
      return `${formatExpr(e.cond)} ? ${formatExpr(e.then)} : ${formatExpr(e.other)}`;

    case "Call":
      return `${paren(e.callee)}(${e.args.map(formatExpr).join(", ")})`;

    case "Attr":
      return `${paren(e.obj)}.${e.name}`;

    case "Index":
      return `${paren(e.obj)}[${formatExpr(e.index)}]`;

    case "Lambda":
      return `(${e.params.map(formatParam).join(", ")}) -> ${formatExpr(e.body)}`;

    case "Spawn":
      return `spawn ${formatExpr(e.call)}`;

    case "Await":
      return `await ${formatExpr(e.expr)}`;
  }
}

function paren(e: Expr): string {
  const text = formatExpr(e);
  return WRAPS.has(e.kind) ? `(${text})` : text;
}

/** Strings are quoted, so `let n = x` and `let n = "x"` stay distinguishable. */
function formatStr(parts: readonly (string | Expr)[]): string {
  if (parts.length === 1 && typeof parts[0] === "string") return JSON.stringify(parts[0]);
  const body = parts
    .map((p) => {
      if (typeof p !== "string") return `\${${formatExpr(p)}}`;
      return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    })
    .join("");
  return `"${body}"`;
}
