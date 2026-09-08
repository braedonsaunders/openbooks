import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {sql} from 'drizzle-orm';
import {db,pool,withOrgTransaction} from './db.ts';
import {createScratchOrg,createScratchUser,dropScratchOrgReporting} from './test-fixtures.ts';
import {billCamReconciliation,reopenFinalizedCamPool} from './property-management.ts';
import {requestDocumentVoid} from './document-void.ts';
import {postDocument} from './posting.ts';
import {submitAndReleaseIfUngated} from './flows/submit.ts';
import {releaseCamBillingProvenance} from './billing-provenance.ts';
import {deleteDocument} from './document-delete.ts';
async function fixture(action:(org:Awaited<ReturnType<typeof createScratchOrg>>, actor:string, lease:string, charge:string, schedule:string,cam:string,allocation:string)=>Promise<void>) {
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
  const cam=randomUUID(),allocation=randomUUID();
  await db.execute(sql`update managed_properties set cam_income_account_id=${org.accounts.revenue} where org_id=${org.orgId} and id=${property}`);
  await db.execute(sql`insert into cam_pools(id,org_id,property_id,name,fiscal_year,period_starts_on,period_ends_on,status,actual_amount) values(${cam},${org.orgId},${property},'Lifecycle CAM',2026,'2026-07-01','2026-07-31','finalized',100)`);
  await db.execute(sql`insert into cam_allocations(id,org_id,pool_id,lease_id,share_percent,actual_allocation,reconciliation_amount) values(${allocation},${org.orgId},${cam},${lease},100,100,100)`);
  await action(org,actor,lease,charge,schedule,cam,allocation);
 } finally {await dropScratchOrgReporting(org.orgId);}
}


for(const kind of ['invoice','credit'] as const){
 test(`CAM ${kind} draft deletion releases a replacement without reopening finalized financial facts`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,_lease,_charge,_schedule,cam,allocation)=>{
  if(kind==='credit') await db.execute(sql`update cam_allocations set reconciliation_amount=-100 where org_id=${org.orgId} and id=${allocation}`);
  const first=await billCamReconciliation(org.orgId,actor,cam,'2026-07-31');
  assert.equal(first.documents.length,1);
  await withOrgTransaction(org.orgId,()=>deleteDocument(first.documents[0]!,actor,org.orgId,{reason:'Discard CAM draft for correction'}));
  const released=(await db.execute<{invoice_document_id:string|null;reconciliation_amount:string}>(sql`select invoice_document_id,reconciliation_amount::text from cam_allocations where org_id=${org.orgId} and id=${allocation}`)).rows[0]!;
  assert.equal(released.invoice_document_id,null);
  assert.equal(released.reconciliation_amount,kind==='credit'?'-100.0000':'100.0000');
  await assert.rejects(withOrgTransaction(org.orgId,()=>reopenFinalizedCamPool(org.orgId,actor,cam,'Cannot reinterpret an invoiced pool')));
  const again=await Promise.all([billCamReconciliation(org.orgId,actor,cam,'2026-07-31'),billCamReconciliation(org.orgId,actor,cam,'2026-07-31')]);
  assert.equal(again.flatMap(r=>r.documents).length,1);
  const id=again.flatMap(r=>r.documents)[0]!;
  assert.notEqual(id,first.documents[0]);
  assert.equal((await db.execute<{kind:string;total:string}>(sql`select kind,total::text from documents where id=${id} and org_id=${org.orgId}`)).rows[0]!.kind,kind==='credit'?'customer_credit':'customer_invoice');
  const audits=(await db.execute<{actor_id:string}>(sql`select actor_id from audit_log where org_id=${org.orgId} and table_name='cam_allocations' and row_id=${allocation} and action='billing_released'`)).rows;
  assert.equal(audits.length,1);
  assert.equal(audits[0]!.actor_id,actor);
 }));
}

