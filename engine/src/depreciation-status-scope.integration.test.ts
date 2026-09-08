import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

for (const scope of ["empty", "other entity"] as const) {
  test(`depreciation status updates respect ${scope} scope`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const ownerId = randomUUID(), categoryId = randomUUID(), assetId = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${ownerId},${org.orgId},${org.subsidiaryId},'Restricted asset owner','CAD','CA')`);
      await db.execute(sql`insert into asset_categories
        (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,
         default_method,default_convention,tax_attributes,is_active)
        values(${categoryId},${org.orgId},'Scoped equipment',${org.accounts.invAsset},${org.accounts.clearing},
          ${org.accounts.adjustment},'straight_line','full_month','{}'::jsonb,true)`);
      await db.execute(sql`insert into fixed_assets
        (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,
         acquisition_cost,salvage_value,depreciation_method,useful_life_months,custom)
        values(${assetId},${org.orgId},${ownerId},${categoryId},'SCOPED-ASSET','Scoped equipment',
          'in_service',${org.date},${org.date},1200,0,'straight_line',1,'{}'::jsonb)`);
      await buildSchedule(assetId, org.orgId, actorId, org.bookId);
      assert.equal((await runDepreciation(org.orgId, "2026-07-31", actorId)).posted, 1);
      // Legacy/imported status can lag its valid, already-posted schedule.
      // Keep that state on an entity this caller cannot access.
      await db.execute(sql`update fixed_assets set status='in_service' where org_id=${org.orgId} and id=${assetId}`);
      const status = async () => (await db.execute<{ status: string }>(sql`
        select status from fixed_assets where org_id=${org.orgId} and id=${assetId}`)).rows[0]!.status;
      const result = await runDepreciation(org.orgId, "2026-07-31", actorId, undefined,
        scope === "empty" ? [] : [org.subsidiaryId]);
      assert.equal(result.posted, 0);
      assert.equal(await status(), "in_service", "a caller cannot update an out-of-scope asset through status housekeeping");
      await runDepreciation(org.orgId, "2026-07-31", actorId, undefined, [ownerId]);
      assert.equal(await status(), "fully_depreciated", "authorized status reconciliation still works");
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId}`)).rows[0]!.n, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}
