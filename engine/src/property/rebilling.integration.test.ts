import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {sql} from 'drizzle-orm';
import {db,withOrgTransaction} from '../platform/db.ts';
import {createScratchOrg,createScratchUser,dropScratchOrgReporting} from '../testing/fixtures.ts';
import {billDueLeaseCharges} from './management.ts';
import {requestDocumentVoid} from '../ledger/document-void.ts';
import {releaseBillingProvenance} from '../ledger/billing-provenance.ts';
import {deleteDocument} from '../ledger/document-delete.ts';
async function fixture(action:(org:Awaited<ReturnType<typeof createScratchOrg>>, actor:string, lease:string, charge:string, schedule:string)=>Promise<void>) {
 const org=await createScratchOrg();
 try {
  const actor=await createScratchUser(org.orgId,'Billing reviewer','admin');
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"propertyManagement":true}'::jsonb) where id=${org.orgId}`);
  const property=randomUUID(),lease=randomUUID(),charge=randomUUID(),schedule=randomUUID();
  await db.execute(sql`insert into managed_properties(id,org_id,subsidiary_id,code,name,property_type,currency,rent_income_account_id) values(${property},${org.orgId},${org.subsidiaryId},'SNAPSHOT','Billing snapshot','commercial','CAD',${org.accounts.revenue})`);
  await db.execute(sql`insert into property_leases(id,org_id,property_id,tenant_id,lease_number,status,starts_on,billing_day,payment_terms_days,auto_invoice,auto_post) values(${lease},${org.orgId},${property},${org.customerId},'SNAPSHOT','active','2026-07-01',1,0,true,false)`);
  await db.execute(sql`insert into lease_charges(id,org_id,lease_id,charge_type,description,amount,frequency,effective_from,income_account_id) values(${charge},${org.orgId},${lease},'base_rent','Monthly rent',1000,'monthly','2026-07-01',${org.accounts.revenue})`);
  await db.execute(sql`insert into lease_schedule_lines(id,org_id,lease_id,charge_id,period_starts_on,period_ends_on,due_on,amount,status) values(${schedule},${org.orgId},${lease},${charge},'2026-07-01','2026-07-31','2026-07-01',1000,'scheduled')`);
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
  await action(org,actor,lease,charge,schedule);
 } finally {await dropScratchOrgReporting(org.orgId);}
}

