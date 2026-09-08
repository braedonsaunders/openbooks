import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

test("depreciation rolls back a failed journal inside the caller transaction and continues valid assets", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const constraint = `audit_depreciation_failure_${randomUUID().replaceAll("-", "")}`;
  const failedAsset = randomUUID(), validAsset = randomUUID();
  try {
    const categoryId = randomUUID();
    await db.execute(sql`
      insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
         depreciation_expense_account_id, default_method, default_convention, tax_attributes, is_active)
      values (${categoryId}, ${org.orgId}, 'Rollback equipment', ${org.accounts.invAsset},
              ${org.accounts.clearing}, ${org.accounts.adjustment}, 'straight_line', 'full_month', '{}'::jsonb, true)`);
    for (const [assetId, number] of [[failedAsset, "A-FAIL"], [validAsset, "B-VALID"]]) {
      await db.execute(sql`
        insert into fixed_assets
          (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on,
           in_service_on, acquisition_cost, salvage_value, depreciation_method, useful_life_months, custom)
        values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, ${number},
                'Rollback equipment', 'in_service', ${org.date}, ${org.date}, 1200, 0, 'straight_line', 1, '{}'::jsonb)`);
      await buildSchedule(assetId!, org.orgId, actorId, org.bookId);
    }
    // Reject the second leg only for A-FAIL, after its draft and debit exist.
    await db.execute(sql`
      update fixed_assets set accumulated_depreciation_account_id=${org.accounts.invAsset}
       where id=${failedAsset} and org_id=${org.orgId}`);
    await db.execute(sql.raw(`alter table journal_lines add constraint ${constraint}
      check (org_id <> '${org.orgId}'::uuid or account_id <> '${org.accounts.invAsset}'::uuid) not valid`));
    await withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`update parties set display_name='Surviving depreciation caller'
        where org_id=${org.orgId} and id=${org.customerId}`);
      const result = await runDepreciation(org.orgId, "2026-07-31", actorId);
      assert.equal(result.posted, 1);
      assert.equal(result.totalAmount, "1200.0000");
      assert.equal(result.problems.length, 1);
      assert.equal(result.entries[0]?.assetNumber, "B-VALID");
      await db.execute(sql`select 1 as usable`);
    });
    const caller = (await db.execute<{ name: string }>(sql`
      select display_name as name from parties where org_id=${org.orgId} and id=${org.customerId}`)).rows[0];
    assert.equal(caller?.name, "Surviving depreciation caller");
    const entries = (await db.execute<{ n: number; drafts: number }>(sql`
      select count(*)::int as n, count(*) filter (where status='draft')::int as drafts
        from journal_entries where org_id=${org.orgId} and origin='depreciation'`)).rows[0]!;
    assert.deepEqual(entries, { n: 1, drafts: 0 });
    const lines = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_lines jl join journal_entries j
        on j.org_id=jl.org_id and j.id=jl.entry_id
       where j.org_id=${org.orgId} and j.origin='depreciation'`)).rows[0]!;
    assert.equal(lines.n, 2, "no debit from the failed journal remains");
    const assets = (await db.execute<{ id: string; status: string }>(sql`
      select id, status from fixed_assets where org_id=${org.orgId} and id in (${failedAsset},${validAsset})`)).rows;
    assert.equal(assets.find((asset) => asset.id === failedAsset)?.status, "in_service");
    assert.equal(assets.find((asset) => asset.id === validAsset)?.status, "fully_depreciated");
  } finally {
    await db.execute(sql.raw(`alter table journal_lines drop constraint if exists ${constraint}`));
    await dropScratchOrg(org.orgId);
  }
});
