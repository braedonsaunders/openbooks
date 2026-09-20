import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { remeasureAsset, reverseAssetLifecycleEvent } from "./asset-lifecycle.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

test("asset lifecycle reversal rechecks current posting scope before copying source lines", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const branchId = randomUUID();
    const categoryId = randomUUID();
    const assetId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
      values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Reversal policy branch', 'CAD', 'CA')
    `);
    await db.execute(sql`
      insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
         depreciation_expense_account_id, gain_loss_account_id, default_method,
         default_life_months, default_convention, tax_attributes, is_active)
      values (${categoryId}, ${org.orgId}, 'Reversal policy equipment', ${org.accounts.invAsset},
              ${org.accounts.clearing}, ${org.accounts.adjustment}, ${org.accounts.adjustment},
              'straight_line', 10, 'full_month', '{}'::jsonb, true)
    `);
    await db.execute(sql`
      insert into fixed_assets
        (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on,
         in_service_on, acquisition_cost, salvage_value, depreciation_method,
         useful_life_months, depreciation_convention, custom, created_by, updated_by)
      values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'ASSET-REV-POLICY',
              'Reversal policy asset', 'in_service', ${org.date}, ${org.date}, 1000, 0,
              'straight_line', 10, 'full_month', '{}'::jsonb, ${actorId}, ${actorId})
    `);

    const source = await remeasureAsset(org.orgId, assetId, {
      newCarryingValue: "800",
      date: org.date,
      actorId,
    });
    const sourceEventId = (await db.execute<{ id: string }>(sql`
      select id from asset_events where org_id = ${org.orgId} and journal_entry_id = ${source.entryId}
    `)).rows[0]!.id;

    // The source was posted while the adjustment account was valid. A later
    // entity-policy edit must also fence the compensating reversal.
    await db.execute(sql`
      update accounts
         set subsidiary_id = ${branchId}, subsidiary_include_children = false
       where org_id = ${org.orgId} and id = ${org.accounts.adjustment}
    `);

    await assert.rejects(
      reverseAssetLifecycleEvent(org.orgId, sourceEventId, {
        date: org.date,
        actorId,
        reason: "Reverse after the account policy changed",
      }),
      /restricted to another subsidiary/,
    );

    await db.execute(sql`
      update accounts
         set subsidiary_id = ${org.subsidiaryId}, subsidiary_include_children = true
       where org_id = ${org.orgId} and id = ${org.accounts.adjustment}
    `);
    await db.execute(sql`
      update accounting_books set is_active = false
       where org_id = ${org.orgId} and id = ${org.bookId}
    `);
    await assert.rejects(
      reverseAssetLifecycleEvent(org.orgId, sourceEventId, {
        date: org.date,
        actorId,
        reason: "Reverse after the book was deactivated",
      }),
      /active for posting/,
    );

    const evidence = (await db.execute<{ entries: number; events: number; status: string }>(sql`
      select
        (select count(*)::int from journal_entries where org_id = ${org.orgId} and origin = 'revaluation') as entries,
        (select count(*)::int from asset_events where org_id = ${org.orgId} and asset_id = ${assetId}) as events,
        (select status from fixed_assets where org_id = ${org.orgId} and id = ${assetId}) as status
    `)).rows[0]!;
    assert.deepEqual(evidence, { entries: 1, events: 1, status: "in_service" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
