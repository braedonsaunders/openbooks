import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The governed query catalog is what the report query console and user scripts
 * can read, through the `openbooks_read` role. It is built entirely by
 * `public.openbooks_refresh_query_catalog()`, which drops the whole schema and
 * rebuilds it — and the baseline's own last statement calls that function.
 *
 * So the function, not the CREATE VIEW statements pg_dump emitted above it, is
 * the real source of truth. These tests exist because those two drifted apart
 * once already: `employee_payroll_profiles` shipped a curated view that omitted
 * `sin_encrypted`, while the function rebuilt it as `select *` and exposed the
 * sealed SIN ciphertext on every fresh install.
 *
 * The function's own comment used to argue that freezing `select *` at create
 * time made a later secret column safe "until this reviewed allowlist is
 * deliberately refreshed". That is the reasoning that failed: refreshing is one
 * function call with no review step in it.
 */

const BASELINE = readFileSync(
  join(import.meta.dirname, "migrations/generated/0001_baseline.sql"),
  "utf8",
);

/** Columns that must never be readable through the governed catalog. */
const NEVER_QUERYABLE = [
  "sin_encrypted",
  "tin_encrypted",
  "account_number_encrypted",
  "password_encrypted",
  "password_hash",
  "secret_encrypted",
  "originator_secrets_encrypted",
  "reseal_secret",
  "birth_date",
];

/** Relations that hold a secret and therefore need an explicit column list. */
const MUST_BE_CURATED = [
  "parties",
  "party_bank_accounts",
  "vendor_roles",
  "employee_payroll_profiles",
  "employee_roles",
];

function safeRelations(): string[] {
  const start = BASELINE.indexOf("safe_relations constant text[] := array[");
  assert.notEqual(start, -1, "safe_relations array not found in the baseline");
  const body = BASELINE.slice(start, BASELINE.indexOf("];", start));
  return [...body.matchAll(/'(\w+)'/g)].map((m) => m[1]!);
}

/** Every `CREATE VIEW openbooks_query.x` and the columns it selects. */
function shippedViews(): Map<string, Set<string> | "star"> {
  const views = new Map<string, Set<string> | "star">();
  const re = /CREATE VIEW openbooks_query\.(\w+) WITH \(security_barrier='true'\) AS\n([\s\S]*?);\n/g;
  for (const match of BASELINE.matchAll(re)) {
    const select = match[2]!.split(/\n\s*FROM /i)[0]!;
    if (/^\s*SELECT \*/i.test(select)) {
      views.set(match[1]!, "star");
      continue;
    }
    views.set(
      match[1]!,
      new Set(
        select
          .replace(/^\s*SELECT\s+/i, "")
          .split(",")
          .map((c) => c.trim().split(/\s+/)[0]!.replace(/^\w+\./, ""))
          .filter(Boolean),
      ),
    );
  }
  return views;
}

function baseTables(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const re = /CREATE TABLE public\.(\w+) \(\n([\s\S]*?)\n\);\n/g;
  for (const match of BASELINE.matchAll(re)) {
    // pg_dump emits every column before the first table CONSTRAINT, and it
    // wraps a CHECK containing a CASE expression across several lines whose
    // continuations (CASE / WHEN … / ELSE … / END) look exactly like column
    // definitions. Stop at the first CONSTRAINT rather than filtering line by
    // line, or those keywords are read as columns the shipped view "omits".
    const body = match[2]!.split("\n");
    const firstConstraint = body.findIndex((l) => /^\s*CONSTRAINT/i.test(l));
    tables.set(
      match[1]!,
      (firstConstraint === -1 ? body : body.slice(0, firstConstraint))
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.split(/\s+/)[0]!)
        .filter((c) => /^\w+$/.test(c)),
    );
  }
  return tables;
}

test("no secret column is readable through the governed query catalog", () => {
  const views = shippedViews();
  const offenders: string[] = [];
  for (const [relation, columns] of views) {
    if (columns === "star") continue;
    for (const secret of NEVER_QUERYABLE) {
      if (columns.has(secret)) offenders.push(`openbooks_query.${relation}.${secret}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `secret columns exposed to openbooks_read: ${offenders.join(", ")}`,
  );
});

test("a relation holding a secret is curated, never in the generic allowlist", () => {
  const safe = safeRelations();
  const tables = baseTables();
  const leaked: string[] = [];

  // The named ones, explicitly.
  for (const relation of MUST_BE_CURATED) {
    if (safe.includes(relation)) leaked.push(`${relation} (named)`);
  }

  // And anything that grows a secret column later, so a new table is caught
  // without anyone remembering to extend MUST_BE_CURATED.
  for (const relation of safe) {
    const columns = tables.get(relation);
    if (!columns) continue;
    const secrets = columns.filter((c) => NEVER_QUERYABLE.includes(c));
    if (secrets.length > 0) leaked.push(`${relation} (holds ${secrets.join(", ")})`);
  }

  assert.deepEqual(
    leaked,
    [],
    "these relations take the generic `select *` path but hold a secret; "
      + `give each an explicit column list in openbooks_refresh_query_catalog(): ${leaked.join("; ")}`,
  );
});

test("the function and the shipped views agree on every generic relation", () => {
  // A relation on the generic path is rebuilt as `select *`, so its shipped
  // view MUST list every base column. A shipped view that omits one is a view
  // the function will silently widen the next time it runs — which is exactly
  // how the sin_encrypted exposure was introduced and then hidden.
  const views = shippedViews();
  const tables = baseTables();
  const drifted: string[] = [];
  for (const relation of safeRelations()) {
    const view = views.get(relation);
    const columns = tables.get(relation);
    if (!view || view === "star" || !columns) continue;
    const missing = columns.filter((c) => !view.has(c));
    if (missing.length > 0) drifted.push(`${relation} omits ${missing.join(", ")}`);
  }
  assert.deepEqual(
    drifted,
    [],
    "shipped view narrower than the function's `select *` — either add the "
      + `column to the view or curate the relation: ${drifted.join("; ")}`,
  );
});

test("every curated relation is granted to openbooks_read", () => {
  // A curated view that nobody can select from is a silent capability
  // regression; the grant loop at the end of the function must name it.
  const start = BASELINE.indexOf("foreach relation_name in array array[", BASELINE.indexOf("create view openbooks_query.parties"));
  const grantBlock = BASELINE.slice(start, BASELINE.indexOf("] loop", start));
  for (const relation of MUST_BE_CURATED) {
    assert.ok(
      grantBlock.includes(`'${relation}'`),
      `${relation} has a curated view but is missing from the grant loop`,
    );
  }
});
