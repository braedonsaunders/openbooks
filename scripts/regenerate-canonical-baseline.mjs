import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * The input is a schema-only dump produced inside the release-pinned
 * PostgreSQL image, never by an arbitrary workstation client:
 *
 * postgres:16.9-alpine3.22@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7
 *
 * pg_dump --format=plain --schema-only --encoding=UTF8 --no-owner
 *   --no-tablespaces --no-table-access-method --no-security-labels
 *   --no-publications --no-subscriptions --strict-names --schema=public
 *   --schema=openbooks_query --exclude-table=public._applied_migrations
 *
 * PostgreSQL 16.9 predates psql's restrict-key metacommands. The transformer
 * rejects every psql metacommand, so its output remains node-postgres-safe.
 *
 * The baseline also carries hand-written prose that pg_dump cannot know about:
 * design-rationale blocks sitting under a `-- Name: ...` object header. Those
 * are lifted from the previous baseline and re-anchored onto the same headers,
 * so regenerating in place is a fixed point instead of a silent doc deletion.
 * `--output` doubles as the default annotation source; `--no-annotations`
 * regenerates without them.
 */

const HEADER = `-- OpenBooks canonical PostgreSQL baseline.
--
-- This file defines the complete schema for a fresh installation: tables,
-- constraints, indexes, functions, triggers, row-level security policies,
-- governed query views, and grants. Deployment bootstrap applies it exactly
-- once and records its digest in _applied_migrations.

`;

const OPTIONAL_TRIGRAM = `-- Trigram search is an optional acceleration. PostgreSQL providers that do
-- not allow application roles to install extensions still receive the full
-- canonical schema and use the application's substring-search fallback.
DO $extension$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'pg_trgm is unavailable; trigram indexes will be skipped';
END
$extension$;


`;

/**
 * Payroll relations that take the catalog's generic `select *` path. Every one
 * of them must be reviewed as a whole: a dump carrying only some of them means
 * the allowlist was edited without a review pass.
 *
 * `employee_payroll_profiles` is deliberately absent — it holds `sin_encrypted`
 * and is rebuilt from an explicit column list instead. See
 * CURATED_QUERY_RELATIONS.
 */
const PAYROLL_QUERY_RELATIONS = Object.freeze([
  "pay_schedules",
  "pay_components",
  "pay_derived_rules",
  "pay_run_adjustments",
  "employee_pay_components",
  "pay_runs",
  "pay_stubs",
  "pay_stub_lines",
  "payroll_filing_accounts",
  "payroll_holidays",
  "payroll_opening_balance_components",
  "payroll_opening_balances",
  "union_agreements",
  "union_classifications",
  "union_fringes",
]);

/**
 * Relations that can hold a secret and therefore may NEVER take the generic
 * `select *` path: the catalog rebuilds each from an explicit column list, so
 * adding a sensitive column is a visible diff rather than a silent widening.
 * schema/governed-query-catalog.test.ts asserts the same rule against the
 * committed baseline; this guard stops a regenerated one from ever reaching it.
 */
const CURATED_QUERY_RELATIONS = Object.freeze([
  "parties",
  "party_bank_accounts",
  "vendor_roles",
  "employee_payroll_profiles",
  "employee_roles",
]);

/** Columns that must never be readable through the governed catalog. */
const NEVER_QUERYABLE = Object.freeze([
  "sin_encrypted",
  "tin_encrypted",
  "account_number_encrypted",
  "password_encrypted",
  "password_hash",
  "secret_encrypted",
  "originator_secrets_encrypted",
  "reseal_secret",
  "birth_date",
]);

/** Matches a pg_dump object header plus the prose a human added beneath it. */
const ANNOTATED_OBJECT = /^--\n-- Name: (.+?)\n--\n((?:--.*\n)+)\n/gm;

/** Matches a bare pg_dump object header, ready to receive that prose back. */
const BARE_OBJECT = /^(--\n-- Name: (.+?)\n--\n)\n/gm;

function replaceExactly(source, pattern, replacement, label) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`${label} must occur exactly once`);
  }
  return source.replace(pattern, replacement);
}

function readAllowlist(functionSql) {
  const safeRelations = functionSql.match(
    /safe_relations constant text\[\] := array\[([\s\S]*?)\n  \];/,
  );
  if (!safeRelations) throw new Error("reviewed query relation allowlist is missing");
  return new Set(
    [...safeRelations[1].matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]),
  );
}

function assertNoUnreviewedExposure(allowlist) {
  if ([...allowlist].some((relation) => relation.startsWith("auth_"))) {
    throw new Error("authentication tables must not enter the governed query catalog");
  }
  for (const relation of CURATED_QUERY_RELATIONS) {
    if (allowlist.has(relation)) {
      throw new Error(
        `curated query relation must not take the generic select * path: ${relation}`,
      );
    }
  }
}

