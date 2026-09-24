#!/usr/bin/env node
/**
 * Repo-wide audit: viewer-facing output must never omit or pin its locale.
 *
 * F2-14b: twenty-two web files formatted dates, counts, and currency with a
 * hardcoded 'en-US', so every viewer saw English month names and groupings
 * regardless of locale. The fix is adoption, not one more hand edit: the
 * convention is the required-locale family in web/lib/format.ts
 * (trendWeekLabel, dateLabel, shortDateLabel, monthYearLabel, monthLabel,
 * countLabel, decimalLabel, currencyLabel — the locale argument is REQUIRED
 * so a caller cannot silently fall back), threaded from the viewer's locale
 * (getLocale() in server loaders, useLocale() in client components), and
 * this checker fails the build when a new site pins 'en-US'.
 *
 * A site violates when EITHER holds (AST-walked, never grepped — a grep
 * counts comments and string literals as code):
 *
 *   viol1  an 'en-US' literal is the locale argument of an Intl call: the
 *          first argument of .toLocaleString() / .toLocaleDateString(), or
 *          of new Intl.NumberFormat() / new Intl.DateTimeFormat() (called
 *          with or without `new`);
 *   viol2  an 'en-US' literal is a default value: a parameter default
 *          (`locale = "en-US"`) or a destructured default
 *          (`const { locale = "en-US" } = args`). A default is a silent
 *          fallback for every future caller that forgets the locale.
 *
 * Exemptions live in check-viewer-locale.allowlist.json, keyed by
 * (path, nearest named enclosing function), each carrying a reviewed reason.
 * The ratchet cuts both ways: a site NOT on the list fails immediately, and
 * a list entry whose site no longer violates ALSO fails ("fixed — remove
 * from the allow-list"), so the list cannot rot into permanent amnesty.
 * The list may only SHRINK (see ALLOWLIST_CEILING): genuine pins are
 * machine output and statutory documents, never viewer UI:
 *
 *   - government/legal print formats (information returns, lien waivers,
 *     tax facsimiles) — localizing them corrupts the filing;
 *   - machine canonicalizations (import comparison, refusal-text contracts
 *     pinned by unit tests, numeric hour extraction parsed by Number());
 *   - documented F-t04-010 reader defaults whose UI callers all pass the
 *     request locale explicitly (the default serves engine tests and
 *     label-agnostic agent-tool callers).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// The repository pins its own parser: devDependency alias
// typescript-eslint-typescript -> npm:typescript@6.0.3 (the classic JS
// compiler API). No dependency is added beyond what package.json already pins.
const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const ts = requireFromRoot("typescript-eslint-typescript");

const SELF_PATH = "scripts/check-viewer-locale.mjs";
const ALLOWLIST_PATH = "scripts/check-viewer-locale.allowlist.json";
/**
 * The allow-list may only SHRINK. This is the count at the F2-14b landing
 * (13 reviewed pins: 7 machine/statutory sites, 6 documented reader
 * defaults); a change that needs a larger list is a new violation being
 * exempted, which is the thing the guard exists to refuse. Lower this
 * number as pins are converted; never raise it. The stale-entry ratchet
 * below stops entries rotting; this stops the list growing.
 */
export const ALLOWLIST_CEILING = 12;

function repoRoot() {
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
    if (!entry || typeof entry.path !== "string" || typeof entry.fn !== "string") {
      throw new Error(`${ALLOWLIST_PATH}: every entry needs string "path" and "fn"`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error(`${ALLOWLIST_PATH}: ${entry.path} (${entry.fn}) carries no reviewed reason`);
    }
    const key = `${entry.path}::${entry.fn}`;
    if (seen.has(key)) throw new Error(`${ALLOWLIST_PATH} contains duplicate entry ${key}`);
    seen.add(key);
  }
  return entries;
}

function discoverWebSources() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "web/**/*.ts", "web/**/*.tsx"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter(
      (file) =>
        !/\.test\.[tj]sx?$/.test(file) && !/\.d\.tsx?$/.test(file) && file !== SELF_PATH,
    );
}

function isEnUsLiteral(node) {
  return !!node && (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    node.text === "en-US"
  );
}

