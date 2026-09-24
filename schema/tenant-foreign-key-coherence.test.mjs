// source-pin-contract: baseline tenant-anchor FK coherence; every edge swept is derived by parsing 0001_baseline.sql, anchor names are reviewed parameters
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const baseline = readFileSync(
  "schema/migrations/generated/0001_baseline.sql",
  "utf8",
);

// The tenant-owned anchors whose ids are used throughout financial, setup,
// inventory, payroll, and operational records. Reviewed architecture, not a
// census: the sweep below derives every edge into them and asserts the
// coherence rules, so a new anchor table arrives with its own reviewed
// migration and joins this set deliberately. Live enforcement of the same
// rules is proven against the migrated database by the ledger
// cross-organization refusals (engine/src/ledger/kernel-constraints) and the
// recognition-event tenant integrity suite; the published migration bytes
// themselves are protected by the bootstrap digest check.
const ANCHORS = Object.freeze([
  "accounts",
  "parties",
  "documents",
  "journal_entries",
  "journal_lines",
  "subsidiaries",
  "projects",
  "departments",
  "locations",
  "classes",
  "items",
  "tax_codes",
  "tax_groups",
]);

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

test("every baseline anchor edge is enumerated with one justified exception", () => {
  const tables = parseTables(baseline);
  const anchors = new Set(ANCHORS);
  const graph = parseForeignKeys(baseline).filter(
    (foreignKey) =>
      anchors.has(foreignKey.parentTable) &&
      foreignKey.childColumns.length === 1 &&
      foreignKey.parentColumns.length === 1 &&
      foreignKey.parentColumns[0] === "id",
  );

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

});