for (const mode of ['void','delete'] as const) {
 test(`rent source can be billed once after controlled ${mode}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,lease,_charge,schedule)=>{
  if(mode==='void') await db.execute(sql`update property_leases set auto_post=true where org_id=${org.orgId} and id=${lease}`);
  const first=await billDueLeaseCharges(org.orgId, actor, null, '2026-07-31',lease);
  const invoice=first.invoices[0]!;
  assert.equal(first.billed,1);
  if(mode==='void'){
   await assert.rejects(requestDocumentVoid({orgId:org.orgId,actorId:actor,documentId:invoice,reason:'',reversalDate:'2026-07-31'}));
   assert.equal((await billDueLeaseCharges(org.orgId, actor, null, '2026-07-31',lease)).billed,0,'refused void must not release sources');
   const result=await requestDocumentVoid({orgId:org.orgId,actorId:actor,documentId:invoice,reason:'Correct rent billing source',reversalDate:'2026-07-31'});
   assert.equal(result.status,'voided');
   assert.ok(result.reversalEntryId);
  } else await withOrgTransaction(org.orgId,()=>deleteDocument(invoice,actor,org.orgId,{reason:'Correct rent billing source',allowedSubsidiaryIds:null}));
  const released=(await db.execute<{status:string;invoice_document_id:string|null}>(sql`select status,invoice_document_id from lease_schedule_lines where org_id=${org.orgId} and id=${schedule}`)).rows[0]!;
  assert.deepEqual(released,{status:'scheduled',invoice_document_id:null});
  const audit=(await db.execute<{actor_id:string;changes:{before:{invoice_document_id:string};after:{invoice_document_id:null}}}>(sql`select actor_id,changes from audit_log where org_id=${org.orgId} and table_name='lease_schedule_lines' and row_id=${schedule} and action='billing_released'`)).rows;
  assert.equal(audit.length,1);
  assert.equal(audit[0]!.actor_id,actor);
  assert.equal(audit[0]!.changes.before.invoice_document_id,invoice);
  assert.equal(audit[0]!.changes.after.invoice_document_id,null);
  const results=await Promise.all([billDueLeaseCharges(org.orgId, actor, null, '2026-07-31',lease),billDueLeaseCharges(org.orgId, actor, null, '2026-07-31',lease)]);
  assert.equal(results.reduce((n,r)=>n+r.billed,0),1,'competing retries create exactly one replacement');
  const replacement=results.flatMap(r=>r.invoices)[0]!;
  assert.notEqual(replacement,invoice,'a voided predecessor cannot be adopted');
  assert.equal((await billDueLeaseCharges(org.orgId, actor, null, '2026-07-31',lease)).billed,0);
  if(mode==='void') {
   await requestDocumentVoid({orgId:org.orgId,actorId:actor,documentId:replacement,reason:'Second controlled correction',reversalDate:'2026-07-31'});
   const third=await billDueLeaseCharges(org.orgId, actor, null, '2026-07-31',lease);
   assert.equal(third.billed,1);
   assert.notEqual(third.invoices[0],replacement);
   const history=(await db.execute<{custom:{propertyManagement:{predecessorInvoiceId:string}}}>(sql`select custom from documents where id=${third.invoices[0]} and org_id=${org.orgId}`)).rows[0]!;
   assert.equal(history.custom.propertyManagement.predecessorInvoiceId,replacement);
   assert.equal((await db.execute<{status:string}>(sql`select status from documents where id=${invoice} and org_id=${org.orgId}`)).rows[0]!.status,'voided','posted predecessor remains historical evidence');
  }
 }));
}

test('voiding a generated invoice releases time and billed-line provenance with actor and reason evidence',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,lease,_charge,_schedule)=>{
 await db.execute(sql`update property_leases set auto_post=true where org_id=${org.orgId} and id=${lease}`);
 const invoice=(await billDueLeaseCharges(org.orgId,actor,null,'2026-07-31',lease)).invoices[0]!;
 const invoiceLine=(await db.execute<{id:string}>(sql`select id from document_lines where org_id=${org.orgId} and document_id=${invoice} order by line_number limit 1`)).rows[0]!.id;
 const employee=randomUUID(),entry=randomUUID(),sourceDocument=randomUUID(),sourceLine=randomUUID();
 await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
   values(${employee},${org.orgId},'employee','Released billable worker',${org.subsidiaryId})`);
 await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,billing_status,invoiced_by_line_id,created_by,updated_by)
   values(${entry},${org.orgId},${employee},'2026-07-31',1,null,${org.items.service},true,'approved',100,'billed',${invoiceLine},${actor},${actor})`);
 await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,document_date,currency,status,subtotal,tax_total,total,created_by)
   values(${sourceDocument},${org.orgId},'customer_invoice','SOURCE-PROVENANCE',${org.customerId},${org.subsidiaryId},'2026-07-31','CAD','draft',100,0,100,${actor})`);
 await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,quantity,unit_price,amount,billed_by_line_id,created_by,updated_by)
   values(${sourceLine},${org.orgId},${sourceDocument},1,${org.accounts.revenue},1,100,100,${invoiceLine},${actor},${actor})`);

 const result=await requestDocumentVoid({orgId:org.orgId,actorId:actor,documentId:invoice,reason:'Correct generated invoice provenance',reversalDate:'2026-07-31'});
 assert.equal(result.status,'voided');
 assert.deepEqual((await db.execute(sql`select billing_status,invoiced_by_line_id from time_entries where org_id=${org.orgId} and id=${entry}`)).rows[0],{billing_status:'unbilled',invoiced_by_line_id:null});
 assert.equal((await db.execute(sql`select billed_by_line_id from document_lines where org_id=${org.orgId} and id=${sourceLine}`)).rows[0]?.billed_by_line_id,null);
 const evidence=(await db.execute<{table_name:string;row_id:string;actor_id:string;changes:{before:Record<string,unknown>;after:Record<string,unknown>;reason:string}}>(sql`select table_name,row_id,actor_id,changes from audit_log
   where org_id=${org.orgId} and action='billing_released' and row_id in (${entry},${sourceLine}) order by table_name`)).rows;
 assert.equal(evidence.length,2);
 assert.deepEqual(evidence.map(row=>[row.table_name,row.row_id,row.actor_id,row.changes.reason]),[
   ['document_lines',sourceLine,actor,'Correct generated invoice provenance'],
   ['time_entries',entry,actor,'Correct generated invoice provenance'],
 ]);
 assert.equal(evidence.find(row=>row.table_name==='time_entries')!.changes.before.billingStatus,'billed');
 assert.equal(evidence.find(row=>row.table_name==='time_entries')!.changes.after.billingStatus,'unbilled');
 assert.equal(evidence.find(row=>row.table_name==='document_lines')!.changes.before.billedByLineId,invoiceLine);
 assert.equal(evidence.find(row=>row.table_name==='document_lines')!.changes.after.billedByLineId,null);
}));

test('rent source release and audit roll back together and respect organization scope',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,lease,_charge,schedule)=>{
 const first=await billDueLeaseCharges(org.orgId, actor, null, '2026-07-31',lease);
 const invoice=first.invoices[0]!;
 await assert.rejects(withOrgTransaction(org.orgId,async()=>{
  await releaseBillingProvenance(db,org.orgId,invoice,{actorId:actor,reason:'Rolled back correction'});
  assert.equal((await db.execute<{status:string}>(sql`select status from lease_schedule_lines where org_id=${org.orgId} and id=${schedule}`)).rows[0]!.status,'scheduled');
  throw new Error('rollback proof');
 }),/rollback proof/);
 const foreign=randomUUID();
 await withOrgTransaction(foreign,()=>releaseBillingProvenance(db,foreign,invoice,{actorId:actor,reason:'Foreign release attempt'}));
 assert.equal((await db.execute<{status:string}>(sql`select status from lease_schedule_lines where org_id=${org.orgId} and id=${schedule}`)).rows[0]!.status,'invoiced');
 assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='lease_schedule_lines' and row_id=${schedule} and action='billing_released'`)).rows.length,0);
}));