async function waitForLock(pid:number){
 for(let i=0;i<250;i++){
  if((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount)return;
  await new Promise(r=>setTimeout(r,20));
 }
 assert.fail('CAM operation did not wait for the controlled source lock');
}

test('CAM billing waits for reopening and refuses its now-open pool',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,_lease,_charge,_schedule,cam,allocation)=>{
 let ready!:(pid:number)=>void,proceed!:()=>void;
 const locked=new Promise<number>(r=>{ready=r;});
 const resume=new Promise<void>(r=>{proceed=r;});
 const reopen=withOrgTransaction(org.orgId,async()=>{
  await db.execute(sql`select id from cam_pools where id=${cam} and org_id=${org.orgId} for update`);
  ready((await db.execute<{pid:number}>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
  await resume;
  await reopenFinalizedCamPool(org.orgId,actor,cam,'Correct source configuration');
 });
 let billing:ReturnType<typeof billCamReconciliation>|undefined;
 try{
  const pid=await locked;
  billing=billCamReconciliation(org.orgId,actor,cam,'2026-07-31');
  await waitForLock(pid);
  proceed();await reopen;
  assert.deepEqual(await billing,{documents:[]});
  assert.equal((await db.execute(sql`select id from documents where org_id=${org.orgId} and custom->'propertyManagement'->>'allocationId'=${allocation}`)).rows.length,0);
 }finally{proceed();await reopen.catch(()=>{});await billing?.catch(()=>{});}
}));

for(const kind of ['customer_invoice','customer_credit'] as const){
 test(`posted CAM ${kind} reversal preserves history and permits one replacement`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,_lease,_charge,_schedule,cam,allocation)=>{
  if(kind==='customer_credit') await db.execute(sql`update cam_allocations set reconciliation_amount=-100 where org_id=${org.orgId} and id=${allocation}`);
  const first=await billCamReconciliation(org.orgId,actor,cam,'2026-07-31');
  const invoice=first.documents[0]!;
  await withOrgTransaction(org.orgId,async()=>{
   const submitted=await submitAndReleaseIfUngated(kind,invoice,actor);
   assert.equal(submitted.gated,false);
   await postDocument(invoice,{control:{ar:org.accounts.ar,ap:org.accounts.ap,bank:org.accounts.bank}},{audit:{actorId:actor,source:'test'}});
  });
  const voided=await requestDocumentVoid({orgId:org.orgId,actorId:actor,documentId:invoice,reason:'Correct posted CAM reconciliation',reversalDate:'2026-07-31'});
  assert.equal(voided.status,'voided');assert.ok(voided.reversalEntryId);
  const again=await billCamReconciliation(org.orgId,actor,cam,'2026-07-31');
  assert.equal(again.documents.length,1);assert.notEqual(again.documents[0],invoice);
  const history=(await db.execute<{custom:{propertyManagement:{predecessorInvoiceId:string}}}>(sql`select custom from documents where id=${again.documents[0]} and org_id=${org.orgId}`)).rows[0]!;
  assert.equal(history.custom.propertyManagement.predecessorInvoiceId,invoice);
  assert.deepEqual(await billCamReconciliation(org.orgId,actor,cam,'2026-07-31'),{documents:[]});
 }));
}

test('reopening rechecks billed dependencies after waiting for the billing pool lock',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,_lease,_charge,_schedule,cam,allocation)=>{
 const client=await pool.connect();
 let billing:ReturnType<typeof billCamReconciliation>|undefined;
 let reopening:ReturnType<typeof reopenFinalizedCamPool>|undefined;
 try{
  await client.query('begin');
  await client.query('select id from cam_allocations where id=$1 for update',[allocation]);
  const pid=(await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
  billing=billCamReconciliation(org.orgId,actor,cam,'2026-07-31');
  await waitForLock(pid);
  reopening=withOrgTransaction(org.orgId,()=>reopenFinalizedCamPool(org.orgId,actor,cam,'Concurrent pool correction'));
  const settled=Promise.allSettled([billing,reopening]);
  let waiting=false;
  for(let i=0;i<250;i++){
   const r=await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%select cp.name%'");
   if(r.rowCount){waiting=true;break;}
   await new Promise(r=>setTimeout(r,20));
  }
  assert.ok(waiting,'reopening waits behind the biller');
  await client.query('commit');
  const result=await settled;
  assert.equal(result[0]!.status,'fulfilled');
  assert.equal(result[1]!.status,'rejected');
  const remaining=(await db.execute<{invoice_document_id:string|null}>(sql`select invoice_document_id from cam_allocations where org_id=${org.orgId} and id=${allocation}`)).rows[0];
  assert.ok(remaining?.invoice_document_id,'successful invoice retains its allocation');
 }finally{await client.query('rollback');client.release();await billing?.catch(()=>{});await reopening?.catch(()=>{});}
}));

test('CAM reservation release is tenant-scoped and rolls back with its audit evidence',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,_lease,_charge,_schedule,cam,allocation)=>{
 const invoice=(await billCamReconciliation(org.orgId,actor,cam,'2026-07-31')).documents[0]!;
 await assert.rejects(withOrgTransaction(org.orgId,async()=>{
  await releaseCamBillingProvenance(db,org.orgId,invoice,{actorId:actor,reason:'Aborted correction'});
  assert.equal((await db.execute<{invoice_document_id:string|null}>(sql`select invoice_document_id from cam_allocations where org_id=${org.orgId} and id=${allocation}`)).rows[0]!.invoice_document_id,null);
  throw new Error('rollback proof');
 }),/rollback proof/);
 const foreign=randomUUID();
 await withOrgTransaction(foreign,()=>releaseCamBillingProvenance(db,foreign,invoice,{actorId:actor,reason:'Foreign attempt'}));
 assert.equal((await db.execute<{invoice_document_id:string|null}>(sql`select invoice_document_id from cam_allocations where org_id=${org.orgId} and id=${allocation}`)).rows[0]!.invoice_document_id,invoice);
 assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='cam_allocations' and row_id=${allocation} and action='billing_released'`)).rows.length,0);
}));
