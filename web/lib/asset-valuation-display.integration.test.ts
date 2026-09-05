import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { buildSchedule, runDepreciation } from '@openbooks/engine/src/depreciation.ts';
import { toUnits } from '@openbooks/engine/src/money.ts';
import { sql } from 'drizzle-orm';
import { db } from '@openbooks/engine/src/db.ts';
import { disposeAsset, remeasureAsset, reverseAssetLifecycleEvent } from '@openbooks/engine/src/asset-lifecycle.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/test-fixtures.ts';

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


registerHooks({resolve(specifier,context,next){
 if(specifier==='server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'};
 return next(specifier,context);
}});
const {loadAsset}=await import('../app/api/assets/_lib');
const cases=['plain','depreciation','impairment','revaluation','reversed impairment','disposal','write-off','reversed disposal','reversed write-off','impaired disposal','future impairment','alternate book','dated reversal'] as const;
for(const scenario of cases){
 test(`asset detail valuation: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const {actorId,assetId}=await seedAsset(org);
   const opts={actorId,date:'2026-07-31'};
   let expectedValue='1000.0000',expectedAccumulated='0.0000';
   let alternateId:string|undefined;
   if(scenario==='future impairment'||scenario==='dated reversal'){
    await db.execute(sql`insert into accounting_periods(org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
      select org_id,2026,8,'2026-08','2026-08-01','2026-08-31',false,fiscal_calendar_id from accounting_periods where org_id=${org.orgId} limit 1`);
   }
   if(scenario==='future impairment')await db.execute(sql`update fixed_assets set useful_life_months=2 where id=${assetId}`);
   if(['depreciation','alternate book','future impairment','dated reversal'].includes(scenario))await buildSchedule(assetId,org.orgId,actorId,org.bookId);
   if(scenario==='alternate book'){
    alternateId=randomUUID();
    await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values (${alternateId},${org.orgId},'ALT','Alternate',false,true,true)`);
    await buildSchedule(assetId,org.orgId,actorId,alternateId);
   }
   if(['depreciation','alternate book','future impairment'].includes(scenario)){
    const depreciation=await runDepreciation(org.orgId,'2026-07-31',actorId,assetId,undefined,org.bookId);
    assert.equal(depreciation.posted,1);
    expectedAccumulated=scenario==='future impairment'?'500.0000':'100.0000';
    expectedValue=scenario==='future impairment'?'500.0000':'900.0000';
   }
   if(['impairment','reversed impairment','impaired disposal','revaluation','alternate book','future impairment','dated reversal'].includes(scenario)){
    const target=scenario==='revaluation'?'1200':scenario==='alternate book'?'700':scenario==='future impairment'?'300':'800';
    const posted=await remeasureAsset(org.orgId,assetId,{...opts,date:scenario==='future impairment'?'2026-08-15':opts.date,newCarryingValue:target});
    expectedValue=target+'.0000';
    expectedAccumulated=scenario==='revaluation'?'-200.0000':scenario==='alternate book'?'300.0000':scenario==='future impairment'?'700.0000':'200.0000';
    if(scenario==='reversed impairment'||scenario==='dated reversal'){
     await reverseAssetLifecycleEvent(org.orgId,await eventFor(org.orgId,posted.entryId),{...opts,date:scenario==='dated reversal'?'2026-08-01':opts.date,reason:'Restore the reviewed asset valuation'});
     expectedValue='1000.0000';expectedAccumulated='0.0000';
    }
   }
   if(['disposal','write-off','reversed disposal','reversed write-off','impaired disposal'].includes(scenario)){
    const posted=await disposeAsset(org.orgId,assetId,{...opts,proceeds:'300',proceedsAccountId:org.accounts.bank,writeOff:scenario.includes('write-off')});
    expectedValue='0.0000';expectedAccumulated='0.0000';
    if(scenario.startsWith('reversed')){
     await reverseAssetLifecycleEvent(org.orgId,await eventFor(org.orgId,posted.entryId),{...opts,reason:'Restore a mistakenly disposed asset'});
     expectedValue='1000.0000';
    }
   }
   const detail=await loadAsset(assetId,org.orgId);
   assert.ok(detail);
   assert.equal(detail.totals.netBookValue,expectedValue,'current primary-book carrying amount');
   assert.equal(toUnits(detail.totals.accumulated),toUnits(expectedAccumulated),'current accumulated balance');
   assert.equal(detail.hasAccountingEvidence,scenario!=='plain','lifecycle journals are accounting evidence');
   if(scenario==='future impairment')assert.deepEqual(detail.schedule.map(line=>line.netBookValue),['500.0000','0.0000'],'future impairment does not alter the earlier period');
   if(scenario==='dated reversal')assert.deepEqual(detail.schedule.map(line=>line.netBookValue),['700.0000','800.0000'],'reversal affects only its effective date onward');
   if(scenario==='alternate book'){
    assert.equal(detail.schedule.find(line=>line.bookId===org.bookId)?.netBookValue,'700.0000');
    const alternate=await loadAsset(assetId,org.orgId,{bookId:alternateId});
    assert.ok(alternate);
    assert.equal(alternate.totals.netBookValue,'700.0000');
    assert.equal(alternate.schedule[0]?.netBookValue,'900.0000','primary-book impairment must not change another book');
   }
  }finally{await dropScratchOrg(org.orgId)}
 });
}
