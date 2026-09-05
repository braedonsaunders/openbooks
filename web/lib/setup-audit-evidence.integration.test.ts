import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { db, env } from '@openbooks/engine/src/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/test-fixtures.ts';

const state: { gate: { user: { orgId: string; id: string } } | null } = { gate: null };
Object.assign(globalThis, { __setupEvidence: state });
const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.endsWith('/lib/authz') && context.parentURL?.includes('/api/admin/setup/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardPermission(){return globalThis.__setupEvidence.gate}' };
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

test('root subsidiary metadata saves while structural protections remain enforced', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await authenticate(org);
    const before = await row('subsidiaries',org.subsidiaryId);
    const body = {id:org.subsidiaryId,name:'Reviewed root',legalName:'Reviewed legal name',country:'CA',parentId:null,isActive:true,isElimination:false};
    const saved = await send('PATCH','subsidiaries',body);
    assert.equal(saved.status,200,JSON.stringify(await saved.json()));
    const after = await row('subsidiaries',org.subsidiaryId);
    const audit = await evidence(org.subsidiaryId,'update');
    assert.deepEqual(audit.changes,json({before,after}));assert.equal(audit.actor_id,actorId);
    for (const change of [{parentId:org.subsidiaryId},{isActive:false}]) {
      const response = await send('PATCH','subsidiaries',{...body,...change});
      assert.equal(response.status,400,JSON.stringify(await response.json()));
    }
    const deleted = await send('DELETE','subsidiaries',{id:org.subsidiaryId});
    assert.equal(deleted.status,400,JSON.stringify(await deleted.json()));
    assert.deepEqual(await row('subsidiaries',org.subsidiaryId),after);
  } finally {state.gate=null;await dropScratchOrg(org.orgId);}
});

for (const action of ['insert','update','delete'] as const) {
  test(`generic setup ${action} stores its actual configuration snapshots`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId=await authenticate(org);
      const body={code:'EVIDENCE',name:'Evidence department',isActive:true};
      const created=await send('POST','departments',body);assert.equal(created.status,200,JSON.stringify(await created.clone().json()));
      const {id}=await created.json();const before=await row('departments',id);
      let expected:Record<string,unknown>={after:before};
      if(action==='update') {
        const response=await send('PATCH','departments',{...body,id,name:'Changed department'});assert.equal(response.status,200);
        expected={before,after:await row('departments',id)};
      } else if(action==='delete') {
        const response=await send('DELETE','departments',{id});assert.equal(response.status,200);expected={before};
      }
      const audit=await evidence(id,action);assert.deepEqual(audit.changes,json(expected));assert.equal(audit.actor_id,actorId);
    } finally {state.gate=null;await dropScratchOrg(org.orgId);}
  });
}

test('tax group evidence preserves ordered members through creation, edit and deletion', {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();
 try{
  await authenticate(org);const members:string[]=[];
  for(const code of ['EVIDENCE-A','EVIDENCE-B']){
   const response=await send('POST','tax-codes',{code,name:code,isActive:true});assert.equal(response.status,200);members.push((await response.json()).id);
  }
  const body={code:'EVIDENCE-GROUP',name:'Evidence group',priceIncludesTax:false,isActive:true,members};
  const created=await send('POST','tax-groups',body);assert.equal(created.status,200,JSON.stringify(await created.clone().json()));
  const {id}=await created.json();const before={...await row('tax_groups',id),members};
  assert.deepEqual((await evidence(id,'insert')).changes,json({after:before}));
  const next=[members[1]!,members[0]!];const updated=await send('PATCH','tax-groups',{...body,id,members:next});assert.equal(updated.status,200);
  const after={...await row('tax_groups',id),members:next};assert.deepEqual((await evidence(id,'update')).changes,json({before,after}));
  const deleted=await send('DELETE','tax-groups',{id});assert.equal(deleted.status,200);
  assert.deepEqual((await evidence(id,'delete')).changes,json({before:after}));
 }finally{state.gate=null;await dropScratchOrg(org.orgId);}
});

