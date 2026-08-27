import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const baseline = readFileSync(
  "schema/migrations/generated/0001_baseline.sql",
  "utf8",
);
const migration = readFileSync(
  "schema/migrations/generated/0044_tenant_foreign_key_org_coherence.sql",
  "utf8",
);

// These are the tenant-owned anchors whose ids are used throughout financial,
// setup, inventory, payroll, and operational records.  Keep this inventory
// explicit: an unreviewed new anchor must fail this regression instead of
// silently becoming an unguarded single-column edge.
const ANCHOR_COUNTS = Object.freeze({
  accounts: 56,
  parties: 49,
  documents: 26,
  journal_entries: 20,
  journal_lines: 4,
  subsidiaries: 34,
  projects: 19,
  departments: 16,
  locations: 9,
  classes: 6,
  items: 19,
  tax_codes: 9,
  tax_groups: 2,
});

// tax_group_members is intentionally org-less.  Its two tenant-owned parents
// are pinned together by the migration's deferrable constraint trigger.
const ORGLESS_EXCEPTIONS = Object.freeze({
  tax_group_members: new Set([
    "tax_group_members_tax_code_id_fkey",
    "tax_group_members_tax_group_id_fkey",
  ]),
});

function parseTables(source) {
  const tables = new Map();
  const tablePattern = /CREATE TABLE public\.([a-z0-9_]+) \(([^]*?)\);/g;
  for (const match of source.matchAll(tablePattern)) {
    tables.set(match[1], match[2]);
  }
  return tables;
}

function parseForeignKeys(source) {
  const foreignKeys = [];
  const constraintPattern =
    /ALTER TABLE ONLY public\.([a-z0-9_]+)\s+ADD CONSTRAINT ([a-z0-9_]+) FOREIGN KEY \(([^)]+)\) REFERENCES public\.([a-z0-9_]+)\(([^)]+)\)([^;]*);/gs;
  for (const match of source.matchAll(constraintPattern)) {
    foreignKeys.push({
      childTable: match[1],
      name: match[2],
      childColumns: match[3].replaceAll(" ", "").split(","),
      parentTable: match[4],
      parentColumns: match[5].replaceAll(" ", "").split(","),
      options: match[6].trim(),
    });
  }
  return foreignKeys;
}

test("the effective tenant-anchor graph is enumerated with one justified exception", () => {
  const tables = parseTables(baseline);
  const anchors = new Set(Object.keys(ANCHOR_COUNTS));
  const graph = parseForeignKeys(baseline).filter(
    (foreignKey) =>
      anchors.has(foreignKey.parentTable) &&
      foreignKey.childColumns.length === 1 &&
      foreignKey.parentColumns.length === 1 &&
      foreignKey.parentColumns[0] === "id",
  );

  assert.equal(
    graph.length,
    Object.values(ANCHOR_COUNTS).reduce((sum, count) => sum + count, 0),
    "the reviewed baseline graph must not silently shrink or grow",
  );
  const counts = Object.fromEntries(
    [...anchors].map((anchor) => [
      anchor,
      graph.filter((foreignKey) => foreignKey.parentTable === anchor).length,
    ]),
  );
  assert.deepEqual(counts, ANCHOR_COUNTS);

  const orgless = graph.filter(
    (foreignKey) => !/\borg_id\b/.test(tables.get(foreignKey.childTable) ?? ""),
  );
  assert.deepEqual(
    orgless.map((foreignKey) => foreignKey.childTable),
    ["tax_group_members", "tax_group_members"],
  );
  assert.deepEqual(
    new Set(orgless.map((foreignKey) => foreignKey.name)),
    ORGLESS_EXCEPTIONS.tax_group_members,
  );
  assert.equal(
    graph.filter(
      (foreignKey) =>
        /\borg_id\b/.test(tables.get(foreignKey.childTable) ?? "") &&
        !/\borg_id\s+uuid[^\n,]*NOT NULL/i.test(
          tables.get(foreignKey.childTable) ?? "",
        ),
    ).length,
    0,
    "every non-exception child must have a required organization key",
  );

  const migrationAnchors = [...migration.matchAll(/'([a-z_]+)'/g)]
    .map((match) => match[1])
    .filter((table) => anchors.has(table));
  assert.deepEqual(
    new Set(migrationAnchors),
    anchors,
    "the forward migration must name every reviewed tenant anchor",
  );
});

test("the forward migration preflights and converts the graph at the storage boundary", () => {
  assert.match(migration, /DO \$preflight\$/);
  assert.match(migration, /legacy data violates tenant coherence/i);
  assert.match(migration, /p\.org_id IS DISTINCT FROM c\.org_id/);
  assert.match(migration, /pg_catalog\.pg_constraint/);
  assert.match(migration, /cardinality\(constraint_row\.conkey\) = 1/);
  assert.match(migration, /FOREIGN KEY \(org_id, %3\$I\)/);
  assert.match(migration, /REFERENCES public\.%4\$I \(org_id, %5\$I\)/);
  assert.match(migration, /VALIDATE CONSTRAINT/);
  assert.match(migration, /tax_group_members_tenant_coherence_guard/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER tax_group_members_tenant_coherence_trigger/);
  assert.match(migration, /DEFERRABLE INITIALLY IMMEDIATE/);
  assert.match(migration, /SET NULL \(%I\)/);
  assert.doesNotMatch(
    migration,
    /^\s*(?:UPDATE|DELETE\s+FROM)\b/im,
    "legacy financial evidence must never be rewritten by the migration",
  );
});
