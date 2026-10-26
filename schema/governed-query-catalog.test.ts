// source-pin-contract: governed query catalog secrecy and tenant-filter invariant; every view swept is derived by parsing the active baseline named in schema/migrations/baseline.json, secret/curated/global names are reviewed rule parameters
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The governed query catalog is what the report query console and user scripts
 * can read, through the `openbooks_read` role. It is built entirely by
 * `public.openbooks_refresh_query_catalog()`, which drops the whole schema and
 * rebuilds it from the `openbooks_query_catalog_relations` registry plus a
 * set of curated views — and the baseline's own last statement calls that
 * function.
 *
 * So the function and its registry, not the CREATE VIEW statements pg_dump
 * emitted above them, are the real source of truth. These tests keep the two
 * in agreement: a curated view that omits a secret column is worthless if the
 * function rebuilds the relation as `select *`, and refreshing is one function
 * call with no review step in it.
 */

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dirname, "migrations/baseline.json"), "utf8"),
) as { filename: string };
const BASELINE = readFileSync(join(import.meta.dirname, "migrations", MANIFEST.filename), "utf8");

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

/** Relations whose private text is redacted by a curated projection. */
const PRIVATE_TEXT_PROJECTIONS = ["crm_activities", "time_entries"];

/**
 * The generic relation set: every relation registered in
 * `openbooks_query_catalog_relations`, which the function rebuilds as
 * `select *` (tenant-filtered when the table has org_id).
 */
function safeRelations(): string[] {
  const inserts = [
    ...BASELINE.matchAll(
      /INSERT INTO public\.openbooks_query_catalog_relations \(relation, added_in\) VALUES\n([\s\S]*?);\n/g,
    ),
  ];
  assert.ok(
    inserts.length > 0,
    "the governed relation registry seed was not found in the baseline",
  );
  const relations = inserts.flatMap((insert) =>
    [...insert[1]!.matchAll(/^\s*\('(\w+)',/gm)].map((m) => m[1]!),
  );
  assert.ok(
    relations.length > 100,
    `expected the registry seed to govern the catalog; found ${relations.length}`,
  );
  return relations;
}

/** Every `CREATE VIEW openbooks_query.x` and the columns it selects. */
function shippedViews(): Map<string, Set<string> | "star"> {
  const views = new Map<string, Set<string> | "star">();
  const re =
    /CREATE VIEW openbooks_query\.(\w+) WITH \(security_barrier='true'\) AS\n([\s\S]*?);\n/g;
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
          .map((c) =>
            c
              .trim()
              .split(/\s+/)[0]!
              .replace(/^\w+\./, ""),
          )
          .filter(Boolean),
      ),
    );
  }
  return views;
}

/** Every `CREATE VIEW openbooks_query.x` and its full statement text. */
function shippedViewBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  const re =
    /CREATE VIEW openbooks_query\.(\w+) WITH \(security_barrier='true'\) AS\n([\s\S]*?);\n/g;
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
    "these relations take the generic `select *` path but hold a secret; " +
      `give each an explicit column list in openbooks_refresh_query_catalog(): ${leaked.join("; ")}`,
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
    "shipped view narrower than the function's `select *` — either add the " +
      `column to the view or curate the relation: ${drifted.join("; ")}`,
  );
});

test("every curated relation is granted to openbooks_read", () => {
  // A curated view that nobody can select from is a silent capability
  // regression. The function grants the whole governed schema in one
  // statement after its last curated view, and the shipped catalog carries a
  // grant for each curated view.
  const functionBody = refreshFunctionBody();
  const lastCuratedView = Math.max(
    ...MUST_BE_CURATED.map((relation) =>
      functionBody.indexOf(`create view openbooks_query.${relation} with`),
    ),
  );
  const blanketGrant = functionBody.lastIndexOf(
    "grant select on all tables in schema openbooks_query to openbooks_read;",
  );
  assert.ok(
    blanketGrant > lastCuratedView,
    "the refresh function must grant the governed schema after creating its curated views",
  );
  for (const relation of MUST_BE_CURATED) {
    assert.ok(
      functionBody.includes(`create view openbooks_query.${relation} with`),
      `${relation} must be curated by the refresh function`,
    );
    assert.ok(
      BASELINE.includes(`GRANT SELECT ON TABLE openbooks_query.${relation} TO openbooks_read;`),
      `${relation} has a curated view but the shipped catalog does not grant it`,
    );
  }
});

test("the shipped catalog carries the tenant filter", () => {
  // The baseline grants SELECT on the shipped views before its final rebuild,
  // so a shipped view without the tenant filter would be readable across
  // tenants for as long as the file takes to apply. The shipped DDL must be
  // as safe as what the function rebuilds.
  const views = shippedViewBodies();
  assert.ok(
    views.size > 100,
    `expected the baseline to ship the governed catalog; found ${views.size}`,
  );
  const unfiltered = [...views]
    .filter(([, body]) => !body.includes("org_id = public.openbooks_query_org_id()"))
    .map(([relation]) => relation)
    .sort();

  assert.deepEqual(
    unfiltered,
    [...GLOBAL_RELATIONS].sort(),
    "a governed view ships without `where org_id = openbooks_query_org_id()`. " +
      "Add the filter and regenerate the baseline",
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

test("the catalog redacts private CRM bodies and time memos", () => {
  // These relations must stay off the generic `select *` path. Otherwise any
  // later catalog refresh would silently restore the private text projection.
  const generic = safeRelations();
  for (const relation of PRIVATE_TEXT_PROJECTIONS) {
    assert.ok(
      !generic.includes(relation),
      `${relation} must not be registered for the generic path`,
    );
  }

  // The curated definitions retain the row, tenant key, privacy flag, and
  // all public reporting columns while replacing only private text with NULL.
  const functionBody = refreshFunctionBody();
  assert.match(
    functionBody,
    /create view openbooks_query\.crm_activities[\s\S]*?case when is_private then null else body end as body[\s\S]*?is_private[\s\S]*?where org_id = public\.openbooks_query_org_id\(\)/i,
  );
  assert.match(
    functionBody,
    /create view openbooks_query\.time_entries[\s\S]*?case when memo_is_private then null else memo end as memo[\s\S]*?memo_is_private[\s\S]*?where org_id = public\.openbooks_query_org_id\(\)/i,
  );

  // The shipped views redact the same way before the final rebuild runs.
  const shipped = shippedViewBodies();
  assert.match(
    shipped.get("crm_activities") ?? "",
    /CASE\s+WHEN is_private THEN NULL::text\s+ELSE body\s+END AS body/,
  );
  assert.match(
    shipped.get("time_entries") ?? "",
    /CASE\s+WHEN memo_is_private THEN NULL::text\s+ELSE memo\s+END AS memo/,
  );
});
