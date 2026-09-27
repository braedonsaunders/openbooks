#!/usr/bin/env node
/**
 * Guard journal and document aggregates against dropping reversal history.
 *
 * Journal entries retain their original lines when reversed, so a journal
 * status set containing `posted` must also contain `reversed`. Documents use
 * `voided_at` for the reversal date; an aggregate that reads document or line
 * amounts must include `voided` (or use the as-of void-date predicate). A
 * current-state read may explicitly exclude reversals on the predicate
 * line with this exact intent comment:
 * `-- Live entries only: <why voided documents are excluded>`
 *
 * The scan uses TypeScript's AST to isolate SQL template literals, then ties
 * status predicates to aliases whose `FROM`/`JOIN` relation is in that same
 * template. Tests and declarations are excluded.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const ts = requireFromRoot("typescript");
const SELF_PATH = "scripts/check-journal-status-filter.mjs";
const SELF_TEST = "scripts/check-journal-status-filter.test.mjs";
const RELATIONS = new Set(["journal_entries", "journal_lines", "documents", "document_lines"]);
const RESERVED = new Set([
  "as", "cross", "except", "fetch", "for", "full", "group", "having", "inner", "intersect",
  "join", "left", "limit", "natural", "offset", "on", "order", "right", "union", "where",
]);

export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function discoverSources() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z",
      "engine/src/**/*.ts", "engine/src/**/*.tsx", "web/**/*.ts", "web/**/*.tsx",
      "packages/**/*.ts", "packages/**/*.tsx"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter((file) => !/\.test\.[tj]sx?$/.test(file) && !/\.d\.tsx?$/.test(file));
}

function isSqlTag(tag) {
  return ts.isIdentifier(tag) && tag.text === "sql";
}

function isSqlTemplateNode(node) {
  if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag)) return true;
  if (!ts.isTemplateExpression(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return false;
  if (ts.isTaggedTemplateExpression(node.parent) && isSqlTag(node.parent.tag)) return false;
  const text = ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : `${node.head.text}${node.templateSpans.map((span) => span.literal.text).join(" ")}`;
  return /\bselect\b[\s\S]*\bfrom\b/i.test(text) && /\b(?:journal_entries|journal_lines|documents|document_lines)\b/i.test(text);
}

function templateText(template, sourceFile) {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  let out = template.head.text;
  for (const span of template.templateSpans) {
    const expression = span.expression.getText(sourceFile);
    out += ` ${"\n".repeat((expression.match(/\n/g) ?? []).length)} ${span.literal.text}`;
  }
  return out;
}

function stripSqlComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (comment) => comment.replace(/[^\n]/g, " "));
}

function relationAliases(text) {
  const aliases = [];
  const relationPattern = new RegExp(`\\b(?:from|join)\\s+(${[...RELATIONS].join("|")})\\b(?:\\s+(?:as\\s+)?([a-z_][\\w$]*))?`, "gi");
  for (const match of text.matchAll(relationPattern)) {
    const relation = match[1].toLowerCase();
    const possibleAlias = match[2]?.toLowerCase();
    aliases.push({
      relation,
      alias: possibleAlias && !RESERVED.has(possibleAlias) ? possibleAlias : relation,
      offset: match.index ?? 0,
    });
  }
  return aliases;
}

