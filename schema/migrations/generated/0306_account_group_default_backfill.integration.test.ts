import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { DEFAULT_ACCOUNT_GROUPS } from "../../src/account-groups";
import { db, withBypass } from "../../../engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const migrationSql = readFileSync(
  new URL("./0306_account_group_default_backfill.sql", import.meta.url),
  "utf8",
);

type StoredGroup = {
  dimension: string;
  key: string;
  name: string;
  color: string | null;
  sort_order: number;
  match: unknown;
  is_catch_all: boolean;
  is_active: boolean;
};

async function storedGroups(orgId: string): Promise<StoredGroup[]> {
  return (await db.execute<StoredGroup>(sql`
    select dimension, key, name, color, sort_order, match, is_catch_all, is_active
      from account_groups
     where org_id = ${orgId} and dimension in ('cost_pool', 'burden')
     order by dimension, sort_order
  `)).rows;
}

test(
  "0306 backfills the default groups for every tenant without touching existing rows, idempotently",
  { skip: !DB },
  async () => {
    const pristine = await withBypass(() => createScratchOrg());
    const customized = await withBypass(() => createScratchOrg());
    try {
      await withBypass(async () => {
        // One tenant customized its policy before the backfill ran: a
        // rewritten direct_labor rule (deactivated) and a deactivated
        // burden category. Parts of the old suite's True Cost fixtures also
        // insert their own burden rows; the backfill must coexist with all
        // of them.
        await db.execute(sql`
          insert into account_groups (org_id, dimension, key, name, color, sort_order, match, is_catch_all, is_active)
          values (${customized.orgId}, 'cost_pool', 'direct_labor', 'Direct Labor', '#0ea5e9', 20,
                  '{"namePattern": "operator-custom-rule"}'::jsonb, false, false)
        `);
        await db.execute(sql`
          insert into account_groups (org_id, dimension, key, name, color, sort_order, match, is_catch_all, is_active)
          values (${customized.orgId}, 'burden', 'insurance', 'Insurance', '#ef4444', 30,
                  '{"namePattern": "insurance"}'::jsonb, false, false)
        `);
        await db.execute(sql.raw(migrationSql));
      });

      for (const orgId of [pristine.orgId, customized.orgId]) {
        const rows = await withBypass(() => storedGroups(orgId));
        assert.deepEqual(
          rows.filter((row) => row.dimension === "cost_pool").map((row) => row.key),
          ["direct_cost", "direct_labor", "overhead", "g_and_a", "other"],
          `cost_pool keys for ${orgId}`,
        );
        assert.deepEqual(
          rows.filter((row) => row.dimension === "burden").map((row) => row.key),
          ["facilities", "admin_wages", "insurance", "it_software", "fleet_equipment", "professional", "people_safety", "financial"],
          `burden keys for ${orgId}`,
        );
      }

      // The pristine tenant's rows are exactly the live defaults: this pins
      // the migration's frozen literals against schema/src/account-groups.ts.
      const pristineRows = await withBypass(() => storedGroups(pristine.orgId));
      assert.ok(pristineRows.every((row) => row.is_active));
      for (const def of DEFAULT_ACCOUNT_GROUPS) {
        const row = pristineRows.find(
          (candidate) => candidate.dimension === def.dimension && candidate.key === def.key,
        );
        assert.ok(row, `${def.dimension}.${def.key} backfilled`);
        assert.equal(row.name, def.name);
        assert.equal(row.color, def.color);
        assert.equal(row.sort_order, def.sortOrder);
        assert.deepEqual(row.match, def.match);
        assert.equal(row.is_catch_all, def.isCatchAll);
      }

      // The customized tenant keeps its policy: the rewritten rule, both
      // deactivations, and every other default filled around them.
      const customizedRows = await withBypass(() => storedGroups(customized.orgId));
      const directLabor = customizedRows.find((row) => row.key === "direct_labor")!;
      assert.deepEqual(directLabor.match, { namePattern: "operator-custom-rule" });
      assert.equal(directLabor.is_active, false);
      const insurance = customizedRows.find((row) => row.key === "insurance")!;
      assert.equal(insurance.is_active, false);
      assert.deepEqual(
        insurance.match,
        DEFAULT_ACCOUNT_GROUPS.find((group) => group.key === "insurance")!.match,
      );

      // Re-running changes nothing: every (org, dimension, key) collides.
      await withBypass(async () => {
        await db.execute(sql.raw(migrationSql));
      });
      assert.deepEqual(await withBypass(() => storedGroups(pristine.orgId)), pristineRows);
      assert.deepEqual(await withBypass(() => storedGroups(customized.orgId)), customizedRows);
    } finally {
      await withBypass(() => dropScratchOrg(pristine.orgId));
      await withBypass(() => dropScratchOrg(customized.orgId));
    }
  },
);
