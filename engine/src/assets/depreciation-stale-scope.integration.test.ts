import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { buildSchedule, previewDepreciation } from "./depreciation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * The stale-schedule blocker (S3): only periods the builder could still
 * project — its own fiscal calendar, inside the depreciable life — hold
 * Confirm. A period past the last depreciable month can never receive a
 * line, so no rebuild can clear it and it must not block; a rollover
 * period inside the life still flags until the rebuild projects it.
 */
async function addPeriods(orgId: string, periodId: string, months: number[]): Promise<void> {
  for (const month of months) {
    const mm = String(month).padStart(2, "0");
    const end = month === 7 ? "2026-07-31" : month === 8 ? "2026-08-31" : "2026-09-30";
    await db.execute(sql`insert into accounting_periods
      (org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment)
      values (${orgId}, (select fiscal_calendar_id from accounting_periods where id=${periodId}), 2026, ${month}, ${`2026-${mm}`}, ${`2026-${mm}-01`}, ${end}, false)`);
  }
}

async function seedAsset(
  orgId: string,
  subsidiaryId: string,
  invAsset: string,
  clearing: string,
  adjustment: string,
  assetNumber: string,
  lifeMonths: number,
  cost: number,
): Promise<string> {
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
    values (${categoryId},${orgId},'Stale scope equipment',${invAsset},${clearing},${adjustment},${adjustment},'straight_line',${lifeMonths},'full_month')`);
  await db.execute(sql`insert into fixed_assets
    (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
    values (${assetId},${orgId},${subsidiaryId},${categoryId},${assetNumber},'Stale scope mill','in_service','2026-07-01','2026-07-01',${cost},0,'straight_line',${lifeMonths},'full_month')`);
  return assetId;
}

test(
  "periods past the last depreciable month never block Confirm",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      await addPeriods(org.orgId, org.periodId, [8, 9]);
      const assetId = await seedAsset(
        org.orgId,
        org.subsidiaryId,
        org.accounts.invAsset,
        org.accounts.clearing,
        org.accounts.adjustment,
        "FA-0001",
        2,
        95,
      );
      await buildSchedule(assetId, org.orgId, actorId, org.bookId);
      const preview = await previewDepreciation(org.orgId, { asOfDate: "2026-08-31" });
      assert.deepEqual(
        preview.rows.map((row) => `${row.assetNumber} ${row.periodName} ${row.amount}`),
        ["FA-0001 P07 FY2026 47.5000", "FA-0001 P08 FY2026 47.5000"],
      );
      assert.deepEqual(preview.staleAssets, []);
      assert.equal(preview.totalAmount, "95.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a rollover period inside the life flags until the rebuild projects it",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      await addPeriods(org.orgId, org.periodId, [8]);
      const assetId = await seedAsset(
        org.orgId,
        org.subsidiaryId,
        org.accounts.invAsset,
        org.accounts.clearing,
        org.accounts.adjustment,
        "FA-0002",
        3,
        300,
      );
      await buildSchedule(assetId, org.orgId, actorId, org.bookId);
      await addPeriods(org.orgId, org.periodId, [9]);
      const flagged = await previewDepreciation(org.orgId, { asOfDate: "2026-09-30" });
      assert.deepEqual(
        flagged.staleAssets.map((asset) => asset.assetNumber),
        ["FA-0002"],
      );
      await buildSchedule(assetId, org.orgId, actorId, org.bookId);
      const cleared = await previewDepreciation(org.orgId, { asOfDate: "2026-09-30" });
      assert.deepEqual(cleared.staleAssets, []);
      assert.equal(cleared.totalAmount, "300.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
