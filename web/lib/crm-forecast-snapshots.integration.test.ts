import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
import * as React from 'react';
Object.assign(globalThis, { React });
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __forecastSnapshotSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__forecastSnapshotSession.user}' };
  if (specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");

const {randomUUID}=await import('node:crypto');
const {ensureCrmDefaults}=await import('@openbooks/engine/src/crm.ts');
const {POST,GET}=await import('../app/api/crm/forecasts/route');
const {NextRequest}=await import('next/server');
const enabled={skip:!process.env.OPENBOOKS_DB_URL};
const period={periodStart:'2026-07-01',periodEnd:'2026-07-31'};
const request=(body:Record<string,unknown>)=>new NextRequest('http://audit.local',{method:'POST',body:JSON.stringify({...period,...body})});
async function fixture(action:(org:Awaited<ReturnType<typeof createScratchOrg>>,actor:string)=>Promise<void>){
 const org=await createScratchOrg();
 try {
  const actor=await createScratchUser(org.orgId,'Forecast reviewer','reviewer');
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`);
  session.user={id:actor,orgId:org.orgId,name:'Reviewer',email:'reviewer@example.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
  await ensureCrmDefaults(org.orgId,actor);
  await withOrgContext(org.orgId,()=>action(org,actor));
 }finally{session.user=null;await dropScratchOrg(org.orgId);}
}
async function pipeline(org:Awaited<ReturnType<typeof createScratchOrg>>,actor:string,currencies:string[]){
 for(const currency of currencies){
  const id=randomUUID();
  await db.execute(sql`insert into crm_opportunities(id,org_id,opportunity_number,title,party_id,owner_user_id,status_id,currency,is_active,projected_amount,weighted_amount,expected_close_date)
   select ${id},${org.orgId},${id},'Currency-specific work',${org.customerId},${actor},id,${currency},true,100,50,'2026-07-15'
   from crm_opportunity_statuses where org_id=${org.orgId} and is_default and not is_closed limit 1`);
 }
}

test('an empty forecast saves explicit zero evidence in the organization reporting currency',enabled,async()=>fixture(async(org)=>{
 const response=await POST(request({}));
 assert.equal(response.status,201);
 const body=await response.json();
 assert.equal(body.ids.length,1);
 const rows=(await db.execute<{currency:string;pipeline_amount:string;weighted_amount:string;detail:Record<string,unknown>}>(sql`select currency,pipeline_amount::text,weighted_amount::text,detail from crm_forecast_snapshots where org_id=${org.orgId}`)).rows;
 assert.equal(rows.length,1);
 assert.equal(rows[0]!.currency,'CAD');
 assert.equal(rows[0]!.pipeline_amount,'0.0000');
 assert.equal(rows[0]!.weighted_amount,'0.0000');
 assert.equal(rows[0]!.detail.emptyPipeline,true);
 assert.equal(rows[0]!.detail.currencySource,'organization_base_currency');
}));

test('forecast routes reject impossible dates before any snapshot write',enabled,async()=>fixture(async(org)=>{
 for(const day of ['2026-02-30','2026-13-01','2026-00-15']){
  const posted=await POST(request({periodStart:day,periodEnd:'2027-01-01'}));
  assert.equal(posted.status,422);
  const read=await GET(new NextRequest('http://audit.local?periodStart='+day+'&periodEnd=2027-01-01'));
  assert.equal(read.status,422);
 }
 assert.equal((await db.execute(sql`select id from crm_forecast_snapshots where org_id=${org.orgId}`)).rows.length,0);
}));

test('multi-currency overrides require one currency and never duplicate money across currencies',enabled,async()=>fixture(async(org,actor)=>{
 await pipeline(org,actor,['CAD','USD']);
 const ambiguous=await POST(request({overrideAmount:'250'}));
 assert.equal(ambiguous.status,422,await ambiguous.clone().text());
 assert.equal((await db.execute(sql`select id from crm_forecast_snapshots where org_id=${org.orgId}`)).rows.length,0);
 const selected=await POST(request({overrideAmount:'250',currency:'usd'}));
 assert.equal(selected.status,201,await selected.clone().text());
 assert.equal((await selected.json()).ids.length,1);
 const rows=(await db.execute<{currency:string;override_amount:string}>(sql`select currency,override_amount::text from crm_forecast_snapshots where org_id=${org.orgId}`)).rows;
 assert.deepEqual(rows,[{currency:'USD',override_amount:'250.0000'}]);
 const calculated=await POST(request({}));
 assert.equal(calculated.status,201);
 assert.equal((await calculated.json()).ids.length,2,'calculated snapshots preserve every original currency');
}));

test('a single-currency override retains its unambiguous currency and snapshot kinds cannot contradict their amounts',enabled,async()=>fixture(async(org,actor)=>{
 await pipeline(org,actor,['USD']);
 const accepted=await POST(request({overrideAmount:'250'}));
 assert.equal(accepted.status,201);
 const rows=(await db.execute<{currency:string;override_amount:string}>(sql`select currency,override_amount::text from crm_forecast_snapshots where org_id=${org.orgId}`)).rows;
 assert.deepEqual(rows,[{currency:'USD',override_amount:'250.0000'}]);
 for(const body of [{snapshotKind:'calculated',overrideAmount:'250'},{snapshotKind:'rep_override'},{snapshotKind:'manager_override'},{currency:'invalid'}]){
  const refused=await POST(request(body));
  assert.equal(refused.status,422,JSON.stringify(body));
 }
 assert.equal((await db.execute(sql`select id from crm_forecast_snapshots where org_id=${org.orgId}`)).rows.length,1);
}));

test('an override for an empty pipeline requires an explicit currency',enabled,async()=>fixture(async(org)=>{
 const ambiguous=await POST(request({overrideAmount:'250'}));
 assert.equal(ambiguous.status,422);
 const accepted=await POST(request({overrideAmount:'250',currency:'USD'}));
 assert.equal(accepted.status,201,await accepted.clone().text());
 const rows=(await db.execute<{currency:string;override_amount:string;pipeline_amount:string}>(sql`select currency,override_amount::text,pipeline_amount::text from crm_forecast_snapshots where org_id=${org.orgId}`)).rows;
 assert.deepEqual(rows,[{currency:'USD',override_amount:'250.0000',pipeline_amount:'0.0000'}]);
}));

test('the forecast page clamps impossible dates before issuing its report queries',enabled,async()=>fixture(async()=>{
 const {default:Page}=await import('../app/(app)/crm/forecasts/page');
 await assert.doesNotReject(Page({searchParams:Promise.resolve({periodStart:'2026-02-30',periodEnd:'2026-03-31'})}));
}));
