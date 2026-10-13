import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateRoePriorPeriod, validateRoeLineEvidence, type RoePriorPeriodInput } from './roe-history.ts';
import { roeQualifiedLineAllocations, type RoeRetainedLine } from './roe-line-allocation.ts';
import type { RoeWindowStub } from './roe-reporting-window.ts';
const source={sourceFileId:randomUUID(),sourceVersionId:randomUUID(),sourceSha256:'a'.repeat(64),
  sourceReference:'Original employer reporting period, page 2',insuranceReference:'Original insurable earnings declaration',
  hoursReference:'Original insured paid hours declaration',reason:'Retain the verified historical reporting source',expectedId:null,expectedUpdatedAt:null};
const prior: RoePriorPeriodInput={...source,filingAccountId:randomUUID(),payScheduleId:randomUUID(),frequency:'weekly',
  periodStart:'2025-05-04',periodEnd:'2025-05-10',payDate:'2025-05-16',earnedFrom:'2025-05-05',earnedTo:'2025-05-09',
  insurableEarnings:'123.45',insurableHours:'4.25',nilPeriod:false};
const stub:RoeWindowStub={id:'stub',documentId:'run',employmentId:'employment',subsidiaryId:'employer',filingAccountId:'filing',currency:'CAD',
  periodStart:'2026-05-03',periodEnd:'2026-05-09',payDate:'2026-05-13',insurableEarnings:'120',insurableHours:'4',hoursBasisQualified:false,
  earnedFrom:null,earnedTo:null,earnedDatesComplete:false};
function line(id:string,amount:string,insured:boolean,hours:string):RoeRetainedLine{return {lineId:id,stubId:stub.id,amount,hours:hours,
  evidenceId:'source-'+id,snapshotMatches:true,isInsurable:insured,insurableHours:insured?hours:'0',reportPeriodStart:'2026-05-03',reportPeriodEnd:'2026-05-09',
  earnedFrom:'2026-05-08',earnedTo:'2026-05-08'};}

test('historical reporting decimals use the shared strict refusal contract and nil periods require explicit zero facts',()=>{
  assert.equal(validateRoePriorPeriod(prior).insurableEarnings,'123.4500');
  assert.throws(()=>validateRoePriorPeriod({...prior,insurableEarnings:'1,234.56'}),/thousands separator/);
  assert.throws(()=>validateRoePriorPeriod({...prior,insurableHours:4.25}),/text|JSON|number|decimal/i);
  assert.throws(()=>validateRoePriorPeriod({...prior,insurableHours:'-1'}),/cannot be negative/);
  assert.throws(()=>validateRoePriorPeriod({...prior,nilPeriod:true}),/nil period/);
  const nil=validateRoePriorPeriod({...prior,nilPeriod:true,payDate:null,earnedFrom:null,earnedTo:null,insurableEarnings:'0',insurableHours:'0'});
  assert.equal(nil.payDate,null);assert.equal(nil.insurableHours,'0.0000');
});
test('line evidence refuses impossible dates, unknown source identity and uninsured hours',()=>{
  const input={...source,payStubLineId:randomUUID(),reportPeriodStart:'2026-05-03',reportPeriodEnd:'2026-05-09',
    earnedFrom:'2026-05-08',earnedTo:'2026-05-08',isInsurable:true,insurableHours:'4'};
  assert.equal(validateRoeLineEvidence(input).insurableHours,'4.0000');
  assert.throws(()=>validateRoeLineEvidence({...input,earnedFrom:'2026-02-30'}),/calendar dates/);
  assert.throws(()=>validateRoeLineEvidence({...input,isInsurable:false}),/uninsured lines/);
  assert.throws(()=>validateRoeLineEvidence({...input,sourceSha256:'unverified'}),/hash/);
});
test('qualified mixed cash and noncash earnings preserve the committed insurance base and zero-cash paid hours',()=>{
  const lines=[line('wages','100',true,'4'),{...line('benefit','20',true,'0'),hours:null},line('reimbursement','10',false,'0'),line('paid-hours','0',true,'1')];
  const before=JSON.stringify({stub,lines});const allocation=roeQualifiedLineAllocations(stub,lines);
  assert.equal(allocation.length,1);assert.equal(allocation[0]!.insurableEarnings,'120.0000');assert.equal(allocation[0]!.insurableHours,'5.0000');
  assert.equal(allocation[0]!.earnedTo,'2026-05-08');assert.equal(allocation[0]!.reportingEvidenceIds!.length,4);
  assert.equal(JSON.stringify({stub,lines}),before,'reporting evidence never edits the committed payroll source');
});
test('line classification refuses partial, mismatched, duplicate and financially inconsistent source sets',()=>{
  const base=[line('wages','100',true,'4'),{...line('benefit','20',true,'0'),hours:null}];
  assert.throws(()=>roeQualifiedLineAllocations(stub,[base[0]!,{...base[1]!,evidenceId:null}]),/incomplete/);
  assert.throws(()=>roeQualifiedLineAllocations(stub,[{...base[0]!,snapshotMatches:false},base[1]!]),/no longer matches/);
  assert.throws(()=>roeQualifiedLineAllocations(stub,[base[0]!,{...base[1]!,isInsurable:false}]),/committed insurable/);
  assert.throws(()=>roeQualifiedLineAllocations(stub,[base[0]!,base[0]!]),/duplicate/);
  assert.throws(()=>roeQualifiedLineAllocations(stub,[{...base[0]!,insurableHours:'5'},base[1]!]),/retained paid hours/);
});
test('source-qualified allocation splits one immutable stub into distinct reporting periods without prorating money',()=>{
  const allocations=roeQualifiedLineAllocations(stub,[line('wages','100',true,'4'),{
    ...line('earlier-bonus','20',true,'0'),hours:null,reportPeriodStart:'2026-04-26',reportPeriodEnd:'2026-05-02',earnedFrom:'2026-04-30',earnedTo:'2026-04-30'}]);
  assert.equal(allocations.length,2);assert.equal(allocations[0]!.insurableEarnings,'100');assert.equal(allocations[1]!.insurableEarnings,'20');
  assert.ok(allocations.every(source=>source.id===stub.id&&source.documentId===stub.documentId));
  assert.notEqual(allocations[0]!.allocationKey,allocations[1]!.allocationKey);
});
