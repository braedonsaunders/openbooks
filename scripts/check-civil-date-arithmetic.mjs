#!/usr/bin/env node
/**
 * Repo-wide audit: civil dates must never be built with a variable year
 * through `Date.UTC(year, ...)` or `new Date(year, ...)`.
 *
 * Both spellings map years 0-99 onto 1900-1999, so any day arithmetic built
 * on them silently relocates business dates in years 0001-0099 by eighteen
 * centuries. The caught instances: a 0099-12-25..0100-01-07 pay period
 * reading as -693946 days (mid-period fixed assignments prorated to zero and
 * dropped), a cross-century subscription period going negative (prorate
 * returning 0.0000, adjustments skipped), misclassified close deadline
 * windows, wrong dunning rungs, 0096 holidays rendering in 1996, and OFX
 * dates in 0096 refused as "not real".
 *
 * The single civil-date definition lives in
 * engine/src/platform/business-date.ts (utcDateFromParts and friends, built
 * on the `new Date(0)` + setUTCFullYear idiom); database-free leaves carry
 * the same 3-line idiom locally with a pointer comment because db.ts creates
 * pools and reads .env at import; packages/reports shares one
 * utcCivilDate in fiscal-calendar.ts because it sits below the engine.
 *
 * A site violates when EITHER holds (AST-walked, never grepped — comments
 * and string literals mentioning Date.UTC do not count):
 *
 *   viol1  `Date.UTC(first, ...)` where `first` is not a numeric literal
 *          (an identifier, a `now.getUTCFullYear()` chain, `Number(...)`,
 *          anything else — whatever it is called);
 *   viol2  `new Date(first, ...)` with two or more arguments where `first`
 *          is not a numeric literal. Single-argument `new Date(x)` (epoch
 *          milliseconds, ISO strings, copies) never matches: construction
 *          from an instant or an ISO string is exact for years 0001-9999.
 *
 * The scan covers engine/src, web/lib and packages (.ts/.tsx, tests
 * included). engine/src/platform/business-date.ts itself is excluded: it
 * OWNS the definition. e2e/ and scripts/ are out of scope: e2e specs pin
 * contemporary wall-clock years against live servers, and scripts/ is dev
 * tooling — neither ships civil-date arithmetic.
 *
 * Exemptions live in check-civil-date-arithmetic.allowlist.json, keyed by
 * path + nearest named function + enclosing test title ("" outside tests) +
 * the year argument's source text, each carrying a reviewed reason. The
 * ratchet cuts both ways: a site NOT on the list fails immediately naming
 * the remedy, and a list entry whose site no longer violates ALSO fails
 * ("stale — remove the entry"), so the list cannot rot into amnesty.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const ts = requireFromRoot("typescript-eslint-typescript");

const SELF_PATH = "scripts/check-civil-date-arithmetic.mjs";
export const ALLOWLIST_PATH = "scripts/check-civil-date-arithmetic.allowlist.json";
const OWNER_PATH = "engine/src/platform/business-date.ts";

export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadAllowlist(readFile = (file) => readFileSync(join(repoRoot(), file), "utf8")) {
  let entries;
  try {
    entries = JSON.parse(readFile(ALLOWLIST_PATH));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) throw new Error(`${ALLOWLIST_PATH} must hold a JSON array`);
  const seen = new Set();
  for (const entry of entries) {
    for (const field of ["path", "fn", "test", "arg", "reason"]) {
      if (typeof entry?.[field] !== "string") {
        throw new Error(`${ALLOWLIST_PATH}: every entry needs string "path", "fn", "test", "arg" and "reason"`);
      }
    }
    if (entry.reason.trim() === "") {
      throw new Error(`${ALLOWLIST_PATH}: ${entry.path} (${entry.fn}) carries no reviewed reason`);
    }
    const key = allowlistKey(entry);
    if (seen.has(key)) throw new Error(`${ALLOWLIST_PATH} contains duplicate entry ${key}`);
    seen.add(key);
  }
  return entries;
}

export function allowlistKey(entry) {
  return `${entry.path}::${entry.fn}::${entry.test}::${entry.arg.replace(/\s+/g, " ").trim()}`;
}

export function discoverSources() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z",
      "engine/src/**/*.ts", "engine/src/**/*.tsx",
      "web/lib/**/*.ts", "web/lib/**/*.tsx",
      "packages/**/*.ts", "packages/**/*.tsx"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    // Test files ARE scanned: a remapped year in a fixture builds the wrong
    // expectation silently. Justified sites take allow-list entries.
    .filter((file) => !/\.d\.tsx?$/.test(file) && file !== OWNER_PATH && file !== SELF_PATH);
}

