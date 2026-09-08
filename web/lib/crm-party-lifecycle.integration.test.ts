import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __crmPartyLifecycleSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__crmPartyLifecycleSession.user}' };
  if (specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, pool, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { PATCH, GET } = await import("../app/api/parties/[id]/route");

const { randomUUID } = await import('node:crypto');
const { ensureCrmDefaults } = await import('@openbooks/engine/src/crm.ts');
const { POST: draft } = await import('../app/api/crm/opportunities/draft/route');
const { PATCH: edit } = await import('../app/api/crm/opportunities/[id]/route');
const { NextRequest } = await import('next/server');
type Fixture = Awaited<ReturnType<typeof createScratchOrg>>;
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patchRequest = (body: unknown) => new Request('http://audit.local', {method:'PATCH',body:JSON.stringify(body)});
async function fixture(action: (org: Fixture, open: string, closed: string) => Promise<void>) {
 const org=await createScratchOrg();
 try {
  const actor=await createScratchUser(org.orgId,'Lifecycle reviewer','reviewer');
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"crm":true}'::jsonb) where id=${org.orgId}`);
  session.user={id:actor,orgId:org.orgId,name:'Reviewer',email:'reviewer@example.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
  await ensureCrmDefaults(org.orgId,actor);
  const statuses=(await db.execute<{id:string;is_closed:boolean}>(sql`select id,is_closed from crm_opportunity_statuses where org_id=${org.orgId} and is_active and not is_won order by is_default desc`)).rows;
  await action(org,statuses.find(s=>!s.is_closed)!.id,statuses.find(s=>s.is_closed)!.id);
 } finally {session.user=null;await dropScratchOrg(org.orgId);}
}
async function opportunity(org: Fixture, status: string, active=true) {
 const id=randomUUID();
 await db.execute(sql`insert into crm_opportunities(id,org_id,opportunity_number,title,party_id,status_id,currency,is_active)
  values(${id},${org.orgId},${id},'Customer work',${org.customerId},${status},'CAD',${active})`);
 return id;
}
async function retirement(org: Fixture) {
 const before=await withOrgContext(org.orgId,()=>GET(new Request('http://audit.local'),params(org.customerId)));
 assert.equal(before.status,200);
 const body=await before.json();
 return patchRequest({isActive:false,changeReason:'Account retirement review',expectedUpdatedAt:body.party.updated_at});
}
async function blockedBy(pid: number) {
 const until=Date.now()+5000;
 while(Date.now()<until){
  const rows=await pool.query('select 1 from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid))',[pid]);
  if(rows.rowCount) return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.fail('the competing write did not wait on the party lock');
}

test('party retirement refuses open opportunities without changing state or audit history', enabled, async()=>fixture(async(org,open,closed)=>{
 const id=await opportunity(org,open);
 const before=(await db.execute<{n:string}>(sql`select count(*)::text as n from audit_log where org_id=${org.orgId}`)).rows[0]!.n;
 const response=await withOrgContext(org.orgId,async()=>PATCH(await retirement(org),params(org.customerId)));
 assert.equal(response.status,422,await response.clone().text());
 assert.match((await response.json()).error,/open opportunities/i);
 assert.equal((await db.execute<{is_active:boolean}>(sql`select is_active from parties where id=${org.customerId}`)).rows[0]!.is_active,true);
 assert.equal((await db.execute<{n:string}>(sql`select count(*)::text as n from audit_log where org_id=${org.orgId}`)).rows[0]!.n,before);
 await db.execute(sql`update crm_opportunities set status_id=${closed} where id=${id}`);
 const accepted=await withOrgContext(org.orgId,async()=>PATCH(await retirement(org),params(org.customerId)));
 assert.equal(accepted.status,200,await accepted.clone().text());
 assert.equal((await db.execute<{is_active:boolean}>(sql`select is_active from parties where id=${org.customerId}`)).rows[0]!.is_active,false);
}));

test('inactive accounts refuse new and reopened opportunities but allow closing legacy work', enabled, async()=>fixture(async(org,open,closed)=>{
 const id=await opportunity(org,open);
 await db.execute(sql`update parties set is_active=false where id=${org.customerId}`);
 const created=await withOrgContext(org.orgId,()=>draft(new NextRequest('http://audit.local',{method:'POST',body:JSON.stringify({partyId:org.customerId})})));
 assert.equal(created.status,422,await created.clone().text());
 const activated=await withOrgContext(org.orgId,()=>edit(patchRequest({isActive:true}),params(id)));
 assert.equal(activated.status,422,await activated.clone().text());
 const finished=await withOrgContext(org.orgId,()=>edit(patchRequest({statusId:closed,winLossReason:'Customer account retired'}),params(id)));
 assert.equal(finished.status,200,await finished.clone().text());
 const reopened=await withOrgContext(org.orgId,()=>edit(patchRequest({statusId:open,isActive:true}),params(id)));
 assert.equal(reopened.status,422,await reopened.clone().text());
 assert.equal((await db.execute<{status_id:string}>(sql`select status_id from crm_opportunities where id=${id}`)).rows[0]!.status_id,closed);
}));

test('retirement rechecks open work after waiting for the account lock', enabled, async()=>fixture(async(org,open)=>{
 const request=await retirement(org);
 const client=await pool.connect();
 let pending:Promise<Response>|undefined;
 try {
  await client.query('begin');
  const pid=(await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
  await client.query('select id from parties where id=$1 for update',[org.customerId]);
  pending=withOrgContext(org.orgId,()=>PATCH(request,params(org.customerId)));
  await blockedBy(pid);
  const id=randomUUID();
  await client.query('insert into crm_opportunities(id,org_id,opportunity_number,title,party_id,status_id,currency,is_active) values($1,$2,$7,$3,$4,$5,$6,true)',[id,org.orgId,'Concurrent open work',org.customerId,open,'CAD',id]);
  await client.query('commit');
  const response=await pending;
  assert.equal(response.status,422,await response.clone().text());
  assert.equal((await db.execute<{is_active:boolean}>(sql`select is_active from parties where id=${org.customerId}`)).rows[0]!.is_active,true);
 } finally {await client.query('rollback');client.release();await pending?.catch(()=>{});}
}));

test('opportunity activation rechecks account retirement after waiting for its lock', enabled, async()=>fixture(async(org,open)=>{
 const id=await opportunity(org,open,false);
 const client=await pool.connect();
 let pending:Promise<Response>|undefined;
 try {
  await client.query('begin');
  const pid=(await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
  await client.query('update parties set is_active=false where id=$1',[org.customerId]);
  pending=withOrgContext(org.orgId,()=>edit(patchRequest({isActive:true}),params(id)));
  await blockedBy(pid);
  await client.query('commit');
  const response=await pending;
  assert.equal(response.status,422,await response.clone().text());
  assert.equal((await db.execute<{is_active:boolean}>(sql`select is_active from crm_opportunities where id=${id}`)).rows[0]!.is_active,false);
 } finally {await client.query('rollback');client.release();await pending?.catch(()=>{});}
}));