/**
 * A curated relation is only curated if the function actually builds it from a
 * named column list. `create view ... as select *` under a curated name is the
 * exact regression that shipped sin_encrypted to every fresh install.
 */
function assertCuratedQueryViews(functionSql) {
  for (const relation of CURATED_QUERY_RELATIONS) {
    const view = functionSql.match(
      new RegExp(
        `create view openbooks_query\\.${relation} with \\(security_barrier=true\\) as\\s*\\n`
          + `\\s*select\\s+([\\s\\S]*?)\\n\\s*from public\\.${relation}\\b`,
      ),
    );
    if (!view) {
      throw new Error(`curated query relation has no explicit view: ${relation}`);
    }
    const columns = view[1].split(",").map((column) => column.trim());
    if (columns.some((column) => column.startsWith("*"))) {
      throw new Error(`curated query relation is rebuilt with select *: ${relation}`);
    }
    const exposed = columns.filter((column) => NEVER_QUERYABLE.includes(column));
    if (exposed.length > 0) {
      throw new Error(
        `curated query view exposes a secret column: ${relation}.${exposed.join(", ")}`,
      );
    }
  }
}

function addReviewedPayrollRelations(source) {
  const functionMatch = source.match(
    /CREATE FUNCTION public\.openbooks_refresh_query_catalog\(\)[\s\S]*?\n\$_\$;/,
  );
  if (!functionMatch) throw new Error("query-catalog refresh function is missing");

  let functionSql = functionMatch[0];
  const present = readAllowlist(functionSql);
  assertNoUnreviewedExposure(present);
  assertCuratedQueryViews(functionSql);

  const missing = PAYROLL_QUERY_RELATIONS.filter((relation) => !present.has(relation));
  if (missing.length !== 0 && missing.length !== PAYROLL_QUERY_RELATIONS.length) {
    throw new Error(
      `payroll query relations are only partially reviewed: missing ${missing.join(", ")}`,
    );
  }
  if (missing.length > 0) {
    functionSql = replaceExactly(
      functionSql,
      /\n  \];/g,
      `,\n    'employee_pay_components',\n    'pay_components', 'pay_derived_rules', 'pay_run_adjustments', 'pay_runs',\n    'pay_schedules', 'pay_stub_lines', 'pay_stubs',\n    'payroll_filing_accounts', 'payroll_holidays',\n    'payroll_opening_balance_components', 'payroll_opening_balances',\n    'union_agreements', 'union_classifications',\n    'union_fringes'\n  ];`,
      "query-catalog allowlist terminator",
    );
  }

  const refreshed = readAllowlist(functionSql);
  for (const relation of PAYROLL_QUERY_RELATIONS) {
    if (!refreshed.has(relation)) {
      throw new Error(`reviewed query relation is missing: ${relation}`);
    }
  }
  assertNoUnreviewedExposure(refreshed);

  return source.replace(functionMatch[0], functionSql);
}

/**
 * Collect the hand-written prose blocks a previous baseline carries, keyed by
 * the pg_dump object header they sit under.
 */
export function extractHandwrittenAnnotations(previousBaseline) {
  const annotations = new Map();
  for (const match of previousBaseline.replace(/\r\n?/g, "\n").matchAll(ANNOTATED_OBJECT)) {
    if (annotations.has(match[1])) {
      throw new Error(`hand-written annotation anchor is ambiguous: ${match[1]}`);
    }
    annotations.set(match[1], match[2]);
  }
  return annotations;
}

function restoreHandwrittenAnnotations(source, annotations) {
  if (annotations.size === 0) return source;
  const restored = new Set();
  const annotated = source.replace(BARE_OBJECT, (whole, header, name) => {
    const annotation = annotations.get(name);
    if (annotation === undefined) return whole;
    restored.add(name);
    return `${header}${annotation}\n`;
  });
  const orphaned = [...annotations.keys()].filter((name) => !restored.has(name));
  if (orphaned.length > 0) {
    throw new Error(
      "hand-written annotation has no object in this dump; move or delete it in the "
        + `previous baseline first: ${orphaned.join("; ")}`,
    );
  }
  return annotated;
}

