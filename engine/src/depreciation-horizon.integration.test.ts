import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from './db.ts';
import { buildSchedule, runDepreciation } from './depreciation.ts';
import { remeasureAsset, reverseAssetLifecycleEvent } from './asset-lifecycle.ts';
import { toUnits } from './money.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from './test-fixtures.ts';

async function calendar(org: ScratchOrg, from: number, until: number) {
  for (let i = from; i < until; i++) {
    const start = new Date(Date.UTC(2026, 6 + i, 1));
    const end = new Date(Date.UTC(2026, 7 + i, 0));
    await db.execute(sql`insert into accounting_periods
      (org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment)
      select ${org.orgId},fiscal_calendar_id,${start.getUTCFullYear()},${start.getUTCMonth()+1},
        ${start.toISOString().slice(0,7)},${start.toISOString().slice(0,10)},${end.toISOString().slice(0,10)},false
      from accounting_periods where id=${org.periodId}`);
  }
}
async function seed(org: ScratchOrg, periods = 10, salvage = '0') {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const categoryId = randomUUID(), assetId = randomUUID();
  await calendar(org, 1, periods);
  await db.execute(sql`insert into asset_categories
    (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
    values (${categoryId},${org.orgId},'Horizon equipment',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',10,'full_month')`);
  await db.execute(sql`insert into fixed_assets
    (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
    values (${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'HORIZON','Horizon asset','in_service',${org.date},${org.date},1000,${salvage},'straight_line',10,'full_month')`);
  await buildSchedule(assetId,org.orgId,actorId,org.bookId);
  return { actorId, assetId };
}
async function rows(org: ScratchOrg, assetId: string, bookId = org.bookId) {
  return (await db.execute<{id:string;sequence:number;planned:string;posted:string|null;journal_entry_id:string|null}>(sql`
    select l.id,l.sequence,l.planned_amount::text as planned,l.posted_amount::text as posted,l.journal_entry_id
    from depreciation_schedule_lines l join depreciation_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
    where s.org_id=${org.orgId} and s.asset_id=${assetId} and s.book_id=${bookId} order by l.sequence`)).rows;
}
async function reverse(org: ScratchOrg, actorId: string, entryId: string) {
  const eventId = (await db.execute<{id:string}>(sql`select id from asset_events where org_id=${org.orgId} and journal_entry_id=${entryId}`)).rows[0]!.id;
  return reverseAssetLifecycleEvent(org.orgId,eventId,{actorId,date:'2026-08-01',reason:'Correct the dated impairment assessment'});
}
async function snapshot(org: ScratchOrg) {
  return (await db.execute(sql`select
    (select jsonb_agg(to_jsonb(t) order by id) from fixed_assets t where org_id=${org.orgId}) as assets,
    (select jsonb_agg(to_jsonb(t) order by id) from asset_events t where org_id=${org.orgId}) as events,
    (select jsonb_agg(to_jsonb(t) order by id) from journal_entries t where org_id=${org.orgId}) as entries,
    (select jsonb_agg(to_jsonb(t) order by id) from journal_lines t where org_id=${org.orgId}) as journals,
    (select jsonb_agg(to_jsonb(t) order by id) from depreciation_schedules t where org_id=${org.orgId}) as schedules,
    (select jsonb_agg(to_jsonb(t) order by id) from depreciation_schedule_lines t where org_id=${org.orgId}) as lines,
    (select jsonb_agg(to_jsonb(t) order by id) from audit_log t where org_id=${org.orgId}) as audit`)).rows;
}

