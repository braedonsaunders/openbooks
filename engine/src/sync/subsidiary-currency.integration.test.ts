/**
 * A source subsidiary changing functional currency must not be restated
 * silently.
 *
 * base_currency is read by billing, inventory, asset lifecycle, and tax, so
 * overwriting it reinterprets what past postings mean. The loader used to
 * apply the source currency unconditionally (updated 1, no failure, no
 * audit): a CAD→USD flip landed green and every translated historical
 * balance shifted with it.
 *
 * These cases pin the hold contract: the first load adopts the source
 * currency (including onto the reused posting root, which starts life with
 * the org's own currency and no connector identity), but a later change
 * keeps the stored currency, still converges the descriptive fields, and
 * reports the held change as a named row failure for controller review.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withOrg } from "../db.ts";
import { loadEntities } from "./migrate.ts";
import type { MigrationSource } from "./source.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";

const DB = !!env.OPENBOOKS_DB_URL;

function source(): MigrationSource {
  return {
    name: "migration-test",
    refKey: "migrationTest",
    baseCurrency: "CAD",
    accountingPeriods: async () => [],
    entities: async () => [],
    nativeChanges: async () => {
      throw new Error("not used by this test");
    },
    trialBalance: async () => [],
    monthlyActivity: async () => [],
  };
}

async function currencyOf(orgId: string, ref: string): Promise<string | null> {
  const [row] = (await withOrg(orgId, () => db.execute<{ base_currency: string }>(sql`
    select base_currency from subsidiaries
     where org_id = ${orgId} and custom->>'migrationTest' = ${ref}`))).rows;
  return row?.base_currency ?? null;
}

test(
  "a source functional-currency change is held and reported, not restated",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const src = source();
      const stream = (childCurrency: string, childName: string) => [
        {
          resource: "subsidiaries",
          records: [
            { sourceRef: "SUB-PARENT", fields: { name: "Parent", baseCurrency: "CAD", country: "CA" } },
            { sourceRef: "SUB-FX", parentRef: "SUB-PARENT", fields: { name: childName, baseCurrency: childCurrency, country: "CA" } },
          ],
        },
      ];
      await withOrg(org.orgId, () =>
        loadEntities(src, org.orgId, null, undefined, undefined, stream("CAD", "Fx Sub")),
      );
      assert.equal(await currencyOf(org.orgId, "SUB-FX"), "CAD");

      const stats = await withOrg(org.orgId, () =>
        loadEntities(src, org.orgId, null, undefined, undefined, stream("USD", "Fx Sub Renamed")),
      );
      assert.equal(
        await currencyOf(org.orgId, "SUB-FX"),
        "CAD",
        "the stored functional currency survives the source flip",
      );
      assert.equal(stats.subsidiaries?.failed, 1);
      assert.match(
        stats.subsidiaries?.errors[0]?.message ?? "",
        /SUB-FX.*CAD → USD/,
        "the held change names the source ref and both currencies",
      );
      const [renamed] = (await withOrg(org.orgId, () => db.execute<{ name: string }>(sql`
        select name from subsidiaries
         where org_id = ${org.orgId} and custom->>'migrationTest' = 'SUB-FX'`))).rows;
      assert.equal(
        renamed?.name,
        "Fx Sub Renamed",
        "descriptive fields still converge while the currency is held",
      );
      assert.equal(
        await currencyOf(org.orgId, "SUB-PARENT"),
        "CAD",
        "the untouched parent is unaffected",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "first load adopts the source currency onto the reused root",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const src = source();
      const stats = await withOrg(org.orgId, () =>
        loadEntities(src, org.orgId, null, undefined, undefined, [
          {
            resource: "subsidiaries",
            records: [
              { sourceRef: "SUB-ROOT", fields: { name: "Root Co", baseCurrency: "USD", country: "US" } },
            ],
          },
        ]),
      );
      assert.equal(await currencyOf(org.orgId, "SUB-ROOT"), "USD");
      assert.equal(stats.subsidiaries?.failed ?? 0, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