export function canonicalizePgDump(rawDump, { annotations = new Map() } = {}) {
  let source = rawDump.replace(/\r\n?/g, "\n");
  if (!/Dumped from database version 16\.9(?:\D|$)/.test(source)
      || !/Dumped by pg_dump version 16\.9(?:\D|$)/.test(source)) {
    throw new Error("pg_dump source and client must use the pinned PostgreSQL 16.9 image");
  }
  const settingsStart = source.indexOf("SET statement_timeout = 0;");
  if (settingsStart < 0) throw new Error("pg_dump session settings are missing");
  source = source.slice(settingsStart);

  source = source
    .replace(/^\\(?:un)?restrict .*\n/gm, "")
    .replace(/^SET row_security = off;\n\n/gm, "")
    .replace(
      /--\n-- Name: public; Type: SCHEMA; Schema: -; Owner: -\n--\n\nCREATE SCHEMA public;\n\n\n--\n-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -\n--\n\nCOMMENT ON SCHEMA public IS 'standard public schema';\n\n\n/,
      "",
    )
    .replace(/--\n-- PostgreSQL database dump complete\n--\n[\s\S]*$/, "")
    .trimEnd();

  source = replaceExactly(
    source,
    /CREATE SCHEMA openbooks_query;\n\n\n/g,
    `CREATE SCHEMA openbooks_query;\n\n\n${OPTIONAL_TRIGRAM}`,
    "openbooks_query schema declaration",
  );
  source = addReviewedPayrollRelations(source);

  const forbidden = [
    [/^\\/m, "psql meta-command"],
    [/\b(?:ALTER\s+\S+[\s\S]{0,120}\s+OWNER TO|OWNER TO)\b/i, "owner assignment"],
    [/\bCREATE DATABASE\b/i, "database creation"],
    [/\bTABLESPACE\b/i, "tablespace"],
    [/\b(?:COPY|INSERT INTO)\s+public\./i, "data statement"],
    [/\b(?:GRANT|REVOKE)[^;]*\bopenbooks_app\b/i, "runtime-role ACL"],
    [/\b(?:CREATE TABLE|ALTER TABLE)\s+(?:ONLY\s+)?public\._applied_migrations\b/i, "migration ledger DDL"],
    [/\bCREATE SCHEMA public\b/i, "public schema creation"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) throw new Error(`canonical baseline contains forbidden ${label}`);
  }

  for (const required of [
    "CREATE TABLE public.orgs",
    "CREATE TABLE public.pay_run_adjustments",
    "CREATE TABLE public.pay_runs",
    "CREATE TABLE public.auth_sessions",
    "CREATE FUNCTION public.openbooks_refresh_query_catalog()",
    "REVOKE ALL ON FUNCTION public.openbooks_refresh_query_catalog() FROM PUBLIC",
    "ALTER TABLE ONLY public.user_org_access FORCE ROW LEVEL SECURITY",
  ]) {
    if (!source.includes(required)) throw new Error(`canonical baseline is missing: ${required}`);
  }

  // Last, so hand-written prose can never satisfy a content guard above.
  source = restoreHandwrittenAnnotations(source, annotations);

  return `${HEADER}${source}\n\n\n-- Rebuild the reviewed query catalog after every canonical table exists. This\n-- also revokes any public-table grants emitted earlier in the baseline.\nSELECT public.openbooks_refresh_query_catalog();\n\n\n-- End of canonical baseline.\n`;
}

const USAGE = "usage: regenerate-canonical-baseline --dump <pg_dump.sql> --output <0001_baseline.sql>"
  + " [--annotations <previous_baseline.sql> | --no-annotations]";

function parseArguments(argv) {
  const known = new Set(["--dump", "--output", "--annotations", "--no-annotations"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!known.has(flag)) throw new Error(USAGE);
    if (values.has(flag)) throw new Error(USAGE);
    if (flag === "--no-annotations") {
      values.set(flag, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
    values.set(flag, value);
    index += 1;
  }

  const dump = values.get("--dump");
  const output = values.get("--output");
  const explicitAnnotations = values.get("--annotations");
  if (!dump || !output) throw new Error(USAGE);
  if (values.has("--no-annotations") && explicitAnnotations !== undefined) {
    throw new Error(USAGE);
  }

  return {
    dump,
    output,
    // Regenerating in place is the normal call, so the file being replaced is
    // the default source of the prose that has to survive.
    annotations: values.has("--no-annotations") ? null : explicitAnnotations ?? output,
    annotationsRequired: explicitAnnotations !== undefined,
  };
}

async function readAnnotations(path, required) {
  if (path === null) return new Map();
  let previous;
  try {
    previous = await readFile(path, "utf8");
  } catch (err) {
    if (!required && err.code === "ENOENT") return new Map();
    throw err;
  }
  return extractHandwrittenAnnotations(previous);
}

async function main() {
  const { dump, output, annotations, annotationsRequired } = parseArguments(process.argv.slice(2));
  const canonical = canonicalizePgDump(await readFile(dump, "utf8"), {
    annotations: await readAnnotations(annotations, annotationsRequired),
  });
  await writeFile(output, canonical, { encoding: "utf8", mode: 0o644 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
