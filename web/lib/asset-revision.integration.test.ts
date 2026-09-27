import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { registerHooks } from 'node:module';
import { sql } from 'drizzle-orm';
import { documentRevisionSql } from '@openbooks/engine/src/records/revision.ts';
import { db, env } from '@openbooks/engine/src/platform/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts';
import { waitForLockWaiter } from '@openbooks/engine/src/testing/lock-wait.ts';

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

const state: { gate: { user: { orgId: string; id: string }; allowedSubsidiaryIds: Set<string> | null } | null } = { gate: null };
Object.assign(globalThis, { __assetEditControls: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/lib/feature-gates') && context.parentURL?.includes('/api/assets/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardFeaturePermission(){return globalThis.__assetEditControls.gate}' };
  }
  return next(specifier, context);
} });
const { PATCH, GET } = await import('../app/api/assets/[id]/route');


async function token(assetId:string){return (await db.execute<{revision:string}>(sql`select ${documentRevisionSql(sql`updated_at`)} as revision from fixed_assets where id=${assetId}`)).rows[0]!.revision;}
async function patch(assetId:string,body:Record<string,unknown>){return PATCH(new Request(`http://audit.local/api/assets/${assetId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({id:assetId})});}
for(const kind of ['missing','millisecond','malformed','stale','current'] as const){
 test(`asset editor revision ${kind}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const {actorId,assetId}=await seedAsset(org);state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:null};
   await db.execute(sql`update fixed_assets set updated_at='2026-09-05T12:00:00.123456Z'::timestamptz where id=${assetId}`);
   const revision=await token(assetId);
   const body:Record<string,unknown>={name:'Revision-tested asset'};
   if(kind!=='missing')body.expectedUpdatedAt=kind==='millisecond'?revision.replace('123456','123'):kind==='malformed'?'invalid':kind==='stale'?revision.replace('123456','123455'):revision;
   const snapshot=async()=>(await db.execute(sql`select (select to_jsonb(a) from fixed_assets a where id=${assetId}) as asset,(select jsonb_agg(to_jsonb(l)) from audit_log l where row_id=${assetId}) as audit`)).rows;
   const before=await snapshot();const response=await patch(assetId,body);
   assert.equal(response.status,kind==='current'?200:409,JSON.stringify(await response.json()));
   if(kind!=='current')assert.deepEqual(await snapshot(),before,'revision conflict leaves both asset and evidence unchanged');
   else assert.notEqual(await token(assetId),revision);
  }finally{state.gate=null;await dropScratchOrg(org.orgId)}
 });
}
test('asset GET returns the lossless revision used by both successive saves',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();
 try{
  const {actorId,assetId}=await seedAsset(org);state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:null};
  await db.execute(sql`update fixed_assets set updated_at='2026-09-05T12:00:00.123456Z'::timestamptz where id=${assetId}`);
  const response=await GET(new Request(`http://audit.local/api/assets/${assetId}`),{params:Promise.resolve({id:assetId})});
  let revision=(await response.json()).asset.updated_at;assert.equal(revision,await token(assetId));
  for(const name of ['First exact save','Second exact save']){
   const saved=await patch(assetId,{expectedUpdatedAt:revision,name});assert.equal(saved.status,200);
   const next=(await saved.json()).asset.updated_at;assert.equal(next,await token(assetId));assert.notEqual(next,revision);revision=next;
  }
 }finally{state.gate=null;await dropScratchOrg(org.orgId)}
});
test('two stale editors cannot silently overwrite each other',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();
 try{
  const {actorId,assetId}=await seedAsset(org);state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:null};const revision=await token(assetId);
  const first=await patch(assetId,{expectedUpdatedAt:revision,name:'First committed editor'});assert.equal(first.status,200);
  const second=await patch(assetId,{expectedUpdatedAt:revision,name:'Stale editor'});assert.equal(second.status,409);
  assert.equal((await db.execute(sql`select name from fixed_assets where id=${assetId}`)).rows[0]!.name,'First committed editor');
 }finally{state.gate=null;await dropScratchOrg(org.orgId)}
});
test('asset revision rechecks the writer that committed while PATCH waited',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();const writer=new pg.Client({connectionString:process.env.OPENBOOKS_TEST_ADMIN_DB_URL ?? env.OPENBOOKS_DB_URL});let connected=false;let pending:Promise<Response>|undefined;
 try{
  const {actorId,assetId}=await seedAsset(org);state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:null};const revision=await token(assetId);
  await writer.connect();connected=true;await writer.query('begin');await writer.query("select set_config('app.bypass_rls','on',true)"); // 0399 gates the bypass GUC by session role: the writer connects as the privileged test login above.
  assert.equal((await writer.query("update fixed_assets set name='Concurrent committed editor',updated_at=updated_at+interval '1 microsecond' where id=$1",[assetId])).rowCount,1,'concurrent writer must hold the asset row');
  pending=patch(assetId,{expectedUpdatedAt:revision,name:'Stale waiting editor'});void pending.catch(()=>{});
  await waitForLockWaiter(writer,{label:'the stale waiting editor'});await writer.query('commit');assert.equal((await pending).status,409);
  assert.equal((await db.execute(sql`select name from fixed_assets where id=${assetId}`)).rows[0]!.name,'Concurrent committed editor');
 }finally{if(connected)await writer.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});if(connected)await writer.end();state.gate=null;await dropScratchOrg(org.orgId)}
});


