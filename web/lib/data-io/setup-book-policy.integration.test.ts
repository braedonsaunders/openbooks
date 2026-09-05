import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({resolve(specifier,context,next){if(specifier==='server-only')return{shortCircuit:true,url:'data:text/javascript,export {}'};return next(specifier,context)}});
const {sql}=await import('drizzle-orm');
const {randomUUID}=await import('node:crypto');
const {pathToFileURL}=await import('node:url');
const {db,withOrgTransaction}=await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,dropScratchOrg,seedFlowActors}=await import('@openbooks/engine/src/test-fixtures.ts');
const {setupResource}=await import('./setup-resources.ts');
const {SETUP_ENTITY_BY_KEY}=await import('../setup/registry.ts');

for(const scenario of ['first-rate-book','demote-rate-book','demote-accounting-book'] as const){
 test(`bulk setup preserves book authority: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const actorId=(await seedFlowActors(org.orgId)).adminId;
   const entity=scenario==='demote-accounting-book'?'accounting-books':'item-rate-books';
   const definition=SETUP_ENTITY_BY_KEY.get(entity)!;
   if(definition.featureKey)await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||jsonb_build_object(${definition.featureKey}::text,true)) where id=${org.orgId}`);
   const resource=setupResource(definition,org.orgId);
   const ctx={orgId:org.orgId,actorId,dryRun:false};
   if(scenario==='first-rate-book'){
    const outcome=await resource.write([{code:'FIRST',name:'First active book',isDefault:false,isActive:true}],'insert',ctx);
    assert.equal(outcome.created,1);assert.equal((await db.execute(sql`select is_default from item_rate_books where org_id=${org.orgId} and code='FIRST'`)).rows[0]!.is_default,true);
   }else if(scenario==='demote-rate-book'){
    const body={code:'DEFAULT',name:'Default book',isDefault:true,isActive:true};
    assert.equal((await resource.write([body],'insert',ctx)).created,1);
    const outcome=await resource.write([{...body,isDefault:false}],'upsert',ctx);
    assert.equal(outcome.updated,0);assert.equal(outcome.failed,1);
   }else{
    const book=(await db.execute(sql`select code,name from accounting_books where id=${org.bookId} and org_id=${org.orgId}`)).rows[0]!;
    const outcome=await resource.write([{code:book.code,name:book.name,isPrimary:false,isActive:true}],'upsert',ctx);
    assert.equal(outcome.updated,0);assert.equal(outcome.failed,1);
   }
  }finally{await dropScratchOrg(org.orgId);}
 });
}

const auth={gate:null as null|{user:{orgId:string,id:string}}};Object.assign(globalThis,{__bookPolicyProbe:auth});
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('/lib/authz')&&context.parentURL?.includes('/api/admin/setup/'))return{shortCircuit:true,url:'data:text/javascript,export async function guardPermission(){return globalThis.__bookPolicyProbe.gate}'};
 if(specifier.startsWith('@/'))return next(pathToFileURL(process.cwd()+'/web/'+specifier.slice(2)+'.ts').href,context);
 return next(specifier,context);
}});
const {PATCH}=await import('../../app/api/admin/setup/[entity]/route.ts');
test('interactive promotion cannot replace an active default with an inactive book',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();
 try{
  const actorId=(await seedFlowActors(org.orgId)).adminId;auth.gate={user:{orgId:org.orgId,id:actorId}};
  const resource=setupResource(SETUP_ENTITY_BY_KEY.get('item-rate-books')!,org.orgId);const ctx={orgId:org.orgId,actorId,dryRun:false};
  assert.equal((await resource.write([{code:'PRIOR',name:'Prior default',isDefault:true,isActive:true},{code:'NEXT',name:'Inactive successor',isDefault:false,isActive:true}],'insert',ctx)).created,2);
  const next=(await db.execute(sql`select id from item_rate_books where org_id=${org.orgId} and code='NEXT'`)).rows[0]!;
  const response=await PATCH(new Request('http://audit.local/api/admin/setup/item-rate-books',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:next.id,name:'Inactive successor',isDefault:true,isActive:false})}),{params:Promise.resolve({entity:'item-rate-books'})});
  assert.equal(response.status,400,JSON.stringify(await response.json()));
  assert.equal((await db.execute(sql`select is_default from item_rate_books where org_id=${org.orgId} and code='PRIOR'`)).rows[0]!.is_default,true);
 }finally{auth.gate=null;await dropScratchOrg(org.orgId);}
});

