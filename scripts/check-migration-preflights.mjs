#!/usr/bin/env node
/**
 * Repo-wide audit: every generated migration with ordinal >= 0242 (the first
 * after v0.1.0-alpha.23) must have EXACTLY ONE decision file in
 * schema/migrations/preflight/:
 *
 *   <basename>.sql   a preflight: exactly one read-only statement
 *                    (SELECT or WITH ... SELECT) returning zero rows when the
 *                    install is ready, else one row per finding with columns
 *                    code / severity / subject / detail / remedy.
 *   <basename>.none  plain text: why no preflight is needed
 *                    (at least 20 non-whitespace characters).
 *
 * There is deliberately no data-dependency heuristic as the trigger: a
 * heuristic can omit a migration, and an omitted migration upgrades blind.
 * The file lists are derived from the directories, never hand-maintained,
 * so a new migration is checked the moment it lands.
 *
 * Refused by name:
 *
 *   preflight-missing        a >= 0242 migration with no decision file
 *   preflight-contradiction  both <basename>.sql and <basename>.none exist
 *   preflight-orphan         a decision file with no matching migration
 *   preflight-none-short     a .none reason under 20 non-whitespace chars
 *   preflight-statements     a .sql file that is not exactly one statement
 *   preflight-not-select     a .sql file that is not SELECT / WITH ... SELECT
 *   preflight-write-keyword  a .sql file containing a write keyword or call
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSqlComments } from "./check-migration-headers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_DIR = join(ROOT, "schema", "migrations", "generated");
const PREFLIGHT_DIR = join(ROOT, "schema", "migrations", "preflight");

/** First ordinal covered by the preflight contract (after v0.1.0-alpha.23). */
export const PREFLIGHT_MIN_ORDINAL = 242;

/** Shortest honest "no preflight needed" reason, in non-whitespace chars. */
export const NONE_REASON_MIN_NONWS = 20;

const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "merge",
  "alter",
  "create",
  "drop",
  "truncate",
  "grant",
  "revoke",
  "set",
  "copy",
  "call",
  "do",
  "into",
];
const FORBIDDEN_CALLS = ["set_config", "pg_advisory_lock", "pg_try_advisory_lock"];

export function ordinalOf(basename) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(basename);
  return match ? Number(match[1]) : null;
}

/**
 * Split SQL into top-level statements. Quote-, dollar-quote- and
 * comment-aware: semicolons inside string literals, quoted identifiers,
 * dollar-quoted bodies, or comments do not split. Empty fragments
 * (whitespace or comments between semicolons) are dropped.
 */
