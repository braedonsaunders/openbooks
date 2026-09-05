import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({resolve(specifier,context,next){if(specifier==='server-only')return{shortCircuit:true,url:'data:text/javascript,export {}'};return next(specifier,context)}});
const {sql}=await import('drizzle-orm');
const {default:pg}=await import('pg');
const {db,withOrgTransaction}=await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,dropScratchOrg,seedFlowActors}=await import('@openbooks/engine/src/test-fixtures.ts');
const {setupResource}=await import('./setup-resources.ts');
const {SETUP_ENTITY_BY_KEY}=await import('../setup/registry.ts');
test('a loaded setup import refuses a subsequently disabled parent feature',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();
 try{
  const actorId=(await seedFlowActors(org.orgId)).adminId;
  const resource=setupResource(SETUP_ENTITY_BY_KEY.get('time-types')!,org.orgId);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"timeTracking":false}'::jsonb) where id=${org.orgId}`);
  const outcome=await withOrgTransaction(org.orgId,()=>resource.write([{name:'Disabled import',classification:'regular',costMultiplier:'1',billMultiplier:'1',isActive:true}],'insert',{orgId:org.orgId,actorId,dryRun:false}));
  assert.equal(outcome.created,0);assert.equal(outcome.failed,1);
 }finally{await dropScratchOrg(org.orgId);}
});


for(const capability of ['subsidiary','currency','field ticket'] as const){
 test(`setup import refuses disabled ${capability} fields`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const actorId=(await seedFlowActors(org.orgId)).adminId;
   const entity=capability==='subsidiary'?'departments':capability==='currency'?'item-rate-books':'time-types';
   const feature=capability==='subsidiary'?'multiSubsidiary':capability==='currency'?'multiCurrency':'fieldTickets';
   await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||jsonb_build_object(${feature}::text,false)) where id=${org.orgId}`);
   const resource=setupResource(SETUP_ENTITY_BY_KEY.get(entity)!,org.orgId);
   const body=capability==='subsidiary'?{code:'DISABLED-SCOPE',name:'Scoped department',subsidiaryId:org.subsidiaryId,isActive:true}:capability==='field ticket'?{name:'Unavailable field ticket',classification:'regular',costMultiplier:'1',billMultiplier:'1',showOnFieldTicket:true,isActive:true}:{code:'DISABLED-FX',name:'Foreign book',currency:'USD',isDefault:true,isActive:true};
   const outcome=await withOrgTransaction(org.orgId,()=>resource.write([body],'insert',{orgId:org.orgId,actorId,dryRun:false}));
   assert.equal(outcome.created,0);assert.equal(outcome.failed,1);
   if(capability==='field ticket')assert.equal(outcome.errors[0]?.message,'showOnFieldTicket is not available');
  }finally{await dropScratchOrg(org.orgId);}
 });
}
test('read-only setup resources do not advertise import support',()=>{
 assert.equal(setupResource(SETUP_ENTITY_BY_KEY.get('currencies')!,'unused').descriptor.supportsImport,false);
});

for(const dryRun of [false,true]){
 test(`read-only setup write refuses before touching storage, preview=${dryRun}`,async()=>{
  const resource=setupResource(SETUP_ENTITY_BY_KEY.get('currencies')!,'unused');
  const outcome=await resource.write([{code:'CAD',name:'Rejected',minorUnits:2}],'upsert',{orgId:'unused',actorId:'unused',dryRun});
  assert.equal(outcome.failed,1);assert.equal(outcome.updated,0);assert.equal(outcome.created,0);
  assert.equal(outcome.errors[0]?.message,'resource is read-only');
 });
}

for(const mode of ['insert','upsert'] as const){
 test(`setup import ${mode} joins the feature fence before waiting writes`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();const holder=new pg.Client({connectionString:process.env.OPENBOOKS_DB_URL});let pending:Promise<unknown>|undefined;
  try{
   const actorId=(await seedFlowActors(org.orgId)).adminId;
   const resource=setupResource(SETUP_ENTITY_BY_KEY.get('item-rate-books')!,org.orgId);
   const body={code:'FENCED',name:'Fenced import',isDefault:true,isActive:true};
   if(mode==='upsert')assert.equal((await resource.write([body],'insert',{orgId:org.orgId,actorId,dryRun:false})).created,1);
   const before=(await db.execute(sql`select * from item_rate_books where org_id=${org.orgId} order by id`)).rows;
   await holder.connect();await holder.query('begin');
   await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`openbooks:feature-gate:${org.orgId}`]);
   await holder.query("update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{\"projects\":false}'::jsonb) where id=$1",[org.orgId]);
   const pid=(await holder.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
   const request=resource.write([{...body,name:'Must be refused'}],mode,{orgId:org.orgId,actorId,dryRun:false});pending=request;void request.catch(()=>{});
   let blocked=false;const deadline=Date.now()+10000;
   while(Date.now()<deadline){
    await holder.query('select pg_stat_clear_snapshot()');
    if((await holder.query<{blocked:boolean}>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',[pid])).rows[0]!.blocked){blocked=true;break;}
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   assert.ok(blocked,'import queues at the authoritative feature fence');await holder.query('commit');
   const outcome=await request;assert.equal(outcome.failed,1);assert.equal(outcome.created,0);assert.equal(outcome.updated,0);
   assert.deepEqual((await db.execute(sql`select * from item_rate_books where org_id=${org.orgId} order by id`)).rows,before);
  }finally{await holder.query('rollback').catch(()=>{});await pending?.catch(()=>{});await holder.end();await dropScratchOrg(org.orgId);}
 });
}

test('enabled import preview remains read-only and disabled preview fails', {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
 const org=await createScratchOrg();
 try{
  const actorId=(await seedFlowActors(org.orgId)).adminId;
  const resource=setupResource(SETUP_ENTITY_BY_KEY.get('time-types')!,org.orgId);
  const rows=[{name:'Preview only',classification:'regular',costMultiplier:'1',billMultiplier:'1',isActive:true}];
  const before=(await db.execute(sql`select * from time_types where org_id=${org.orgId} order by id`)).rows;
  const auditBefore=(await db.execute(sql`select id from audit_log where org_id=${org.orgId} order by id`)).rows;
  assert.equal((await resource.write(rows,'insert',{orgId:org.orgId,actorId,dryRun:true})).created,1);
  assert.deepEqual((await db.execute(sql`select * from time_types where org_id=${org.orgId} order by id`)).rows,before);
  assert.deepEqual((await db.execute(sql`select id from audit_log where org_id=${org.orgId} order by id`)).rows,auditBefore);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"timeTracking":false}'::jsonb) where id=${org.orgId}`);
  assert.equal((await resource.write(rows,'insert',{orgId:org.orgId,actorId,dryRun:true})).failed,1);
 }finally{await dropScratchOrg(org.orgId);}
});

