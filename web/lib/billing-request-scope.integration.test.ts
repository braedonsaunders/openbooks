import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __billingScopeSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__billingScopeSession.user}' };
  if (specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { randomUUID } = await import('node:crypto');
const { PATCH } = await import('../app/api/billing-requests/[id]/route');
const { POST } = await import('../app/api/billing-requests/[id]/create-invoice/route');
const { GET, POST: POST_BACKUP } = await import('../app/api/billing-requests/[id]/backup/route');
const { createBillingRequest } = await import('./billing-requests');
for(const action of ['cancel','invoice','backup']) for(const scope of ['empty','hidden','visible','all',...(action==='backup'?['invoice-hidden','source-hidden','manifest-hidden']:[])]) {
  test(`billing request scope: ${action} ${scope}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
    try{
      const actor=await createScratchUser(org.orgId,'Billing controller','reviewer');
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
      session.user={id:actor,orgId:org.orgId,name:'Billing controller',email:'billing@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
      const project=randomUUID(), other=randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`);
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active) values (${project},${org.orgId},${org.subsidiaryId},'SCOPED','Scoped billing',${org.customerId},'active',true)`);
      const request=await createBillingRequest(org.orgId,actor,{projectId:project,basis:'draw_amount',drawAmount:'100',cutoffDate:org.date,backupRequired:false});
      let invoice:string|null=null;
      const bytes=Buffer.from('%PDF-1.4\nDisposable scoped backup');
      if(action==='backup') {
        invoice=randomUUID();
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,subsidiary_id,party_id,project_id,currency) values (${invoice},${org.orgId},'customer_invoice',${invoice},${org.date},${org.subsidiaryId},${org.customerId},${project},'CAD')`);
        await db.execute(sql`update billing_requests set invoice_document_id=${invoice},status='invoiced' where id=${request.id}`);
        const {uploadAndAttach}=await import('./file-cabinet');
        const file=await uploadAndAttach({orgId:org.orgId,targetTable:'documents',targetId:invoice,filename:'Backup.pdf',contentType:'application/pdf',bytes,createdBy:actor});
        await db.execute(sql`insert into invoice_backups(org_id,document_id,billing_request_id,backup_type,file_id,page_count) values (${org.orgId},${invoice},${request.id},'none',${file.id},1)`);
      }
      if(scope==='source-hidden'||scope==='manifest-hidden') {
        const source=randomUUID(),sourceLine=randomUUID(),invoiceLine=randomUUID();
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,subsidiary_id,party_id,project_id,currency) values (${source},${org.orgId},'vendor_bill',${source},${org.date},${other},${org.vendorId},${project},'CAD')`);
        if(scope==='manifest-hidden') await db.execute(sql`update invoice_backups set component_manifest=${JSON.stringify([{kind:'attachments',sourceDocumentId:source}])}::jsonb where document_id=${invoice}`);
        else {
        await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,quantity,unit_price,amount) values (${invoiceLine},${org.orgId},${invoice},1,${org.accounts.revenue},1,100,100)`);
        await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,quantity,unit_price,amount,billed_by_line_id) values (${sourceLine},${org.orgId},${source},1,${org.accounts.cogs},1,100,100,${invoiceLine})`);
        }
      }
      if(scope==='invoice-hidden') await db.execute(sql`update documents set subsidiary_id=${other} where id=${invoice}`);
      if(scope!=='all') await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({mode:'list',subsidiaryIds:scope==='empty'?[]:[['visible','invoice-hidden','source-hidden','manifest-hidden'].includes(scope)?org.subsidiaryId:other]})}::jsonb where org_id=${org.orgId} and key='reviewer'`);
      const call=action==='cancel'?PATCH:action==='invoice'?POST:GET;
      const response=await withOrgContext(org.orgId,()=>call(new Request('http://audit.local/api/billing-requests/'+request.id,{method:action==='cancel'?'PATCH':action==='invoice'?'POST':'GET',...(action==='cancel'?{body:JSON.stringify({action:'cancel'})}:{})}),{params:Promise.resolve({id:request.id})}));
      const allowed=scope==='visible'||scope==='all';
      assert.equal(response.status,allowed?200:404,action==='backup'&&response.status===200?'backup bytes disclosed':await response.text());
      if(action==='backup'&&allowed) assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
      if(action==='backup'&&!allowed) {
        const {loadInvoiceBackup,assembleInvoiceBackup}=await import('./invoice-backup');
        const scopeIds=new Set(scope==='empty'?[]:[['invoice-hidden','source-hidden','manifest-hidden'].includes(scope)?org.subsidiaryId:other]);
        await assert.rejects(loadInvoiceBackup(org.orgId,invoice!,scopeIds),/Invoice not found/);
        if(scope!=='manifest-hidden') {
        await assert.rejects(assembleInvoiceBackup(org.orgId,actor,invoice!,'none',scopeIds),/Invoice not found/);
        const rebuilt=await withOrgContext(org.orgId,()=>POST_BACKUP(new Request('http://audit.local/api/backup',{method:'POST'}),{params:Promise.resolve({id:request.id})}));
        assert.equal(rebuilt.status,404);
        }
        if(scope==='invoice-hidden') {
          const {listBillingRequests}=await import('./billing-requests');
          const listed=await listBillingRequests(org.orgId,project,scopeIds);
          assert.equal(listed[0]?.invoiceDocumentId,null);
          assert.equal(listed[0]?.invoiceTotal,null);
        }
      }
      const state=(await db.execute(sql`select status,invoice_document_id from billing_requests where id=${request.id}`)).rows[0];
      assert.equal(state?.status,action==='backup'?'invoiced':allowed?(action==='cancel'?'cancelled':'invoiced'):'open');
      if(!allowed&&action==='invoice') assert.equal(state?.invoice_document_id,null);
    }finally{session.user=null;await dropScratchOrg(org.orgId);}
  });
}
