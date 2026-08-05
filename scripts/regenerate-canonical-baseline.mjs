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
 *   --restrict-key=OPENBOOKS_CANONICAL_BASELINE_V1
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

const PAYROLL_QUERY_RELATIONS = Object.freeze([
  "pay_schedules",
  "pay_components",
  "employee_payroll_profiles",
  "employee_pay_components",
  "pay_runs",
  "pay_stubs",
  "pay_stub_lines",
  "payroll_opening_balances",
  "union_agreements",
  "union_classifications",
  "union_fringes",
]);

function replaceExactly(source, pattern, replacement, label) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`${label} must occur exactly once`);
  }
  return source.replace(pattern, replacement);
}

function addReviewedPayrollRelations(source) {
  const functionMatch = source.match(
    /CREATE FUNCTION public\.openbooks_refresh_query_catalog\(\)[\s\S]*?\n\$_\$;/,
  );
  if (!functionMatch) throw new Error("query-catalog refresh function is missing");

  let functionSql = functionMatch[0];
  const safeRelations = functionSql.match(
    /safe_relations constant text\[\] := array\[([\s\S]*?)\n  \];/,
  );
  if (!safeRelations) throw new Error("reviewed query relation allowlist is missing");

  const present = new Set(
    [...safeRelations[1].matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]),
  );
  if ([...present].some((relation) => relation.startsWith("auth_"))) {
    throw new Error("authentication tables must not enter the governed query catalog");
  }
  const missing = PAYROLL_QUERY_RELATIONS.filter((relation) => !present.has(relation));
  if (missing.length !== 0 && missing.length !== PAYROLL_QUERY_RELATIONS.length) {
    throw new Error("payroll query relations are only partially reviewed");
  }
  if (missing.length > 0) {
    functionSql = replaceExactly(
      functionSql,
      /\n  \];/g,
      `,\n    'employee_pay_components', 'employee_payroll_profiles',\n    'pay_components', 'pay_runs', 'pay_schedules', 'pay_stub_lines', 'pay_stubs',\n    'payroll_opening_balances', 'union_agreements', 'union_classifications',\n    'union_fringes'\n  ];`,
      "query-catalog allowlist terminator",
    );
  }

  const refreshedAllowlist = functionSql.match(
    /safe_relations constant text\[\] := array\[([\s\S]*?)\n  \];/,
  )?.[1] ?? "";
  for (const relation of PAYROLL_QUERY_RELATIONS) {
    if (!new RegExp(`'${relation}'`).test(refreshedAllowlist)) {
      throw new Error(`reviewed query relation is missing: ${relation}`);
    }
  }
  if (/'auth_[a-z0-9_]+'/.test(refreshedAllowlist)) {
    throw new Error("authentication tables must not enter the governed query catalog");
  }

  return source.replace(functionMatch[0], functionSql);
}

export function canonicalizePgDump(rawDump) {
  let source = rawDump.replace(/\r\n?/g, "\n");
  if (!source.includes("\\restrict OPENBOOKS_CANONICAL_BASELINE_V1")
      || !source.includes("\\unrestrict OPENBOOKS_CANONICAL_BASELINE_V1")) {
    throw new Error("pg_dump must use the canonical deterministic restrict key");
  }
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
    "CREATE TABLE public.pay_runs",
    "CREATE TABLE public.auth_sessions",
    "CREATE FUNCTION public.openbooks_refresh_query_catalog()",
    "REVOKE ALL ON FUNCTION public.openbooks_refresh_query_catalog() FROM PUBLIC",
    "ALTER TABLE ONLY public.user_org_access FORCE ROW LEVEL SECURITY",
  ]) {
    if (!source.includes(required)) throw new Error(`canonical baseline is missing: ${required}`);
  }

  return `${HEADER}${source}\n\n\n-- Rebuild the reviewed query catalog after every canonical table exists. This\n-- also revokes any public-table grants emitted earlier in the baseline.\nSELECT public.openbooks_refresh_query_catalog();\n\n\n-- End of canonical baseline.\n`;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("usage: regenerate-canonical-baseline --dump <pg_dump.sql> --output <0001_baseline.sql>");
    }
    values.set(flag, value);
  }
  const dump = values.get("--dump");
  const output = values.get("--output");
  if (!dump || !output || values.size !== 2) {
    throw new Error("usage: regenerate-canonical-baseline --dump <pg_dump.sql> --output <0001_baseline.sql>");
  }
  return { dump, output };
}

async function main() {
  const { dump, output } = parseArguments(process.argv.slice(2));
  const canonical = canonicalizePgDump(await readFile(dump, "utf8"));
  await writeFile(output, canonical, { encoding: "utf8", mode: 0o644 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