export function splitSqlStatements(content) {
  const statements = [];
  let current = "";
  let hasCode = false;
  let i = 0;
  let state = "code";
  let blockDepth = 0;
  let dollarTag = null;
  const n = content.length;
  const tagPattern = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/y;
  const flush = () => {
    if (hasCode) statements.push(current);
    current = "";
    hasCode = false;
  };
  while (i < n) {
    if (dollarTag !== null) {
      hasCode = true;
      if (content.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += content[i];
        i += 1;
      }
      continue;
    }
    const ch = content[i];
    const next = content[i + 1];
    if (state === "code") {
      if (ch === "-" && next === "-") {
        state = "line";
        current += ch + next;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        blockDepth = 1;
        current += ch + next;
        i += 2;
        continue;
      }
      if (ch === "'") {
        hasCode = true;
        state = "squote";
        current += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        hasCode = true;
        state = "dquote";
        current += ch;
        i += 1;
        continue;
      }
      if (ch === "$") {
        tagPattern.lastIndex = i;
        const tag = tagPattern.exec(content)?.[0];
        if (tag) {
          hasCode = true;
          dollarTag = tag;
          current += tag;
          i += tag.length;
          continue;
        }
        if (ch.trim().length > 0) hasCode = true;
        current += ch;
        i += 1;
        continue;
      }
      if (ch === ";") {
        current += ch;
        i += 1;
        flush();
        continue;
      }
      if (ch.trim().length > 0) hasCode = true;
      current += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      current += ch;
      i += 1;
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      current += ch;
      if (ch === "/" && next === "*") {
        blockDepth += 1;
        current += next;
        i += 2;
        continue;
      }
      if (ch === "*" && next === "/") {
        current += next;
        i += 2;
        blockDepth -= 1;
        if (blockDepth === 0) state = "code";
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "squote") {
      current += ch;
      i += 1;
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (ch === "'") {
        state = "code";
      }
      continue;
    }
    current += ch;
    i += 1;
    if (ch === '"' && next === '"') {
      current += next;
      i += 1;
    } else if (ch === '"') {
      state = "code";
    }
  }
  flush();
  return statements;
}

/**
 * Blank string literals and quoted identifiers so a remedy like
 * 'delete these rows' is prose, not a write keyword. Returns code with
 * every quoted span replaced by spaces (offsets preserved, content gone).
 */
export function blankQuotedSpans(source) {
  let out = "";
  let i = 0;
  let state = "code";
  let dollarTag = null;
  const n = source.length;
  const tagPattern = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/y;
  const blanks = (text) => text.replace(/[^\n]/g, " ");
  while (i < n) {
    if (dollarTag !== null) {
      if (source.startsWith(dollarTag, i)) {
        out += blanks(dollarTag);
        i += dollarTag.length;
        dollarTag = null;
      } else {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    const ch = source[i];
    if (state === "code") {
      if (ch === "'") {
        state = "squote";
        out += " ";
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = "dquote";
        out += " ";
        i += 1;
        continue;
      }
      if (ch === "$") {
        tagPattern.lastIndex = i;
        const tag = tagPattern.exec(source)?.[0];
        if (tag) {
          dollarTag = tag;
          out += blanks(tag);
          i += tag.length;
          continue;
        }
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === "squote") {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "'" && source[i + 1] === "'") {
        out += " ";
        i += 2;
      } else {
        i += 1;
        if (ch === "'") state = "code";
      }
      continue;
    }
    out += ch === "\n" ? "\n" : " ";
    if (ch === '"' && source[i + 1] === '"') {
      out += " ";
      i += 2;
    } else {
      i += 1;
      if (ch === '"') state = "code";
    }
  }
  return out;
}

export function scanPreflightSql(filename, content) {
  const findings = [];
  const statements = splitSqlStatements(stripSqlComments(content));
  if (statements.length !== 1) {
    findings.push({
      file: filename,
      kind: "preflight-statements",
      value: `expected exactly one statement, found ${statements.length}`,
    });
    return findings;
  }
  const [statement] = statements;
  if (!/^\s*(select\b|with\b)/i.test(statement)) {
    findings.push({
      file: filename,
      kind: "preflight-not-select",
      value: "a preflight is exactly one SELECT or WITH ... SELECT statement",
    });
    return findings;
  }
  const code = blankQuotedSpans(stripSqlComments(statement));
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(code)) {
      findings.push({
        file: filename,
        kind: "preflight-write-keyword",
        value: keyword.toUpperCase(),
      });
    }
  }
  for (const call of FORBIDDEN_CALLS) {
    if (new RegExp(`\\b${call}\\s*\\(`, "i").test(code)) {
      findings.push({
        file: filename,
        kind: "preflight-write-keyword",
        value: `${call}()`,
      });
    }
  }
  return findings;
}

export function scanNoneFile(filename, content) {
  const nonws = content.replace(/\s/g, "").length;
  if (nonws < NONE_REASON_MIN_NONWS) {
    return [
      {
        file: filename,
        kind: "preflight-none-short",
        value: `reason has ${nonws} non-whitespace characters, need ${NONE_REASON_MIN_NONWS}`,
      },
    ];
  }
  return [];
}

function listFiles(directory, extension) {
  try {
    return readdirSync(directory)
      .filter((file) => file.endsWith(extension))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function scanTree(generatedDir = GENERATED_DIR, preflightDir = PREFLIGHT_DIR) {
  const findings = [];
  const generated = listFiles(generatedDir, ".sql") ?? [];
  const decisionsRaw = listFiles(preflightDir, ".sql");
  const nonesRaw = listFiles(preflightDir, ".none");
  const decisions = decisionsRaw ?? [];
  const nones = nonesRaw ?? [];
  const preflightMissing = decisionsRaw === null && nonesRaw === null;
  const sqlSet = new Set(decisions ?? []);
  const noneSet = new Set(nones ?? []);
  const migrationStems = new Set(
    generated.map((file) => file.replace(/\.sql$/, "")),
  );

  for (const file of generated) {
    const ordinal = ordinalOf(file);
    if (ordinal === null || ordinal < PREFLIGHT_MIN_ORDINAL) continue;
    const stem = file.replace(/\.sql$/, "");
    const hasSql = sqlSet.has(`${stem}.sql`);
    const hasNone = noneSet.has(`${stem}.none`);
    if (hasSql && hasNone) {
      findings.push({
        file,
        kind: "preflight-contradiction",
        value: `both ${stem}.sql and ${stem}.none exist; keep exactly one`,
      });
      continue;
    }
    if (!hasSql && !hasNone) {
      const where = preflightMissing
        ? "schema/migrations/preflight/ does not exist"
        : `schema/migrations/preflight/${stem}.sql or ${stem}.none is missing`;
      findings.push({
        file,
        kind: "preflight-missing",
        value: `${where}: add a one-statement preflight or a .none reason`,
      });
      continue;
    }
    if (hasSql) {
      const content = readFileSync(join(preflightDir, `${stem}.sql`), "utf8");
      for (const finding of scanPreflightSql(`${stem}.sql`, content)) {
        findings.push({ ...finding, file: `${stem}.sql` });
      }
    } else {
      const content = readFileSync(join(preflightDir, `${stem}.none`), "utf8");
      for (const finding of scanNoneFile(`${stem}.none`, content)) {
        findings.push({ ...finding, file: `${stem}.none` });
      }
    }
  }

  for (const file of [...decisions, ...nones]) {
    const stem = file.replace(/\.(sql|none)$/, "");
    if (!migrationStems.has(stem)) {
      findings.push({
        file,
        kind: "preflight-orphan",
        value: `no generated migration matches ${stem}`,
      });
    }
  }
  return findings;
}

const invoked = process.argv[1] ? process.argv[1].endsWith("check-migration-preflights.mjs") : false;
if (invoked) {
  const findings = scanTree();
  for (const finding of findings) {
    console.log(`${finding.file} [${finding.kind}] ${finding.value}`);
  }
  console.log(`checked migration preflights; violations=${findings.length}`);
  process.exit(findings.length > 0 ? 1 : 0);
}
