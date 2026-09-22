import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { disposeAsset, reverseAssetLifecycleEvent } from './asset-lifecycle.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '../testing/fixtures.ts';

async function seedAsset(orgId: string, subsidiaryId: string, accounts: { invAsset: string; clearing: string; adjustment: string }, date: string, tag: string) {
  const categoryId = randomUUID(), assetId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
    values (${categoryId},${orgId},${`Scope equipment ${tag}`},${accounts.invAsset},${accounts.clearing},${accounts.adjustment},${accounts.adjustment},'straight_line',10,'full_month')`);
  await db.execute(sql`insert into fixed_assets
    (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
    values (${assetId},${orgId},${subsidiaryId},${categoryId},${tag},'Scope asset','in_service',${date},${date},1000,0,'straight_line',10,'full_month')`);
  return assetId;
}

async function eventFor(orgId: string, entryId: string) {
  return (await db.execute<{ id: string }>(sql`select id from asset_events where org_id=${orgId} and journal_entry_id=${entryId}`)).rows[0]!.id;
}

async function writeCounts(orgId: string, assetId: string) {
  const rows = (await db.execute<{ events: number; journals: number }>(sql`
    select (select count(*)::int from asset_events where org_id=${orgId} and asset_id=${assetId}) as events,
           (select count(*)::int from journal_entries where org_id=${orgId}) as journals`)).rows[0]!;
  return rows;
}

test('a reversal scoped to the named asset refuses a foreign asset id without writing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const assetId = await seedAsset(org.orgId, org.subsidiaryId, org.accounts, org.date, 'SCOPE-A');
    const otherId = await seedAsset(org.orgId, org.subsidiaryId, org.accounts, org.date, 'SCOPE-B');
    const disposal = await disposeAsset(org.orgId, assetId, { actorId, date: org.date, writeOff: true });
    const before = await writeCounts(org.orgId, assetId);
    await assert.rejects(
      reverseAssetLifecycleEvent(org.orgId, await eventFor(org.orgId, disposal.entryId),
        { actorId, date: org.date, reason: 'Restore the other asset by mistake', assetId: otherId }),
      /asset lifecycle event not found/,
    );
    assert.deepEqual(await writeCounts(org.orgId, assetId), before);
  } finally { await dropScratchOrg(org.orgId); }
});

test('a reversal scoped to allowed subsidiaries refuses an out-of-scope asset without writing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const assetId = await seedAsset(org.orgId, org.subsidiaryId, org.accounts, org.date, 'SCOPE-C');
    const disposal = await disposeAsset(org.orgId, assetId, { actorId, date: org.date, writeOff: true });
    const before = await writeCounts(org.orgId, assetId);
    await assert.rejects(
      reverseAssetLifecycleEvent(org.orgId, await eventFor(org.orgId, disposal.entryId),
        { actorId, date: org.date, reason: 'Restore from an unauthorized entity', assetId, allowedSubsidiaryIds: [randomUUID()] }),
      /asset lifecycle event not found/,
    );
    assert.deepEqual(await writeCounts(org.orgId, assetId), before);
  } finally { await dropScratchOrg(org.orgId); }
});

test('a matching asset and subsidiary scope still reverses', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const assetId = await seedAsset(org.orgId, org.subsidiaryId, org.accounts, org.date, 'SCOPE-D');
    const disposal = await disposeAsset(org.orgId, assetId, { actorId, date: org.date, writeOff: true });
    const reversed = await reverseAssetLifecycleEvent(org.orgId, await eventFor(org.orgId, disposal.entryId),
      { actorId, date: org.date, reason: 'Restore asset after mistaken write-off', assetId, allowedSubsidiaryIds: [org.subsidiaryId] });
    assert.equal(reversed.created, true);
    assert.equal(reversed.assetId, assetId);
    assert.equal(reversed.restoredStatus, 'in_service');
  } finally { await dropScratchOrg(org.orgId); }
});
