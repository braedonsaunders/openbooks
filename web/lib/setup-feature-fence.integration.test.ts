import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { db, env } from '@openbooks/engine/src/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/test-fixtures.ts';

const state: { gate: { user: { orgId: string; id: string } } | null } = { gate: null };
Object.assign(globalThis, { __setupFeatureFence: state });
const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.endsWith('/lib/authz') && context.parentURL?.includes('/api/admin/setup/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardPermission(){return globalThis.__setupFeatureFence.gate}' };
  }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
} });
const { POST, PATCH, DELETE } = await import('../app/api/admin/setup/[entity]/route');

async function authenticate(org: ScratchOrg) {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  state.gate = { user: { orgId: org.orgId, id: actorId } };
  await db.execute(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiSubsidiary":true}'::jsonb) where id=${org.orgId}`);
  return actorId;
}
function send(method: 'POST'|'PATCH'|'DELETE', entity: string, body: Record<string,unknown>) {
  const request = new Request(`http://audit.local/api/admin/setup/${entity}${method==='DELETE' ? '?id='+body.id : ''}`, {
    method, headers: { 'Content-Type':'application/json' }, ...(method==='DELETE' ? {} : {body:JSON.stringify(body)}),
  });
  return ({POST,PATCH,DELETE})[method](request,{params:Promise.resolve({entity})});
}
const { featureGateLockKey, resolvedFeatureState } = await import('./features');
for(const entity of ['asset-categories','item-rate-books','pay-derived-rules'] as const){
 for(const method of ['POST','PATCH','DELETE'] as const){
  test(`setup ${entity} ${method} refuses a feature disabled while its write waits`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
   const org=await createScratchOrg();const writer=new pg.Client({connectionString:env.OPENBOOKS_DB_URL});let pending:Promise<Response>|undefined;
   try{
    const actorId=await authenticate(org);const feature=entity==='asset-categories'?'fixedAssets':entity==='item-rate-books'?'projects':'payroll';const table=entity.replaceAll('-','_');
    let body:Record<string,unknown>=entity==='asset-categories'
     ? {name:'Fenced category',assetAccountId:org.accounts.invAsset,accumulatedDepreciationAccountId:org.accounts.clearing,depreciationExpenseAccountId:org.accounts.adjustment,defaultMethod:'straight_line',defaultLifeMonths:10,isActive:true}
     : {code:'FENCED',name:'Fenced rate book',isDefault:false,isActive:true};
    if(entity==='pay-derived-rules'){
     const component=(await db.execute(sql`insert into pay_components(org_id,code,name,kind,value,created_by,updated_by) values(${org.orgId},'FENCED','Fenced earning','earning','1',${actorId},${actorId}) returning id`)).rows[0]!;
     body={code:'FENCED',name:'Fenced rule',componentId:String(component.id),trigger:'distinct_day',effectiveFrom:'2026-01-01',effectiveTo:null,rateMode:'fixed_per_unit',rateValue:'10',quantityMode:'count',costingMode:'source',billableOnly:false,includedJobTitles:[],excludedJobTitles:[],sequence:50,isActive:true};
    }
    if(entity==='item-rate-books'){
     const prior=await send('POST',entity,{code:'PRIOR',name:'Prior default',isDefault:true,isActive:true});assert.equal(prior.status,200);
    }
    if(method!=='POST'){
     const created=await send('POST',entity,body);assert.equal(created.status,200,JSON.stringify(await created.clone().json()));body.id=(await created.json()).id;
    }
    const before=(await db.execute(sql`select * from ${sql.identifier(table)} where org_id=${org.orgId} order by id`)).rows;
    await writer.connect();await writer.query('begin');
    await writer.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[featureGateLockKey(org.orgId)]);
    if(entity==='item-rate-books')await writer.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`item-rate-books:${org.orgId}`]);
    else await writer.query(`lock table ${table} in share row exclusive mode`);
    await writer.query("update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||jsonb_build_object($1::text,false)) where id=$2",[feature,org.orgId]);
    const pid=(await writer.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
    pending=send(method,entity,{...body,name:'Write after disable'});void pending.catch(()=>{});
    let blocked=false;const deadline=Date.now()+10000;
    while(Date.now()<deadline){
     await writer.query('select pg_stat_clear_snapshot()');
     if((await writer.query<{blocked:boolean}>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',[pid])).rows[0]!.blocked){blocked=true;break;}
     await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(blocked,'request passed its initial gate and waits at a write boundary');await writer.query('commit');
    const response=await pending;assert.equal(response.status,404,JSON.stringify(await response.json()));
    assert.deepEqual((await db.execute(sql`select * from ${sql.identifier(table)} where org_id=${org.orgId} order by id`)).rows,before);
   }finally{await writer.query('rollback').catch(()=>{});await pending?.catch(()=>{});await writer.end();state.gate=null;await dropScratchOrg(org.orgId);}
  });
 }
}

test('resolved feature defaults use the supplied transaction for uncommitted settings and subsidiaries',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();
 try{
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)-'multiSubsidiary') where id=${org.orgId}`);
  assert.equal((await resolvedFeatureState(org.orgId)).multiSubsidiary,false);
  await db.transaction(async tx=>{
   await tx.execute(sql`insert into subsidiaries(org_id,parent_id,name,base_currency,country,is_active) values(${org.orgId},${org.subsidiaryId},'Uncommitted entity','CAD','CA',true)`);
   await tx.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"fixedAssets":false}'::jsonb) where id=${org.orgId}`);
   const features=await resolvedFeatureState(org.orgId,tx);
   assert.equal(features.multiSubsidiary,true);assert.equal(features.fixedAssets,false);
  });
 }finally{await dropScratchOrg(org.orgId);}
});

