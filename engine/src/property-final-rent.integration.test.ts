import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {sql} from 'drizzle-orm';
import {db,pool,withOrgTransaction} from './db.ts';
import {createScratchOrg,createScratchUser,dropScratchOrgReporting} from './test-fixtures.ts';
import {billDueLeaseCharges,terminatePropertyLease} from './property-management.ts';
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


test('termination preserves billing of earned prorated rent and cancels future periods',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,lease,charge,schedule)=>{
 const future=randomUUID();
 await db.execute(sql`insert into lease_schedule_lines(id,org_id,lease_id,charge_id,period_starts_on,period_ends_on,due_on,amount,status) values(${future},${org.orgId},${lease},${charge},'2026-08-01','2026-08-31','2026-08-01',1000,'scheduled')`);
 await withOrgTransaction(org.orgId,()=>terminatePropertyLease(org.orgId,actor,lease,'2026-07-15','Tenant vacated on agreed date'));
 const billed=await billDueLeaseCharges(org.orgId,actor,'2026-08-31',lease);
 assert.equal(billed.billed,1);
 const result=(await db.execute<{amount:string;total:string;description:string}>(sql`select s.amount::text,d.total::text,dl.description from lease_schedule_lines s join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id join document_lines dl on dl.document_id=d.id and dl.org_id=d.org_id where s.id=${schedule} and s.org_id=${org.orgId}`)).rows[0]!;
 assert.equal(result.amount,'483.8710');
 assert.equal(result.total,result.amount);
 assert.ok(result.description.endsWith('2026-07-15'));
 assert.equal((await db.execute<{status:string}>(sql`select status from lease_schedule_lines where id=${future} and org_id=${org.orgId}`)).rows[0]!.status,'cancelled');
 assert.equal((await billDueLeaseCharges(org.orgId,actor,'2026-08-31',lease)).billed,0);
}));

test('terminated billing respects auto-invoice suspension and refuses unprorated periods',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,lease,_charge,schedule)=>{
 await withOrgTransaction(org.orgId,()=>terminatePropertyLease(org.orgId,actor,lease,'2026-07-15','Tenant vacated on agreed date'));
 await db.execute(sql`update property_leases set auto_invoice=false where id=${lease} and org_id=${org.orgId}`);
 assert.equal((await billDueLeaseCharges(org.orgId,actor,'2026-07-31',lease)).billed,0);
 await db.execute(sql`update property_leases set auto_invoice=true where id=${lease} and org_id=${org.orgId}`);
 // A legacy schedule or released predecessor crossing termination needs review;
 // admitting terminated leases must never bill an unearned remainder.
 await db.execute(sql`update lease_schedule_lines set period_ends_on='2026-07-31',amount=1000 where id=${schedule} and org_id=${org.orgId}`);
 assert.equal((await billDueLeaseCharges(org.orgId,actor,'2026-07-31',lease)).billed,0);
}));

test('billing rechecks final rent after waiting for the real termination transaction',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,lease,_charge,schedule)=>{
 let ready!:(pid:number)=>void,proceed!:()=>void;
 const locked=new Promise<number>(r=>{ready=r;});
 const resume=new Promise<void>(r=>{proceed=r;});
 const termination=withOrgTransaction(org.orgId,async()=>{
  await db.execute(sql`select id from property_leases where id=${lease} and org_id=${org.orgId} for update`);
  ready((await db.execute<{pid:number}>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
  await resume;
  await terminatePropertyLease(org.orgId,actor,lease,'2026-07-15','Concurrent agreed termination');
 });
 let pending:ReturnType<typeof billDueLeaseCharges>|undefined;
 try {
  const pid=await locked;
  pending=billDueLeaseCharges(org.orgId,actor,'2026-07-31',lease);
  let waiting=false;
  for(let i=0;i<250;i++){
   if((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount){waiting=true;break;}
   await new Promise(r=>setTimeout(r,20));
  }
  assert.ok(waiting,'billing waits for the terminating lease');
  proceed();
  await termination;
  assert.equal((await pending).billed,1);
  const line=(await db.execute<{amount:string;total:string}>(sql`select s.amount::text,d.total::text from lease_schedule_lines s join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id where s.id=${schedule} and s.org_id=${org.orgId}`)).rows[0]!;
  assert.equal(line.amount,'483.8710');
  assert.equal(line.total,line.amount);
 }finally{proceed();await termination.catch(()=>{});await pending?.catch(()=>{});}
}));
