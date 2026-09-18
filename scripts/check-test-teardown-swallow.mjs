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

// A swallowed scratch-org teardown hides a FAILED reset: the fixture pool
// then hands the next test a tainted lease and the symptom surfaces far away
// as lease_not_found timeouts or mystery row-count mismatches. Teardown must
// fail loudly so the taint is fixed where it is made. There is no legitimate
// case on record; if one ever appears, list it here with a reason instead of
// loosening the pattern.
export const ALLOW = [
  // { file: "web/lib/example.integration.test.ts", reason: "why swallowing is correct here" },
];

const ALLOWED_FILES = new Set(ALLOW.map((entry) => entry.file));

const DROP_RE = /\bdropScratchOrg(Reporting)?\b/;
const CATCH_RE = /\.catch\s*\(/;

// A `.catch(` chained onto a dropScratchOrg(Reporting) call expression: either
// on the same statement after the call (`await withBypassContext(() =>
// dropScratchOrg(id)).catch(() => {})`), or continued on the next line. A
// `.catch(` before the call on the same line (rollback/pending cleanup next
// to a loud drop) is not a swallow and must not flag.
function lineHasSwallow(line) {
  const drop = line.match(DROP_RE);
  if (!drop) return false;
  const after = line.slice(drop.index + drop[0].length);
  const semi = after.indexOf(";");
  const tail = semi === -1 ? after : after.slice(0, semi);
  return CATCH_RE.test(tail);
}

export function scanFile(path, root = ROOT) {
  const findings = [];
  const rel = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
  if (ALLOWED_FILES.has(rel)) return findings;
  // Scan the code-only projection (same length/newlines): a swallow inside a
  // comment or a failure message must not forge a finding.
  const lines = codeOnly(readFileSync(path, "utf8")).split("\n");
  const lineOf = (index) => index + 1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (lineHasSwallow(line)) {
      findings.push({ file: rel, line: lineOf(index), kind: "teardown-swallow", value: line.trim().slice(0, 120) });
      continue;
    }
    if (DROP_RE.test(line) && index + 1 < lines.length && /^\s*\.catch\s*\(/.test(lines[index + 1])) {
      findings.push({ file: rel, line: lineOf(index + 1), kind: "teardown-swallow", value: lines[index + 1].trim().slice(0, 120) });
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

const invoked = process.argv[1] ? process.argv[1].endsWith("check-test-teardown-swallow.mjs") : false;
if (invoked) {
  const root = process.argv[2] ?? ROOT;
  const findings = scanTree(root);
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line} [${finding.kind}] ${finding.value}`);
  }
  console.log(`checked test teardown drops; violations=${findings.length}`);
  process.exit(findings.length > 0 ? 1 : 0);
}
