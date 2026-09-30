#!/usr/bin/env node
/**
 * Repo-wide ratchet: agent-built surfaces must compose the shared UI layer.
 *
 * Owner directive 2026-09-26: every agent-built surface reuses the shared
 * tables, drawers, forms, list sources and customization layer. A new feature
 * that hand-rolls its own table, dialog, confirm flow, page shell or list
 * source is wrong even if it works. This gate fails the build when a new
 * site does so. It is textual, never AST-walked: comments and string
 * literals are blanked first, so prose mentioning `<table>` never counts.
 *
 * A site violates when one of these holds on comment/string-blanked source:
 *
 *   rule1  raw `<table` in web/app/(app)/** or web/components/** (non-test).
 *          Lists render PagedTable / RecordListView / EntityListView, reports
 *          render the ReportTable primitives, detail sections render the
 *          shared Table in @openbooks/ui — never a lowercase `<table`.
 *   rule2  `<dialog`, `window.confirm(`, `window.prompt(` or `window.alert(`
 *          in the same scopes. Blocking browser dialogs are replaced by the
 *          shared promptDialog flow in web/lib/prompt.tsx.
 *   rule3  a page.tsx under web/app/(app) that does not import ModuleView
 *          (web/components/viewspec/module-view.tsx). Pages that genuinely
 *          own a custom shell are listed, never silently bespoke.
 *   rule4  a PagedTable / RecordListView / EntityListView element passing a
 *          `source`, `entity` or `recordType` string literal that is not
 *          registered in web/lib/list/sources.ts or
 *          web/lib/list/entity-sources.ts. Only statically known literals
 *          are checked; dynamic keys (identifiers, ternaries over
 *          identifiers) resolve at runtime through listSource /
 *          entityListSource, which already throw on unknown types.
 *
 * Rules 1-3 reconcile against scripts/check-ui-reuse.allowlist.json, keyed
 * by file path with a reviewed reason. The ratchet cuts both ways: a
 * violating file NOT on the list fails immediately, and a list entry whose
 * file no longer violates ALSO fails ("fixed — remove from the
 * allow-list"), so the list cannot rot into permanent amnesty. Each section
 * carries a ceiling comment: the list may only SHRINK. Rule 4 has no
 * allow-list: an unregistered key fails and names the key.
 *
 *   node scripts/check-ui-reuse.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = "scripts/check-ui-reuse.mjs";
const ALLOWLIST_PATH = "scripts/check-ui-reuse.allowlist.json";
const DOC_SOURCES_PATH = "web/lib/list/sources.ts";
const ENTITY_SOURCES_PATH = "web/lib/list/entity-sources.ts";

/**
 * The allow-lists may only SHRINK. These are the counts at the gate-first
 * landing; a change that needs a larger list is a new violation being
 * exempted, which is the thing the gate exists to refuse. Lower each number
 * as sites are converted; never raise it. The stale-entry ratchet below
 * stops entries rotting; these stop the lists growing.
 */
export const TABLE_CEILING = 1;
export const DIALOG_WINDOW_CEILING = 0;
export const BESPOKE_PAGE_CEILING = 17;

const LIST_COMPONENTS = ["PagedTable", "RecordListView", "EntityListView"];
const LIST_KEY_PROPS = ["source", "entity", "recordType"];

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Blank comments and string contents, keeping newlines, quote delimiters
 * and template `${...}` code. What remains is the shape of the code: JSX
 * tags, calls and imports still match, while prose and HTML strings do not.
 */