for (const method of ['POST','PATCH','DELETE'] as const) {
 test(`generic setup ${method} rolls back when evidence cannot be appended`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();let cleanup:(()=>Promise<void>)|undefined;
  try{
   const actorId=await authenticate(org);const body={code:'ATOMIC',name:'Atomic department',isActive:true};
   let id:string|undefined;
   if(method!=='POST') {const response=await send('POST','departments',body);assert.equal(response.status,200);id=(await response.json()).id;}
   const snapshot=async()=>(await db.execute(sql`select (select jsonb_agg(to_jsonb(d) order by id) from departments d where org_id=${org.orgId}) as rows,(select jsonb_agg(to_jsonb(a) order by id) from audit_log a where org_id=${org.orgId} and table_name='departments') as audits`)).rows;
   const before=await snapshot();const name=`setup_audit_${randomUUID().replaceAll('-','')}`;
   await db.execute(sql.raw(`create function public."${name}"() returns trigger language plpgsql as $$ begin if new.table_name='departments' and new.actor_id='${actorId}'::uuid then raise exception 'forced setup audit failure'; end if; return new; end $$; create trigger "${name}" before insert on audit_log for each row execute function public."${name}"();`));
   cleanup=async()=>{await db.execute(sql.raw(`drop trigger if exists "${name}" on audit_log; drop function if exists public."${name}"();`));};
   const response=await send(method,'departments',{...body,id,name:'Unrecorded department'});assert.equal(response.status,400);
   assert.deepEqual(await snapshot(),before);
  }finally{await cleanup?.();state.gate=null;await dropScratchOrg(org.orgId);}
 });
}

test('a referenced tax group refuses deletion and restores all removed members', {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();
 try{
  await authenticate(org);const code=randomUUID(),group=randomUUID(),document=randomUUID(),line=randomUUID();
  await db.execute(sql`insert into tax_codes(id,org_id,code,name,is_active) values(${code},${org.orgId},'REFERENCED','Referenced tax',true)`);
  await db.execute(sql`insert into tax_groups(id,org_id,code,name,is_active) values(${group},${org.orgId},'REFERENCED','Referenced group',true)`);
  await db.execute(sql`insert into tax_group_members(tax_group_id,tax_code_id,sequence) values(${group},${code},1)`);
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total) values(${document},${org.orgId},'vendor_bill','draft','GROUP-REF',${org.subsidiaryId},${org.vendorId},${org.date},'CAD','1','100','0','100')`);
  await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,amount,tax_input_amount,tax_amount,tax_group_id,quantity,unit_price) values(${line},${org.orgId},${document},1,${org.accounts.cogs},'100','100','0',${group},'1','100')`);
  const before=(await db.execute(sql`select * from tax_group_members where tax_group_id=${group}`)).rows;
  const response=await send('DELETE','tax-groups',{id:group});assert.equal(response.status,409);
  assert.ok(await row('tax_groups',group));assert.deepEqual((await db.execute(sql`select * from tax_group_members where tax_group_id=${group}`)).rows,before);
  assert.equal((await db.execute(sql`select id from audit_log where row_id=${group}`)).rows.length,0);
 }finally{state.gate=null;await dropScratchOrg(org.orgId);}
});

test('setup evidence reads the committed before-image after waiting for another writer', {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();const writer=new pg.Client({connectionString:env.OPENBOOKS_DB_URL});let pending:Promise<Response>|undefined;
 try{
  await authenticate(org);const body={code:'CONCURRENT',name:'Original department',isActive:true};
  const created=await send('POST','departments',body);assert.equal(created.status,200);const {id}=await created.json();
  await writer.connect();await writer.query('begin');
  await writer.query('update departments set name=$1 where id=$2',['Concurrent committed name',id]);
  const pid=(await writer.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
  pending=send('PATCH','departments',{...body,id,name:'Final reviewed name'});void pending.catch(()=>{});
  let blocked=false;const deadline=Date.now()+10000;
  while(Date.now()<deadline){
   if((await writer.query<{blocked:boolean}>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',[pid])).rows[0]!.blocked){blocked=true;break;}
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.ok(blocked);await writer.query('commit');assert.equal((await pending).status,200);
  const audit=await evidence(id,'update');assert.equal((audit.changes.before as Record<string,unknown>).name,'Concurrent committed name');
  assert.deepEqual(audit.changes.after,json(await row('departments',id)));
 }finally{await writer.query('rollback').catch(()=>{});await pending?.catch(()=>{});await writer.end();state.gate=null;await dropScratchOrg(org.orgId);}
});

for(const method of ['PATCH','DELETE'] as const){
 test(`setup ${method} cannot snapshot or mutate another tenant's row`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg(),other=await createScratchOrg();
  try{
   await authenticate(org);const body={code:'ISOLATED',name:'Isolated department',isActive:true};
   const created=await send('POST','departments',body);assert.equal(created.status,200);const {id}=await created.json();const before=await row('departments',id);
   await authenticate(other);const response=await send(method,'departments',{...body,id,name:'Cross tenant write'});assert.equal(response.status,404);
   assert.deepEqual(await row('departments',id),before);
   assert.equal((await db.execute(sql`select id from audit_log where org_id=${other.orgId} and row_id=${id}`)).rows.length,0);
  }finally{state.gate=null;await dropScratchOrg(org.orgId);await dropScratchOrg(other.orgId);}
 });
}
