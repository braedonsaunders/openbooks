// Flags Promise.all over a transaction-owned executor.
//
// One pg client serves one connection: concurrent queries issued on the same
// client interleave instead of parallelising (deprecated by pg, fatal in
// pg 9). A `tx` (or tx-bound runner) inside Promise.all is therefore always
// a defect, while `db` inside Promise.all is only a defect under an ambient
// transaction — which this check cannot decide, so it does not flag it.
// Rule: inside Promise.all, await on the transaction; fan out on the pool.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["engine/src", "web/lib", "web/app/api"];
const EXT = /\.(ts|tsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(entry) && !entry.includes(".test.")) out.push(full);
  }
}

// Span of the call starting at the open paren (index of `(`), using a frame
// stack that understands strings, template literals with ${} nesting, and
// both comment styles. Returns the full `Promise.all(...)` text or null.
function callSpan(src, matchIdx, openIdx) {
  const stack = ["paren"];
  let i = openIdx + 1;
  let esc = false;
  while (i < src.length && stack.length > 0) {
    const top = stack[stack.length - 1];
    const ch = src[i];
    const nxt = src[i + 1] ?? "";
    if (top === "line") {
      if (ch === "\n") stack.pop();
      i++;
      continue;
    }
    if (top === "block") {
      if (ch === "*" && nxt === "/") {
        stack.pop();
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (top === "str1" || top === "str2") {
      const quote = top === "str1" ? "'" : '"';
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === quote) stack.pop();
      i++;
      continue;
    }
    if (top === "tpl") {
      if (ch === "`") stack.pop();
      else if (ch === "$" && nxt === "{") {
        stack.push("interp");
        i++;
      }
      // All other template text (including bare braces) is literal.
      i++;
      continue;
    }
    // Code-like frames: paren, bracket, brace, interp.
    if (ch === "/" && nxt === "/") {
      stack.push("line");
      i += 2;
      continue;
    }
    if (ch === "/" && nxt === "*") {
      stack.push("block");
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      stack.push(ch === "'" ? "str1" : "str2");
      i++;
      continue;
    }
    if (ch === "`") {
      stack.push("tpl");
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push(ch === "(" ? "paren" : ch === "[" ? "bracket" : "brace");
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const want = ch === ")" ? "paren" : ch === "]" ? "bracket" : null;
      if (top === "interp" && ch === "}") {
        stack.pop();
        i++;
        continue;
      }
      if (want && top === want) {
        stack.pop();
        i++;
        continue;
      }
      // Mismatched closers (e.g. `}` closing a brace frame) just pop brace.
      if (ch === "}" && top === "brace") {
        stack.pop();
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  void esc;
  return stack.length === 0 ? src.slice(matchIdx, i) : null;
}

const TX_USE = /(?<![\w$])tx\s*\.\s*(execute|query)\s*\(/;
const files = [];
for (const root of ROOTS) walk(root, files);
const violations = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const re = /Promise\s*\.\s*all\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf("(", m.index);
    const block = callSpan(src, m.index, open);
    if (block && TX_USE.test(block)) {
      const line = src.slice(0, m.index).split("\n").length;
      violations.push(`${file}:${line}`);
    }
  }
}
if (violations.length > 0) {
  console.error(
    "Promise.all over a transaction-owned executor (one pg client cannot serve concurrent queries):",
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "Await sequentially on the transaction; fan out only on the pool (db with no ambient tx).",
  );
  process.exit(1);
}
console.log(`checked transaction concurrency; ${files.length} files clean`);
