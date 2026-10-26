#!/usr/bin/env node
/**
 * RLS bypass-predicate gate: tenant policies AND function/trigger bodies must
 * call public.app_bypass_rls_active() instead of trusting the raw
 * app.bypass_rls GUC inline. Any SET on the runtime pool could otherwise
 * escalate across tenants; the predicate additionally requires a privileged
 * login, so the raw read is the hole.
 *
 * The gate scans the release schema (the active baseline plus every forward
 * migration) and the environments.sql backstop, which re-applies the
 * org_isolation template on every bootstrap. None of them may contain an
 * executable current_setting('app.bypass_rls', ...) read in a policy
 * expression or a function/trigger body. The one exemption is the definition
 * of public.app_bypass_rls_active() itself, which is where the GUC is read
 * together with the privileged-login check. SQL comments are stripped before
 * matching, so prose naming the GUC does not count. Bodies wrap lines where
 * policy expressions did not, so matching runs over both individual lines
 * (for precise locations) and the whole file (for reads split across lines).
 *
 * A forward migration that still reads the raw GUC is accepted only when it
 * is SUPERSEDED: a named later migration drops each of its offending policies
 * (and any re-creation there goes through the predicate, which the scan of
 * that later file enforces). The gate reads the superseding file and refuses
 * when it is missing, is not later, or does not drop the policy — a
 * supersession claim is checked, never trusted. A stale entry (a path that no
 * longer reads the GUC) also fails, so the list can only shrink.
 *
 *   node scripts/check-rls-bypass-predicate.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripSqlComments } from "./check-migration-headers.mjs";
import { releaseSchemaFiles } from "./release-schema-sql.mjs";

const root = ".";

export function migrationOrdinal(basename) {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(basename);
  return match ? Number(match[1]) : null;
}

/** The release schema files, baseline first, in apply order. */
export const RELEASE_SCAN_FILES = releaseSchemaFiles(root).map(({ path }) => path);

const SCAN_FILES = [join(root, "schema", "migrations", "environments.sql"), ...RELEASE_SCAN_FILES];

/** An executable read of the raw bypass GUC (any spacing/cast spelling). */
export const INLINE_BYPASS_GUC = /current_setting\s*\(\s*'app\.bypass_rls'/;

/**
 * Forward migrations whose raw reads live only in policies a later migration
 * replaced. Published migrations are immutable, so the fix for such a file is
 * a later migration, and this map names it together with every policy it must
 * drop: `policies` lists [policy, table] pairs.
 */
export const INLINE_BYPASS_GUC_SUPERSEDED = new Map();

/** The predicate's own definition: the single place the raw GUC is read. */
const PREDICATE_DEFINITION =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\.)?"?app_bypass_rls_active"?\s*\(\s*\)[\s\S]*?\bAS\s+(\$[A-Za-z_]*\$)[\s\S]*?\1/gi;

/**
 * Blank the predicate's definition, keeping its newlines so reported line
 * numbers still point into the scanned file.
 */
export function withoutPredicateDefinition(content) {
  return content.replace(PREDICATE_DEFINITION, (definition) => definition.replace(/[^\n]/g, " "));
}

function executableSql(content) {
  return stripSqlComments(withoutPredicateDefinition(content));
}

function dropsPolicy(content, policy, table) {
  return new RegExp(
    `drop\\s+policy\\s+(?:if\\s+exists\\s+)?"?${policy}"?\\s+on\\s+(?:only\\s+)?(?:"?public"?\\.)?"?${table}"?\\s*;`,
    "i",
  ).test(stripSqlComments(content));
}

/** Why a supersession claim does not hold, or null when the later migration proves it. */
export function supersessionFailure(basename, claim, files) {
  const superseder = files.find((file) => file.split("/").pop() === claim.by);
  if (!superseder) return `${basename}: superseding migration ${claim.by} does not exist`;
  const ordinal = migrationOrdinal(basename);
  if (ordinal === null || (migrationOrdinal(claim.by) ?? -1) <= ordinal) {
    return `${basename}: ${claim.by} is not a later migration`;
  }
  const content = readFileSync(superseder, "utf8");
  const missing = claim.policies.filter(([policy, table]) => !dropsPolicy(content, policy, table));
  return missing.length
    ? `${basename}: ${claim.by} does not drop ${missing.map(([policy, table]) => `${policy} on ${table}`).join(", ")}`
    : null;
}

/** Line numbers (1-based) of executable inline-GUC reads in comment-stripped SQL. */
export function findInlineBypassTrust(content) {
  const hits = [];
  for (const [index, line] of executableSql(content).split("\n").entries()) {
    if (INLINE_BYPASS_GUC.test(line)) hits.push(index + 1);
  }
  return hits;
}

/**
 * Whole-content match for reads split across lines — function bodies wrap
 * where policy expressions did not. True when the comment-stripped content
 * holds an executable read anywhere, even if no single line does.
 */
export function hasInlineBypassTrust(content) {
  return INLINE_BYPASS_GUC.test(executableSql(content));
}

export function auditBypassPredicate(
  files = SCAN_FILES,
  superseded = INLINE_BYPASS_GUC_SUPERSEDED,
) {
  const violations = [];
  const stale = [];
  const unproven = [];
  const seenAllowlisted = new Set();
  for (const file of files) {
    const basename = file.split("/").pop();
    const content = readFileSync(file, "utf8");
    const hits = findInlineBypassTrust(content);
    if (hits.length === 0 && !hasInlineBypassTrust(content)) continue;
    if (superseded.has(basename)) {
      seenAllowlisted.add(basename);
      const failure = supersessionFailure(basename, superseded.get(basename), files);
      if (failure) unproven.push(failure);
      continue;
    }
    violations.push(hits.length > 0 ? `${file}:${hits.join(",")}` : `${file}:multiline`);
  }
  for (const basename of superseded.keys()) {
    if (!seenAllowlisted.has(basename)) stale.push(basename);
  }
  return { violations, stale, unproven, scanned: files.length };
}

function main() {
  if (RELEASE_SCAN_FILES.length === 0) {
    console.error("no release schema to scan; the active migration baseline is missing");
    process.exitCode = 1;
    return;
  }
  const { violations, stale, unproven, scanned } = auditBypassPredicate();
  console.log(
    `checked RLS bypass predicate; scanned-files=${scanned} violations=${violations.length} stale-supersessions=${stale.length}`,
  );
  if (violations.length) {
    console.error(
      `inline app.bypass_rls trust (call public.app_bypass_rls_active() instead): ${violations.join(" ")}`,
    );
    process.exitCode = 1;
  }
  if (unproven.length) {
    console.error(
      `unproven bypass-predicate supersession (a later migration must drop the policy): ${unproven.join("; ")}`,
    );
    process.exitCode = 1;
  }
  if (stale.length) {
    console.error(`stale bypass-predicate supersession (remove the entry): ${stale.join(", ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
