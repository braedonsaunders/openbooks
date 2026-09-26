#!/usr/bin/env node
// check-ledger-journal-writes.mjs — every journal write routes through the
// journal kernel (engine/src/journal/post-entry.ts postEntry /
// markEntryReversed, extracted from ledger; the
// document-posting sibling writer posting-commit.ts stays in ledger).
// Owner approved this widening under "everything lands in alpha24".
// Fails if any other engine module issues INSERT / UPDATE / DELETE on
// journal_entries or journal_lines, in raw SQL or through the drizzle
// schema handles. Derived from the source tree on every run — never a hand
// list of allowed files: the only structural allowances are (a) anything
// inside engine/src/ledger/ or engine/src/journal/ and (b) UPDATEs of journal_lines whose SET
// clause touches only governed non-financial columns — reconciliation
// evidence (reconciled_at, reconciliation_id, source_cleared_date,
// source_cleared_connector), which the jl_guard storage trigger holds
// append-only, and party attribution (party_id), which the governed party-
// merge path moves under its own period checks. Amounts, accounts,
// subsidiaries, currencies, and entry lifecycle never change outside the
// ledger API. Test files are out of scope (fixtures must build rows
// directly); scripts/ tooling and schema/ migrations are outside the engine
// module boundary this check guards.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const ENGINE_SRC = join(ROOT, "engine", "src");
const LEDGER_DIR = join(ENGINE_SRC, "ledger") + "/";
const JOURNAL_DIR = join(ENGINE_SRC, "journal") + "/";

// Mirrors the test/type exclusions of check-engine-boundaries.mjs.
const TEST =
  /(^|\/)(__tests__|__snapshots__|__fixtures__|__mocks__)\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|\/testing\//;

const RAW_WRITE =
  /\b(insert\s+into|update|delete\s+from)\s+journal_(entries|lines)\b/gi;
const DRIZZLE_WRITE =
  /\.(insert|update|delete)\(\s*schema\.journal(Entries|Lines)\s*\)/g;

// SET columns allowed on journal_lines outside the ledger module: governed
// non-financial columns only (see header).
const NON_FINANCIAL_LINE_COLUMNS = new Set([
  "reconciled_at",
  "reconciliation_id",
  "source_cleared_date",
  "source_cleared_connector",
  "party_id",
]);

function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^\n\\])\/\/[^\n]*/g, "$1 ")
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}

function setColumns(statement, keywordIndex) {
  const rest = statement.slice(keywordIndex);
  const setMatch = /\bset\b([\s\S]*?)(?:\bwhere\b|\breturning\b|;|$)/i.exec(rest);
  if (!setMatch) return null;
  return setMatch[1]
    .split(",")
    .map((part) => {
      const name = /^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=/.exec(part);
      return name ? name[1].toLowerCase() : null;
    })
    .filter(Boolean);
}

function* sourceFiles() {
  // Tracked files only (git ls-files --cached): ignored (.gitignore,
  // .git/info/exclude) and untracked files are out of scope, so private
  // local tooling in a checkout can never fail the boundary. Same
  // enumeration as check-engine-boundaries.mjs, minus its --others.
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--", "engine/src"], {
    cwd: ROOT,
    maxBuffer: 1 << 27,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const rel of listed) {
    const posix = rel.replace(/\\/g, "/");
    if (/\.[cm]?[jt]sx?$/.test(posix) && !TEST.test(posix)) yield join(ROOT, posix);
  }
}

const violations = [];
for (const file of sourceFiles()) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (file.startsWith(LEDGER_DIR) || file.startsWith(JOURNAL_DIR)) continue;
  const text = stripNoise(readFileSync(file, "utf8"));
  for (const match of text.matchAll(RAW_WRITE)) {
    const verb = match[1].toLowerCase().replace(/\s+/g, " ");
    const table = `journal_${match[2].toLowerCase()}`;
    const before = text.slice(0, match.index);
    const line = before.split("\n").length;
    if (verb === "update" && table === "journal_lines") {
      const columns = setColumns(text, match.index);
      if (columns && columns.every((column) => NON_FINANCIAL_LINE_COLUMNS.has(column))) continue;
    }
    violations.push(
      `${rel}:${line}: ${verb} on ${table} outside engine/src/ledger/ — route it through the ledger API (engine/src/journal/post-entry.ts)`,
    );
  }
  for (const match of text.matchAll(DRIZZLE_WRITE)) {
    const before = text.slice(0, match.index);
    const line = before.split("\n").length;
    violations.push(
      `${rel}:${line}: drizzle .${match[1].toLowerCase()}(schema.journal${match[2]}) outside engine/src/ledger/ — route it through the ledger API (engine/src/journal/post-entry.ts)`,
    );
  }
}

if (violations.length > 0) {
  console.error(
    `ledger journal-write boundary: ${violations.length} violation(s)\n${violations.join("\n")}`,
  );
  process.exit(1);
}
console.log("ledger journal-write boundary: every journal write routes through the ledger API");
