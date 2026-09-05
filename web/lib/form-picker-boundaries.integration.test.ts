import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
const root=pathToFileURL(process.cwd()+'/').href;
const session:{user:SessionUser|null}={user:null};Object.assign(globalThis,{__formPickerSession:session});
registerHooks({resolve(specifier,context,next){
 if(specifier==='server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'};
 if(specifier==='./auth'&&context.parentURL?.endsWith('/web/lib/authz.ts'))return {shortCircuit:true,url:'data:text/javascript,export async function currentUser(){return globalThis.__formPickerSession.user}'};
 if(specifier.startsWith('@/'))return next(root+'web/'+specifier.slice(2)+'.ts',context);
 return next(specifier,context);
}});
const {sql}=await import('drizzle-orm');
const {db,withOrgContext}=await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,createScratchUser,dropScratchOrg}=await import('@openbooks/engine/src/test-fixtures.ts');
const {GET}=await import('../app/api/forms/options/route');
const sources=['parties','parties&partyKind=customer','parties&partyKind=vendor','parties&partyKind=employee','reference&table=parties','reference&table=projects','reference&table=accounts','gl_accounts','reference&table=items'] as const;
for(const source of sources){for(const scope of ['all','restricted','empty'] as const){
 test(`form picker ${source}: ${scope}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg(),foreign=await createScratchOrg();
  try{
   const actor=await createScratchUser(org.orgId,'Scoped picker reviewer','picker');
   const hidden=randomUUID();await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`);
   await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiSubsidiary":true,"projects":true}'::jsonb) where id=${org.orgId}`);
   const restriction=scope==='all'?{mode:'all'}:{mode:'list',subsidiaryIds:scope==='empty'?[]:[org.subsidiaryId]};
   await db.execute(sql`update app_roles set permissions='["*"]'::jsonb,subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='picker'`);
   session.user={id:actor,orgId:org.orgId,name:'Scoped picker',email:'picker@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
   const candidates:{id:string;label:string;visible:boolean}[]=[];
   for(const [kind,tenant,subsidiary,active] of [
    ['visible',org.orgId,org.subsidiaryId,true],['hidden',org.orgId,hidden,true],['shared',org.orgId,null,true],['inactive',org.orgId,org.subsidiaryId,false],['foreign',foreign.orgId,foreign.subsidiaryId,true],
   ] as const){
    if(source.includes('projects')&&kind==='shared')continue;
    const id=randomUUID(),label=`Picker ${kind}`;
    if(source.includes('parties')){
     await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active) values (${id},${tenant},'person',${label},${subsidiary},${active})`);
     for(const table of ['customer_roles','vendor_roles','employee_roles'])await db.execute(sql`insert into ${sql.identifier(table)}(org_id,party_id,is_active) values (${tenant},${id},true)`);
    }else if(source.includes('projects')){
     await db.execute(sql`insert into projects(id,org_id,code,name,subsidiary_id,status,is_active) values (${id},${tenant},${id},${label},${subsidiary},'active',${active})`);
    }else if(source.includes('accounts')){
     await db.execute(sql`insert into accounts(id,org_id,name,type,subsidiary_id,is_active) values (${id},${tenant},${label},'expense',${subsidiary},${active})`);
    }else{
     await db.execute(sql`insert into items(id,org_id,kind,name,is_active) values (${id},${tenant},'service',${label},${active})`);
    }
    const sharedItems=source.endsWith('items');
    candidates.push({id,label,visible:tenant===org.orgId&&active&&(sharedItems||scope==='all'||(scope==='restricted'&&(kind==='visible'||kind==='shared')))});
   }
   const response=await withOrgContext(org.orgId,()=>GET(new Request(`http://audit.local/api/forms/options?source=${source}`)));
   const data=await response.json() as {options:{value:string;label:string}[]};assert.equal(response.status,200,JSON.stringify(data));
   for(const candidate of candidates){
    const option=data.options.find(row=>row.value===candidate.id);
    assert.equal(!!option,candidate.visible,`${candidate.label} visibility`);
    if(candidate.visible)assert.equal(option!.label.trim(),candidate.label,'every valid option has a readable label');
   }
  }finally{session.user=null;await dropScratchOrg(org.orgId);await dropScratchOrg(foreign.orgId)}
 });
}}
for(const enabled of [false,true])test(`project reference picker parent gate ${enabled}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();
 try{
  const actor=await createScratchUser(org.orgId,'Project picker','picker');
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}',${JSON.stringify(enabled)}::jsonb,true) where id=${org.orgId}`);
  session.user={id:actor,orgId:org.orgId,name:'Project picker',email:'picker@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
  const id=randomUUID();await db.execute(sql`insert into projects(id,org_id,code,name,subsidiary_id,status,is_active) values (${id},${org.orgId},${id},'Retained project',${org.subsidiaryId},'active',true)`);
  const response=await withOrgContext(org.orgId,()=>GET(new Request('http://audit.local/api/forms/options?source=reference&table=projects')));
  assert.equal(response.status,enabled?200:404);
  assert.equal((await db.execute(sql`select count(*)::int as count from projects where id=${id}`)).rows[0]!.count,1,'feature disable preserves the project');
 }finally{session.user=null;await dropScratchOrg(org.orgId)}
});
