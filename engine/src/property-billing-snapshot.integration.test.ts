import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const {sql}=await import('drizzle-orm');
const {db,pool,withOrgTransaction}=await import('./db.ts');
const {createScratchOrg,createScratchUser,dropScratchOrgReporting}=await import('./test-fixtures.ts');
const {billDueLeaseCharges,addLeaseEscalation,applyLeaseEscalation}=await import('./property-management.ts');

const {default:test}=await import('node:test');
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
  await action(org,actor,lease,charge,schedule);
 } finally {await dropScratchOrgReporting(org.orgId);}
}
async function blockedBy(pid:number){
 for(let i=0;i<250;i++){
  const result=await pool.query('select 1 from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid))',[pid]);
  if(result.rowCount)return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 assert.fail('billing never reached the competing row lock');
}
for(const change of ['proration','charge','lease'] as const){
 test(`rent billing uses the committed ${change} after waiting for its source lock`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,lease,charge,schedule)=>{
  const client=await pool.connect();
  let pending:ReturnType<typeof billDueLeaseCharges>|undefined;
  try {
   await client.query('begin');
   const pid=(await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
   if(change==='lease')await client.query('select id from property_leases where id=$1 for update',[lease]);
   if(change==='charge')await client.query('select id from lease_charges where id=$1 for update',[charge]);
   await client.query('select id from lease_schedule_lines where id=$1 for update',[schedule]);
   pending=billDueLeaseCharges(org.orgId,actor,'2026-07-31',lease);
   await blockedBy(pid);
   if(change==='proration')await client.query("update lease_schedule_lines set amount=500,period_ends_on='2026-07-15' where id=$1",[schedule]);
   if(change==='charge')await client.query("update lease_charges set description='Reviewed rent' where id=$1",[charge]);
   if(change==='lease')await client.query('update property_leases set auto_invoice=false where id=$1',[lease]);
   await client.query('commit');
   const billed=await pending;
   if(change==='lease'){
    assert.deepEqual(billed,{billed:0,invoices:[]});
    assert.equal((await db.execute<{status:string}>(sql`select status from lease_schedule_lines where id=${schedule}`)).rows[0]!.status,'scheduled');
   } else {
    const result=(await db.execute<{scheduled:string;invoiced:string;through_date:string;description:string}>(sql`select s.amount::text as scheduled,d.total::text as invoiced,s.period_ends_on::text as through_date,dl.description from lease_schedule_lines s join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id join document_lines dl on dl.document_id=d.id and dl.org_id=d.org_id where s.id=${schedule} and s.org_id=${org.orgId}`)).rows[0]!;
    assert.equal(result.invoiced,result.scheduled,'invoice must match the locked schedule amount');
    assert.ok(result.description.endsWith(result.through_date),'invoice period must match the locked schedule');
    if(change==='charge')assert.ok(result.description.startsWith('Reviewed rent'));
    assert.deepEqual(await billDueLeaseCharges(org.orgId,actor,'2026-07-31',lease),{billed:0,invoices:[]},'a replay cannot rebill the schedule');
   }
  } finally {await client.query('rollback');client.release();await pending?.catch(()=>{});}
 }));
}

test('billing and a real rent escalation serialize without blocking replacement-charge references',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(org,actor,lease,charge,schedule)=>{
 const escalation=await addLeaseEscalation({orgId:org.orgId,actorId:actor,leaseId:lease,effectiveOn:'2026-07-16',method:'new_amount',value:'2000'});
 let ready!:(pid:number)=>void;
 let proceed!:()=>void;
 const locked=new Promise<number>(resolve=>{ready=resolve;});
 const resume=new Promise<void>(resolve=>{proceed=resolve;});
 let pending:ReturnType<typeof billDueLeaseCharges>|undefined;
 const holder=withOrgTransaction(org.orgId,async()=>{
  await db.execute(sql`set local lock_timeout='3s'`);
  const pid=(await db.execute<{pid:number}>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
  await db.execute(sql`select id from lease_charges where id=${charge} and org_id=${org.orgId} for update`);
  ready(pid);
  await resume;
  return applyLeaseEscalation(org.orgId,actor,escalation.id);
 });
 try {
  const pid=await locked;
  pending=billDueLeaseCharges(org.orgId,actor,'2026-07-31',lease);
  await blockedBy(pid);
  proceed();
  const applied=await holder;
  assert.equal(applied.newAmount,'2000.0000');
  const billed=await pending;
  assert.equal(billed.billed,1);
  const result=(await db.execute<{amount:string;total:string;description:string}>(sql`
   select s.amount::text,d.total::text,dl.description from lease_schedule_lines s
   join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id
   join document_lines dl on dl.document_id=d.id and dl.org_id=d.org_id
   where s.id=${schedule} and s.org_id=${org.orgId}`)).rows[0]!;
  assert.equal(result.total,result.amount);
  assert.ok(result.description.endsWith('2026-07-15'));
 } finally {proceed();await holder.catch(()=>{});await pending?.catch(()=>{});}
}));
