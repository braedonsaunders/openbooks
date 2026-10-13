import {payRunStaleness} from '../readiness.ts';
import {calculatePayRun} from '../run-calculation.ts';
import {commitPayRun} from '../run-commit.ts';
import {listPeriodSiblings} from '../period-priors.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {db,withBypassContext,withOrgContext} from '../../platform/db.ts';
import {seedAdoption,calculatedRun} from '../filing-test-fixtures.ts';
import {seedPayrollDocument,seedPayrollStub,seedPayrollSettings,seedWorkerEmployment,dropScratchOrgReporting} from '../../testing/fixtures.ts';
import {employeeYtd} from './compute-statutory.ts';
import {saveOpeningBalances} from '../opening-balances.ts';
import {qualifyOpeningEmployerAuthority,readOpeningEmployerContext} from '../opening-employer-authority.ts';
import {errorChainMatches} from '../../testing/error-chain.ts';
const DB=!!process.env.OPENBOOKS_DB_URL;
async function setup(){
 const f=await seedAdoption();await seedPayrollSettings(f.orgId,{features:{payroll:true}});
 await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
  values(${f.orgId},${f.actorId},'payroll.read','grant'),(${f.orgId},${f.actorId},'payroll.run','grant')`);
 const other=randomUUID();await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
  values(${other},${f.orgId},${f.subsidiaryId},'Second legal employer','CAD','CA')`);
 const employmentB=await seedWorkerEmployment(f.orgId,f.employeeId,other);
 return {...f,other,employmentB};
}
type Fixture=Awaited<ReturnType<typeof setup>>;
async function run(f:Fixture,owner:string,status:'draft'|'committed',amount='0',employment=f.employmentId,account:string|null=null){
 const id=randomUUID();await seedPayrollDocument(f.orgId,id,{kind:'pay_run',documentNumber:'PAY-'+id.slice(0,8),
  subsidiaryId:owner,documentDate:'2026-06-13',currency:'CAD',status:status==='committed'?'approved':'draft',createdBy:f.actorId,updatedBy:f.actorId});
 await db.execute(sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,created_by,updated_by)
  values(${id},${f.orgId},${f.scheduleId},'2026-05-31','2026-06-13','2026-06-15',2026,${status},${f.actorId},${f.actorId})`);
 if(status==='committed'){
  const stub=randomUUID();await seedPayrollStub(f.orgId,id,f.employeeId,employment,{id:stub,province:'ON',periodsPerYear:26,
   payDate:'2026-06-15',taxYear:2026,currency:'CAD',gross:'10000',pensionableEarnings:'10000',insurableEarnings:'10000',
   netPay:'10000',filingAccountId:account,country:'CA',countrySource:'calculation',factors:{C:amount,C2:'10',EI:'12',QPIP:'0',QPIP_ER:'0',B:'0',F3:'0',F5B:'0',QC_CSB:'0'},createdBy:f.actorId,updatedBy:f.actorId});
 }
 return {tx:db,orgId:f.orgId,employeePartyId:f.employeeId,taxYear:2026,documentId:id,subsidiaryId:owner};
}
async function source(f:Fixture,amounts:Record<string,string>={pensionableYtd:'10000',cppYtd:'100'}){
 const folder=randomUUID(),file=randomUUID(),version=randomUUID(),bytes=Buffer.from(JSON.stringify({employeePartyId:f.employeeId,legalEmployerSubsidiaryId:f.subsidiaryId,taxYear:2026,amounts}));
 const sha=createHash('sha256').update(bytes).digest('hex');
 await db.execute(sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
  values(${folder},${f.orgId},'Original opening evidence',true,${f.actorId},${f.actorId},${f.actorId})`);
 await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
  values(${file},${f.orgId},${folder},'original-opening.txt','text/plain',${bytes.length},${f.actorId},${f.actorId})`);
 await db.execute(sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
  values(${version},${file},1,${bytes.length},'text/plain',${sha},${f.actorId})`);
 await db.execute(sql`insert into file_blobs(version_id,bytes) values(${version},${bytes})`);
 await db.execute(sql`update files set current_version_id=${version} where org_id=${f.orgId} and id=${file}`);
 return {sourceFileId:file,sourceVersionId:version,sourceSha256:sha,sourceReference:'Original employer A employee opening report',reason:'Qualify original employer ownership'};
}

