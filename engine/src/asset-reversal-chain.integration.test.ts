import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withOrg } from './db.ts';
import { disposeAsset, remeasureAsset, reverseAssetLifecycleEvent } from './asset-lifecycle.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from './test-fixtures.ts';

async function seedAsset(org: ScratchOrg) {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const assetId = randomUUID(), categoryId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
    values (${categoryId},${org.orgId},'Reversal equipment',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',10,'full_month')`);
  await db.execute(sql`insert into fixed_assets
    (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
    values (${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'REVERSE-CHAIN','Reversal asset','in_service',${org.date},${org.date},1000,0,'straight_line',10,'full_month')`);
  return { actorId, assetId };
}

async function eventFor(orgId: string, entryId: string) {
  return (await db.execute<{ id: string }>(sql`select id from asset_events where org_id=${orgId} and journal_entry_id=${entryId}`)).rows[0]!.id;
}

for (const scenario of ['redisposal', 'reverse earlier impairment'] as const) {
  test(`asset controlled reversal supports ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const { actorId, assetId } = await seedAsset(org);
      const opts = { actorId, date: org.date };
      if (scenario === 'redisposal') {
        const first = await disposeAsset(org.orgId, assetId, { ...opts, writeOff: true });
        await reverseAssetLifecycleEvent(org.orgId, await eventFor(org.orgId, first.entryId), { ...opts, reason: 'Restore asset after mistaken write-off' });
        const second = await disposeAsset(org.orgId, assetId, { ...opts, proceeds: '300', proceedsAccountId: org.accounts.bank });
        assert.equal(second.status, 'disposed');
        assert.notEqual(first.entryId, second.entryId);
        const entries = (await db.execute<{ entry_number: string }>(sql`select entry_number from journal_entries where org_id=${org.orgId} and id in (${first.entryId},${second.entryId})`)).rows;
        assert.equal(new Set(entries.map(row => row.entry_number)).size, 2);
      } else {
        const first = await remeasureAsset(org.orgId, assetId, { ...opts, newCarryingValue: '800' });
        const second = await remeasureAsset(org.orgId, assetId, { ...opts, newCarryingValue: '600' });
        const firstEvent = await eventFor(org.orgId, first.entryId), secondEvent = await eventFor(org.orgId, second.entryId);
        await assert.rejects(reverseAssetLifecycleEvent(org.orgId, firstEvent, { ...opts, reason: 'Reverse older impairment for correction' }), /later impaired/);
        await reverseAssetLifecycleEvent(org.orgId, secondEvent, { ...opts, reason: 'Reverse newest impairment before earlier one' });
        const earlier = await reverseAssetLifecycleEvent(org.orgId, firstEvent, { ...opts, reason: 'Reverse earlier impairment after latest reversal' });
        assert.equal(earlier.created, true);
        const net = (await db.execute<{ net: string }>(sql`select sum(l.amount)::text as net from journal_lines l join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=${org.orgId} and l.account_id=${org.accounts.clearing} and e.status in ('posted','reversed')`)).rows[0]!.net;
        assert.equal(net, '0.0000');
      }
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test('asset reversal order is preserved when two impairments share a transaction', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const { actorId, assetId } = await seedAsset(org);
    await withOrg(org.orgId, async () => {
      const first = await remeasureAsset(org.orgId, assetId, { actorId, date: org.date, newCarryingValue: '800' });
      await remeasureAsset(org.orgId, assetId, { actorId, date: org.date, newCarryingValue: '600' });
      await assert.rejects(reverseAssetLifecycleEvent(org.orgId, await eventFor(org.orgId, first.entryId), {
        actorId, date: org.date, reason: 'Earlier impairment must wait for the later reversal',
      }), /later impaired/);
    });
  } finally { await dropScratchOrg(org.orgId); }
});
