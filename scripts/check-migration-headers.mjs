#!/usr/bin/env node
/**
 * Repo-wide audit: new migrations must not disarm the runner's bounded
 * lock_timeout, and must carry the standard session header.
 *
 * Every migration used to run with `SET lock_timeout = 0` in its own body,
 * each in one transaction while the old stack keeps serving traffic — an
 * ALTER TABLE queued behind a long report query waits forever, and every
 * later query on that table queues behind the migration. Published files
 * (ordinal <= 0251) are immutable, so the runner strips their file-level
 * lock_timeout statements and imposes its own bound instead. That amnesty
 * ends at 0251: any migration with a HIGHER ordinal that sets lock_timeout
 * to 0 (or resets it to the unbounded default) is refused here, because the
 * author could simply have omitted it and let the runner's bound govern.
 *
 * A new migration violates when EITHER holds (checked on the body with SQL
 * comments stripped, so prose mentioning lock_timeout does not count):
 *
 *   viol1  it sets lock_timeout to 0 in any spelling (`SET lock_timeout = 0`,
 *          `SET lock_timeout TO '0s'`, `SET SESSION ...`, `SET LOCAL ...`),
 *          or `RESET lock_timeout` (the default is 0 — unbounded);
 *   viol2  it omits the standard header: the five session SETs every
 *          migration since the early ordinals carries (statement_timeout,
 *          idle_in_transaction_session_timeout, client_encoding,
 *          standard_conforming_strings, client_min_messages). lock_timeout
 *          is deliberately NOT part of the required header — the runner owns
 *          it now.
 *
 * The file list is derived from schema/migrations/generated (never
 * hand-listed), so a new migration is checked the moment it lands.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_DIR = join(ROOT, "schema", "migrations", "generated");

/** Last ordinal covered by the published-files amnesty. */
export const LOCK_TIMEOUT_AMNESTY_MAX_ORDINAL = 251;

const REQUIRED_HEADER_SETTINGS = [
  "statement_timeout",
  "idle_in_transaction_session_timeout",
  "client_encoding",
  "standard_conforming_strings",
  "client_min_messages",
];

export function stripSqlComments(source) {
  let out = "";
  let i = 0;
  let state = "code";
  let blockDepth = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "-" && next === "-") {
        state = "line";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        blockDepth = 1;
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = "squote";
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "/" && next === "*") {
        blockDepth += 1;
        i += 2;
        continue;
      }
      if (ch === "*" && next === "/") {
        blockDepth -= 1;
        i += 2;
        if (blockDepth === 0) state = "code";
        continue;
      }
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
    if (ch === "'" && next === "'") {
      out += next;
      i += 1;
    } else if (ch === "'") {
      state = "code";
    }
  }
  return out;
}

function lockTimeoutSetting(code) {
  const match = /set(?:\s+(?:session|local))?\s+lock_timeout\s*(?:=|to\b)\s*([^;\s]+)/i.exec(code);
  return match ? match[1].replace(/^'|'$/g, "") : null;
}

function isZeroTimeout(value) {
  if (value === null) return false;
  const compact = value.replace(/['"\s]/g, "").toLowerCase();
  // DEFAULT is the stock 0 (wait forever); spelling it out disarms the
  // runner's bound exactly like writing 0.
  if (compact === "0" || compact === "default") return true;
  const timed = /^0+(?:\.0+)?(ms|s|sec|secs|second|seconds|min|m|h|d)?$/.exec(compact);
  return timed !== null;
}

export function scanMigrationFile(filename, content) {
  const ordinal = Number(/^(\d{4})_[a-z0-9_]+\.sql$/.exec(filename)?.[1] ?? NaN);
  if (!Number.isInteger(ordinal) || ordinal <= LOCK_TIMEOUT_AMNESTY_MAX_ORDINAL) return [];
  const findings = [];
  const code = stripSqlComments(content);
  const setting = lockTimeoutSetting(code);
  if ((setting !== null && isZeroTimeout(setting)) || /reset\s+lock_timeout\s*;?/i.test(code)) {
    findings.push({
      file: filename,
      kind: "lock_timeout-zero",
      value: setting === null ? "RESET lock_timeout" : `SET lock_timeout = ${setting}`,
    });
  }
  const missing = REQUIRED_HEADER_SETTINGS.filter(
    (name) => !new RegExp(`(^|\\s)SET\\s+(?:(?:SESSION|LOCAL)\\s+)?${name}\\b`, "i").test(code),
  );
  for (const name of missing) {
    findings.push({ file: filename, kind: "header-missing", value: `SET ${name}` });
  }
  return findings;
}

export function scanTree(directory = GENERATED_DIR) {
  const findings = [];
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const content = readFileSync(join(directory, file), "utf8");
    for (const finding of scanMigrationFile(file, content)) findings.push(finding);
  }
  return findings;
}

const invoked = process.argv[1] ? process.argv[1].endsWith("check-migration-headers.mjs") : false;
if (invoked) {
  const directory = process.argv[2] ?? GENERATED_DIR;
  const findings = scanTree(directory);
  for (const finding of findings) {
    console.log(`${finding.file} [${finding.kind}] ${finding.value}`);
  }
  console.log(`checked migration headers; violations=${findings.length}`);
  process.exit(findings.length > 0 ? 1 : 0);
}