for(const entity of ['accounting-books','item-rate-books'] as const){
 for(const mode of ['insert','upsert'] as const){
  for(const failLeg of ['demotion','promotion'] as const){
   test(`book import ${entity} ${mode} rolls back every row when ${failLeg} evidence fails`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();const suffix=randomUUID().replaceAll('-','');const fn=`book_import_veto_${suffix}`;const trigger=`book_import_veto_${suffix}`;
    try{
     const actorId=(await seedFlowActors(org.orgId)).adminId;const definition=SETUP_ENTITY_BY_KEY.get(entity)!;
     if(definition.featureKey)await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||jsonb_build_object(${definition.featureKey}::text,true)) where id=${org.orgId}`);
     const resource=setupResource(definition,org.orgId);const ctx={orgId:org.orgId,actorId,dryRun:false};const key=entity==='accounting-books'?'isPrimary':'isDefault';const table=definition.table;
     if(entity==='item-rate-books')assert.equal((await resource.write([{code:'PRIOR',name:'Prior',isDefault:true,isActive:true}],'insert',ctx)).created,1);
     const body={code:'TARGET',name:'Target',[key]:true,isActive:true};
     if(mode==='upsert')assert.equal((await resource.write([{...body,[key]:false}],'insert',ctx)).created,1);
     const before=(await db.execute(sql`select * from ${sql.identifier(table)} where org_id=${org.orgId} order by id`)).rows;
     const auditBefore=(await db.execute(sql`select id from audit_log where org_id=${org.orgId} order by id`)).rows;
     const condition=failLeg==='demotion'?"NEW.changes->>'reason' is not null":"NEW.changes->'after'->>'code' = 'TARGET'";
     await db.execute(sql.raw(`create function ${fn}() returns trigger language plpgsql as $$ begin if NEW.org_id='${org.orgId}'::uuid and NEW.table_name='${table}' and (${condition}) then raise exception 'book evidence unavailable'; end if; return NEW; end $$`));
     await db.execute(sql.raw(`create trigger ${trigger} before insert on audit_log for each row execute function ${fn}()`));
     const result=await withOrgTransaction(org.orgId,()=>resource.write([body],mode,ctx));
     assert.equal(result.failed,1);assert.equal(result.created,0);assert.equal(result.updated,0);assert.match(result.errors[0]!.message,/book evidence unavailable/);
     assert.deepEqual((await db.execute(sql`select * from ${sql.identifier(table)} where org_id=${org.orgId} order by id`)).rows,before);
     assert.deepEqual((await db.execute(sql`select id from audit_log where org_id=${org.orgId} order by id`)).rows,auditBefore);
    }finally{await db.execute(sql.raw(`drop trigger if exists ${trigger} on audit_log`));await db.execute(sql.raw(`drop function if exists ${fn}()`));await dropScratchOrg(org.orgId);}
   });
  }
 }
 test(`book import ${entity} promotion retains all snapshots and preview leaves them intact`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const actorId=(await seedFlowActors(org.orgId)).adminId;const definition=SETUP_ENTITY_BY_KEY.get(entity)!;const table=definition.table;
   if(definition.featureKey)await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||jsonb_build_object(${definition.featureKey}::text,true)) where id=${org.orgId}`);
   const resource=setupResource(definition,org.orgId);const ctx={orgId:org.orgId,actorId,dryRun:false};const key=entity==='accounting-books'?'isPrimary':'isDefault';const column=entity==='accounting-books'?'is_primary':'is_default';
   if(entity==='item-rate-books')assert.equal((await resource.write([{code:'PRIOR',name:'Prior',isDefault:true,isActive:true}],'insert',ctx)).created,1);
   const before=(await db.execute(sql`select * from ${sql.identifier(table)} where org_id=${org.orgId} and ${sql.identifier(column)}`)).rows[0]!;
   const auditBefore=(await db.execute(sql`select id from audit_log where org_id=${org.orgId} order by id`)).rows;
   const body={code:'PROMOTED',name:'Promoted book',[key]:true,isActive:true};
   assert.equal((await resource.write([body],'insert',{...ctx,dryRun:true})).created,1);
   assert.deepEqual((await db.execute(sql`select * from ${sql.identifier(table)} where id=${String(before.id)} and org_id=${org.orgId}`)).rows[0],before);
   assert.deepEqual((await db.execute(sql`select id from audit_log where org_id=${org.orgId} order by id`)).rows,auditBefore);
   assert.equal((await resource.write([body],'insert',ctx)).created,1);
   const after=(await db.execute(sql`select * from ${sql.identifier(table)} where org_id=${org.orgId} order by id`)).rows;
   assert.equal(after.filter(row=>row[column]).length,1);assert.equal(after.find(row=>row[column])!.code,'PROMOTED');
   const evidence=(await db.execute<{actor_id:string;changes:{source:string;before?:Record<string,unknown>;after:Record<string,unknown>;reason?:string}}>(sql`select actor_id,changes from audit_log where org_id=${org.orgId} and table_name=${table} and ((row_id=${String(before.id)} and changes->>'reason' is not null) or changes->'after'->>'code'='PROMOTED') order by id`)).rows;
   assert.equal(evidence.length,2);
   for(const row of evidence){
    assert.equal(row.actor_id,actorId);assert.equal(row.changes.source,'import');
    const stored=after.find(record=>record.id===row.changes.after.id);
    assert.deepEqual(row.changes.after,JSON.parse(JSON.stringify(stored)));
   }
   assert.deepEqual(evidence.find(row=>row.changes.reason)!.changes.before,JSON.parse(JSON.stringify(before)));
  }finally{await dropScratchOrg(org.orgId);}
 });
}