test('different employers retain independent annual contribution room while same-employer employment and RP changes retain history',{skip:!DB},async()=>{
 const f=await withBypassContext(setup);
 try{await withOrgContext(f.orgId,async()=>{
  const accountA=randomUUID(),accountB=randomUUID();
  for(const [id,number] of [[accountA,'123456789RP0001'],[accountB,'123456789RP0002']])await db.execute(sql`
   insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
   values(${id},${f.orgId},${f.subsidiaryId},'CA','ca_rp',${number},'Payroll program',true)`);
  await run(f,f.subsidiaryId,'committed','100',f.employmentId,accountA);
  const rehire=await seedWorkerEmployment(f.orgId,f.employeeId,f.subsidiaryId);
  await run(f,f.subsidiaryId,'committed','200',rehire,accountB);
  await run(f,f.other,'committed','400',f.employmentB);
  const a=await employeeYtd(await run(f,f.subsidiaryId,'draft'));
  const currentB=await run(f,f.other,'draft');const b=await employeeYtd(currentB);
  const identity=(await db.execute<{createdAt:string;documentNumber:string}>(sql`select r.created_at::text as "createdAt",d.document_number as "documentNumber"
    from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id where r.org_id=${f.orgId} and r.document_id=${currentB.documentId}`)).rows[0]!;
  const siblings=await listPeriodSiblings(db,f.orgId,{documentId:currentB.documentId,...identity,payScheduleId:f.scheduleId,
    periodStart:'2026-05-31',periodEnd:'2026-06-13',payDate:'2026-06-15',runType:'regular'});
  assert.equal(siblings.length,2,'another employer cannot share period exemptions or sequencing');
  const ownerRows=(await db.execute<{subsidiaryId:string}>(sql`select subsidiary_id as "subsidiaryId" from documents
    where org_id=${f.orgId} and id=any(${`{${siblings.map(sibling=>sibling.document_id).join(',')}}`}::uuid[])`)).rows;
  assert.ok(ownerRows.every(row=>row.subsidiaryId===f.other));
  assert.equal(a.cpp,'300');assert.equal(a.cpp2,'20');assert.equal(a.ei,'24');
  assert.equal(b.cpp,'400');assert.equal(b.cpp2,'10');assert.equal(b.ei,'12');
  await assert.rejects(employeeYtd({...await run(f,f.other,'draft'),subsidiaryId:f.subsidiaryId}),/actual pay-run legal employer/);
 });}finally{await withBypassContext(()=>dropScratchOrgReporting(f.orgId));}
});

test('unqualified opening payer refuses, exact source qualification replays, and another employer cannot consume it',{skip:!DB},async()=>{
 const f=await withBypassContext(setup);
 try{await withOrgContext(f.orgId,async()=>{
  await saveOpeningBalances({orgId:f.orgId,actorId:f.actorId,taxYear:2026,rows:[{employeePartyId:f.employeeId,amounts:{cppYtd:'100',pensionableYtd:'10000'}}]});
  const current=await run(f,f.subsidiaryId,'draft');await assert.rejects(employeeYtd(current),/no qualified original legal-employer authority/);
  const before=(await db.execute<{snapshot:string}>(sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`)).rows;
  const context=await readOpeningEmployerContext({orgId:f.orgId,actorId:f.actorId,employeePartyId:f.employeeId,taxYear:2026,allowedSubsidiaryIds:null});assert.ok(context.record);
  const input={orgId:f.orgId,actorId:f.actorId,openingBalanceId:context.record.id,subsidiaryId:f.subsidiaryId,
   expectedOpeningSha256:context.record.openingSha256,...await source(f),allowedSubsidiaryIds:null};
  await assert.rejects(qualifyOpeningEmployerAuthority({...input,expectedOpeningSha256:'f'.repeat(64)}),/source changed/);
  const qualified=await qualifyOpeningEmployerAuthority(input);assert.deepEqual(await qualifyOpeningEmployerAuthority(input),qualified);
  assert.equal((await employeeYtd(current)).cpp,'100.0000');assert.equal((await employeeYtd(await run(f,f.other,'draft'))).cpp,'0');
  await assert.rejects(qualifyOpeningEmployerAuthority({...input,subsidiaryId:f.other}),/different source evidence/);
  await assert.rejects(qualifyOpeningEmployerAuthority({...input,allowedSubsidiaryIds:new Set([f.other])}),/outside your payroll authority/);
  await assert.rejects(db.execute(sql`update payroll_opening_balances set cpp_ytd=0 where org_id=${f.orgId}`),
   error=>errorChainMatches(error,/Source-qualified opening amounts must be preserved/));
  assert.deepEqual((await db.execute<{snapshot:string}>(sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`)).rows,before);
  assert.equal((await db.execute<{n:number}>(sql`select count(*)::int as n from audit_log where org_id=${f.orgId} and table_name='payroll_opening_employer_authorities'`)).rows[0]!.n,1);
 });}finally{await withBypassContext(()=>dropScratchOrgReporting(f.orgId));}
});


test('qualifying employer source after calculation makes unchanged opening amounts stale until native recalculation',{skip:!DB},async()=>{
 const f=await withBypassContext(setup);
 try{await withOrgContext(f.orgId,async()=>{
  await saveOpeningBalances({orgId:f.orgId,actorId:f.actorId,taxYear:2026,rows:[{employeePartyId:f.employeeId,amounts:{taxableYtd:'1000'}}]});
  const {input}=await calculatedRun(f);assert.deepEqual((await payRunStaleness(f.orgId,input.documentId)).reasons,[]);
  const before=(await db.execute<{snapshot:string}>(sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`)).rows;
  const context=await readOpeningEmployerContext({orgId:f.orgId,actorId:f.actorId,employeePartyId:f.employeeId,taxYear:2026,allowedSubsidiaryIds:null});assert.ok(context.record);
  await qualifyOpeningEmployerAuthority({orgId:f.orgId,actorId:f.actorId,openingBalanceId:context.record.id,subsidiaryId:f.subsidiaryId,
   expectedOpeningSha256:context.record.openingSha256,...await source(f,{taxableYtd:'1000'}),allowedSubsidiaryIds:null});
  assert.deepEqual((await db.execute<{snapshot:string}>(sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`)).rows,before);
  assert.ok((await payRunStaleness(f.orgId,input.documentId)).reasons.includes('openingBalances'));
  await assert.rejects(commitPayRun(input),/openingBalances/);
  assert.deepEqual((await calculatePayRun(input)).errors,[]);
  assert.deepEqual((await payRunStaleness(f.orgId,input.documentId)).reasons,[]);
 });}finally{await withBypassContext(()=>dropScratchOrgReporting(f.orgId));}
});
