import {resolveStatutoryHistoryScope,employerScopedStatutoryStubs} from '../statutory-history-scope.ts';
import {payRunStaleness} from '../readiness.ts';
import {calculatePayRun} from '../run-calculation.ts';
import {commitPayRun} from '../run-commit.ts';
import {listPeriodSiblings} from '../period-priors.ts';
import {canonicalJson,parsePayRunCalculationErrors,payRunCalculationSourceDigest,type PayRunCalculationError,type PayRunCalculationSourceSnapshot} from '../run-calculation-evidence.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {db,withBypassContext,withOrgContext} from '../../platform/db.ts';
import {seedAdoption,calculatedRun} from '../filing-test-fixtures.ts';
import {seedVacationTerms,seedPayrollSettings,seedWorkerEmployment,dropScratchOrgReporting} from '../../testing/fixtures.ts';
import {createPayRun,reresolveRunToSubsidiary} from '../run-lifecycle.ts';
import {mutatePayRunAdjustment} from '../run-adjustments.ts';
import {add,cmp} from '../../money/money.ts';
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
 const created=await createPayRun({orgId:f.orgId,actorId:f.actorId,payScheduleId:f.scheduleId,
  periodStart:'2026-05-31',periodEnd:'2026-06-13',payDate:'2026-06-15',runType:'supplemental'});
 const id=created.documentId;
 let calculationWarnings:PayRunCalculationError[]=[];
 await reresolveRunToSubsidiary(db,{orgId:f.orgId,actorId:f.actorId,documentId:id,subsidiaryId:owner});
 if(status==='committed'){
  assert.ok(account,'A native calculation retains its actual employer filing account');
  assert.equal((await db.execute(sql`update parties set subsidiary_id=${owner}
   where org_id=${f.orgId} and id=${f.employeeId} returning id`)).rows.length,1);
  assert.equal((await db.execute(sql`update employee_payroll_profiles set employment_id=${employment},filing_account_id=${account}
   where org_id=${f.orgId} and employee_party_id=${f.employeeId} returning employee_party_id`)).rows.length,1);
  const base=(await db.execute<{id:string}>(sql`select id from pay_components where org_id=${f.orgId} and system_key='base_pay'`)).rows;
  assert.equal(base.length,1);
  await mutatePayRunAdjustment({orgId:f.orgId,actorId:f.actorId,documentId:id,reason:'Declared supplemental wage for the selected employment',
   mutation:{action:'add',employeePartyId:f.employeeId,componentId:base[0]!.id,amount,hours:'100',replaceComponent:true,
    earnedFrom:'2026-06-12',earnedTo:'2026-06-12'}});
  const input={orgId:f.orgId,actorId:f.actorId,documentId:id};
  const calculation=await calculatePayRun(input);
  const parsed=parsePayRunCalculationErrors(calculation.errors);assert.ok(parsed,'Native calculation outcomes must be well formed');
  const stored=(await db.execute<{errors:unknown}>(sql`select calculation_errors as errors from pay_runs
    where org_id=${f.orgId} and document_id=${id}`)).rows;
  assert.equal(stored.length,1);
  const retainedOutcomes=parsePayRunCalculationErrors(stored[0]!.errors);assert.ok(retainedOutcomes);
  assert.equal(canonicalJson(retainedOutcomes),canonicalJson(parsed),'Every native warning remains in retained calculation evidence');
  assert.deepEqual(parsed.filter(entry=>entry.kind!=='warning'),[],'No refusal, out-of-scope or unknown outcome may be waived');
  calculationWarnings=parsed.filter(entry=>entry.kind==='warning');
  await commitPayRun(input);
  const retained=(await db.execute<{employmentId:string;account:string;gross:string}>(sql`select employment_id as "employmentId",
    filing_account_id as account,gross::text as gross from pay_stubs where org_id=${f.orgId} and pay_run_document_id=${id}`)).rows;
  assert.equal(retained.length,1);assert.equal(retained[0]!.employmentId,employment);assert.equal(retained[0]!.account,account);
  assert.equal(cmp(retained[0]!.gross,amount),0);
 }
 return {tx:db,orgId:f.orgId,employeePartyId:f.employeeId,taxYear:2026,documentId:id,subsidiaryId:owner,calculationWarnings};
}
async function source(f:Fixture,amounts:Record<string,string>={pensionableYtd:'10000',insurableYtd:'10000',cppYtd:'100'}){
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

test('different employers retain independent annual contribution room while same-employer employment and RP changes retain history',{skip:!DB},async t=>{
 const f=await withBypassContext(setup);
 try{await withOrgContext(f.orgId,async()=>{
  const accountA=randomUUID(),accountB=randomUUID();
  for(const [id,number] of [[accountA,'123456789RP0001'],[accountB,'123456789RP0002']])await db.execute(sql`
   insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
   values(${id},${f.orgId},${f.subsidiaryId},'CA','ca_rp',${number},'Payroll program',true)`);
  const first=await run(f,f.subsidiaryId,'committed','100000',f.employmentId,accountA);
  const rehire=await seedWorkerEmployment(f.orgId,f.employeeId,f.subsidiaryId);
  await seedVacationTerms(f.orgId,rehire,f.actorId);
  const second=await run(f,f.subsidiaryId,'committed','100000',rehire,accountB);
  const accountOther=randomUUID();
  assert.equal((await db.execute(sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
   values(${accountOther},${f.orgId},${f.other},'CA','ca_rp','987654321RP0001','Second employer payroll',true) returning id`)).rows.length,1);
  await seedVacationTerms(f.orgId,f.employmentB,f.actorId);
  const third=await run(f,f.other,'committed','100000',f.employmentB,accountOther);
  t.diagnostic(JSON.stringify([first,second,third].map(run=>({documentId:run.documentId,warnings:run.calculationWarnings}))));
  const contributions=async(documentId:string)=>(await db.execute<{cpp:string;cpp2:string;ei:string}>(sql`
   select factors->>'C' as cpp,factors->>'C2' as cpp2,factors->>'EI' as ei from pay_stubs
   where org_id=${f.orgId} and pay_run_document_id=${documentId}`)).rows[0]!;
  const original=await contributions(first.documentId),rehired=await contributions(second.documentId),other=await contributions(third.documentId);
  for(const key of ['cpp','cpp2','ei'] as const){
   assert.ok(cmp(original[key],'0')>0,'The first native wage consumes each annual contribution limit');
   assert.equal(cmp(rehired[key],'0'),0,'Same employer rehire and RP changes cannot reset annual room');
   assert.equal(cmp(other[key],original[key]),0,'Another employer retains its independent annual room');
  }
  const currentA=await run(f,f.subsidiaryId,'draft');const a=await employeeYtd(currentA);
  const currentB=await run(f,f.other,'draft');const b=await employeeYtd(currentB);
  const scopeA=await resolveStatutoryHistoryScope(db,{...currentA,country:'CA'});
  const scopeB=await resolveStatutoryHistoryScope(db,{...currentB,country:'CA'});
  const history=async(scope:typeof scopeA)=>(await db.execute<{id:string;employmentId:string}>(sql`select s.id,s.employment_id as "employmentId"
    from ${employerScopedStatutoryStubs(scope,{employeePartyId:f.employeeId})} s order by s.id`)).rows;
  const retainedA=await history(scopeA),retainedB=await history(scopeB);
  assert.equal(retainedA.length,2);assert.equal(retainedB.length,1);
  assert.deepEqual(new Set(retainedA.map(row=>row.employmentId)),new Set([f.employmentId,rehire]),'Employer-wide annual room retains same-payer rehires');
  assert.equal(retainedB[0]!.employmentId,f.employmentB,'A current party reassignment cannot reinterpret earlier payer history');
  const employmentOnly=(await db.execute<{employmentId:string}>(sql`select s.employment_id as "employmentId"
    from ${employerScopedStatutoryStubs(scopeA,{employeePartyId:f.employeeId,employmentId:rehire})} s`)).rows;
  assert.deepEqual(employmentOnly,[{employmentId:rehire}],'Pack-declared employment priors do not double count a previous spell already certified as prior pay');
  await assert.rejects(resolveStatutoryHistoryScope(db,{...currentB,country:'CA',subsidiaryId:f.subsidiaryId}),/actual pay-run legal employer/);
  assert.deepEqual(await history(scopeA),retainedA);assert.deepEqual(await history(scopeB),retainedB);
  const identity=(await db.execute<{createdAt:string;documentNumber:string}>(sql`select r.created_at::text as "createdAt",d.document_number as "documentNumber"
    from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id where r.org_id=${f.orgId} and r.document_id=${currentB.documentId}`)).rows[0]!;
  const siblings=await listPeriodSiblings(db,f.orgId,{documentId:currentB.documentId,...identity,payScheduleId:f.scheduleId,
    periodStart:'2026-05-31',periodEnd:'2026-06-13',payDate:'2026-06-15',runType:'supplemental'});
  assert.equal(siblings.length,2,'another employer cannot share period exemptions or sequencing');
  const ownerRows=(await db.execute<{subsidiaryId:string}>(sql`select subsidiary_id as "subsidiaryId" from documents
    where org_id=${f.orgId} and id=any(${`{${siblings.map(sibling=>sibling.document_id).join(',')}}`}::uuid[])`)).rows;
  assert.ok(ownerRows.every(row=>row.subsidiaryId===f.other));
  for(const key of ['cpp','cpp2','ei'] as const){
   assert.equal(cmp(a[key],add(original[key],rehired[key])),0);
   assert.equal(cmp(b[key],other[key]),0);
  }
  assert.deepEqual(await contributions(first.documentId),original,'Later employment and employer assignments preserve earlier committed factors');
  await assert.rejects(employeeYtd({...await run(f,f.other,'draft'),subsidiaryId:f.subsidiaryId}),/actual pay-run legal employer/);
 });}finally{await withBypassContext(()=>dropScratchOrgReporting(f.orgId));}
});

test('unqualified opening payer refuses, exact source qualification replays, and another employer cannot consume it',{skip:!DB},async()=>{
 const f=await withBypassContext(setup);
 try{await withOrgContext(f.orgId,async()=>{
  await saveOpeningBalances({orgId:f.orgId,actorId:f.actorId,taxYear:2026,rows:[{employeePartyId:f.employeeId,amounts:{cppYtd:'100',pensionableYtd:'10000',insurableYtd:'10000'}}]});
  const current=await run(f,f.subsidiaryId,'draft');await assert.rejects(employeeYtd(current),/no qualified original legal-employer authority/);
  const before=(await db.execute<{snapshot:string}>(sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`)).rows;
  const context=await readOpeningEmployerContext({orgId:f.orgId,actorId:f.actorId,employeePartyId:f.employeeId,taxYear:2026,allowedSubsidiaryIds:null});assert.ok(context.record);
  const input={orgId:f.orgId,actorId:f.actorId,openingBalanceId:context.record.id,subsidiaryId:f.subsidiaryId,
   expectedOpeningSha256:context.record.openingSha256,...await source(f),allowedSubsidiaryIds:null};
  const unrelated=randomUUID();
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
    values(${unrelated},${f.orgId},${f.subsidiaryId},'Unrelated legal employer','CAD','CA')`);
  await assert.rejects(qualifyOpeningEmployerAuthority({...input,subsidiaryId:unrelated}),/retained native employment/);
  assert.equal((await db.execute(sql`select id from payroll_opening_employer_authorities where org_id=${f.orgId}`)).rows.length,0);
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
  const sourceEvidence=await source(f,{taxableYtd:'1000'});
  const qualified=await qualifyOpeningEmployerAuthority({orgId:f.orgId,actorId:f.actorId,openingBalanceId:context.record.id,subsidiaryId:f.subsidiaryId,
   expectedOpeningSha256:context.record.openingSha256,...sourceEvidence,allowedSubsidiaryIds:null});
  assert.deepEqual((await db.execute<{snapshot:string}>(sql`select to_jsonb(b)::text as snapshot from payroll_opening_balances b where org_id=${f.orgId}`)).rows,before);
  assert.ok((await payRunStaleness(f.orgId,input.documentId)).reasons.includes('openingBalances'));
  await assert.rejects(commitPayRun(input),/openingBalances/);
  assert.deepEqual((await calculatePayRun(input)).errors,[]);
  assert.deepEqual((await payRunStaleness(f.orgId,input.documentId)).reasons,[]);
  const retained=(await db.execute<{snapshot:PayRunCalculationSourceSnapshot;digest:string}>(sql`
    select calculation_source_snapshot as snapshot,calculation_source_digest as digest
    from pay_runs where org_id=${f.orgId} and document_id=${input.documentId}`)).rows;
  assert.equal(retained.length,1);
  assert.equal(payRunCalculationSourceDigest(retained[0]!.snapshot),retained[0]!.digest);
  assert.deepEqual(retained[0]!.snapshot.openingEmployerAuthorities,[{id:qualified.id,openingBalanceId:context.record.id,
    employeePartyId:f.employeeId,taxYear:2026,subsidiaryId:f.subsidiaryId,
    sourceFileId:sourceEvidence.sourceFileId,sourceVersionId:sourceEvidence.sourceVersionId,
    sourceSha256:sourceEvidence.sourceSha256,openingSha256:context.record.openingSha256}]);
 });}finally{await withBypassContext(()=>dropScratchOrgReporting(f.orgId));}
});
