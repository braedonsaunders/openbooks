import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {buildSchedule,runDepreciation} from './depreciation.ts';
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


for(const operation of ['dispose','remeasure'] as const){
 for(const source of ['acquisition','depreciation','valuation','reversed valuation'] as const){
  for(const timing of ['earlier','same','later'] as const){
   test(`asset lifecycle chronology: ${operation}, ${source}, ${timing}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
    try{
     const {actorId,assetId}=await seedAsset(org);
     await db.execute(sql`insert into accounting_periods(org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
       select org_id,2026,8,'2026-08','2026-08-01','2026-08-31',false,fiscal_calendar_id from accounting_periods where org_id=${org.orgId} limit 1`);
     const dates={acquisition:['2026-07-14','2026-07-15','2026-07-16'],depreciation:['2026-07-30','2026-07-31','2026-08-01'],valuation:['2026-07-19','2026-07-20','2026-07-21'],'reversed valuation':['2026-07-20','2026-07-21','2026-07-22']};
     if(source==='depreciation'){
      await buildSchedule(assetId,org.orgId,actorId,org.bookId);
      assert.equal((await runDepreciation(org.orgId,'2026-07-31',actorId,assetId)).posted,1);
     }
     if(source==='valuation'||source==='reversed valuation'){
      const original=await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-20',newCarryingValue:'800'});
      if(source==='reversed valuation')await reverseAssetLifecycleEvent(org.orgId,await eventFor(org.orgId,original.entryId),{actorId,date:'2026-07-21',reason:'Correct the preceding valuation event'});
     }
     const date=dates[source][timing==='earlier'?0:timing==='same'?1:2]!;
     const snapshot=()=>db.execute(sql`
       select (select jsonb_agg(to_jsonb(a) order by id) from fixed_assets a where org_id=${org.orgId}) as assets,
              (select jsonb_agg(to_jsonb(e) order by id) from asset_events e where org_id=${org.orgId}) as events,
              (select jsonb_agg(to_jsonb(e) order by id) from journal_entries e where org_id=${org.orgId}) as entries,
              (select jsonb_agg(to_jsonb(l) order by id) from journal_lines l where org_id=${org.orgId}) as lines,
              (select jsonb_agg(to_jsonb(l) order by id) from depreciation_schedule_lines l where org_id=${org.orgId}) as schedule_lines
     `);
     const before=(await snapshot()).rows;
     const perform=()=>operation==='dispose'
       ?disposeAsset(org.orgId,assetId,{actorId,date,writeOff:true})
       :remeasureAsset(org.orgId,assetId,{actorId,date,newCarryingValue:'700'});
     if(timing==='earlier'){
      await assert.rejects(perform(),/before|precede/);
      assert.deepEqual((await snapshot()).rows,before,'refusal is atomic');
     }else{
      const result=await perform();
      assert.equal((await db.execute<{date:string}>(sql`select posting_date::text as date from journal_entries where id=${result.entryId}`)).rows[0]!.date,date);
     }
    }finally{await dropScratchOrg(org.orgId)}
   });
  }
 }
}