function enclosingFunctionName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current)) return current.name.getText();
    if (ts.isConstructorDeclaration(current)) {
      const cls = current.parent;
      if (cls && ts.isClassDeclaration(cls) && cls.name) return cls.name.text;
      return "constructor";
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const parent = current.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
      return "(anonymous)";
    }
    if (ts.isClassDeclaration(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return "(top-level)";
}

function intlLocaleCall(node) {
  const callee =
    (ts.isCallExpression(node) || ts.isNewExpression(node)) ? node.expression : null;
  if (!callee || !ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  if (/^toLocale(?:String|DateString|TimeString)$/.test(method)) return "method";
  if (
    ts.isIdentifier(callee.expression) && callee.expression.text === "Intl" &&
    ["DateTimeFormat", "NumberFormat", "RelativeTimeFormat", "Collator", "PluralRules", "DisplayNames", "ListFormat"].includes(method)
  ) return "constructor";
  return null;
}

function isMissingLocale(node) {
  return !node || (ts.isIdentifier(node) && node.text === "undefined") || node.kind === ts.SyntaxKind.NullKeyword;
}

function isPinnedLocale(node) {
  return !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    (node.text === "en-US" || node.text === "en-CA");
}

export function scanSource(text, filePath) {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const violations = [];
  const requireExplicitViewerLocale = filePath.startsWith("web/app/") || filePath.startsWith("web/components/");
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callKind = intlLocaleCall(node);
      if (callKind) {
        const first = node.arguments?.[0];
        const pinned = requireExplicitViewerLocale ? isPinnedLocale(first) : isEnUsLiteral(first);
        if ((requireExplicitViewerLocale && isMissingLocale(first)) || pinned) {
        const { line } = source.getLineAndCharacterOfPosition((first ?? node.expression).getStart(source));
        violations.push({ path: filePath, fn: enclosingFunctionName(node), line: line + 1 });
        }
      }
    }
    if (
      (ts.isParameter(node) || ts.isBindingElement(node)) &&
      node.initializer &&
      (requireExplicitViewerLocale ? isPinnedLocale(node.initializer) : isEnUsLiteral(node.initializer))
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.initializer.getStart(source));
      violations.push({ path: filePath, fn: enclosingFunctionName(node), line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

export function auditRepository(files) {
  const root = repoRoot();
  const violations = [];
  const syntaxErrors = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    try {
      violations.push(...scanSource(text, file));
    } catch {
      syntaxErrors.push(file);
    }
  }
  return { scannedFiles: files.length, violations, syntaxErrors };
}

export function reconcile(violations, allowlist) {
  const baselineKeys = new Map(allowlist.map((entry) => [`${entry.path}::${entry.fn}`, entry]));
  const matchedKeys = new Set();
  const knownGaps = [];
  const newViolations = [];
  for (const site of violations) {
    const key = `${site.path}::${site.fn}`;
    const entry = baselineKeys.get(key);
    if (entry) {
      matchedKeys.add(key);
      knownGaps.push({ ...site, reason: entry.reason });
    } else {
      newViolations.push(site);
    }
  }
  const staleEntries = allowlist.filter((entry) => !matchedKeys.has(`${entry.path}::${entry.fn}`));
  return { knownGaps, newViolations, staleEntries };
}

export function main() {
  const allowlist = loadAllowlist();
  const { scannedFiles, violations, syntaxErrors } = auditRepository(discoverWebSources());

  let failed = false;
  if (syntaxErrors.length > 0) {
    failed = true;
    console.error(
      `FAIL: ${syntaxErrors.length} file(s) have syntax errors, so the AST walk cannot reason about them.\n` +
        `Fix the syntax first — an unparseable file reports no violations and the gate would green a tree it never measured:`,
    );
    for (const file of syntaxErrors) console.error(`  ${file}`);
  }

  if (allowlist.length > ALLOWLIST_CEILING) {
    console.error(
      `FAIL ${ALLOWLIST_PATH} holds ${allowlist.length} entries, above the ceiling of ${ALLOWLIST_CEILING}: ` +
        "the allow-list may only shrink — route the site through web/lib/format.ts instead of listing it.",
    );
    process.exitCode = 1;
    return;
  }
  const { knownGaps, newViolations, staleEntries } = reconcile(violations, allowlist);

  if (newViolations.length > 0) {
    failed = true;
    console.error(
      `FAIL: ${newViolations.length} viewer-facing site(s) omit or pin the locale.\n` +
        `Every viewer must receive locale-sensitive output in their active locale.\n` +
        `Route the site through the required-locale family in web/lib/format.ts\n` +
        `(trendWeekLabel, dateLabel, shortDateLabel, monthYearLabel, monthLabel,\n` +
        `countLabel, decimalLabel, currencyLabel), threaded from the viewer's locale\n` +
        `(getLocale() in server loaders, useLocale() in client components):`,
    );
    for (const site of newViolations) console.error(`  ${site.path}:${site.line} (${site.fn})`);
  }
  if (staleEntries.length > 0) {
    failed = true;
    console.error("FAIL: allow-list entries no longer violate:");
    for (const entry of staleEntries) {
      console.error(`  ${entry.path} (${entry.fn}): fixed — remove from ${ALLOWLIST_PATH}`);
    }
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `PASS: no omitted or hardcoded viewer locales across ${scannedFiles} files ` +
      `(${violations.length} known pin(s) allow-listed).`,
  );
  for (const gap of knownGaps) {
    console.log(`  allow-listed ${gap.path}:${gap.line} (${gap.fn}): ${gap.reason}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
