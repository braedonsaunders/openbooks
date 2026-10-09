import assert from 'node:assert/strict';
import test from 'node:test';
import {sql} from 'drizzle-orm';
import {db} from '../platform/db.ts';
import {parseMoney} from '../money/brands.ts';
import {dropScratchOrgReporting} from '../testing/fixtures.ts';
import {seedHourlyPayrollOrg,seedHourlyPayrollEmployee,seedHourlyPayrollTime} from '../testing/payroll-hourly-fixture.ts';
import {createPayRun,discardPayRun} from './run-lifecycle.ts';
import {calculatePayRun,captureCalculatedStubs} from './run-calculation.ts';
import {insertPayStubLineRows,totalHours,type Line} from './run-stub-records.ts';

test('native payroll persistence retains operational precision and source code without changing worked hours',
 {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const fx=await seedHourlyPayrollOrg();
  try{
   const {partyId}=await seedHourlyPayrollEmployee(fx,'Operational quantity employee');
   await seedHourlyPayrollTime(fx,partyId,['2026-07-13']);
   const run=await createPayRun({orgId:fx.orgId,actorId:fx.actorId,payScheduleId:fx.scheduleId,
    periodStart:'2026-07-12',periodEnd:'2026-07-18',payDate:'2026-07-21'});
   assert.deepEqual((await calculatePayRun({orgId:fx.orgId,actorId:fx.actorId,documentId:run.documentId})).errors,[]);
   const stub=(await db.execute<{id:string}>(sql`select id from pay_stubs where org_id=${fx.orgId}
    and pay_run_document_id=${run.documentId} and employee_party_id=${partyId}`)).rows[0]!;
   const component=(await db.execute<{id:string}>(sql`select id from pay_components where org_id=${fx.orgId}
    and system_key='base_pay' and kind='earning'`)).rows[0]!;
   const line:Line={componentId:component.id,kind:'earning',description:'Operational incentive',
    derivedQuantity:'8.1234',derivedRuleCode:'SITE',rate:'2',amount:parseMoney('16.25'),sequence:900};
   const args={orgId:fx.orgId,stubId:stub.id,actorId:fx.actorId,country:'CA',payDate:'2026-07-21'};
   assert.equal(totalHours([line]),'0.0000');
   await insertPayStubLineRows(db,args,[line]);
   const captured=(await captureCalculatedStubs(db,fx.orgId,run.documentId)).find(stub=>stub.employeePartyId===partyId)!;
   const retained=captured.lines.find(line=>line.sequence===900)!;
   assert.equal(retained.derivedQuantity,'8.1234');assert.equal(retained.derivedRuleCode,'SITE');
   assert.equal(retained.hours,null);assert.equal(retained.amount,'16.2500');
   await assert.rejects(insertPayStubLineRows(db,args,[{...line,derivedQuantity:'8.12345'}]),/positive exact quantity/);
   assert.equal((await db.execute<{count:number}>(sql`select count(*)::int as count from pay_stub_lines
    where org_id=${fx.orgId} and stub_id=${stub.id} and sequence=900`)).rows[0]!.count,1);
   await discardPayRun({orgId:fx.orgId,actorId:fx.actorId,documentId:run.documentId});
  }finally{await dropScratchOrgReporting(fx.orgId);}
 });
