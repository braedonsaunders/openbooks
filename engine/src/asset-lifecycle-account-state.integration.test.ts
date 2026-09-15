import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { AssetLifecycleError, disposeAsset } from "./asset-lifecycle.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

for (const state of ["inactive", "summary"] as const) {
  test(`asset disposal refuses a ${state} configured account without changing history`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const categoryId = randomUUID(), assetId = randomUUID();
      await db.execute(sql`insert into asset_categories
        (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,
         gain_loss_account_id,default_method,default_life_months,default_convention,tax_attributes,is_active)
        values(${categoryId},${org.orgId},'State equipment',${org.accounts.invAsset},${org.accounts.clearing},
          ${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',10,'full_month','{}'::jsonb,true)`);
      await db.execute(sql`insert into fixed_assets
        (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,
         salvage_value,depreciation_method,useful_life_months,depreciation_convention,location_id,custom,created_by,updated_by)
        values(${assetId},${org.orgId},${org.subsidiaryId},${categoryId},
          'ASSET-STATE','Asset state','in_service',${org.date},${org.date},1000,0,'straight_line',10,'full_month',
          null,'{}'::jsonb,${actorId},${actorId})`);
      if (state === "inactive") {
        await db.execute(sql`update accounts set is_active=false
          where org_id=${org.orgId} and id=${org.accounts.adjustment}`);
      } else {
        await db.execute(sql`update accounts set is_summary=true
          where org_id=${org.orgId} and id=${org.accounts.adjustment}`);
      }
      await assert.rejects(
        disposeAsset(org.orgId, assetId, { writeOff: true, date: org.date, actorId }),
        (error: unknown) => {
          assert.ok(error instanceof AssetLifecycleError);
          assert.match(error.message, /active, non-summary/i);
          return true;
        },
      );
      const after = (await db.execute<{ status: string; journals: number; events: number }>(sql`
        select status,(select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
          (select count(*)::int from asset_events where org_id=${org.orgId} and asset_id=${assetId}) as events
        from fixed_assets where org_id=${org.orgId} and id=${assetId}`)).rows[0]!;
      assert.deepEqual(after, { status: "in_service", journals: 0, events: 0 });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}
