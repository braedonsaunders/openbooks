import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from './db.ts';
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

const sourceDate = '2026-07-20';
for (const kind of ['disposal', 'write-off', 'impairment', 'revaluation'] as const) {
  for (const timing of ['earlier', 'same day', 'later', 'invalid calendar'] as const) {
    test(`asset reversal chronology: ${kind}, ${timing}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const { actorId, assetId } = await seedAsset(org);
        const source = kind === 'disposal' || kind === 'write-off'
          ? await disposeAsset(org.orgId, assetId, {
            actorId, date: sourceDate, writeOff: kind === 'write-off',
            proceeds: '300', proceedsAccountId: org.accounts.bank,
          })
          : await remeasureAsset(org.orgId, assetId, {
            actorId, date: sourceDate, newCarryingValue: kind === 'impairment' ? '800' : '1200',
          });
        const eventId = await eventFor(org.orgId, source.entryId);
        const snapshot = async () => (await db.execute(sql`
          select
            (select jsonb_agg(to_jsonb(a) order by a.id) from fixed_assets a where org_id=${org.orgId}) as assets,
            (select jsonb_agg(to_jsonb(e) order by e.id) from asset_events e where org_id=${org.orgId}) as events,
            (select jsonb_agg(to_jsonb(e) order by e.id) from journal_entries e where org_id=${org.orgId}) as entries,
            (select jsonb_agg(to_jsonb(l) order by l.id) from journal_lines l where org_id=${org.orgId}) as lines,
            (select jsonb_agg(to_jsonb(s) order by s.id) from depreciation_schedules s where org_id=${org.orgId}) as schedules,
            (select jsonb_agg(to_jsonb(l) order by l.id) from depreciation_schedule_lines l where org_id=${org.orgId}) as schedule_lines
        `)).rows;
        const before = await snapshot();
        const dates = { earlier: '2026-07-19', 'same day': sourceDate, later: '2026-07-21', 'invalid calendar': '2026-02-30' };
        const opts = { actorId, date: dates[timing], reason: 'Correct an asset lifecycle entry after review' };
        if (timing === 'earlier' || timing === 'invalid calendar') {
          await assert.rejects(reverseAssetLifecycleEvent(org.orgId, eventId, opts), timing === 'earlier' ? /before|predate/ : /calendar/);
          assert.deepEqual(await snapshot(), before, 'refusal preserves asset, event, journal and schedule state');
          return;
        }
        const reversed = await reverseAssetLifecycleEvent(org.orgId, eventId, opts);
        assert.equal(reversed.created, true);
        const journal = (await db.execute<{ date: string; net: string; source: string }>(sql`
          select e.posting_date::text as date, e.reverses_entry_id as source,
                 (select sum(amount)::text from journal_lines where entry_id=e.id and org_id=e.org_id) as net
            from journal_entries e where e.id=${reversed.reversalEntryId} and e.org_id=${org.orgId}
        `)).rows[0]!;
        assert.equal(journal.date, opts.date);
        assert.equal(journal.net, '0.0000');
        assert.equal(journal.source, source.entryId);
        const replay = await reverseAssetLifecycleEvent(org.orgId, eventId, opts);
        assert.equal(replay.created, false);
        assert.equal(replay.reversalEntryId, reversed.reversalEntryId);
      } finally { await dropScratchOrg(org.orgId); }
    });
  }
}
