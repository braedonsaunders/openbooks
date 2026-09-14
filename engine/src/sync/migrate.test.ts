import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withOrg } from "../db.ts";
import { loadEntities } from "./migrate.ts";
import type { MigrationSource } from "./source.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";

const DB = !!env.OPENBOOKS_DB_URL;

test(
  "master-data row upsert failures are reported separately with their source error",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const source: MigrationSource = {
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
      const stats = await withOrg(org.orgId, () =>
        loadEntities(
          source,
          org.orgId,
          null,
          undefined,
          undefined,
          [
            {
              resource: "items",
              records: [
                {
                  sourceRef: "broken-item",
                  fields: {
                    name: "Broken item",
                    kind: "service",
                    defaultCost: "not-a-decimal",
                  },
                },
                {
                  sourceRef: "good-item",
                  fields: { name: "Good item", kind: "service" },
                },
              ],
            },
          ],
        ),
      );

      assert.deepEqual(stats.items, {
        created: 1,
        updated: 0,
        skipped: 0,
        failed: 1,
        errors: [
          {
            sourceRef: "broken-item",
            message: "item default cost must be an exact decimal",
          },
        ],
      });
      const landed = await withOrg(org.orgId, () =>
        db.execute<{ sourceRef: string }>(sql`
          select custom->>'migrationTest' as "sourceRef"
            from items
           where org_id = ${org.orgId}
             and custom->>'migrationTest' = 'good-item'
        `),
      );
      assert.deepEqual(landed.rows, [{ sourceRef: "good-item" }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "master-data mirror updates persist instead of failing on connector identity",
  { skip: !DB },
  async () => {
    // Every mirror re-upserts master data it already landed. The subsidiary,
    // payment-term, tax-code, and party update paths merge the connector
    // identity back into custom with jsonb_build_object — with both key and
    // value as untyped bound parameters, PostgreSQL cannot infer a type and
    // rejects the write, so every one of those updates lands in failed++
    // while the run reports success. (Tax-code coverage rides with the rate-
    // window tests below, which exercise the same update path.)
    const org = await createScratchOrg();
    try {
      const source: MigrationSource = {
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
      await withOrg(org.orgId, () => db.execute(sql`
        insert into subsidiaries (org_id, parent_id, name, base_currency, country, custom)
        values (${org.orgId}, ${org.subsidiaryId}, 'Old Sub', 'CAD', 'CA',
                '{"migrationTest": "SUB-1"}'::jsonb)
      `));
      await withOrg(org.orgId, () => db.execute(sql`
        insert into parties (org_id, kind, display_name, custom)
        values (${org.orgId}, 'company', 'Old Party', '{"migrationTest": "PTY-1"}'::jsonb)
      `));
      await withOrg(org.orgId, () => db.execute(sql`
        insert into payment_terms (org_id, name, net_days, custom)
        values (${org.orgId}, 'Old Term', 30, '{"migrationTest": "TRM-1"}'::jsonb)
      `));
      const stats = await withOrg(org.orgId, () =>
        loadEntities(source, org.orgId, null, undefined, undefined, [
          {
            resource: "subsidiaries",
            records: [
              { sourceRef: "SUB-1", fields: { name: "New Sub", baseCurrency: "CAD", country: "CA" } },
            ],
          },
          {
            resource: "parties",
            records: [
              { sourceRef: "PTY-1", fields: { displayName: "New Party", kind: "company" } },
            ],
          },
          {
            resource: "payment_terms",
            records: [
              { sourceRef: "TRM-1", fields: { name: "New Term", netDays: 45 } },
            ],
          },
        ]),
      );
      assert.deepEqual(
        [stats.subsidiaries?.updated, stats.parties?.updated, stats.payment_terms?.updated],
        [1, 1, 1],
      );
      assert.deepEqual(
        [stats.subsidiaries?.failed, stats.parties?.failed, stats.payment_terms?.failed],
        [0, 0, 0],
      );
      const names = await withOrg(org.orgId, () => db.execute<{ name: string }>(sql`
        select name from subsidiaries where org_id = ${org.orgId} and custom->>'migrationTest' = 'SUB-1'
        union all
        select display_name as name from parties where org_id = ${org.orgId} and custom->>'migrationTest' = 'PTY-1'
        union all
        select name from payment_terms where org_id = ${org.orgId} and custom->>'migrationTest' = 'TRM-1'
      `));
      assert.deepEqual(names.rows.map((row) => row.name).sort(), ["New Party", "New Sub", "New Term"]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
