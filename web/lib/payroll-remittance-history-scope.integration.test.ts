import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {Authz} from './authz';
registerHooks({resolve(specifier,context,next){if(specifier==='server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'};return next(specifier,context);}});
const {sql}=await import('drizzle-orm');
const {db}=await import('@openbooks/engine/src/db.ts');
const {seedAdoption,calculatedRun}=await import('@openbooks/engine/src/payroll-filing-test-fixtures.ts');
const {dropScratchOrgReporting}=await import('@openbooks/engine/src/test-fixtures.ts');
const {commitPayRun}=await import('@openbooks/engine/src/payroll-run.ts');
const {guardRemittancePeriod}=await import('../app/api/payroll/subsidiary-scope');
const {payrollRemittanceSummary}=await import('@openbooks/engine/src/payroll-remittance.ts');

test('remittance history remains scoped to the original pay-run entity after employee transfer',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const fx=await seedAdoption();
 try{
  await db.execute(sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
  const {input}=await calculatedRun(fx);await commitPayRun(input);
  const range={from:'2026-07-01',to:'2026-07-31'};
  const gate={user:{orgId:fx.orgId,id:fx.actorId},permissions:new Set(['payroll.read']),allowedSubsidiaryIds:new Set([fx.subsidiaryId])} as Authz;
  assert.equal(await guardRemittancePeriod(gate,range.from,range.to),null);
  const before=await payrollRemittanceSummary(fx.orgId,range,gate.allowedSubsidiaryIds);
  assert.ok(before.length);
  const hidden=randomUUID();
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Transferred employee entity','CAD','CA')`);
  await db.execute(sql`update parties set subsidiary_id=${hidden} where org_id=${fx.orgId} and id=${fx.employeeId}`);
  assert.equal(await guardRemittancePeriod(gate,range.from,range.to),null,'original employer retains its history');
  assert.deepEqual(await payrollRemittanceSummary(fx.orgId,range,gate.allowedSubsidiaryIds),before);
  const moved={...gate,allowedSubsidiaryIds:new Set([hidden])};
  assert.equal((await guardRemittancePeriod(moved,range.from,range.to))?.status,404,'new employer cannot read the earlier employer payroll');
  assert.deepEqual(await payrollRemittanceSummary(fx.orgId,range,moved.allowedSubsidiaryIds),[]);
  assert.equal((await guardRemittancePeriod({...gate,allowedSubsidiaryIds:new Set()},range.from,range.to))?.status,404);
  assert.deepEqual(await payrollRemittanceSummary(fx.orgId,range,new Set()),[]);
  assert.equal(await guardRemittancePeriod({...gate,allowedSubsidiaryIds:null},range.from,range.to),null);
 }finally{await dropScratchOrgReporting(fx.orgId);}
});

test('scoped remittance history excludes matching bill artifacts owned by another legal entity',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const fx=await seedAdoption();
 try{
  const vendor=randomUUID(),hidden=randomUUID(),invoice=randomUUID();
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active) values(${vendor},${fx.orgId},'organization','Shared remittance authority',true)`);
  await db.execute(sql`insert into vendor_roles(org_id,party_id,is_active) values(${fx.orgId},${vendor},true)`);
  await db.execute(sql`update pay_components set remittance_party_id=${vendor} where org_id=${fx.orgId}`);
  await db.execute(sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
  const {input}=await calculatedRun(fx);await commitPayRun(input);
  const range={from:'2026-07-01',to:'2026-07-31'};
  const group=(await payrollRemittanceSummary(fx.orgId,range))[0]!;
  assert.equal(group.partyId,vendor);
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Other bill owner','CAD','CA')`);
  await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,document_date,currency,status,custom) values(${invoice},${fx.orgId},'vendor_bill','HIDDEN-REMIT',${vendor},${hidden},'2026-07-31','CAD','draft',${JSON.stringify({payrollRemittance:{...range,filingAccountId:group.filingAccount.id}})}::jsonb)`);
  const expense=(await db.execute<{id:string}>(sql`select id from accounts where org_id=${fx.orgId} and type='expense' and not is_summary limit 1`)).rows[0]!.id;
  await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,subsidiary_id,description,quantity,unit_price,amount,tax_amount) values(${fx.orgId},${invoice},1,${expense},${hidden},'Other entity remittance',1,999,999,0)`);
  assert.ok((await payrollRemittanceSummary(fx.orgId,range)).flatMap(g=>g.existingBills).some(b=>b.documentId===invoice),'the unfiltered fixture actually contains the matching bill');
  assert.equal((await payrollRemittanceSummary(fx.orgId,range,new Set([fx.subsidiaryId]))).flatMap(g=>g.existingBills).some(b=>b.documentId===invoice),false);
 }finally{await dropScratchOrgReporting(fx.orgId);}
});