export function stripCode(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let state = "code";
  let quote = "";
  while (i < n) {
    const c = src[i];
    const nx = src[i + 1];
    if (state === "code") {
      if (c === "/" && nx === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && nx === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'" || c === '"') { state = "str"; quote = c; out += c; i++; continue; }
      if (c === "`") { state = "tpl"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; } else { out += " "; }
      i++; continue;
    }
    if (state === "block") {
      if (c === "*" && nx === "/") { state = "code"; out += "  "; i += 2; }
      else { out += c === "\n" ? "\n" : " "; i++; }
      continue;
    }
    if (state === "str") {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === quote) { state = "code"; out += c; i++; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    // Template: blank literal spans, splice `${...}` code back in.
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === "`") { state = "code"; out += c; i++; continue; }
    if (c === "$" && nx === "{") {
      out += "  "; i += 2;
      let depth = 1;
      let inner = "";
      while (i < n && depth > 0) {
        const d = src[i];
        if (d === "{") depth++;
        if (d === "}") depth--;
        if (depth > 0) inner += d;
        i++;
      }
      out += inner;
      continue;
    }
    out += c === "\n" ? "\n" : " "; i++;
  }
  return out;
}

function lineOf(stripped, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (stripped[i] === "\n") line++;
  return line;
}

/**
 * Blank comments only, keeping string/template literals intact. List-key
 * extraction needs the literal values, which stripCode blanks away.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let state = "code";
  while (i < n) {
    const c = src[i];
    const nx = src[i + 1];
    if (state === "code") {
      if (c === "/" && nx === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && nx === "*") { state = "block"; out += "  "; i += 2; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; } else { out += " "; }
      i++; continue;
    }
    if (c === "*" && nx === "/") { state = "code"; out += "  "; i += 2; }
    else { out += c === "\n" ? "\n" : " "; i++; }
  }
  return out;
}

/** Index just past the string literal starting at t[i] (a quote char). */
function skipStringLiteral(t, i) {
  const q = t[i];
  i++;
  while (i < t.length) {
    const c = t[i];
    if (q === "`" && c === "$" && t[i + 1] === "{") { i = skipBalanced(t, i + 1); continue; }
    if (c === "\\") { i += 2; continue; }
    if (c === q) return i + 1;
    i++;
  }
  return i;
}

/** Index just past the balanced brace run starting at t[i] ("{"). */
function skipBalanced(t, i) {
  let depth = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '"' || c === "'" || c === "`") { i = skipStringLiteral(t, i); continue; }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/** Registered list keys: the SOURCES record keys in both list registries. */
export function extractRegistryKeys(sourcesText, entitySourcesText) {
  const keys = new Set();
  for (const text of [sourcesText, entitySourcesText]) {
    const start = text.indexOf("const SOURCES");
    if (start < 0) throw new Error("list registry has no SOURCES record");
    const region = text.slice(start);
    const end = region.search(/\nexport function /);
    const body = end < 0 ? region : region.slice(0, end);
    for (const m of body.matchAll(/^  ([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)) keys.add(m[1]);
  }
  if (keys.size === 0) throw new Error("no registered list keys found");
  return keys;
}

export function loadRegisteredKeys(readFile = (file) => readFileSync(join(repoRoot(), file), "utf8")) {
  return extractRegistryKeys(readFile(DOC_SOURCES_PATH), readFile(ENTITY_SOURCES_PATH));
}

/** All violations in one file of comment/string-blanked source. */
export function scanText(path, text, registeredKeys = new Set()) {
  const stripped = stripCode(text);
  const violations = [];
  const tableAt = stripped.search(/<table(?=[\s/>])/);
  if (tableAt >= 0) violations.push({ rule: "raw-table", path, line: lineOf(stripped, tableAt) });
  const dialogAt = stripped.search(/<dialog(?=[\s/>])/);
  if (dialogAt >= 0) violations.push({ rule: "dialog", path, line: lineOf(stripped, dialogAt) });
  const windowRe = /window\.(confirm|prompt|alert)\s*\(/g;
  let wm;
  while ((wm = windowRe.exec(stripped))) {
    violations.push({ rule: "window-dialog", path, line: lineOf(stripped, wm.index), key: wm[1] });
    if (violations.length > 50) break;
  }
  if (/(^|\/)page\.tsx$/.test(path) && path.startsWith("web/app/(app)/")) {
    if (!/^\s*import\s[^;]*\bModuleView\b/m.test(stripped)) {
      violations.push({ rule: "bespoke-page", path, line: 1 });
    }
  }
  // List keys carry literal values, so this rule reads comment-blanked
  // (not string-blanked) source with a string-aware element walk.
  const code = stripComments(text);
  if (LIST_COMPONENTS.some((name) => code.includes(`<${name}`))) {
    const openRe = /<(PagedTable|RecordListView|EntityListView)\b/g;
    let m;
    while ((m = openRe.exec(code))) {
      const line = lineOf(code, m.index);
      let i = m.index + m[0].length;
      let depth = 0;
      let attrs = "";
      while (i < code.length) {
        const c = code[i];
        if (c === '"' || c === "'" || c === "`") {
          const end = skipStringLiteral(code, i);
          attrs += code.slice(i, end);
          i = end;
          continue;
        }
        if (c === "{") depth++;
        if (c === "}") depth--;
        if (c === ">" && depth === 0) break;
        attrs += c; i++;
      }
      const propNames = LIST_KEY_PROPS.join("|");
      const propRe = new RegExp(
        `(?:^|[\\s{])(${propNames})\\s*=\\s*(?:"([^"]+)"|'([^']+)'|\\{\\s*"([^"]+)"\\s*\\}|\\{\\s*'([^']+)'\\s*\\})`,
        "g",
      );
      let pm;
      while ((pm = propRe.exec(attrs))) {
        const key = pm[2] ?? pm[3] ?? pm[4] ?? pm[5];
        if (key && !registeredKeys.has(key)) {
          violations.push({ rule: "unknown-list-key", path, line, key });
        }
      }
    }
  }
  return violations;
}

function discoverScopeFiles() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "web/app/(app)", "web/components"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter(
      (file) =>
        /\.(tsx?)$/.test(file) &&
        !/\.test\.[tj]sx?$/.test(file) &&
        !/\.d\.tsx?$/.test(file) &&
        file !== SELF,
    );
}

export function loadAllowlist(readFile = (file) => readFileSync(join(repoRoot(), file), "utf8")) {
  const parsed = JSON.parse(readFile(ALLOWLIST_PATH));
  for (const section of ["tables", "dialogWindow", "bespokePages"]) {
    if (!Array.isArray(parsed[section])) {
      throw new Error(`${ALLOWLIST_PATH}: "${section}" must hold a JSON array`);
    }
    const seen = new Set();
    for (const entry of parsed[section]) {
      if (!entry || typeof entry.path !== "string") {
        throw new Error(`${ALLOWLIST_PATH}: every "${section}" entry needs a string "path"`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
        throw new Error(`${ALLOWLIST_PATH}: ${entry.path} carries no reviewed reason`);
      }
      if (seen.has(entry.path)) throw new Error(`${ALLOWLIST_PATH} contains duplicate entry ${entry.path}`);
      seen.add(entry.path);
    }
  }
  return parsed;
}

function reconcileFiles(violationPaths, entries) {
  const allowed = new Map(entries.map((entry) => [entry.path, entry]));
  const matched = new Set();
  const fresh = [];
  for (const path of violationPaths) {
    if (allowed.has(path)) matched.add(path);
    else fresh.push(path);
  }
  return { fresh, stale: entries.filter((entry) => !matched.has(entry.path)) };
}

export function auditRepository(files, registeredKeys, readFile) {
  const root = repoRoot();
  const violations = [];
  for (const file of files) {
    let text;
    try {
      text = readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    violations.push(...scanText(file, text, registeredKeys));
  }
  return violations;
}

export function main() {
  const allowlist = loadAllowlist();
  let failed = false;
  const ceilings = [
    ["tables", allowlist.tables.length, TABLE_CEILING],
    ["dialogWindow", allowlist.dialogWindow.length, DIALOG_WINDOW_CEILING],
    ["bespokePages", allowlist.bespokePages.length, BESPOKE_PAGE_CEILING],
  ];
  for (const [section, count, ceiling] of ceilings) {
    if (count > ceiling) {
      console.error(
        `FAIL ${ALLOWLIST_PATH} "${section}" holds ${count} entries, above the ceiling of ${ceiling}: ` +
          "the allow-list may only shrink — compose the shared layer instead of listing the site.",
      );
      failed = true;
    }
  }

  let registered;
  try {
    registered = loadRegisteredKeys();
  } catch (err) {
    console.error(`FAIL: cannot derive registered list keys: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const violations = auditRepository(
    discoverScopeFiles(),
    registered,
    (abs) => readFileSync(abs, "utf8"),
  );

  const byRule = (rule) => violations.filter((v) => v.rule === rule);
  const tablePaths = [...new Set(byRule("raw-table").map((v) => v.path))].sort();
  const dialogPaths = [...new Set(
    violations.filter((v) => v.rule === "dialog" || v.rule === "window-dialog").map((v) => v.path),
  )].sort();
  const bespokePaths = [...new Set(byRule("bespoke-page").map((v) => v.path))].sort();
  const unknownKeys = byRule("unknown-list-key");

  if (unknownKeys.length > 0) {
    failed = true;
    console.error(
      "FAIL: list elements pass unregistered source keys. " +
        "Register the source in web/lib/list/sources.ts or web/lib/list/entity-sources.ts:",
    );
    for (const v of unknownKeys) console.error(`  ${v.path}:${v.line} unregistered key "${v.key}"`);
  }
  const sections = [
    ["tables", tablePaths, allowlist.tables, "raw <table>. Compose the shared table layer (PagedTable / RecordListView / EntityListView for lists, the ReportTable primitives for reports, Table in @openbooks/ui) instead of a lowercase <table>"],
    ["dialogWindow", dialogPaths, allowlist.dialogWindow, "<dialog> or window.confirm/prompt/alert. Route the confirmation through the shared promptDialog flow in web/lib/prompt.tsx"],
    ["bespokePages", bespokePaths, allowlist.bespokePages, "page.tsx without a ModuleView import. Render ModuleView from web/components/viewspec/module-view.tsx"],
  ];
  for (const [name, paths, entries, remedy] of sections) {
    const { fresh, stale } = reconcileFiles(paths, entries);
    if (fresh.length > 0) {
      failed = true;
      console.error(`FAIL: ${fresh.length} file(s) with ${remedy}:`);
      for (const path of fresh) console.error(`  ${path}`);
    }
    if (stale.length > 0) {
      failed = true;
      console.error(`FAIL "${name}" entries no longer violate (fixed — remove from ${ALLOWLIST_PATH}):`);
      for (const entry of stale) console.error(`  ${entry.path}`);
    }
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `PASS: shared UI layer intact across scope ` +
      `(${tablePaths.length} grandfathered table file(s), ${dialogPaths.length} dialog file(s), ` +
      `${bespokePaths.length} bespoke page(s) allow-listed).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
