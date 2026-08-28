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
const PRIVATE_PROJECTION_MIGRATION = readFileSync(
  join(import.meta.dirname, "migrations/generated/0070_governed_query_private_projection.sql"),
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

/**
 * Relations the catalog exposes without a tenant filter on purpose: they hold
 * no `org_id` and are reviewed as global reference data. Every other governed
 * view must carry `where org_id = public.openbooks_query_org_id()`.
 */
const GLOBAL_RELATIONS = ["currencies"];

/**
 * Payroll views that the baseline once emitted WITHOUT the tenant filter while
 * the refresh function built them with it. The file has since been rebaselined
 * from a dump of the database it builds, so the list is empty and must stay
 * that way — see "the shipped catalog carries the tenant filter" below.
 */
const KNOWN_UNFILTERED_STALE_VIEWS: string[] = [];

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

/** Every `CREATE VIEW openbooks_query.x` and its full statement text. */
function shippedViewBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  const re = /CREATE VIEW openbooks_query\.(\w+) WITH \(security_barrier='true'\) AS\n([\s\S]*?);\n/g;
  for (const match of BASELINE.matchAll(re)) bodies.set(match[1]!, match[2]!);
  return bodies;
}

/** The body of `openbooks_refresh_query_catalog()`, the real source of truth. */
function refreshFunctionBody(): string {
  const body = BASELINE.match(
    /CREATE FUNCTION public\.openbooks_refresh_query_catalog\(\)[\s\S]*?\n\$_\$;/,
  )?.[0];
  assert.ok(body, "openbooks_refresh_query_catalog() not found in the baseline");
  return body;
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

test("the shipped catalog carries the tenant filter", () => {
  // Twelve payroll views used to ship with no `where org_id = ...` while the
  // refresh function built them with it. That was survivable only because the
  // baseline's last statement drops the schema and rebuilds — but the file
  // reaches `GRANT SELECT ... TO openbooks_read` on the unfiltered forms
  // first, so the whole safety argument rested on statement order. The file
  // has been rebaselined; this keeps it that way.
  const unfiltered = [...shippedViewBodies()]
    .filter(([, body]) => !body.includes("org_id = public.openbooks_query_org_id()"))
    .map(([relation]) => relation)
    .sort();

  assert.deepEqual(
    unfiltered,
    [...GLOBAL_RELATIONS, ...KNOWN_UNFILTERED_STALE_VIEWS].sort(),
    "a governed view ships without `where org_id = openbooks_query_org_id()`. "
      + "Add the filter and regenerate the baseline — KNOWN_UNFILTERED_STALE_VIEWS "
      + "is spent and must not be reopened",
  );
});

test("the function tenant-filters every relation it rebuilds", () => {
  // The shipped DDL above is transient: the function drops the schema and
  // rebuilds it, so the function is what a live database actually gets. Both
  // routes must filter, or the catalog leaks across tenants.
  const tables = baseTables();
  const functionBody = refreshFunctionBody();
  const unprotected: string[] = [];

  for (const relation of safeRelations()) {
    if (GLOBAL_RELATIONS.includes(relation)) continue;
    // The generic path filters whenever the base table has org_id, and raises
    // for a relation that has neither org_id nor global review.
    if (!(tables.get(relation) ?? []).includes("org_id")) unprotected.push(relation);
  }
  for (const relation of MUST_BE_CURATED) {
    const curated = new RegExp(
      `create view openbooks_query\\.${relation} with[\\s\\S]*?org_id = public\\.openbooks_query_org_id\\(\\)`,
    ).test(functionBody);
    if (!curated) unprotected.push(`${relation} (curated)`);
  }

  assert.deepEqual(
    unprotected,
    [],
    `the refresh function does not tenant-filter these: ${unprotected.join(", ")}`,
  );
});

test("the function's global relations are exactly the reviewed ones", () => {
  const declared = refreshFunctionBody().match(
    /global_relations constant text\[\] := array\[([\s\S]*?)\];/,
  )?.[1];
  assert.ok(declared, "global_relations array not found in the refresh function");
  assert.deepEqual(
    [...declared.matchAll(/'(\w+)'/g)].map((m) => m[1]!).sort(),
    [...GLOBAL_RELATIONS].sort(),
    "a relation was added to the unfiltered global path without review",
  );
});

test("the refresh call is the baseline's final statement", () => {
  // Load-bearing. The baseline grants SELECT on every governed view to
  // openbooks_read before this call; the rebuild is what re-derives them from
  // the reviewed function. Any statement appended after it would ship whatever
  // pg_dump happened to emit.
  const statements = BASELINE.replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  assert.equal(
    statements.at(-1),
    "SELECT public.openbooks_refresh_query_catalog()",
    "the baseline must end by rebuilding the governed query catalog",
  );
});

test("forward catalog migration redacts private CRM bodies and time memos", () => {
  // These relations must leave the generic SELECT * allowlist. Otherwise any
  // later catalog refresh would silently restore the private text projection.
  const safeRelationsBody = PRIVATE_PROJECTION_MIGRATION.match(
    /safe_relations constant text\[\] := array\[([\s\S]*?)\n  \];/,
  )?.[1];
  assert.ok(safeRelationsBody, "0070 safe_relations array not found");
  assert.doesNotMatch(safeRelationsBody, /'crm_activities'/);
  assert.doesNotMatch(safeRelationsBody, /'time_entries'/);

  // The curated definitions retain the row, tenant key, privacy flag, and
  // all public reporting columns while replacing only private text with NULL.
  assert.match(
    PRIVATE_PROJECTION_MIGRATION,
    /create view openbooks_query\.crm_activities[\s\S]*?case when is_private then null else body end as body[\s\S]*?is_private[\s\S]*?where org_id = public\.openbooks_query_org_id\(\)/i,
  );
  assert.match(
    PRIVATE_PROJECTION_MIGRATION,
    /create view openbooks_query\.time_entries[\s\S]*?case when memo_is_private then null else memo end as memo[\s\S]*?memo_is_private[\s\S]*?where org_id = public\.openbooks_query_org_id\(\)/i,
  );
  assert.match(
    PRIVATE_PROJECTION_MIGRATION,
    /select public\.openbooks_refresh_query_catalog\(\);\s*$/i,
  );
});
