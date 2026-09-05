import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __billingSourceSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingSourceSession.user}' };
  if (specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { randomUUID }=await import('node:crypto');
const {createBillingRequest}=await import('./billing-requests');
const {generateInvoiceFromBillingRequest}=await import('./billing');
for(const scenario of ['hidden cost','concurrent time','project move']) {
 test(`billing sources: ${scenario}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  let release=()=>{};let holder:Promise<unknown>|undefined;let runs:Promise<unknown>[]=[];
  try{
   const actor=await createScratchUser(org.orgId,'Billing controller','reviewer');
   const project=randomUUID();
   await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${org.subsidiaryId},'SOURCE','Source controls',${org.customerId},'active',true)`);
   const make=()=>createBillingRequest(org.orgId,actor,{projectId:project,basis:'date_range',cutoffDate:org.date,backupRequired:false});
   const first=await make();
   if(scenario==='project move') {
    const other=randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Moved project','CAD','CA')`);
    let ready=()=>{};const locked=new Promise<void>(r=>{ready=r});const finish=new Promise<void>(r=>{release=r});
    holder=db.transaction(async tx=>{await tx.execute(sql`update projects set subsidiary_id=${other} where id=${project}`);ready();await finish;});
    await Promise.race([locked,holder]);
    runs=[generateInvoiceFromBillingRequest(org.orgId,actor,first.id,new Set([org.subsidiaryId]))];
    const outcomes=Promise.allSettled(runs);let blocked=0;const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      blocked=(await db.execute<{n:number}>(sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query ilike '%from billing_requests br%'`)).rows[0]!.n;
      if(blocked)break;await new Promise(r=>setTimeout(r,25));
    }
    assert.ok(blocked,'invoice generation waits for the concurrent project reassignment');
    release();await holder;
    const [result]=await outcomes;
    assert.equal(result?.status,'rejected');
    if(result?.status==='rejected') assert.match(String(result.reason),/Billing request not found/);
    assert.equal((await db.execute(sql`select status from billing_requests where id=${first.id}`)).rows[0]?.status,'open');
   }else if(scenario==='hidden cost') {
    const other=randomUUID(),source=randomUUID(),line=randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Hidden costs','CAD','CA')`);
    await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,subsidiary_id,party_id,project_id,currency) values (${source},${org.orgId},'vendor_bill',${source},${org.date},${other},${org.vendorId},${project},'CAD')`);
    await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,quantity,unit_price,amount,is_billable) values (${line},${org.orgId},${source},1,${org.accounts.cogs},1,100,100,true)`);
    await db.execute(sql`update documents set status='approved' where id=${source}`);
    await assert.rejects(generateInvoiceFromBillingRequest(org.orgId,actor,first.id,new Set([org.subsidiaryId])),/outside.*access/i);
    assert.equal((await db.execute(sql`select billed_by_line_id from document_lines where id=${line}`)).rows[0]?.billed_by_line_id,null);
    assert.equal((await db.execute(sql`select status from billing_requests where id=${first.id}`)).rows[0]?.status,'open');
   }else{
    const second=await make(),employee=randomUUID(),entry=randomUUID();
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Billable worker',${org.subsidiaryId})`);
    await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate) values (${entry},${org.orgId},${employee},${org.date},1,${project},${org.items.service},true,'approved',100)`);
    let ready=()=>{};const locked=new Promise<void>(r=>{ready=r});const finish=new Promise<void>(r=>{release=r});
    holder=db.transaction(async tx=>{await tx.execute(sql`select id from time_entries where id=${entry} for update`);ready();await finish;});
    await Promise.race([locked,holder]);
    runs=[first,second].map(request=>generateInvoiceFromBillingRequest(org.orgId,actor,request.id,null));
    const outcomes=Promise.allSettled(runs);
    const deadline=Date.now()+10000;let blocked=0;
    while(Date.now()<deadline){
     blocked=(await db.execute<{n:number}>(sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and (query ilike '%time_entries%' or query ilike '%pg_advisory_xact_lock%' or query ilike '%insert into document_lines%')`)).rows[0]!.n;
     if(blocked>=2)break;await new Promise(r=>setTimeout(r,25));
    }
    assert.ok(blocked>=2,'both generators reached the controlled contention point');
    release();await holder;
    const results=await outcomes;
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'one source must produce only one committed invoice');
    assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!.n,1);
    assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from billing_requests where org_id=${org.orgId} and status='open'`)).rows[0]!.n,1);
   }
  }finally{release();await Promise.allSettled([...(holder?[holder]:[]),...runs]);await dropScratchOrg(org.orgId);}
 });
}
