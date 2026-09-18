import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly } from "./check-test-mock-surface.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TEST_RE = /\.integration\.test\.(ts|tsx|mts|mjs|js|jsx)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);

export function collectTestFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (TEST_RE.test(entry)) out.push(path);
    }
  };
  for (const sub of ["engine/src", "web", "packages", "schema", "e2e"]) {
    try {
      if (statSync(join(root, sub)).isDirectory()) walk(join(root, sub));
    } catch { /* optional tree absent */ }
  }
  return out;
}

export function splitTests(src) {
  const starts = [];
  const re = /(?:^|[;}\n])\s*(?:test|it)\s*\(\s*(['"`])/g;
  let match;
  while ((match = re.exec(src))) starts.push(match.index);
  return starts.map((start, k) => ({
    start,
    line: src.slice(0, start).split("\n").length,
    name: (src.slice(start).match(/(?:test|it)\s*\(\s*(['"`])((?:\\\1|(?!\1).){0,80})/) ?? [])[2] ?? "?",
    body: src.slice(start, k + 1 < starts.length ? starts[k + 1] : src.length),
  }));
}

const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Collections provably non-empty by construction:
// - inline literals (or ternaries whose branches are all literals)
// - ALL_CAPS module constants (registry inventories, pinned in place)
// - same-test array/object literals: `const cases = [...]` seeds the loop
//   in the open, so emptying it means editing the seed the author sees
// - Promise.all[_settled] over a same-test literal (length preserved)
// - Object.entries/keys/values over a same-test literal or ALL_CAPS name
function constructedNonEmpty(collection, body) {
  const trimmed = collection.trim();
  if (/^\[/.test(trimmed)) return true;
  if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed.split(".")[0])) return true;
  if (trimmed.includes("?") && trimmed.includes("[")) {
    const branches = trimmed.split("?")[1]?.split(":") ?? [];
    if (branches.length > 0 && branches.every((branch) => /^\s*\[/.test(branch.trim()))) return true;
  }
  const base = trimmed.split(".")[0].split("[")[0].split("(")[0];
  // Right-hand side of a same-test `const/let/var BASE ... = RHS;`, found by
  // scanning for the `=` at nesting depth 0 so type annotations (object
  // types with `;`, arrows with `=>`, generics with `<>`) cannot confuse it.
  const rhsOf = (name) => {
    const decl = body.match(new RegExp(`(?:const|let|var)\\s+${esc(name)}\\b`));
    if (!decl) return null;
    let depth = 0; let quote = null;
    for (let i = decl.index + decl[0].length; i < body.length; i++) {
      const ch = body[i];
      if (quote) { if (ch === quote && body[i - 1] !== "\\") quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
      if (ch === "(" || ch === "{" || ch === "[") { depth++; continue; }
      if (ch === ")" || ch === "}" || ch === "]") { depth--; continue; }
      if (ch === "=" && depth === 0 && !/[=<>!]/.test(body[i - 1] ?? "") && !/[=>]/.test(body[i + 1] ?? "")) {
        return body.slice(i + 1, body.indexOf(";", i));
      }
      if (ch === ";" && depth === 0) return null;
    }
    return null;
  };
  if (/^[A-Za-z_$][\w$]*$/.test(base)) {
    // A same-test definition whose right-hand side reaches a `[` before any
    // `(` builds the collection from literals in the open (plain literals,
    // ternaries of literals, `as const` tuples, typed arrays) — no call can
    // empty it.
    const rhs = rhsOf(base);
    if (rhs && /\[[\s\S]/.test(rhs) && !/[([]/.test(rhs.split("[")[0])) return true;
    // new Set([...]) / new Map([...]) over literals: length preserved.
    if (rhs && new RegExp(`^\\s*new\\s+(?:Set|Map)\\s*\\(\\s*\\[`).test(rhs)) return true;
    if (new RegExp(`(?:const|let|var)\\s+${esc(base)}\\s*=\\s*await\\s+Promise\\s*\\.\\s*all(?:Settled)?\\s*\\(\\s*\\[`).test(body)) return true;
  }
  const objectOf = trimmed.match(/^Object\s*\.\s*(?:entries|keys|values)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)$/);
  if (objectOf) {
    const inner = objectOf[1];
    if (/^[A-Z_][A-Z0-9_]*$/.test(inner)) return true;
    if (new RegExp(`(?:const|let|var)\\s+${esc(inner)}\\s*=\\s*[\\[{]`).test(body)) return true;
  }
  return false;
}

// One-hop derivations that preserve (map/flatMap/slice/sort/Object.*) or
// shrink (filter) a collection: an anchor on the derived name transitively
// anchors the source, and a literal source exempts the loop outright.
function derivations(body, collection) {
  const names = new Set([collection, `${collection}.rows`]);
  const pattern = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${esc(collection)}(?:\\.rows)?\\s*\\.\\s*(map|filter|flatMap|slice|sort)\\s*\\(` +
    `|(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*Object\\s*\\.\\s*(?:entries|keys|values)\\s*\\(\\s*${esc(collection)}\\s*\\)` +
    `|(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${esc(collection)}\\s*\\.\\s*rows\\b`,
    "g",
  );
  for (const match of body.matchAll(pattern)) {
    names.add(match[1] ?? match[2] ?? match[3]);
  }
  return names;
}

// A non-vacuity anchor: an assertion in the same test that fails when the
// collection is empty — a length/size pin, a membership/find probe, or an
// index into the first element. Checked against the full dotted path, so
// `detail.other.length` cannot anchor a loop over `detail.versions`.
// The comparand of `deepEqual(<expression>..., <comparand>)`: the first
// comma at balanced depth after the expression, so commas inside map
// callbacks or nested literals cannot truncate it. String-aware.
export function comparandAfter(body, expression) {
  const head = body.match(new RegExp(`(?:deepEqual|deepStrictEqual)\\s*\\(\\s*${expression}\\b`));
  if (!head || head.index === undefined) return null;
  let i = head.index + head[0].length;
  // call tracks the deepEqual call's own parens: a close at call depth 1
  // ends the call with no comparand. Brackets nest independently.
  let call = 1;
  const depth = { "[": 0, "{": 0 };
  let quote = null;
  const atZero = () => call === 1 && depth["["] === 0 && depth["{"] === 0;
  while (i < body.length) {
    const char = body[i];
    if (quote) {
      if (char === "\\") { i += 2; continue; }
      if (char === quote) quote = null;
      i++;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; i++; continue; }
    if (char === "(") { call++; i++; continue; }
    if (char === ")") {
      call--;
      if (call === 0) return null;
      i++;
      continue;
    }
    if (char === "[" || char === "{") { depth[char]++; i++; continue; }
    if (char === "]" || char === "}") {
      if (char === "]" && depth["["] > 0) depth["["]--;
      if (char === "}" && depth["{"] > 0) depth["{"]--;
      i++;
      continue;
    }
    if (char === "," && atZero()) {
      const start = i + 1;
      let j = start;
      let subQuote = null;
      let subCall = 1;
      const sub = { "[": 0, "{": 0 };
      const subZero = () => subCall === 1 && sub["["] === 0 && sub["{"] === 0;
      while (j < body.length) {
        const inner = body[j];
        if (subQuote) {
          if (inner === "\\") { j += 2; continue; }
          if (inner === subQuote) subQuote = null;
          j++;
          continue;
        }
        if (inner === "'" || inner === '"') { subQuote = inner; j++; continue; }
        if (inner === "(") { subCall++; j++; continue; }
        if (inner === "[") { sub["["]++; j++; continue; }
        if (inner === "{") { sub["{"]++; j++; continue; }
        if (inner === ")") {
          subCall--;
          if (subCall === 0) return body.slice(start, j).trim();
          j++;
          continue;
        }
        if (inner === "," && subZero()) {
          return body.slice(start, j).trim();
        }
        if (inner === "]" && sub["["] > 0) { sub["["]--; j++; continue; }
        if (inner === "}" && sub["{"] > 0) { sub["{"]--; j++; continue; }
        j++;
      }
      return body.slice(start).trim();
    }
    i++;
  }
  return null;
}

export function anchored(body, collection) {
  for (const name of derivations(body, collection)) {
    const expression = esc(name);
    if (new RegExp(`\\b${expression}\\s*\\.\\s*(length|size)\\b`).test(body)) return true;
    if (new RegExp(`\\b${expression}\\s*\\.\\s*(includes|indexOf|find|some|every)\\s*\\(`).test(body)) return true;
    if (new RegExp(`\\b${expression}\\s*\\[\\s*0\\s*\\]`).test(body)) return true;
    // A deepEqual of the collection (or its map) against a non-empty literal
    // fails on empty: `deepEqual(rows.map(r => r.id), [..])`. A comparand
    // held in a variable proves nothing by itself and does not anchor.
    const comparand = comparandAfter(body, expression);
    if (comparand && /^\s*(\[\s*\S|\{\s*[^}]|['"`][^'"`]|true\b|[1-9])/.test(comparand)) return true;
  }
  return false;
}

// The single statement of a braceless `for..of` body — `for (const row of
// rows) assert.equal(...)` guards exactly as much as its braced twin, so the
// checker must see it. Reads to the `;` at paren depth 0; bails on a brace
// (a block body belongs to loopBody, a `}` ends the enclosing scope).
function bareStatement(text, from) {
  let depth = 0; let quote = null;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "(") { depth++; continue; }
    if (char === ")") { depth = Math.max(0, depth - 1); continue; }
    if (char === ";" && depth === 0) return text.slice(from, i + 1);
    if ((char === "{" || char === "}") && depth === 0) return "";
  }
  return "";
}

// The brace-matched body of a `for..of` loop, or null when the loop has no
// block (the caller falls back to bareStatement for single-statement bodies).
// String-aware so braces inside messages cannot end the body early.
function loopBody(body, from) {
  let i = body.indexOf("{", from);
  if (i < 0) return null;
  // The `{` must open the loop body, not a later statement: only whitespace
  // and the closing paren may sit between the header end and the brace.
  if (!/^\s*\{/.test(body.slice(from, i + 1))) return null;
  const start = i;
  let depth = 0;
  let quote = null;
  while (i < body.length) {
    const char = body[i];
    if (quote) {
      if (char === "\\") { i += 2; continue; }
      if (char === quote) quote = null;
      i++;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; i++; continue; }
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
    i++;
  }
  return null;
}

export function scanFile(path, root = ROOT) {
  const findings = [];
  // Scan the code-only projection (same length/newlines): fixture text must
  // not forge loops or anchors.
  const src = codeOnly(readFileSync(path, "utf8"));
  const rel = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
  for (const unit of splitTests(src)) {
    const loopRe = /for\s*\(\s*(?:const|let|var|await)\s+[a-zA-Z_$][\w$]*\s+of\s+([^;()]{1,90})\)|([a-zA-Z_$][\w$.[\]()'"?]*)\.forEach\s*\(/g;
    let match;
    while ((match = loopRe.exec(unit.body))) {
      const collection = (match[1] ?? match[2]).trim();
      if (!collection || /await\s/.test(collection)) continue;
      if (constructedNonEmpty(collection, unit.body)) continue;
      // Only assertions inside the loop's own braces count; a later assert
      // in the same test must not launder an assertion-free loop, and an
      // assertion-free aggregation must not inherit a later assert.
      const headerEnd = match.index + match[0].length;
      // forEach callbacks run to the call's balanced close paren.
      const forEachChunk = () => {
        let i = unit.body.indexOf("(", match.index + match[0].length - 1);
        if (i < 0) return "";
        const start = i;
        let depth = 0;
        let quote = null;
        while (i < unit.body.length) {
          const char = unit.body[i];
          if (quote) {
            if (char === "\\") { i += 2; continue; }
            if (char === quote) quote = null;
            i++;
            continue;
          }
          if (char === "'" || char === '"') { quote = char; i++; continue; }
          if (char === "(") depth++;
          if (char === ")") {
            depth--;
            if (depth === 0) return unit.body.slice(start, i + 1);
          }
          i++;
        }
        return "";
      };
      const loopChunk = match[1] !== undefined
        ? (loopBody(unit.body, headerEnd) ?? bareStatement(unit.body, headerEnd))
        : forEachChunk();
      if (!/\bassert\b/.test(loopChunk) && !/\bexpect\b/.test(loopChunk)) continue;
      if (anchored(unit.body, collection)) continue;
      const loopLine = unit.line + unit.body.slice(0, match.index).split("\n").length - 1;
      findings.push({ file: rel, line: loopLine, name: unit.name.slice(0, 70), collection: collection.slice(0, 70) });
    }
  }
  return findings;
}

export function scanTree(root = ROOT) {
  const findings = [];
  for (const file of collectTestFiles(root)) {
    for (const finding of scanFile(file, root)) findings.push(finding);
  }
  return findings;
}

const invoked = process.argv[1] ? process.argv[1].endsWith("check-test-loop-anchors.mjs") : false;
if (invoked) {
  const root = process.argv[2] ?? ROOT;
  const findings = scanTree(root);
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line} [${finding.name}] loop over \`${finding.collection}\` has no non-vacuity anchor`);
  }
  console.log(`checked integration loop anchors; unanchored=${findings.length}`);
  process.exit(findings.length > 0 ? 1 : 0);
}
