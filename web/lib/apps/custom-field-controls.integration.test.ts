import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({resolve(specifier,context,next){
  if(specifier==='server-only')return{shortCircuit:true,url:'data:text/javascript,export {}'};
  if(specifier.startsWith('@/'))return next(new URL(`../../${specifier.slice(2)}`,import.meta.url).href,context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { documentRevisionSql } = await import('@openbooks/engine/src/document-revision.ts');
const { installApp } = await import('./store');
const base = { type:'custom_field',targetTable:'parties',key:'review_field',label:'Review field',fieldType:'text',config:{} };
function bundle(field: Record<string,unknown>, version='1.0.0') {
  return {manifest:{key:'field-controls-review',name:'Field controls',version,permissions:[],frontend:{entry:'frontend/index.html'}},files:[{path:'frontend/index.html',content:'<p>Review</p>'},{path:'objects/field.json',content:JSON.stringify({...base,...field})}]};
}
const invalid: [string,Record<string,unknown>][] = [
 ['boolean label',{label:true}],['string required',{isRequired:'false'}],['array key',{key:['review_field']}],
 ['invalid kind',{targetKind:'not_a_record_kind'}],['array config',{config:[]}],['unsupported file type',{fieldType:'file'}],
 ['reversed bounds',{fieldType:'currency',config:{min:'100',max:'1'}}],['invalid default',{fieldType:'currency',config:{defaultValue:'wrong'}}],
 ['duplicate options',{fieldType:'select',config:{options:['One','One']}}],['missing options',{fieldType:'select'}],
 ['invalid reference target',{fieldType:'reference',config:{referenceTable:'users'}}],['reserved document key',{targetTable:'documents',key:'total'}],
];
for(const [name,field] of invalid) test(`app custom fields reject ${name} before installation`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();
 try{
  const actor=(await seedFlowActors(org.orgId)).adminId;
  await assert.rejects(()=>withOrgContext(org.orgId,()=>installApp(org.orgId,actor,bundle(field))),error=>(error as {status?:number}).status===400);
  const result=(await db.execute(sql`select (select count(*)::int from apps where org_id=${org.orgId}) as apps,(select count(*)::int from custom_field_defs where org_id=${org.orgId}) as definitions,(select count(*)::int from audit_log where org_id=${org.orgId}) as audits`)).rows[0];
  assert.deepEqual(result,{apps:0,definitions:0,audits:0});
 }finally{await dropScratchOrg(org.orgId)}
});
for(const scenario of ['create evidence','upgrade evidence','create audit failure','upgrade audit failure','disabled project target']) test(`app custom fields: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();let cleanup=async()=>{};
 try{
  const actor=(await seedFlowActors(org.orgId)).adminId;
  const install=(field:Record<string,unknown>,version='1.0.0')=>withOrgContext(org.orgId,()=>installApp(org.orgId,actor,bundle(field,version)));
  const definition=async()=>(await db.execute(sql`select f.*,${documentRevisionSql(sql`created_at`)} as created_at,${documentRevisionSql(sql`updated_at`)} as updated_at from custom_field_defs f where org_id=${org.orgId}`)).rows[0];
  const audits=async()=>(await db.execute(sql`select * from audit_log where org_id=${org.orgId} and table_name='custom_field_defs' order by at,id`)).rows;
  if(scenario==='disabled project target'){
   await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"projects":false}'::jsonb) where id=${org.orgId}`);
   await assert.rejects(()=>install({targetTable:'projects'}),error=>(error as {status?:number}).status===404);
   assert.equal(await definition(),undefined);return;
  }
  const upgrade=scenario.startsWith('upgrade');
  if(upgrade)await install({fieldType:'currency',config:{min:'1',max:'2',defaultValue:'1.5',extension:{keep:true}}});
  if(scenario==='upgrade evidence')await db.execute(sql`update custom_field_defs set updated_at=now()+interval '1 day' where org_id=${org.orgId}`);
  const before=await definition();
  if(scenario.endsWith('audit failure')){
   const name='app_cf_audit_'+randomUUID().replaceAll('-','');
   await db.execute(sql.raw(`create function public."${name}"() returns trigger language plpgsql as $$ begin if new.table_name='custom_field_defs' and new.actor_id='${actor}'::uuid then raise exception 'forced app custom-field audit failure'; end if; return new; end $$; create trigger "${name}" before insert on audit_log for each row execute function public."${name}"();`));
   cleanup=async()=>{await db.execute(sql.raw(`drop trigger if exists "${name}" on audit_log; drop function if exists public."${name}"();`))};
   const snapshot=async()=>(await db.execute(sql`select (select jsonb_agg(to_jsonb(a) order by a.id) from apps a where org_id=${org.orgId}) as apps,(select jsonb_agg(to_jsonb(v) order by v.id) from app_versions v where org_id=${org.orgId}) as versions,(select jsonb_agg(to_jsonb(f) order by f.id) from custom_field_defs f where org_id=${org.orgId}) as definitions,(select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where org_id=${org.orgId}) as audits`)).rows;
   const original=await snapshot();await assert.rejects(()=>install({label:'Must roll back'},upgrade?'1.0.1':'1.0.0'));assert.deepEqual(await snapshot(),original);return;
  }
  await install({fieldType:'currency',label:upgrade?'Renamed field':'Review field',config:{min:' +0001.0000 ',max:'2.0000',defaultValue:'1.5',extension:{keep:true}}},upgrade?'1.0.1':'1.0.0');
  const after=await definition();assert.ok(after);assert.deepEqual(after.config,{min:'1',max:'2',defaultValue:'1.5',extension:{keep:true}});
  const evidence=await audits();assert.equal(evidence.length,upgrade?2:1);const last=evidence.at(-1)!;
  assert.equal(last.actor_id,actor);assert.equal(last.row_id,after.id);assert.equal(last.action,upgrade?'update':'insert');assert.ok(last.at);
  const changes=last.changes as {before?:unknown;after:unknown;source:{appKey:string;appVersionId:string}};
  assert.deepEqual(changes.after,JSON.parse(JSON.stringify(after)));assert.deepEqual(changes.before,before?JSON.parse(JSON.stringify(before)):undefined);
  assert.equal(changes.source.appKey,'field-controls-review');assert.equal(typeof changes.source.appVersionId,'string');
  if(before)assert.ok(String(after.updated_at)>String(before.updated_at));
 }finally{await cleanup();await dropScratchOrg(org.orgId)}
});