const assetDisplayCases = [
  { label: "asset valuation display", register: async () => {
        const assert = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const test = (await import('node:test')).default;
        const { buildSchedule, runDepreciation } = await import('@openbooks/engine/src/assets/depreciation.ts');
        const { toUnits } = await import('@openbooks/engine/src/money/money.ts');
        const { sql } = await import('drizzle-orm');
        const { db } = await import('@openbooks/engine/src/platform/db.ts');
        const { disposeAsset, remeasureAsset, reverseAssetLifecycleEvent } = await import('@openbooks/engine/src/assets/asset-lifecycle.ts');
        const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts');
        type ScratchOrg = import('@openbooks/engine/src/testing/fixtures.ts').ScratchOrg;
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
            const posted=await disposeAsset(org.orgId,assetId,{...opts,proceeds:scenario.includes('write-off')?'0':'300',proceedsAccountId:org.accounts.bank,writeOff:scenario.includes('write-off')});
            expectedValue='0.0000';expectedAccumulated='0.0000';
            if(scenario.startsWith('reversed')){
             await reverseAssetLifecycleEvent(org.orgId,await eventFor(org.orgId,posted.entryId),{...opts,reason:'Restore a mistakenly disposed asset'});
             expectedValue='1000.0000';
            }
           }
           const detail=await loadAsset(assetId,org.orgId,{allowedSubsidiaryIds:null});
           assert.ok(detail);
           assert.equal(detail.totals.netBookValue,expectedValue,'current primary-book carrying amount');
           assert.equal(toUnits(detail.totals.accumulated),toUnits(expectedAccumulated),'current accumulated balance');
           assert.equal(detail.hasAccountingEvidence,scenario!=='plain','lifecycle journals are accounting evidence');
           if(scenario==='future impairment')assert.deepEqual(detail.schedule.map(line=>line.netBookValue),['500.0000','0.0000'],'future impairment does not alter the earlier period');
           if(scenario==='dated reversal')assert.deepEqual(detail.schedule.map(line=>line.netBookValue),['720.0000','817.7778'],'July retains its impaired 80 charge; August allocates restored 920 over nine remaining months');
           if(scenario==='alternate book'){
            assert.equal(detail.schedule.find(line=>line.bookId===org.bookId)?.netBookValue,'700.0000');
            const alternate=await loadAsset(assetId,org.orgId,{allowedSubsidiaryIds:null,bookId:alternateId});
            assert.ok(alternate);
            assert.equal(alternate.totals.netBookValue,'700.0000');
            assert.equal(alternate.schedule[0]?.netBookValue,'900.0000','primary-book impairment must not change another book');
           }
          }finally{await dropScratchOrg(org.orgId)}
         });
        }

        test('asset detail valuation: dated reversal retains posted July and restores current 900 and August 800',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
         const org=await createScratchOrg();
         try {
          const {actorId,assetId}=await seedAsset(org);
          await db.execute(sql`insert into accounting_periods(org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
            select org_id,2026,8,'2026-08','2026-08-01','2026-08-31',false,fiscal_calendar_id from accounting_periods where org_id=${org.orgId} limit 1`);
          await buildSchedule(assetId,org.orgId,actorId,org.bookId);
          assert.equal((await runDepreciation(org.orgId,'2026-07-31',actorId,assetId)).totalAmount,'100.0000');
          const history=(await db.execute(sql`select * from depreciation_schedule_lines where org_id=${org.orgId} and posted_amount is not null`)).rows;
          const impairment=await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'800'});
          await reverseAssetLifecycleEvent(org.orgId,await eventFor(org.orgId,impairment.entryId),{actorId,date:'2026-08-01',reason:'Correct the impairment after July depreciation'});
          for(let i=0;i<2;i++) {
           await buildSchedule(assetId,org.orgId,actorId,org.bookId);
           const detail=await loadAsset(assetId,org.orgId,{allowedSubsidiaryIds:null});
           assert.ok(detail);
           assert.equal(detail.totals.netBookValue,'900.0000');
           assert.deepEqual(detail.schedule.map(line=>line.netBookValue),['800.0000','800.0000']);
           assert.deepEqual((await db.execute(sql`select * from depreciation_schedule_lines where org_id=${org.orgId} and posted_amount is not null`)).rows,history);
          }
         } finally {await dropScratchOrg(org.orgId);}
        });

        test('asset detail loader returns no payload after the asset moves outside the caller scope',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
         const org=await createScratchOrg();
         try {
          const {assetId}=await seedAsset(org);
          const otherSubsidiary=randomUUID();
          await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
            values(${otherSubsidiary},${org.orgId},${org.subsidiaryId},'Hidden asset owner','CAD','CA')`);
          await db.execute(sql`update fixed_assets set subsidiary_id=${otherSubsidiary}
            where id=${assetId} and org_id=${org.orgId}`);

          const hidden=await loadAsset(assetId,org.orgId,{allowedSubsidiaryIds:new Set([org.subsidiaryId])});
          assert.equal(hidden,null,'the locked loader must not return aggregates for a reassigned asset');
          const visible=await loadAsset(assetId,org.orgId,{allowedSubsidiaryIds:new Set([otherSubsidiary])});
          assert.equal(visible?.asset.id,assetId,'the new owner retains normal detail access');
         } finally {await dropScratchOrg(org.orgId);}
        });
  } },
] as const;

for (const row of assetDisplayCases) await row.register();
