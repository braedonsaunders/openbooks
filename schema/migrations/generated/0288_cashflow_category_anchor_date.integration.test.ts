import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../../../engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const migrationSql = readFileSync(
  new URL("./0288_cashflow_category_anchor_date.sql", import.meta.url),
  "utf8",
);

interface StoredCategory {
  id: string;
  anchorDate?: string;
  [key: string]: unknown;
}

async function storedCategories(orgId: string): Promise<StoredCategory[]> {
  const r = await db.execute<{ cats: unknown }>(sql`
    select settings -> 'analytics' -> 'cashflowCategories' as cats
      from orgs where id = ${orgId}
  `);
  const cats = r.rows[0]?.cats;
  assert.ok(Array.isArray(cats), "categories array survives the migration");
  return cats as StoredCategory[];
}

test(
  "0288 backfills anchorDate onto manual categories missing it, idempotently",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      await withBypass(async () => {
        await db.execute(sql`
          update orgs
             set settings = jsonb_set(
               jsonb_set(
                 coalesce(settings, '{}'::jsonb),
                 '{analytics}',
                 coalesce(settings -> 'analytics', '{}'::jsonb),
                 true
               ),
               '{analytics,cashflowCategories}',
               ${JSON.stringify([
                 { id: "cat-manual", name: "Rent", direction: "outflow", method: "manual_recurring", amount: "1000.0000", frequency: "monthly" },
                 { id: "cat-anchored", name: "Pinned", direction: "outflow", method: "manual_recurring", amount: "500.0000", frequency: "monthly", anchorDate: "2026-01-15" },
                 { id: "cat-gl", name: "GL", direction: "outflow", method: "gl_history_average", accountIds: ["00000000-0000-0000-0000-000000000000"] },
               ])}::jsonb,
               true
             )
           where id = ${org.orgId}
        `);
        await db.execute(sql.raw(migrationSql));
      });
      const today = (
        await db.execute<{ today: string }>(sql`select CURRENT_DATE::text as today`)
      ).rows[0]!.today;

      const after = await withBypass(() => storedCategories(org.orgId));
      assert.equal(after.length, 3);
      assert.equal(
        after.find((c) => c.id === "cat-manual")?.anchorDate,
        today,
        "an anchorless manual schedule freezes at the migration date",
      );
      assert.equal(
        after.find((c) => c.id === "cat-anchored")?.anchorDate,
        "2026-01-15",
        "an existing anchor is never overwritten",
      );
      assert.ok(
        !("anchorDate" in (after.find((c) => c.id === "cat-gl") ?? {})),
        "non-manual categories are untouched",
      );

      // Re-running changes nothing: the predicate matches no row.
      await withBypass(async () => {
        await db.execute(sql.raw(migrationSql));
      });
      assert.deepEqual(await withBypass(() => storedCategories(org.orgId)), after);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
