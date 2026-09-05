import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __emailRevisionSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__emailRevisionSession.user}' };
  if (specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { POST } = await import("../app/api/documents/[id]/void/route");
const { DELETE } = await import("../app/api/documents/[id]/route");
for (const operation of ['void stale','void current','void missing','delete stale','delete current','delete missing']) {
test(`interactive document lifecycle: ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async()=>{
 const org=await createScratchOrg();
 try{
  const {randomUUID}=await import('node:crypto');
  const actor=await createScratchUser(org.orgId,'Document controller','reviewer');
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
  session.user={id:actor,orgId:org.orgId,name:'Document controller',email:'doc@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
  const id=randomUUID();
  await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,party_id,subsidiary_id,currency) values (${id},${org.orgId},'customer_invoice',${id},${org.date},${org.customerId},${org.subsidiaryId},'CAD')`);
  await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount) values (${org.orgId},${id},1,${org.accounts.revenue},1,'100','100')`);
  if (operation.startsWith('void')) await db.execute(sql`update documents set status='approved' where id=${id}`);
  const token=(await db.execute<{revision:string}>(sql`select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision from documents where id=${id}`)).rows[0]!.revision;
  if (operation.endsWith('stale')) await db.execute(sql`update documents set memo='Concurrent change',updated_at=updated_at+interval '1 microsecond' where id=${id}`);
  const response=await withOrgContext(org.orgId,()=>(operation.startsWith('void') ? POST : DELETE)(new Request('http://audit.local/api/documents/'+id+'/void',{method:operation.startsWith('void') ? 'POST' : 'DELETE',body:JSON.stringify({reason:'Cancel reviewed invoice',reversalDate:org.date,expectedUpdatedAt:operation.endsWith('missing') ? undefined : token})}),{params:Promise.resolve({id})}));
  assert.equal(response.status,operation.endsWith('current') ? 200 : 409,JSON.stringify(await response.json()));
  const row=(await db.execute<{status:string}>(sql`select status from documents where id=${id}`)).rows[0];
  if (operation==='delete current') assert.equal(row,undefined);
  else assert.equal(row?.status, operation==='void current' ? 'voided' : operation.startsWith('void') ? 'approved' : 'draft');
 }finally{session.user=null;await dropScratchOrg(org.orgId);}
});
}
