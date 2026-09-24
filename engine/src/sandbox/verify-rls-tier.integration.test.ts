import assert from "node:assert/strict";
import test from "node:test";
import { cloneTierVerificationTables } from "./verify-rls.ts";
import { CUSTOMIZATION_LAYER, selectCloneTables } from "./clone.ts";
import { loadCatalog } from "./catalog.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * C-40: the isolation proof must cover exactly the tables the clone tier
 * actually copied, derived from the clone plan. The old fixed trio
 * (journal_lines, accounts, accounting_periods) is never copied on a dev
 * tier, so proving those tables proved nothing while production counts kept
 * the total positive.
 *
 * These tests derive the sets from the live catalog the clone itself uses:
 * a dev tier carries the customization layer plus the legal-entity tree and
 * no ledger table; the full tier carries the ledger. Every verified table
 * is org-scoped (RLS-subject).
 */
test("dev-tier verification set is the copied customization layer, never the ledger", { skip: !DB }, async () => {
  const tables = await cloneTierVerificationTables("dev");
  assert.ok(tables.length > 0, "a dev tier must verify a non-empty table set");
  for (const ledger of ["journal_lines", "journal_entries", "accounts", "accounting_periods", "documents"]) {
    assert.ok(!tables.includes(ledger), `dev tier never copies ${ledger}, so it must not be verified`);
  }
  assert.ok(tables.includes("subsidiaries"), "dev copies the legal-entity tree for role scope targets");
  assert.ok(
    tables.includes("saved_reports"),
    "dev copies the customization layer (saved_reports is a member)",
  );
  for (const name of tables) {
    assert.ok(
      CUSTOMIZATION_LAYER.has(name) || name === "subsidiaries",
      `dev verifies only what it copies: ${name} is outside the customization layer plus subsidiaries`,
    );
  }
});

test("full-tier verification set carries the ledger", { skip: !DB }, async () => {
  const tables = await cloneTierVerificationTables("full");
  for (const ledger of ["journal_lines", "journal_entries", "accounts", "accounting_periods"]) {
    assert.ok(tables.includes(ledger), `full tier copies ${ledger}, so it must be verified`);
  }
  assert.ok(
    tables.length > (await cloneTierVerificationTables("dev")).length,
    "the full tier must verify strictly more than dev",
  );
});

test("every verified table is org-scoped", { skip: !DB }, async () => {
  const cat = await loadCatalog();
  const byName = new Map(cat.tables.map((table) => [table.name, table]));
  for (const tier of ["dev", "full", "masked", "as_of"] as const) {
    for (const name of await cloneTierVerificationTables(tier)) {
      assert.equal(byName.get(name)?.hasOrgId, true, `${name} (tier ${tier}) must be RLS-subject`);
    }
  }
});

test("selectCloneTables mirrors the clone plan per tier", () => {
  const tables = [
    { name: "journal_lines", hasOrgId: true },
    { name: "subsidiaries", hasOrgId: true },
    { name: "saved_reports", hasOrgId: true },
    { name: "feature_flags", hasOrgId: false },
  ].map((row) => ({
    ...row,
    hasId: true,
    columns: [],
    fks: {},
    fkDeleteRules: {},
    hardFks: {},
    forceRebase: new Set<string>(),
  }));
  assert.deepEqual(
    selectCloneTables(tables, "dev").map((table) => table.name).sort(),
    ["saved_reports", "subsidiaries"],
  );
  assert.deepEqual(
    selectCloneTables(tables, "full").map((table) => table.name).sort(),
    ["feature_flags", "journal_lines", "saved_reports", "subsidiaries"],
  );
  assert.deepEqual(
    selectCloneTables(tables, "full", new Set(["journal_lines"])).map((table) => table.name),
    ["journal_lines"],
  );
});
