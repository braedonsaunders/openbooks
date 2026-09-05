import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { db, env, withOrgTransaction } from '@openbooks/engine/src/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/test-fixtures.ts';

const state: { gate: { user: { orgId: string; id: string } } | null } = { gate: null };
Object.assign(globalThis, { __rateBookDefaultControls: state });
const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.endsWith('/lib/authz') && context.parentURL?.includes('/api/admin/setup/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardPermission(){return globalThis.__rateBookDefaultControls.gate}' };
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

test('rate book deletion cannot remove a concurrently promoted default', {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();const writer=new pg.Client({connectionString:env.OPENBOOKS_DB_URL});let pending:Promise<Response>|undefined;
 try{
  await authenticate(org);
  const prior=await send('POST','item-rate-books',{code:'PRIOR',name:'Prior default',isDefault:true,isActive:true});assert.equal(prior.status,200);const priorId=(await prior.json()).id;
  const next=await send('POST','item-rate-books',{code:'NEXT',name:'Next default',isDefault:false,isActive:true});assert.equal(next.status,200);const nextId=(await next.json()).id;
  await writer.connect();await writer.query('begin');
  await writer.query('update item_rate_books set is_default=false where id=$1',[priorId]);
  await writer.query('update item_rate_books set is_default=true where id=$1',[nextId]);
  const pid=(await writer.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
  pending=send('DELETE','item-rate-books',{id:nextId});void pending.catch(()=>{});
  let blocked=false;const deadline=Date.now()+10000;
  while(Date.now()<deadline){
   if((await writer.query<{blocked:boolean}>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',[pid])).rows[0]!.blocked){blocked=true;break;}
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(blocked,'deletion waits behind the concurrent promotion');await writer.query('commit');
  const response=await pending;assert.equal(response.status,409,JSON.stringify(await response.json()));
  assert.equal((await row('item_rate_books',nextId))?.is_default,true);
  assert.equal((await db.execute(sql`select id from audit_log where row_id=${nextId} and action='delete'`)).rows.length,0);
 }finally{await writer.query('rollback').catch(()=>{});await pending?.catch(()=>{});await writer.end();state.gate=null;await dropScratchOrg(org.orgId);}
});

for(const isDefault of [false,true]){
 test(`rate book deletion ${isDefault?'refuses a current default':'audits an unused nondefault'}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   await authenticate(org);
   const prior=await send('POST','item-rate-books',{code:'PRIOR',name:'Prior book',isDefault:true,isActive:true});assert.equal(prior.status,200);
   const created=await send('POST','item-rate-books',{code:'TARGET',name:'Target book',isDefault,isActive:true});assert.equal(created.status,200);const {id}=await created.json();const before=await row('item_rate_books',id);
   const response=await send('DELETE','item-rate-books',{id});assert.equal(response.status,isDefault?409:200,JSON.stringify(await response.json()));
   if(isDefault){assert.deepEqual(await row('item_rate_books',id),before);assert.equal((await db.execute(sql`select id from audit_log where row_id=${id} and action='delete'`)).rows.length,0);}
   else{assert.equal(await row('item_rate_books',id),undefined);assert.deepEqual((await evidence(id,'delete')).changes,json({before}));}
  }finally{state.gate=null;await dropScratchOrg(org.orgId);}
 });
}

test('a committed rate-book deletion makes a waiting promotion refuse the missing record',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 let ready!:(pid:number)=>void,failReady!:(error:unknown)=>void;const started=new Promise<number>((resolve,reject)=>{ready=resolve;failReady=reject;});
 let deleting:Promise<unknown>|undefined,promoting:Promise<Response>|undefined;
 try{
  await authenticate(org);const body={code:'PRIOR',name:'Prior default',isDefault:true,isActive:true};
  const prior=await send('POST','item-rate-books',body);assert.equal(prior.status,200);const priorId=(await prior.json()).id;
  const next=await send('POST','item-rate-books',{...body,code:'TARGET',name:'Target book',isDefault:false});assert.equal(next.status,200);const nextId=(await next.json()).id;
  deleting=withOrgTransaction(org.orgId,async()=>{
   const response=await send('DELETE','item-rate-books',{id:nextId});assert.equal(response.status,200);
   ready((await db.execute<{pid:number}>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);await gate;
  });void deleting.catch(failReady);const pid=await started;
  promoting=send('PATCH','item-rate-books',{id:nextId,name:'Target book',isDefault:true,isActive:true});void promoting.catch(()=>{});
  let blocked=false;const deadline=Date.now()+10000;
  while(Date.now()<deadline){
   if((await db.execute<{blocked:boolean}>(sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as blocked`)).rows[0]!.blocked){blocked=true;break;}
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(blocked,'promotion shares the deletion lock');release();await deleting;
  const response=await promoting;assert.equal(response.status,404,JSON.stringify(await response.json()));
  assert.equal((await row('item_rate_books',priorId))?.is_default,true);
  assert.equal(await row('item_rate_books',nextId),undefined);
 }finally{release();await deleting?.catch(()=>{});await promoting?.catch(()=>{});state.gate=null;await dropScratchOrg(org.orgId);}
});

test('rate-book deletion cannot read or remove a foreign tenant default', {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg(),other=await createScratchOrg();
 try{
  await authenticate(org);const created=await send('POST','item-rate-books',{code:'ISOLATED',name:'Isolated default',isDefault:true,isActive:true});assert.equal(created.status,200);const {id}=await created.json();const before=await row('item_rate_books',id);
  await authenticate(other);const response=await send('DELETE','item-rate-books',{id});assert.equal(response.status,404);
  assert.deepEqual(await row('item_rate_books',id),before);
 }finally{state.gate=null;await dropScratchOrg(org.orgId);await dropScratchOrg(other.orgId);}
});
