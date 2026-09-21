import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { buildAllSchedules, runDepreciation } from "../assets/depreciation.ts";
import { computeFixedAssetDifferences } from "./income-tax-provision.ts";

test("the provision consumes recognized reporting-book depreciation without manufacturing tax GL", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      const { adminId } = await seedFlowActors(org.orgId);
      const taxBookId = randomUUID(), categoryId = randomUUID(), assetId = randomUUID();
      await db.execute(sql`
        insert into accounting_books (id,org_id,code,name,is_primary,posts_gl,is_active,created_by,updated_by)
        values (${taxBookId},${org.orgId},'tax','Tax reporting',false,false,true,${adminId},${adminId})`);
      await db.execute(sql`
        insert into asset_categories
          (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,
           depreciation_expense_account_id,default_method,default_life_months,default_convention,tax_attributes,is_active)
        values (${categoryId},${org.orgId},'Reporting equipment',${org.accounts.invAsset},${org.accounts.clearing},
                ${org.accounts.adjustment},'straight_line',12,'full_month','{}'::jsonb,true)`);
      await db.execute(sql`
        insert into fixed_assets
          (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,
           acquisition_cost,salvage_value,depreciation_method,useful_life_months,custom)
        values (${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'FA-PROVISION','Reporting equipment','in_service',
                ${org.date},${org.date},12000,0,'straight_line',12,'{}'::jsonb)`);
      await db.execute(sql`
        insert into depreciation_book_policies
          (org_id,book_id,category_id,method,life_months,convention,created_by,updated_by)
        values (${org.orgId},${taxBookId},${categoryId},'straight_line',6,'full_month',${adminId},${adminId})`);
      const schedules = await buildAllSchedules(assetId, org.orgId, adminId);
      assert.equal(schedules.length, 2);
      assert.deepEqual(await computeFixedAssetDifferences(org.orgId, "2026-07-31"), [],
        "formula estimates alone are not recognized depreciation");
      const run = await runDepreciation(org.orgId, "2026-07-31", adminId, assetId);
      assert.deepEqual(run.problems, []);
      assert.equal(run.posted, 1);
      assert.equal(run.recorded, 1);
      assert.equal(run.recordedAmount, "2000.0000");
      const result = await computeFixedAssetDifferences(org.orgId, "2026-07-31");
      assert.equal(result.length, 1);
      assert.deepEqual({
        book: result[0]!.bookBasis,
        tax: result[0]!.taxBasis,
        difference: result[0]!.difference,
      }, { book: "11000.0000", tax: "10000.0000", difference: "1000.0000" });
      const evidence = (await db.execute<{ amount: string; journal_entry_id: string | null; recorded: boolean }>(sql`
        select l.posted_amount::text as amount,l.journal_entry_id,l.non_gl_recognized_at is not null as recorded
          from depreciation_schedule_lines l join depreciation_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
         where s.org_id=${org.orgId} and s.asset_id=${assetId} and s.book_id=${taxBookId}`)).rows;
      assert.deepEqual(evidence, [{ amount: "2000.0000", journal_entry_id: null, recorded: true }]);
      assert.equal((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries where org_id=${org.orgId} and book_id=${taxBookId}`)).rows[0]!.n, 0);
      assert.deepEqual(await computeFixedAssetDifferences(org.orgId, "2026-06-30"), [],
        "recognition must retain the effective service-period cutoff");
      const retry = await runDepreciation(org.orgId, "2026-07-31", adminId, assetId);
      assert.equal(retry.posted + retry.recorded, 0);
      assert.deepEqual(await computeFixedAssetDifferences(org.orgId, "2026-07-31"), result,
        "a repeated depreciation run does not duplicate the tax difference");
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
