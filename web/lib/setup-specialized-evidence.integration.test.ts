import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '@openbooks/engine/src/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/test-fixtures.ts';

const state: { gate: { user: { orgId: string; id: string } } | null } = { gate: null };
Object.assign(globalThis, { __specializedSetupEvidence: state });
const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.endsWith('/lib/authz') && context.parentURL?.includes('/api/admin/setup/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardPermission(){return globalThis.__specializedSetupEvidence.gate}' };
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
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
async function row(table: string, id: string) {
  return (await db.execute(sql`select * from ${sql.identifier(table)} where id=${id}`)).rows[0];
}
async function evidence(id: string, action: string) {
  return (await db.execute<{changes:Record<string,unknown>;actor_id:string}>(sql`select changes,actor_id from audit_log where row_id=${id} and action=${action} order by at desc limit 1`)).rows[0]!;
}

for(const entity of ['accounting-books','item-rate-books'] as const){
 for(const method of ['POST','PATCH'] as const){
  test(`${entity} ${method} promotion retains full evidence for every changed book`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
   const org=await createScratchOrg();
   try{
    const actorId=await authenticate(org);const table=entity.replaceAll('-','_');const flag=entity==='accounting-books'?'isPrimary':'isDefault';
    let priorId=org.bookId;
    if(entity==='item-rate-books'){
     const response=await send('POST',entity,{code:'PRIOR',name:'Prior book',[flag]:true,isActive:true});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));priorId=(await response.json()).id;
    }
    const prior=await row(table,priorId);const body={code:'PROMOTED',name:'Promoted book',[flag]:method==='POST',isActive:true};
    const created=await send('POST',entity,body);assert.equal(created.status,200,JSON.stringify(await created.clone().json()));const {id}=await created.json();
    const inserted=await row(table,id);
    if(method==='PATCH'){
     const promoted=await send('PATCH',entity,{...body,id,[flag]:true});assert.equal(promoted.status,200,JSON.stringify(await promoted.json()));
     assert.deepEqual((await evidence(id,'update')).changes,json({before:inserted,after:await row(table,id)}));
    }
    const creation=await evidence(id,'insert');assert.equal(creation.actor_id,actorId);assert.deepEqual(creation.changes,json({after:inserted}));
    const demotion=await evidence(priorId,'update');assert.equal(demotion.actor_id,actorId);
    assert.deepEqual(demotion.changes,json({before:prior,after:await row(table,priorId),reason:entity==='accounting-books'?'primary-book-reassigned':'default-rate-book-reassigned'}));
   }finally{state.gate=null;await dropScratchOrg(org.orgId);}
  });
 }
}
async function seedRule(org:ScratchOrg){
 const actorId=await authenticate(org);const componentId=randomUUID();
 await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,value,created_by,updated_by) values(${componentId},${org.orgId},'EVIDENCE','Evidence earning','earning','1',${actorId},${actorId})`);
 const body={code:'EVIDENCE-RULE',name:'Original rule',componentId,trigger:'distinct_day',effectiveFrom:'2026-01-01',effectiveTo:null,rateMode:'fixed_per_unit',rateValue:'10',quantityMode:'count',costingMode:'source',billableOnly:false,includedJobTitles:[],excludedJobTitles:[],sequence:50,isActive:true};
 const created=await send('POST','pay-derived-rules',body);assert.equal(created.status,200,JSON.stringify(await created.clone().json()));
 return{actorId,id:String((await created.json()).id),body};
}
for(const method of ['POST','PATCH'] as const){
 test(`derived-rule ${method} successor retains actual closed and inserted snapshots`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const f=await seedRule(org);const before=await row('pay_derived_rules',f.id);
   const response=await send(method,'pay-derived-rules',{...f.body,...(method==='PATCH'?{id:f.id}:{}),name:'Successor rule',effectiveFrom:'2026-07-01',rateValue:'25'});
   assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const {id}=await response.json();assert.notEqual(id,f.id);
   assert.deepEqual((await evidence(f.id,'insert')).changes,json({after:before}));
   assert.deepEqual((await evidence(f.id,'update')).changes,json({before,after:await row('pay_derived_rules',f.id)}));
   const inserted=await evidence(id,'insert');assert.equal(inserted.actor_id,f.actorId);assert.deepEqual(inserted.changes,json({after:await row('pay_derived_rules',id)}));
  }finally{state.gate=null;await dropScratchOrg(org.orgId);}
 });
}
for(const change of ['archive','close window'] as const){
 test(`derived-rule ${change} without a pricing change preserves identity and audit snapshots`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const f=await seedRule(org);const before=await row('pay_derived_rules',f.id);
   const response=await send('PATCH','pay-derived-rules',{...f.body,id:f.id,...(change==='archive'?{isActive:false}:{effectiveTo:'2026-06-30'})});
   assert.equal(response.status,200,JSON.stringify(await response.clone().json()));assert.equal((await response.json()).id,f.id);
   assert.deepEqual((await evidence(f.id,'update')).changes,json({before,after:await row('pay_derived_rules',f.id)}));
  }finally{state.gate=null;await dropScratchOrg(org.orgId);}
 });
}

async function rejectAudit(table:string,actorId:string,predicate:string){
 const name=`special_setup_audit_${randomUUID().replaceAll('-','')}`;
 await db.execute(sql.raw(`create function public."${name}"() returns trigger language plpgsql as $$ begin if new.table_name='${table}' and new.actor_id='${actorId}'::uuid and (${predicate}) then raise exception 'forced specialized setup audit failure'; end if; return new; end $$; create trigger "${name}" before insert on audit_log for each row execute function public."${name}"();`));
 return async()=>{await db.execute(sql.raw(`drop trigger if exists "${name}" on audit_log; drop function if exists public."${name}"();`));};
}
async function snapshot(table:string,orgId:string){
 return (await db.execute(sql`select (select jsonb_agg(to_jsonb(r) order by id) from ${sql.identifier(table)} r where org_id=${orgId}) as rows,(select jsonb_agg(to_jsonb(a) order by id) from audit_log a where org_id=${orgId} and table_name=${table}) as audits`)).rows;
}
for(const entity of ['accounting-books','item-rate-books'] as const){
 for(const method of ['POST','PATCH'] as const){
  for(const failure of ['demotion','promotion'] as const){
   test(`${entity} ${method} rolls back all rows if ${failure} evidence fails`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();let cleanup:(()=>Promise<void>)|undefined;
    try{
     const actorId=await authenticate(org);const table=entity.replaceAll('-','_'),flag=entity==='accounting-books'?'isPrimary':'isDefault';
     let priorId=org.bookId;
     if(entity==='item-rate-books'){
      const response=await send('POST',entity,{code:'PRIOR',name:'Prior book',[flag]:true,isActive:true});assert.equal(response.status,200);priorId=(await response.json()).id;
     }
     const body:Record<string,unknown>={code:'PROMOTED',name:'Promoted book',[flag]:true,isActive:true};
     if(method==='PATCH'){
      const response=await send('POST',entity,{...body,[flag]:false});assert.equal(response.status,200);body.id=(await response.json()).id;
     }
     const before=await snapshot(table,org.orgId);
     cleanup=await rejectAudit(table,actorId,failure==='demotion'?`new.row_id='${priorId}'::uuid`:method==='POST'?"new.action='insert'":`new.row_id='${body.id}'::uuid`);
     const response=await send(method,entity,body);assert.equal(response.status,400,JSON.stringify(await response.json()));
     assert.deepEqual(await snapshot(table,org.orgId),before);
    }finally{await cleanup?.();state.gate=null;await dropScratchOrg(org.orgId);}
   });
  }
 }
}
for(const method of ['POST','PATCH'] as const){
 for(const failure of ['closure','successor'] as const){
  test(`derived-rule ${method} rolls back both versions if ${failure} evidence fails`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
   const org=await createScratchOrg();let cleanup:(()=>Promise<void>)|undefined;
   try{
    const f=await seedRule(org);const before=await snapshot('pay_derived_rules',org.orgId);
    cleanup=await rejectAudit('pay_derived_rules',f.actorId,failure==='closure'?"new.action='update'":"new.action='insert'");
    const response=await send(method,'pay-derived-rules',{...f.body,...(method==='PATCH'?{id:f.id}:{}),name:'Successor rule',effectiveFrom:'2026-07-01',rateValue:'25'});
    assert.equal(response.status,400,JSON.stringify(await response.json()));assert.deepEqual(await snapshot('pay_derived_rules',org.orgId),before);
   }finally{await cleanup?.();state.gate=null;await dropScratchOrg(org.orgId);}
  });
 }
}