function isFunctionLike(node) {
  return (
    node != null &&
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node))
  );
}

function functionNameOf(node) {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return undefined;
}

/** Nearest NAMED enclosing function, or "(top-level)". */
function enclosingFunctionName(node) {
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) {
      const name = functionNameOf(current);
      if (name) return name;
    }
    current = current.parent;
  }
  return "(top-level)";
}

/** Title of the nearest enclosing test()/it() call, or "" outside tests. */
function enclosingTestTitle(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      (current.expression.text === "test" || current.expression.text === "it") &&
      current.arguments.length > 0 &&
      ts.isStringLiteralLike(current.arguments[0])
    ) {
      return current.arguments[0].text;
    }
    current = current.parent;
  }
  return "";
}

function isDateUtcCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Date" &&
    node.expression.name.text === "UTC"
  );
}

function isMultiArgNewDate(node) {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Date" &&
    node.arguments != null &&
    node.arguments.length >= 2
  );
}

function isLiteralYear(arg) {
  return arg != null && ts.isNumericLiteral(arg);
}

export function scanSource(path, content) {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const findings = [];
  const visit = (node) => {
    if (isDateUtcCall(node) || isMultiArgNewDate(node)) {
      const args = node.arguments ?? [];
      if (!isLiteralYear(args[0])) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        findings.push({
          path,
          line: line + 1,
          fn: enclosingFunctionName(node),
          test: enclosingTestTitle(node),
          kind: isDateUtcCall(node) ? "Date.UTC" : "new Date",
          arg: (args[0]?.getText() ?? "(missing)").replace(/\s+/g, " ").trim(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export function scanTree(readFile = (file) => readFileSync(join(repoRoot(), file), "utf8")) {
  const findings = [];
  for (const file of discoverSources()) {
    for (const finding of scanSource(file, readFile(file))) findings.push(finding);
  }
  findings.sort((a, b) =>
    a.path.localeCompare(b.path) || a.line - b.line || a.arg.localeCompare(b.arg),
  );
  return findings;
}

export function checkTree(allowlist = loadAllowlist(), findings = scanTree()) {
  const problems = [];
  const allowed = new Set(allowlist.map(allowlistKey));
  for (const finding of findings) {
    if (!allowed.has(allowlistKey(finding))) {
      problems.push(
        `${finding.path}:${finding.line} [${finding.fn}] ${finding.kind}(${finding.arg}, …) builds a civil date with a non-literal year — ` +
        `Date.UTC/new Date map years 0-99 onto 1900-1999. Construct through ` +
        `engine/src/platform/business-date.ts (utcDateFromParts / calendarDaysBetween / inclusiveCalendarDays), ` +
        `or carry the setUTCFullYear idiom locally with a pointer comment when the module must stay db-free. ` +
        `A wall-clock site that provably cannot see a year below 100 may take an allow-list entry with its reason.`,
      );
    }
  }
  const live = new Set(findings.map(allowlistKey));
  for (const entry of allowlist) {
    if (!live.has(allowlistKey(entry))) {
      problems.push(
        `${entry.path} [${entry.fn}] allow-list entry no longer matches a violating site (stale — remove the entry)`,
      );
    }
  }
  return problems;
}

const invoked = process.argv[1] ? process.argv[1].endsWith("check-civil-date-arithmetic.mjs") : false;
if (invoked) {
  const allowlist = loadAllowlist();
  const findings = scanTree();
  const problems = checkTree(allowlist, findings);
  for (const problem of problems) console.log(problem);
  console.log(`checked civil-date arithmetic; violations=${problems.length} (sites=${findings.length}, allowlisted=${allowlist.length})`);
  process.exit(problems.length > 0 ? 1 : 0);
}
