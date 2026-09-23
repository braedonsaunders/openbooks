import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mockBlocks, unescapeTemplate } from "./check-test-mock-surface.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TEST_RE = /\.test\.(ts|tsx|mts|mjs|js|jsx)$/;
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
  for (const sub of ["engine/src", "web", "packages", "schema", "e2e", "scripts"]) {
    try {
      if (statSync(join(root, sub)).isDirectory()) walk(join(root, sub));
    } catch { /* optional tree absent */ }
  }
  return out;
}

// Yield regex literals as {pattern, line, snippet}. Template literal bodies
// are skipped wholesale: nested mock-module regexes are covered by scanning
// the unescaped mock bodies instead (see scanFile), which puts every scanned
// pattern at effective depth 0. Division is told apart from regex literals
// by the previous significant token (heuristic): a `/` opens a regex when it
// follows an opener, an operator, a keyword like return, or nothing at all.
// A division slash after `)`, `]`, or an identifier stays a division.
export function regexLiterals(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  const prevSignificant = (j) => {
    j--;
    while (j >= 0 && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j--;
    return j;
  };
  const wordBefore = (j) => {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    return src.slice(k + 1, j + 1);
  };
  const KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "yield", "await", "case"]);
  while (i < n) {
    const char = src[i];
    if (char === "\n") { line++; i++; continue; }
    if (char === "'" || char === '"') {
      const quote = char;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") i++;
        if (src[i] === "\n") line++;
        i++;
      }
      i++;
      continue;
    }
    if (char === "`") {
      i++;
      while (i < n) {
        const inner = src[i];
        if (inner === "\n") line++;
        if (inner === "\\") { i += 2; continue; }
        if (inner === "`") { i++; break; }
        i++;
      }
      continue;
    }
    if (char === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (char === "/") {
      const prevIndex = prevSignificant(i);
      const prev = prevIndex >= 0 ? src[prevIndex] : "";
      const opener = prev === "" || prev === "\n" || " (,=:[!&|?{};".includes(prev);
      const afterKeyword = /[A-Za-z0-9_$]/.test(prev) && KEYWORDS.has(wordBefore(prevIndex));
      if (opener || afterKeyword) {
        const start = i;
        const startLine = line;
        i++;
        let inClass = false;
        let pattern = "";
        while (i < n) {
          const inner = src[i];
          if (inner === "\n") break;
          if (inner === "\\") { pattern += src.slice(i, i + 2); i += 2; continue; }
          if (inner === "[") inClass = true;
          if (inner === "]") inClass = false;
          if (inner === "/" && !inClass) break;
          pattern += inner;
          i++;
        }
        let j = i + 1;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        out.push({ pattern, line: startLine, snippet: src.slice(start, Math.min(j, start + 90)) });
        i = j;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return out;
}

function backslashRuns(pattern) {
  const runs = [];
  const re = /(\\{2,})/g;
  let match;
  while ((match = re.exec(pattern))) runs.push(match[1].length);
  return runs;
}

// A regex whose effective pattern matches a literal backslash: any raw run
// of 2+ backslashes in a scanned literal. Every scanned literal sits at
// effective depth 0 — top-level code, or a mock body after one template
// unescape — so no halving is needed here.
export function suspectRun(rawRun) {
  return rawRun >= 2 ? rawRun : 0;
}

// Entries the sweep verified by hand: the effective pattern really does
// match a literal backslash, and the text under test really contains one
// (shell continuations, psql metacommands, BRE-in-YAML, Windows separators,
// escapeRegExp idioms, source-text pins). A NEW occurrence fails the build;
// extend this list only with a reason naming the backslash in the text.
export const ALLOWLIST = [
  { file: "engine/src/sync/readme-accuracy.test.ts", snippet: "[.*+?^${}()|[", reason: "escapeRegExp idiom: must match a literal backslash to escape it" },
  { file: "engine/src/payroll/au/tax-year-2027.test.ts", snippet: "[.*+?^${}()|[", reason: "escapeRegExp idiom" },
  { file: "web/app/(app)/analytics/_ui/CashTimeline.test.tsx", snippet: "[.*+?^${}()|[", reason: "escapeRegExp idiom" },
  { file: "web/lib/accounts-hygiene.test.ts", snippet: "[.*+?^${}()|[", reason: "escapeRegExp idiom" },
  { file: "web/lib/data-io/import-route.test.ts", snippet: "[.*+?${}()|[", reason: "escapeRegExp idiom" },
  { file: "scripts/ci-pipeline-integrity.test.mjs", snippet: "[.*+?^${}()|[", reason: "escapeRegExp idiom" },
  { file: "scripts/ci-pipeline-integrity.test.mjs", snippet: "\\\\\\s*$", reason: "shell line-continuation backslash at end of line" },
  { file: "scripts/deploy-edge-workflow.test.mjs", snippet: "gh api", reason: "expected YAML embeds shell continuations (literal backslash-newline)" },
  { file: "scripts/deploy-edge-workflow.test.mjs", snippet: "dispatches", reason: "expected YAML embeds shell continuations" },
  { file: "scripts/deploy-edge-workflow.test.mjs", snippet: "workflow_run_id", reason: "expected YAML embeds shell continuations" },
  { file: "scripts/deploy-edge-workflow.test.mjs", snippet: "PUBLISH_RUN_ID", reason: "expected YAML embeds shell continuations" },
  { file: "scripts/deploy-production-workflow.test.mjs", snippet: "^v", reason: "pins a BRE version pattern inside the workflow YAML (backslashes are the text)" },
  { file: "web/lib/assistant/coverage-matrix.test.ts", snippet: 'replace(/\\\\/g, "/")', reason: "Windows separator normalization: the backslash is the text" },
  { file: "schema/canonical-baseline-generator.test.ts", snippet: "restrict", reason: "psql \\\\restrict/\\\\unrestrict metacommand lines in dump text" },
  { file: "web/lib/feature-gates.test.ts", snippet: "replace", reason: "pins the absence of slash-stripping source (backslashes are the source text)" },
  { file: "scripts/ci-pipeline-integrity.test.mjs", snippet: "not ok \\\\d", reason: "pins the canary's TAP grep in test.yml, whose text really contains backslash escapes" },
  { file: "scripts/test-fixture-architecture.test.mjs", snippet: "\\$\\{receipt", reason: "pins owner source text that really contains backslash-n escape sequences" },
  { file: "engine/src/provisioning/bootstrap-safety.test.ts", snippet: "seed-project-types", reason: "pins the \\. stem escape inside isSeedProjectTypesCli's entrypoint regex (seed-project-types.ts:80), whose text really contains a backslash" },
  { file: "scripts/test-workflow.test.mjs", snippet: "package-lock", reason: "pins the scope job's grep over the build's own inputs in test.yml:66, whose text really contains backslash escapes (\\.github, package-lock\\.json) so the minimal correct pattern carries \\\\ runs" },
];

export function isAllowlisted(file, snippet) {
  return ALLOWLIST.some((entry) => file === entry.file &&
    (snippet.includes(entry.snippet) || entry.snippet.includes(snippet)));
}

export function scanFile(path, root = ROOT) {
  const findings = [];
  const src = readFileSync(path, "utf8");
  const rel = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
  const checkLiteral = (pattern, line, snippet, origin) => {
    for (const run of backslashRuns(pattern)) {
      if (suspectRun(run) > 0 && !isAllowlisted(rel, snippet)) {
        findings.push({ file: rel, line, run, snippet: snippet.slice(0, 100), origin });
      }
    }
  };
  for (const literal of regexLiterals(src)) {
    checkLiteral(literal.pattern, literal.line, literal.snippet, "literal");
  }
  // Mock bodies unescape one level: scan the effective module source.
  try {
    const blocks = mockBlocks(src, src);
    for (const [key, body] of blocks) {
      const effective = unescapeTemplate(body);
      for (const literal of regexLiterals(effective)) {
        checkLiteral(literal.pattern, literal.line, `mock:${key} ${literal.snippet}`, "mock-body literal");
      }
    }
  } catch { /* unparseable mock wiring is the sibling checker's job */ }
  return findings;
}

export function scanTree(root = ROOT) {
  const findings = [];
  for (const file of collectTestFiles(root)) {
    for (const finding of scanFile(file, root)) findings.push(finding);
  }
  return findings;
}

const invoked = process.argv[1] ? process.argv[1].endsWith("check-test-regex-escapes.mjs") : false;
if (invoked) {
  const root = process.argv[2] ?? ROOT;
  const findings = scanTree(root);
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line} [${finding.origin}] run=${finding.run} :: ${finding.snippet}`);
  }
  console.log(`checked test regexes; suspects=${findings.length}`);
  process.exit(findings.length > 0 ? 1 : 0);
}