for(const capability of ['equipment trigger','subsidiary scope','currency','field ticket'] as const){
 for(const method of ['POST','PATCH'] as const){
 test(`setup ${method} rejects ${capability} disabled while its write waits`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();const writer=new pg.Client({connectionString:env.OPENBOOKS_DB_URL});let pending:Promise<Response>|undefined;
  try{
   const actorId=await authenticate(org);const entity=capability==='equipment trigger'?'pay-derived-rules':capability==='currency'?'item-rate-books':capability==='field ticket'?'time-types':'departments';const table=entity.replaceAll('-','_');const feature=capability==='equipment trigger'?'equipment':capability==='currency'?'multiCurrency':capability==='field ticket'?'fieldTickets':'multiSubsidiary';
   let body:Record<string,unknown>={code:'FIELD-FENCE',name:'Fenced scope',subsidiaryId:org.subsidiaryId,isActive:true};
   if(capability==='equipment trigger'){
    const component=(await db.execute(sql`insert into pay_components(org_id,code,name,kind,value,created_by,updated_by) values(${org.orgId},'FIELD-FENCE','Fenced earning','earning','1',${actorId},${actorId}) returning id`)).rows[0]!;
    body={code:'FIELD-FENCE',name:'Fenced equipment rule',componentId:String(component.id),trigger:'equipment_charge',effectiveFrom:'2026-01-01',effectiveTo:null,rateMode:'fixed_per_unit',rateValue:'10',quantityMode:'count',costingMode:'source',billableOnly:false,includedJobTitles:[],excludedJobTitles:[],sequence:50,isActive:true};
   }
   await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||jsonb_build_object(${feature}::text,true)) where id=${org.orgId}`);
   if(capability==='currency')body={code:'FIELD-FENCE',name:'Fenced currency',currency:'USD',isDefault:false,isActive:true};
   if(capability==='field ticket')body={name:'Fenced field ticket',classification:'regular',costMultiplier:'1',billMultiplier:'1',isBillableDefault:true,showOnFieldTicket:true,excludeFromWages:false,isActive:true};
   if(method==='PATCH'){
    const initial=capability==='equipment trigger'?{...body,trigger:'distinct_day'}:capability==='subsidiary scope'?{...body,subsidiaryId:null}:body;
    const created=await send('POST',entity,initial);assert.equal(created.status,200,JSON.stringify(await created.clone().json()));body.id=(await created.json()).id;
   }
   const before=(await db.execute(sql`select * from ${sql.identifier(table)} where org_id=${org.orgId} order by id`)).rows;
   await writer.connect();await writer.query('begin');await writer.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[featureGateLockKey(org.orgId)]);
   await writer.query(`lock table ${table} in share row exclusive mode`);
   await writer.query("update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||jsonb_build_object($1::text,false)) where id=$2",[feature,org.orgId]);
   const pid=(await writer.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
   pending=send(method,entity,body);void pending.catch(()=>{});
   let blocked=false;const deadline=Date.now()+10000;
   while(Date.now()<deadline){
    await writer.query('select pg_stat_clear_snapshot()');
    if((await writer.query<{blocked:boolean}>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',[pid])).rows[0]!.blocked){blocked=true;break;}
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   assert.ok(blocked);await writer.query('commit');const response=await pending;
   assert.equal(response.status,capability==='subsidiary scope'?400:404,JSON.stringify(await response.json()));
   assert.deepEqual((await db.execute(sql`select * from ${sql.identifier(table)} where org_id=${org.orgId} order by id`)).rows,before);
  }finally{await writer.query('rollback').catch(()=>{});await pending?.catch(()=>{});await writer.end();state.gate=null;await dropScratchOrg(org.orgId);}
 });
}

}
