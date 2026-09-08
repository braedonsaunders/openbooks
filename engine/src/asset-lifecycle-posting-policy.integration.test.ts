import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { AssetLifecycleError, disposeAsset, remeasureAsset } from "./asset-lifecycle.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

for (const operation of ["disposal", "remeasurement"] as const) {
  for (const policy of ["account", "location", "inactive subsidiary", "inactive book", "non-posting book"] as const) {
    test(`asset ${operation} refuses ${policy} policy violations without changing history`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const actorId = (await seedFlowActors(org.orgId)).adminId;
        const branchId = randomUUID(), categoryId = randomUUID(), assetId = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
          values(${branchId},${org.orgId},${org.subsidiaryId},'Asset policy branch','CAD','CA')`);
        await db.execute(sql`insert into asset_categories
          (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,
           gain_loss_account_id,default_method,default_life_months,default_convention,tax_attributes,is_active)
          values(${categoryId},${org.orgId},'Policy equipment',${org.accounts.invAsset},${org.accounts.clearing},
            ${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',10,'full_month','{}'::jsonb,true)`);
        await db.execute(sql`insert into fixed_assets
          (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,
           salvage_value,depreciation_method,useful_life_months,depreciation_convention,location_id,custom,created_by,updated_by)
          values(${assetId},${org.orgId},${policy === "inactive subsidiary" ? branchId : org.subsidiaryId},${categoryId},
            'ASSET-POLICY','Asset policy','in_service',${org.date},${org.date},1000,0,'straight_line',10,'full_month',
            ${policy === "location" ? org.locationId : null},'{}'::jsonb,${actorId},${actorId})`);
        if (policy === "account") await db.execute(sql`update accounts set subsidiary_id=${branchId},subsidiary_include_children=false
          where org_id=${org.orgId} and id=${org.accounts.adjustment}`);
        if (policy === "location") await db.execute(sql`update locations set subsidiary_id=${branchId},subsidiary_include_children=false
          where org_id=${org.orgId} and id=${org.locationId}`);
        if (policy === "inactive subsidiary") await db.execute(sql`update subsidiaries set is_active=false
          where org_id=${org.orgId} and id=${branchId}`);
        if (policy === "inactive book") await db.execute(sql`update accounting_books set is_active=false
          where org_id=${org.orgId} and id=${org.bookId}`);
        if (policy === "non-posting book") await db.execute(sql`update accounting_books set posts_gl=false
          where org_id=${org.orgId} and id=${org.bookId}`);
        const run = () => operation === "disposal"
          ? disposeAsset(org.orgId,assetId,{writeOff:true,date:org.date,actorId})
          : remeasureAsset(org.orgId,assetId,{newCarryingValue:"800",date:org.date,actorId});
        await assert.rejects(run(), (error: unknown) => {
          assert.ok(error instanceof AssetLifecycleError);
          assert.match(error.message, policy === "account" || policy === "location" ? /restricted to another subsidiary/
            : policy === "inactive subsidiary" ? /inactive/ : /active primary posting book/);
          return true;
        });
        const state = (await db.execute<{ status: string; journals: number; events: number }>(sql`
          select status,(select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
            (select count(*)::int from asset_events where org_id=${org.orgId} and asset_id=${assetId}) as events
          from fixed_assets where org_id=${org.orgId} and id=${assetId}`)).rows[0]!;
        assert.deepEqual(state,{status:"in_service",journals:0,events:0});
        await db.execute(sql`update accounts set subsidiary_id=${org.subsidiaryId},subsidiary_include_children=true
          where org_id=${org.orgId} and id=${org.accounts.adjustment}`);
        await db.execute(sql`update locations set subsidiary_id=${org.subsidiaryId},subsidiary_include_children=true
          where org_id=${org.orgId} and id=${org.locationId}`);
        await db.execute(sql`update subsidiaries set is_active=true where org_id=${org.orgId} and id=${branchId}`);
        await db.execute(sql`update accounting_books set is_active=true,posts_gl=true where org_id=${org.orgId} and id=${org.bookId}`);
        assert.ok((await run()).entryId, "corrected policy allows the preserved asset to post");
      } finally { await dropScratchOrg(org.orgId); }
    });
  }
}
