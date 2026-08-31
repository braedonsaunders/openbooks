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