for (const postJuly of [false,true]) {
  test(`native horizon is independent of available calendar, July posted=${postJuly}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const partial = await createScratchOrg(), full = await createScratchOrg();
    try {
      const partialAsset = await seed(partial,2), fullAsset = await seed(full);
      const fixtures = [[partial,partialAsset],[full,fullAsset]] as const;
      for (const [org,{actorId,assetId}] of fixtures) {
        if (postJuly) assert.equal((await runDepreciation(org.orgId,'2026-07-31',actorId,assetId)).totalAmount,'100.0000');
        await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'800'});
      }
      const values = async (org:ScratchOrg,assetId:string) => (await rows(org,assetId)).map(r=>r.planned);
      const fullImpaired = await values(full,fullAsset.assetId);
      assert.deepEqual(await values(partial,partialAsset.assetId),fullImpaired.slice(0,2),'common months must agree before reversal');
      assert.deepEqual(fullImpaired,postJuly ? ['100.0000',...Array<string>(8).fill('88.8888'),'88.8896'] : Array<string>(10).fill('80.0000'));
      for (const [org,{actorId,assetId}] of fixtures) {
        const july = (await rows(org,assetId))[0]!;
        const impairment = (await db.execute<{journal_entry_id:string}>(sql`select journal_entry_id from asset_events where org_id=${org.orgId} and asset_id=${assetId} and kind='impaired'`)).rows[0]!;
        await reverse(org,actorId,impairment.journal_entry_id);
        assert.deepEqual((await rows(org,assetId))[0],july,'a later reversal preserves the earlier row, including its unposted state');
        for(let i=0;i<2;i++) {
          await buildSchedule(assetId,org.orgId,actorId,org.bookId);
          assert.deepEqual((await rows(org,assetId))[0],july,'explicit rebuild retains the same historical projection');
        }
      }
      const expected = postJuly ? Array<string>(10).fill('100.0000') : ['80.0000',...Array<string>(8).fill('102.2222'),'102.2224'];
      assert.deepEqual(await values(full,fullAsset.assetId),expected);
      assert.deepEqual(await values(partial,partialAsset.assetId),expected.slice(0,2));
      await calendar(partial,2,10);
      await buildSchedule(partialAsset.assetId,partial.orgId,partialAsset.actorId,partial.bookId);
      assert.deepEqual(await values(partial,partialAsset.assetId),expected,'adding missing future periods cannot change any common amount');
      assert.equal(expected.reduce((sum,value)=>sum+toUnits(value),0n),toUnits('1000'));
      for (const [org,{actorId,assetId}] of fixtures) {
        const result=await runDepreciation(org.orgId,'2027-04-30',actorId,assetId);
        assert.deepEqual(result.problems,[]);
        assert.equal(result.totalAmount,postJuly?'900.0000':'1000.0000');
      }
    } finally { await dropScratchOrg(partial.orgId); await dropScratchOrg(full.orgId); }
  });
}

test('zero impairment projections survive a later reversal and other books remain unchanged',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try {
    const {actorId,assetId}=await seed(org);
    const bookId=randomUUID();
    await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${bookId},${org.orgId},'ALT','Alternate',false,true,false)`);
    await buildSchedule(assetId,org.orgId,actorId,bookId);
    const other=await rows(org,assetId,bookId);
    const impaired=await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'0'});
    assert.deepEqual((await rows(org,assetId)).map(r=>r.planned),Array<string>(10).fill('0.0000'));
    await buildSchedule(assetId,org.orgId,actorId,org.bookId);
    const july=(await rows(org,assetId))[0]!;
    assert.ok(july,'zero amounts are retained as historical projection evidence');
    await reverse(org,actorId,impaired.entryId);
    assert.deepEqual((await rows(org,assetId))[0],july);
    assert.equal((await rows(org,assetId)).reduce((sum,r)=>sum+toUnits(r.planned),0n),toUnits('1000'));
    assert.deepEqual(await rows(org,assetId,bookId),other);
  } finally {await dropScratchOrg(org.orgId);}
});

for(const missing of ['line','period'] as const) {
  test(`dated reversal refuses missing historical ${missing} atomically`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
    try {
      const {actorId,assetId}=await seed(org);
      const impaired=await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'800'});
      await db.execute(sql`delete from depreciation_schedule_lines where org_id=${org.orgId} and period_id=${org.periodId}`);
      if(missing==='period') await db.execute(sql`update accounting_periods set starts_on='2026-07-02' where id=${org.periodId}`);
      const before=await snapshot(org);
      await assert.rejects(reverse(org,actorId,impaired.entryId),/historical.*(period|projection)/i);
      assert.deepEqual(await snapshot(org),before);
    } finally {await dropScratchOrg(org.orgId);}
  });
}