function statusConditions(text, alias) {
  const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = alias === "documents" || alias === "journal_entries" || alias === "journal_lines" || alias === "document_lines"
    ? `(?<![\\w$.])(?:\\b${escapedAlias}\\s*\\.\\s*)?status\\s*`
    : `\\b${escapedAlias}\\s*\\.\\s*status\\s*`;
  const conditions = [];
  for (const match of text.matchAll(new RegExp(`${prefix}(=|==)\\s*'([^']+)'`, "gi"))) {
    conditions.push({ values: [match[2].toLowerCase()], offset: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  for (const match of text.matchAll(new RegExp(`${prefix}in\\s*\\(([^)]*)\\)`, "gi"))) {
    const values = [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1].toLowerCase());
    if (values.length) conditions.push({ values, offset: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return conditions;
}

function hasOrStatus(text, alias, first, second) {
  const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const status = `(?<![\\w$.])(?:\\b${escapedAlias}\\s*\\.\\s*)?status`;
  const term = (value) => `${status}\\s*(?:=\\s*'${value}'|in\\s*\\([^)]*'${value}'[^)]*\\))`;
  const left = new RegExp(`${term(first)}\\s+or\\s+${term(second)}`, "i");
  const right = new RegExp(`${term(second)}\\s+or\\s+${term(first)}`, "i");
  return left.test(text) || right.test(text);
}

function hasDocumentAsOfVoidPredicate(text, alias) {
  const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b${escapedAlias}\\s*\\.\\s*status\\s*=\\s*'posted'\\s+or\\s+\\(\\s*${escapedAlias}\\s*\\.\\s*voided_at\\s+is\\s+not\\s+null\\s+and\\s+${escapedAlias}\\s*\\.\\s*voided_at\\s*::\\s*date\\s*>`,
    "i",
  ).test(text);
}

function hasDocumentAmountAggregate(text, aliases) {
  const amountAliases = aliases
    .filter(({ relation }) => ["documents", "document_lines", "journal_lines"].includes(relation))
    .map(({ alias }) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const aggregate = /\b(?:sum|avg|count)\s*\(/i;
  if (!aggregate.test(text)) return false;
  if (amountAliases.some((alias) =>
    new RegExp(`\\b(?:sum|avg)\\s*\\(\\s*(?:distinct\\s+)?${alias}\\s*\\.\\s*(?:amount|total|open_balance)\\b`, "i").test(text),
  )) return true;
  if (/\b(?:sum|avg)\s*\(\s*(?:distinct\s+)?(?:amount|total|open_balance)\b/i.test(text)) return true;
  return aliases.some(({ relation, alias }) => relation === "documents" &&
    (new RegExp(`\\bcount\\s*\\(\\s*(?:distinct\\s+)?${alias}\\s*\\.\\s*id\\s*\\)`, "i").test(text) || /\bcount\s*\(\s*\*\s*\)/i.test(text)));
}

function hasLiveEntriesOnlyIntent(raw, condition) {
  const lineStart = raw.lastIndexOf("\n", condition.offset) + 1;
  const lineEnd = raw.indexOf("\n", condition.end);
  const predicateLine = raw.slice(lineStart, lineEnd < 0 ? raw.length : lineEnd);
  return /--\s*Live entries only: [^\r\n]+\s*$/.test(predicateLine);
}

export function scanSource(path, content) {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const findings = [];
  const visit = (node) => {
    if (isSqlTemplateNode(node)) {
      const template = ts.isTaggedTemplateExpression(node) ? node.template : node;
      const raw = templateText(template, sourceFile);
      const sqlText = stripSqlComments(raw);
      const aliases = relationAliases(sqlText);
      for (const { alias, relation } of aliases) {
        const conditions = statusConditions(sqlText, alias);
        for (const condition of conditions) {
          const values = new Set(condition.values);
          const liveEntriesOnly = hasLiveEntriesOnlyIntent(raw, condition);
          let reason = null;
          if (relation === "journal_entries" && values.has("posted") && !values.has("reversed") &&
              !hasOrStatus(sqlText, alias, "posted", "reversed") && !liveEntriesOnly) {
            reason = "journal-entry filters that include posted must also include reversed";
          }
          if (relation === "documents" && values.has("posted") && !values.has("voided") &&
              !hasOrStatus(sqlText, alias, "posted", "voided") &&
              hasDocumentAmountAggregate(sqlText, aliases) && !hasDocumentAsOfVoidPredicate(sqlText, alias) && !liveEntriesOnly) {
            reason = "document amount aggregates must include voided history or an as-of void-date predicate; current-state exclusions need the documented intent comment";
          }
          if (reason) {
            const templateLine = sourceFile.getLineAndCharacterOfPosition(template.getStart(sourceFile) + 1).line;
            const line = templateLine + (raw.slice(0, condition.offset).match(/\n/g) ?? []).length + 1;
            findings.push({ path, line, alias, relation, reason });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Map(findings.map((finding) => [`${finding.path}:${finding.line}:${finding.alias}:${finding.relation}`, finding])).values()];
}

export function scanTree(readFile = (file) => readFileSync(join(repoRoot(), file), "utf8")) {
  return discoverSources().flatMap((file) => scanSource(file, readFile(file)));
}

export function checkTree(findings = scanTree()) {
  return findings.map(({ path, line, alias, relation, reason }) =>
    `${path}:${line} alias ${alias} (${relation}) ${reason}`,
  );
}

const invoked = process.argv[1] ? process.argv[1].endsWith("check-journal-status-filter.mjs") : false;
if (invoked) {
  const findings = scanTree();
  const problems = checkTree(findings);
  for (const problem of problems) console.log(problem);
  console.log(`checked journal status filters; violations=${problems.length} (sites=${findings.length})`);
  process.exit(problems.length > 0 ? 1 : 0);
}