test('app field upgrades preserve target identity', {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
 const org=await createScratchOrg();
 try{
  const actor=(await seedFlowActors(org.orgId)).adminId;
  const install=(kind:string,version:string)=>withOrgContext(org.orgId,()=>installApp(org.orgId,actor,bundle({targetTable:'documents',targetKind:kind},version)));
  await install('vendor_bill','1.0.0');
  await assert.rejects(()=>install('customer_invoice','1.0.1'),error=>(error as {status?:number}).status===400);
  const result=(await db.execute(sql`select target_kind from custom_field_defs where org_id=${org.orgId}`)).rows;
  assert.deepEqual(result,[{target_kind:'vendor_bill'}]);
  assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from app_versions where org_id=${org.orgId}`)).rows[0]!.n,1);
 }finally{await dropScratchOrg(org.orgId)}
});

test('app field installation rechecks a feature after a competing disable commits', {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
 const org=await createScratchOrg();const {default:pg}=await import('pg');const {featureGateLockKey}=await import('../features');
 const holder=new pg.Client({connectionString:process.env.OPENBOOKS_DB_URL});let pending:Promise<unknown>|undefined;
 await holder.connect();
 try{
  const actor=(await seedFlowActors(org.orgId)).adminId;
  await holder.query('begin');
  const pid=(await holder.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
  await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[featureGateLockKey(org.orgId)]);
  await holder.query(`update orgs set settings=jsonb_set(settings,'{features}','{"projects":false}'::jsonb) where id=$1`,[org.orgId]);
  pending=withOrgContext(org.orgId,()=>installApp(org.orgId,actor,bundle({targetTable:'projects'})));pending.catch(()=>{});
  let waiting=false;
  for(let attempt=0;attempt<100;attempt++){
   const row=(await db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as waiting`)).rows[0]!;
   if(row.waiting){waiting=true;break}await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok(waiting,'installation must wait at the feature fence');
  await holder.query('commit');
  await assert.rejects(pending,error=>(error as {status?:number}).status===404);
  assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from custom_field_defs where org_id=${org.orgId}`)).rows[0]!.n,0);
 }finally{await holder.query('rollback');await holder.end();await pending?.catch(()=>{});await dropScratchOrg(org.orgId)}
});

// X5: uninstall preserves provisioned objects but deleted the ownership map with
// the apps row, so every reinstall of the same app 409'd on its own objects.
// Provenance is now recovered from the uninstall audit evidence, restricted to
// objects that existed at uninstall time, and the adoption is itself audited.
test('app reinstall after uninstall re-adopts the objects it provisioned', {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
 const org=await createScratchOrg();
 const {deleteApp}=await import('./store');
 try{
  const actor=(await seedFlowActors(org.orgId)).adminId;
  const recordType={type:'record_type',key:'review-asset',name:'Review asset',pluralName:'Review assets',fields:[{id:'main',fields:[{id:'name',type:'text',label:'Name'}]}]};
  const withType=(version:string)=>{const b=bundle({fieldType:'text',config:{}},version);b.files.push({path:'objects/type.json',content:JSON.stringify(recordType)});return b;};
  const install=(version:string)=>withOrgContext(org.orgId,()=>installApp(org.orgId,actor,withType(version)));
  const objects=async()=>(await db.execute<{types:number;fields:number;apps:number}>(sql`select (select count(*)::int from custom_record_types where org_id=${org.orgId} and key='review-asset') as types,(select count(*)::int from custom_field_defs where org_id=${org.orgId} and key='review_field') as fields,(select count(*)::int from apps where org_id=${org.orgId}) as apps`)).rows[0]!;
  await install('1.0.0');
  assert.deepEqual(await objects(),{types:1,fields:1,apps:1});
  await withOrgContext(org.orgId,()=>deleteApp(org.orgId,actor,'field-controls-review'));
  assert.deepEqual(await objects(),{types:1,fields:1,apps:0},'uninstall preserves provisioned objects');

  await install('1.0.1');
  assert.deepEqual(await objects(),{types:1,fields:1,apps:1},'reinstall upgrades in place, no duplicates');
  const app=(await db.execute<{provisioned:{recordTypes:string[];customFields:string[]}}>(sql`select provisioned from apps where org_id=${org.orgId} and key='field-controls-review'`)).rows[0]!;
  assert.deepEqual(app.provisioned,{recordTypes:['review-asset'],customFields:['parties:review_field']});
  const adoption=(await db.execute<{changes:{event:string;appKey:string;evidenceAuditId:string;after:{provisioned:{recordTypes:string[];customFields:string[]}}}}>(sql`select changes from audit_log where org_id=${org.orgId} and table_name='apps' and changes->>'event'='app_provenance_adopted'`)).rows;
  assert.equal(adoption.length,1);
  assert.equal(adoption[0]!.changes.appKey,'field-controls-review');
  assert.deepEqual(adoption[0]!.changes.after.provisioned,{recordTypes:['review-asset'],customFields:['parties:review_field']});
  const evidence=(await db.execute(sql`select 1 from audit_log where id=${adoption[0]!.changes.evidenceAuditId} and org_id=${org.orgId} and changes->>'event'='app_uninstall'`)).rows;
  assert.equal(evidence.length,1,'adoption cites the uninstall evidence it relied on');

  // A same-key object authored AFTER the uninstall is the user's, not the app's.
  await withOrgContext(org.orgId,()=>deleteApp(org.orgId,actor,'field-controls-review'));
  await db.execute(sql`delete from custom_field_defs where org_id=${org.orgId} and key='review_field'`);
  await db.execute(sql`insert into custom_field_defs (org_id,target_table,key,label,field_type,config,created_by,updated_by) values (${org.orgId},'parties','review_field','User field','text','{}'::jsonb,${actor},${actor})`);
  await assert.rejects(()=>install('1.0.2'),error=>(error as {status?:number}).status===409);
  assert.equal((await objects()).apps,0,'the refused install rolled back');
 }finally{await dropScratchOrg(org.orgId)}
});