test('retained unposted depreciation and salvage are reserved separately from posted carrying value',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try {
    const {actorId,assetId}=await seed(org,10,'100');
    const impaired=await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'800'});
    const july=(await rows(org,assetId))[0]!;
    assert.equal(july.planned,'70.0000');
    await reverse(org,actorId,impaired.entryId);
    assert.deepEqual((await rows(org,assetId))[0],july);
    const plan=await rows(org,assetId);
    assert.deepEqual(plan.map(r=>r.planned),['70.0000',...Array<string>(8).fill('92.2222'),'92.2224']);
    assert.equal(plan.reduce((sum,r)=>sum+toUnits(r.planned),0n),toUnits('900'));
    assert.equal((await runDepreciation(org.orgId,'2027-04-30',actorId,assetId)).totalAmount,'900.0000');
  } finally {await dropScratchOrg(org.orgId);}
});

test('later impairment refuses a basis below retained unposted reservations atomically',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try {
    const {actorId,assetId}=await seed(org);
    await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'800'});
    assert.equal((await rows(org,assetId))[0]?.planned,'80.0000');
    const before=await snapshot(org);
    await assert.rejects(remeasureAsset(org.orgId,assetId,{actorId,date:'2026-08-01',newCarryingValue:'50'}),/retained unposted depreciation.*basis/i);
    assert.deepEqual(await snapshot(org),before);
    await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-08-01',newCarryingValue:'80'});
    assert.deepEqual((await rows(org,assetId)).map(r=>r.planned),['80.0000',...Array<string>(9).fill('0.0000')]);
  } finally {await dropScratchOrg(org.orgId);}
});

for(const existing of [false,true]) {
  test(`multiple native months in one accounting period refuse atomically, existing=${existing}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
    try {
      const {actorId,assetId}=await seed(org,2);
      if(!existing) await db.execute(sql`delete from depreciation_schedule_lines where org_id=${org.orgId}`);
      await db.execute(sql`update accounting_periods set ends_on='2026-09-30' where org_id=${org.orgId} and starts_on='2026-08-01'`);
      const before=await snapshot(org);
      await assert.rejects(buildSchedule(assetId,org.orgId,actorId,org.bookId),/multiple native depreciation months/i);
      assert.deepEqual(await snapshot(org),before);
    } finally {await dropScratchOrg(org.orgId);}
  });
}

test('accelerated custom formula retains declared native life across partial and full calendars',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const partial=await createScratchOrg(),full=await createScratchOrg();
  try {
    for(const [org,count] of [[partial,2],[full,10]] as const) {
      const {actorId,assetId}=await seed(org,count);
      const methodId=randomUUID();
      await db.execute(sql`insert into depreciation_methods(id,org_id,code,name,formula,end_of_life,is_active)
        values (${methodId},${org.orgId},'HORIZON-CUSTOM','Accelerated horizon','((OC-RV)/AL)*2','fully_depreciate',true)`);
      await db.execute(sql`update fixed_assets set depreciation_method_id=${methodId} where id=${assetId}`);
      await buildSchedule(assetId,org.orgId,actorId,org.bookId);
      assert.equal((await runDepreciation(org.orgId,'2026-07-31',actorId,assetId)).totalAmount,'200.0000');
      await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'450'});
      assert.equal((await rows(org,assetId))[1]?.planned,'50.0000','450 divided over nine remaining native months');
      if(count===2) {await calendar(org,2,10);await buildSchedule(assetId,org.orgId,actorId,org.bookId);}
      assert.deepEqual((await rows(org,assetId)).map(r=>r.planned),['200.0000',...Array<string>(9).fill('50.0000')]);
    }
  } finally {await dropScratchOrg(partial.orgId);await dropScratchOrg(full.orgId);}
});
