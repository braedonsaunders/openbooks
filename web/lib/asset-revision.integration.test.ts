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
 const org=await createScratchOrg();const writer=new pg.Client({connectionString:env.OPENBOOKS_DB_URL});let connected=false;let pending:Promise<Response>|undefined;
 try{
  const {actorId,assetId}=await seedAsset(org);state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:null};const revision=await token(assetId);
  await writer.connect();connected=true;await writer.query('begin');await writer.query("select set_config('app.bypass_rls','on',true)");
  await writer.query("update fixed_assets set name='Concurrent committed editor',updated_at=updated_at+interval '1 microsecond' where id=$1",[assetId]);
  const pid=(await writer.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
  pending=patch(assetId,{expectedUpdatedAt:revision,name:'Stale waiting editor'});void pending.catch(()=>{});
  let blocked=false;const deadline=Date.now()+10000;
  while(Date.now()<deadline){
   if((await writer.query<{blocked:boolean}>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',[pid])).rows[0]!.blocked){blocked=true;break;}
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(blocked);await writer.query('commit');assert.equal((await pending).status,409);
  assert.equal((await db.execute(sql`select name from fixed_assets where id=${assetId}`)).rows[0]!.name,'Concurrent committed editor');
 }finally{if(connected)await writer.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});if(connected)await writer.end();state.gate=null;await dropScratchOrg(org.orgId)}
});
