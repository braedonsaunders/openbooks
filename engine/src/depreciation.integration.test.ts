import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { buildSchedule } from "./depreciation.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("unsupported depreciation methods fail without persisting a fallback schedule", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const categoryId = randomUUID();
    await db.execute(sql`
      insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
         depreciation_expense_account_id, default_method, default_life_months, default_convention,
         tax_attributes, is_active)
      values (${categoryId}, ${org.orgId}, 'Equipment', ${org.accounts.invAsset}, ${org.accounts.clearing},
              ${org.accounts.adjustment}, 'straight_line', 12, 'full_month', '{}'::jsonb, true)`);

    for (const method of ["manual", "units_of_production"] as const) {
      const assetId = randomUUID();
      await db.execute(sql`
        insert into fixed_assets
          (id, org_id, subsidiary_id, category_id, asset_number, name, status,
           acquired_on, in_service_on, acquisition_cost, salvage_value, custom)
        values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, ${`ASSET-${method}`},
                ${method}, 'in_service', ${org.date}, ${org.date}, '12000.0000', '0.0000',
                ${JSON.stringify({ method, lifeMonths: 12 })}::jsonb)`);
      await assert.rejects(
        buildSchedule(assetId, org.orgId, null, org.bookId),
        method === "manual" ? /manual depreciation is disabled/ : /units-of-production depreciation is disabled/,
      );
      const persisted = (await db.execute(sql`
        select count(*)::int as schedules,
               (select count(*)::int from depreciation_schedule_lines where org_id = ${org.orgId}) as lines
          from depreciation_schedules where asset_id = ${assetId}`)) as unknown as {
        rows: { schedules: number; lines: number }[];
      };
      assert.deepEqual(persisted.rows[0], { schedules: 0, lines: 0 });
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
