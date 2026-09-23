import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly } from "./check-test-mock-surface.mjs";

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

// Every skip condition in the repo gates on test infrastructure that may be
// absent (database/redis URLs, platform). A skip on anything else — a bare
// `true`, a reason string, a feature flag — passes silently in exactly the
// configuration the author runs, and nobody notices. New skip shapes fail
// the build; extend SKIP_VALUE only with an infra gate and a reason.
const SKIP_VALUE_ALLOW = [
  /OPENBOOKS_DB_URL/,
  /OPENBOOKS_REDIS_URL/,
  /REDIS_URL/,
  /RUNTIME_DB/,
  /OPENBOOKS_TEST_DB_MARKER/,
  /(^|[^A-Za-z0-9_$])DB([^A-Za-z0-9_$]|$)/,
  /(^|[^A-Za-z0-9_$])enabled([^A-Za-z0-9_$]|$)/,
  /(^|[^A-Za-z0-9_$])behavior([^A-Za-z0-9_$]|$)/,
  /(^|[^A-Za-z0-9_$])databaseUrl([^A-Za-z0-9_$]|$)/,
  /(^|[^A-Za-z0-9_$])ENABLED([^A-Za-z0-9_$]|$)/,
  /process\.platform/,
];

// t.skip() with a recorded reason. Same rule: infra-gated or explicitly
// listed here, never a bare skip nobody can audit.
const TSKIP_ALLOW = [
  "git-filter-repo is not installed; install it to rehearse the rewrite transforms",
  "database user cannot disable enforcement triggers for the probe session",
];

// A skip that gates on the database must gate ONLY on infrastructure.
// `skip: !DB || new Date() < new Date("2026-12-02")` sails through the
// allow-list on the DB token while the date does the real gating — the
// time-bomb shape that once parked four payroll suites silently. Strip every
// known infra token plus boolean/negation/grouping syntax; anything left is
// a second, non-infra condition riding on the infra gate.
const DB_GATE = /OPENBOOKS_DB_URL|RUNTIME_DB|OPENBOOKS_TEST_DB_MARKER|databaseUrl|(^|[^A-Za-z0-9_$])DB([^A-Za-z0-9_$]|$)/;
const INFRA_STRIP = [
  /OPENBOOKS_DB_URL/g,
  /OPENBOOKS_REDIS_URL/g,
  /REDIS_URL/g,
  /RUNTIME_DB/g,
  /OPENBOOKS_TEST_DB_MARKER/g,
  /databaseUrl/g,
  /(?<![A-Za-z0-9_$])DB(?![A-Za-z0-9_$])/g,
  /(?<![A-Za-z0-9_$])enabled(?![A-Za-z0-9_$])/g,
  /(?<![A-Za-z0-9_$])behavior(?![A-Za-z0-9_$])/g,
  /(?<![A-Za-z0-9_$])ENABLED(?![A-Za-z0-9_$])/g,
  /process\.platform/g,
  /process/g,
  /env/g,
];
const SKIP_SYNTAX_STRIP = /[!|&()?\s.:'"]/g;

export function combinesInfraWithOther(value) {
  if (!DB_GATE.test(value)) return false;
  let rest = value;
  for (const token of INFRA_STRIP) rest = rest.replace(token, "");
  rest = rest.replace(SKIP_SYNTAX_STRIP, "");
  return /[A-Za-z0-9_$]/.test(rest);
}

export function scanFile(path, root = ROOT) {
  const findings = [];
  // Scan the code-only projection (same length/newlines): fixture templates
  // containing skip-shaped text must not forge findings.
  const src = codeOnly(readFileSync(path, "utf8"));
  const rel = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
  const lineOf = (index) => src.slice(0, index).split("\n").length;
  // Skip options sit in test-call position — test("name", { skip: ... }) —
  // or in a named options object passed there. Matching bare `{ skip:` would
  // also catch data assertions shaped like { skip: "..." } (fail-closed
  // markers in some connector suites), so position matters.
  const checkOptions = (index, options) => {
    // Ternary form: skip: <condition> ? "<reason>" : false. The condition
    // decides and the reason names it, so judge the condition and report
    // the reason. Without this branch the 120-char value cap below misses
    // long ternaries entirely — the December-2026 time bombs were invisible.
    const ternary = options.match(/skip\s*:\s*([^?][^?]{0,300}?)\?\s*(['"`])((?:\\\2|(?!\2).){0,200})\2\s*:\s*false\s*(,|}|$)/);
    if (ternary) {
      const condition = ternary[1].trim();
      const reason = ternary[3].slice(0, 80);
      if (!SKIP_VALUE_ALLOW.some((allowed) => allowed.test(condition))) {
        findings.push({ file: rel, line: lineOf(index), kind: "skip-option", value: reason });
      } else if (combinesInfraWithOther(condition)) {
        findings.push({ file: rel, line: lineOf(index), kind: "skip-combined", value: `${condition} ? "${reason}"` });
      }
      return;
    }
    const skip = options.match(/skip\s*:\s*([^,}][^,}]{0,120}?)\s*(,|}|$)/);
    if (!skip) return;
    const value = skip[1].trim();
    if (!SKIP_VALUE_ALLOW.some((allowed) => allowed.test(value))) {
      findings.push({ file: rel, line: lineOf(index), kind: "skip-option", value });
    } else if (combinesInfraWithOther(value)) {
      findings.push({ file: rel, line: lineOf(index), kind: "skip-combined", value });
    }
  };
  for (const match of src.matchAll(/(?:test|it)\s*\(\s*(['"`])((?:\\\1|(?!\1).){1,200})\1\s*,\s*\{([^{}]*)\}/g)) {
    checkOptions(match.index, match[3]);
  }
  for (const match of src.matchAll(/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\{([^{}]*)\}/g)) {
    checkOptions(match.index, match[1]);
  }
  for (const match of src.matchAll(/\bt\.skip\(\s*(['"`])((?:\\\1|(?!\1).){0,200})\1\s*\)/g)) {
    if (!TSKIP_ALLOW.includes(match[2])) {
      findings.push({ file: rel, line: lineOf(match.index), kind: "t.skip", value: match[2].slice(0, 80) });
    }
  }
  for (const match of src.matchAll(/\b(?:test|it|describe)\s*\.\s*(skip|todo)\s*\(/g)) {
    findings.push({ file: rel, line: lineOf(match.index), kind: `${match[1]}-method`, value: match[0] });
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

const invoked = process.argv[1] ? process.argv[1].endsWith("check-test-skips.mjs") : false;
if (invoked) {
  const root = process.argv[2] ?? ROOT;
  const findings = scanTree(root);
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line} [${finding.kind}] ${finding.value}`);
  }
  if (findings.some((finding) => finding.kind === "skip-combined")) {
    console.log("skip-combined: a DB gate must gate on infrastructure only — split the extra condition into its own declared skip, or pin the clock so the test runs now instead of on a date.");
  }
  console.log(`checked test skips; violations=${findings.length}`);
  process.exit(findings.length > 0 ? 1 : 0);
}
