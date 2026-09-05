import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts';
import { db, env } from '@openbooks/engine/src/db.ts';
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

const root = pathToFileURL(process.cwd() + '/').href;
const state: { gate: { user: { orgId: string; id: string }; allowedSubsidiaryIds: Set<string> | null } | null } = { gate: null };
Object.assign(globalThis, { __assetEditControls: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.endsWith('/lib/feature-gates') && context.parentURL?.includes('/api/assets/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardFeaturePermission(){return globalThis.__assetEditControls.gate}' };
  }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
} });
const { PATCH } = await import('../app/api/assets/[id]/route');


async function patch(assetId:string, body:Record<string,unknown>) {
 return PATCH(new Request(`http://audit.local/api/assets/${assetId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({id:assetId})});
}
for(const change of ['name','asset account','accumulated account','expense account','status','serial','description','tax'] as const){
 test(`asset editor audits ${change}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const {actorId,assetId}=await seedAsset(org);
   state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:null};
   const bodies:Record<typeof change,Record<string,unknown>>={name:{name:'Audited equipment'},'asset account':{assetAccountId:org.accounts.taxInput},'accumulated account':{accumulatedDepreciationAccountId:org.accounts.taxOutput},'expense account':{depreciationExpenseAccountId:org.accounts.cogs},status:{status:'draft'},serial:{serialNumber:'AUDIT-1'},description:{description:'Material configuration'},tax:{taxDepreciation:{ca_cca:{businessUsePercent:'80'}}}};
   const row=async()=>JSON.parse(JSON.stringify((await db.execute(sql`select a.*,${documentRevisionSql(sql`a.updated_at`)} as updated_at,${documentRevisionSql(sql`a.created_at`)} as created_at from fixed_assets a where id=${assetId}`)).rows[0]!));
   if(change==='name')await db.execute(sql`update fixed_assets set acquisition_cost='900000000000000.1234' where id=${assetId}`);
   const before=await row();
   const response=await patch(assetId,bodies[change]);
   assert.equal(response.status,200,JSON.stringify(await response.json()));
   const after=await row();
   const audits=(await db.execute<{actor_id:string;changes:{before:unknown;after:unknown}}>(sql`select actor_id,changes from audit_log where org_id=${org.orgId} and table_name='fixed_assets' and row_id=${assetId}`)).rows;
   assert.equal(audits.length,1,'every successful configuration edit has one atomic audit record');
   assert.equal(audits[0]!.actor_id,actorId);
   assert.deepEqual(audits[0]!.changes.before,before);
   assert.deepEqual(audits[0]!.changes.after,after);
  }finally{state.gate=null;await dropScratchOrg(org.orgId)}
 });
}
for(const edit of ['metadata','custom','tax'] as const){
 test(`asset editor preserves concurrent provenance during ${edit} save`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();const writer=new pg.Client({connectionString:env.OPENBOOKS_DB_URL});let connected=false;let pending:Promise<Response>|undefined;
  try{
   const {actorId,assetId}=await seedAsset(org);
   state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:null};
   await db.execute(sql`update fixed_assets set custom='{"provenance":{"version":1},"taxDepreciation":{"ca_cca":{"businessUsePercent":"100"}}}'::jsonb where id=${assetId}`);
   await db.execute(sql`insert into custom_field_defs(org_id,target_table,key,label,field_type) values (${org.orgId},'fixed_assets','inspection_note','Inspection','text')`);
   const latest={provenance:{version:2},inspection_note:'Latest inspection',taxDepreciation:{ca_cca:{businessUsePercent:'90'}}};
   await writer.connect();connected=true;await writer.query('begin');await writer.query("select set_config('app.bypass_rls','on',true)");
   await writer.query('update fixed_assets set custom=$1::jsonb where id=$2',[JSON.stringify(latest),assetId]);
   const pid=(await writer.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
   const body:Record<string,unknown>={name:'Concurrent save'};
   if(edit==='custom')body.custom={inspection_note:'Replaced inspection'};
   if(edit==='tax')body.taxDepreciation={};
   pending=patch(assetId,body);void pending.catch(()=>{});
   let blocked=false;const deadline=Date.now()+10000;
   while(Date.now()<deadline){
    if((await writer.query<{blocked:boolean}>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',[pid])).rows[0]!.blocked){blocked=true;break;}
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   assert.ok(blocked,'edit waits behind the real asset writer');await writer.query('commit');
   const response=await pending;assert.equal(response.status,200,JSON.stringify(await response.json()));
   const custom=(await db.execute(sql`select custom from fixed_assets where id=${assetId}`)).rows[0]!.custom;
   assert.deepEqual(custom,{...latest,inspection_note:edit==='custom'?'Replaced inspection':latest.inspection_note,taxDepreciation:edit==='tax'?{}:latest.taxDepreciation});
   const audit=(await db.execute<{changes:{before:{custom:unknown}}}>(sql`select changes from audit_log where row_id=${assetId} and table_name='fixed_assets'`)).rows[0];
   assert.deepEqual(audit?.changes.before.custom,latest,'audit starts at the locked committed state');
  }finally{
   if(connected)await writer.query('rollback').catch(()=>{});
   if(pending)await pending.catch(()=>{});
   if(connected)await writer.end();state.gate=null;await dropScratchOrg(org.orgId);
  }
 });
}

test('asset edit rolls back when its audit record cannot be stored',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();let cleanup:(()=>Promise<void>)|undefined;
 try{
  const {actorId,assetId}=await seedAsset(org);state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:null};
  const suffix=randomUUID().replaceAll('-','');const fn=`asset_audit_fail_${suffix}`;const trigger=`asset_audit_fail_${suffix}`;
  await db.execute(sql.raw(`create function public."${fn}"() returns trigger language plpgsql as $$ begin if new.table_name='fixed_assets' and new.actor_id='${actorId}'::uuid then raise exception 'forced asset audit failure'; end if; return new; end $$; create trigger "${trigger}" before insert on audit_log for each row execute function public."${fn}"();`));
  cleanup=async()=>{await db.execute(sql.raw(`drop trigger if exists "${trigger}" on audit_log; drop function if exists public."${fn}"();`));};
  const snapshot=async()=>(await db.execute(sql`select (select jsonb_agg(to_jsonb(a)) from fixed_assets a where org_id=${org.orgId}) as assets,(select jsonb_agg(to_jsonb(s)) from depreciation_schedules s where org_id=${org.orgId}) as schedules,(select jsonb_agg(to_jsonb(l)) from depreciation_schedule_lines l where org_id=${org.orgId}) as lines`)).rows;
  const before=await snapshot();const response=await patch(assetId,{assetAccountId:org.accounts.taxInput});
  assert.equal(response.status,422);assert.deepEqual(await snapshot(),before,'asset and schedule writes roll back with failed evidence');
 }finally{if(cleanup)await cleanup();state.gate=null;await dropScratchOrg(org.orgId)}
});