test('a base-currency book import uses the organization currency and retains it on metadata update', {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
 const org=await createScratchOrg();
 try{
  const actorId=(await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":false}'::jsonb) where id=${org.orgId}`);
  const resource=setupResource(SETUP_ENTITY_BY_KEY.get('item-rate-books')!,org.orgId);
  assert.ok(!(await resource.fields()).some(field=>field.key==='currency'));
  const body={code:'BASE',name:'Base import',isDefault:true,isActive:true};
  assert.equal((await resource.write([body],'insert',{orgId:org.orgId,actorId,dryRun:false})).created,1);
  const currency=(await db.execute(sql`select base_currency from orgs where id=${org.orgId}`)).rows[0]!.base_currency;
  assert.equal((await db.execute(sql`select currency from item_rate_books where org_id=${org.orgId} and code='BASE'`)).rows[0]!.currency,currency);
  assert.equal((await resource.write([{...body,name:'Updated label'}],'upsert',{orgId:org.orgId,actorId,dryRun:false})).updated,1);
  assert.equal((await db.execute(sql`select currency from item_rate_books where org_id=${org.orgId} and code='BASE'`)).rows[0]!.currency,currency);
 }finally{await dropScratchOrg(org.orgId);}
});

test('an unavailable field fails only its row and an outer evidence failure rolls back every accepted row', {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
 const org=await createScratchOrg();
 try{
  const actorId=(await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiSubsidiary":false}'::jsonb) where id=${org.orgId}`);
  const resource=setupResource(SETUP_ENTITY_BY_KEY.get('departments')!,org.orgId);
  const rows=[{code:'INVALID',name:'Unavailable scope',subsidiaryId:org.subsidiaryId,isActive:true},{code:'VALID',name:'Valid unscoped',isActive:true}];
  const auditBefore=(await db.execute(sql`select id from audit_log where org_id=${org.orgId} order by id`)).rows;
  await assert.rejects(withOrgTransaction(org.orgId,async()=>{
   const outcome=await resource.write(rows,'insert',{orgId:org.orgId,actorId,dryRun:false});
   assert.equal(outcome.failed,1);assert.equal(outcome.created,1);assert.equal(outcome.errors[0]?.row,1);
   throw new Error('import job evidence unavailable');
  }),/import job evidence unavailable/);
  assert.equal((await db.execute(sql`select id from departments where org_id=${org.orgId} and code in ('INVALID','VALID')`)).rows.length,0);
  assert.deepEqual((await db.execute(sql`select id from audit_log where org_id=${org.orgId} order by id`)).rows,auditBefore);
  const outcome=await resource.write(rows,'insert',{orgId:org.orgId,actorId,dryRun:false});
  assert.equal(outcome.failed,1);assert.equal(outcome.created,1);
  assert.deepEqual((await db.execute(sql`select code,subsidiary_id from departments where org_id=${org.orgId} and code in ('INVALID','VALID')`)).rows,[{code:'VALID',subsidiary_id:null}]);
 }finally{await dropScratchOrg(org.orgId);}
});

test('a setup import bound to one tenant refuses another tenant context before SQL',async()=>{
 const resource=setupResource(SETUP_ENTITY_BY_KEY.get('departments')!,'first');
 const outcome=await resource.write([{code:'FOREIGN',name:'Foreign tenant'}],'insert',{orgId:'second',actorId:'unused',dryRun:false});
 assert.equal(outcome.failed,1);assert.equal(outcome.created,0);assert.match(outcome.errors[0]!.message,/another organization/);
});
