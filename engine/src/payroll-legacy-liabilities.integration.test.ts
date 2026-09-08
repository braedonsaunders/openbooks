import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {sql} from 'drizzle-orm';
import {db} from './db.ts';
import {seedAdoption,calculatedRun} from './payroll-filing-test-fixtures.ts';
import {dropScratchOrgReporting} from './test-fixtures.ts';
import {commitPayRun} from './payroll-run.ts';
import {createRemittanceBill,payrollRemittanceSummary} from './payroll-remittance.ts';

test('unknown legacy liability accounts cannot follow setup changes or generate remittance bills',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const fx=await seedAdoption();
 try{
  const {input}=await calculatedRun(fx);await commitPayRun(input);
  const range={from:'2026-07-01',to:'2026-07-31'};
  const known=await payrollRemittanceSummary(fx.orgId,range);
  const original=known.flatMap(g=>g.components).find(c=>c.systemKey==='cpp')!.liabilityAccountId;
  assert.ok(original);
  // Model pre-0094 evidence in this disposable fixture only. Re-enable the
  // immutability guard in the same transaction, including on rollback.
  await db.transaction(async tx=>{
   await tx.execute(sql`alter table pay_stub_lines disable trigger pay_stub_line_liability_guard`);
   await tx.execute(sql`update pay_stub_lines l set liability_account_id=null,liability_account_source='unknown' from pay_components c where l.org_id=${fx.orgId} and c.org_id=l.org_id and c.id=l.component_id and c.system_key='cpp'`);
   await tx.execute(sql`alter table pay_stub_lines enable trigger pay_stub_line_liability_guard`);
  });
  const unresolved=/unknown historical liability account/i;
  await assert.rejects(payrollRemittanceSummary(fx.orgId,range),unresolved);
  const replacement=randomUUID();
  await db.execute(sql`insert into accounts(id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children) values(${replacement},${fx.orgId},'2311','Replacement payroll payable','liability_current_other',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true)`);
  await db.execute(sql`update pay_components set liability_account_id=${replacement} where org_id=${fx.orgId} and system_key='cpp'`);
  await assert.rejects(payrollRemittanceSummary(fx.orgId,range),unresolved);
  // A legacy statutory slot is equally mutable and cannot repair evidence.
  await db.execute(sql`update pay_components set liability_account_id=null where org_id=${fx.orgId} and system_key='cpp'`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{payroll,cppPayableAccountId}',to_jsonb(${replacement}::text)) where id=${fx.orgId}`);
  await assert.rejects(payrollRemittanceSummary(fx.orgId,range),unresolved);
  const vendor=randomUUID();
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active,custom) values(${vendor},${fx.orgId},'organization','Payroll remittance authority',true,'{}'::jsonb)`);
  await db.execute(sql`insert into vendor_roles(org_id,party_id,is_active) values(${fx.orgId},${vendor},true)`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{payroll,craRemittancePartyId}',to_jsonb(${vendor}::text)) where id=${fx.orgId}`);
  await assert.rejects(createRemittanceBill(fx.orgId,fx.actorId,{partyId:vendor,...range,filingAccountId:known[0]!.filingAccount.id}),unresolved);
  assert.equal((await db.execute(sql`select id from documents where org_id=${fx.orgId} and kind='vendor_bill'`)).rows.length,0);
  assert.deepEqual(await payrollRemittanceSummary(fx.orgId,{from:'2026-08-01',to:'2026-08-31'}),[],'unrelated periods stay usable');
 }finally{await dropScratchOrgReporting(fx.orgId);}
});
