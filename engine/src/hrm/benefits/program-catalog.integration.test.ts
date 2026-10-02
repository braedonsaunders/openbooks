import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db,withOrgTransaction } from '../../platform/db.ts';
import { setupHarness,withHarness,seedPlan,seedEmployment,mkSecondSubsidiary,restrictRole,setFeatures } from '../../testing/hrm-harness.ts';
import { listBenefitsProgramCatalog,listBenefitsProgramParticipants,listBenefitsProgramActivity,getBenefitsProgramWorkspace } from './program-catalog.ts';
import { validateVacationTermConfiguration,resolveVacationTerms } from '../../payroll/vacation-terms.ts';
const SPEC={features:['hrm','payroll'],users:[{key:'hr',name:'Benefits Reader',handle:'benefits_reader',permissions:['hrm.benefits.read','hrm.benefits.manage']}] } as const;
const refusal=(message:RegExp)=>(error:unknown)=>error instanceof Error && message.test(error.cause instanceof Error ? error.cause.message : error.message);
test('Canonical program ownership and scoped participants',{skip:!process.env.OPENBOOKS_DB_URL},async t=>withHarness(()=>setupHarness(SPEC),async h=>{
  const orgId=h.org.orgId,actorId=h.hr,{planId}=await seedPlan(orgId),vacationId=randomUUID(),rewardId=randomUUID();
  await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,system_key,unit,direction,accrual_method) values(${vacationId},${orgId},'VAC','Vacation','vacation','money','accrue','manual')`);
  await db.execute(sql`insert into hrm_benefit_programs(id,org_id,code,name,family,currency,legal_entity_id,effective_from) values(${rewardId},${orgId},'THANKS','Recognition','reward','USD',${h.org.subsidiaryId},'2026-01-01')`);
  const first=await seedEmployment(orgId,h.org.subsidiaryId),otherEntity=await mkSecondSubsidiary(orgId,h.org.subsidiaryId),other=await seedEmployment(orgId,otherEntity);
  const insertTerms=(employmentId:string)=>db.execute(sql`insert into payroll_vacation_terms(org_id,employment_id,plan_id,method,percent_floor,effective_from,reason) values(${orgId},${employmentId},${vacationId},'accrue',6,'2026-01-01','Granted employee terms')`);
  await insertTerms(first.employmentId);await insertTerms(other.employmentId);
  await db.execute(sql`insert into hrm_benefit_enrollments(org_id,employment_id,plan_id,currency,effective_from) values(${orgId},${first.employmentId},${planId},'USD','2026-01-01')`);
  await t.test('Native inserts have exactly one identity and configuration remains native',async()=>{
    const catalog=await listBenefitsProgramCatalog(db,orgId,actorId);assert.equal(catalog.length,3);
    assert.deepEqual(new Set(catalog.map(p=>p.id)),new Set([planId,vacationId,rewardId]));
    await db.execute(sql`update entitlement_plans set name='Annual vacation' where org_id=${orgId} and id=${vacationId}`);
    const workspace=await getBenefitsProgramWorkspace(db,orgId,actorId,vacationId);assert.equal(workspace.program.name,'Annual vacation');assert.equal(workspace.participants.length,2);
  });
  await t.test('Recovery banks retain their insured parent without becoming duplicate offerings',async()=>{
    const bank=randomUUID();await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,payout_component_id) select ${bank},${orgId},'RECOVERY','Premium recovery','money','owe','manual',pay_component_id from hrm_benefit_contribution_rules where org_id=${orgId} and plan_id=${planId} and kind='employee_deduction'`);
    await db.execute(sql`update hrm_benefit_contribution_rules set unpaid_period_treatment='carry',arrears_plan_id=${bank},arrears_recovery_periods=10 where org_id=${orgId} and plan_id=${planId} and kind='employee_deduction'`);
    assert.equal((await listBenefitsProgramCatalog(db,orgId,actorId)).length,3);
    assert.deepEqual((await listBenefitsProgramCatalog(db,orgId,actorId,{includeInternal:true})).find(p=>p.id===bank)?.parentProgramIds,[planId]);
  });
  await t.test('Identity deletion and reassociation refuse without removing native records',async()=>{
    await assert.rejects(()=>db.execute(sql`delete from hrm_benefit_catalog where org_id=${orgId} and id=${vacationId}`),refusal(/cannot be removed/));
    await assert.rejects(()=>db.execute(sql`update hrm_benefit_catalog set insured_plan_id=${planId},entitlement_plan_id=null where org_id=${orgId} and id=${vacationId}`),refusal(/immutable/));
    await assert.rejects(()=>db.execute(sql`update entitlement_plans set system_key=null where org_id=${orgId} and id=${vacationId}`),refusal(/cannot change its engine binding/));
    assert.equal((await getBenefitsProgramWorkspace(db,orgId,actorId,vacationId)).participants.length,2);
  });
  await t.test('Vacation terms resolve their exact governing program and amount',async()=>{
    const terms=await resolveVacationTerms(db,orgId,first.employmentId,'2026-02-01');assert.equal(terms?.planId,vacationId);assert.equal(terms?.percentFloor,'6.0000');
    await assert.rejects(()=>validateVacationTermConfiguration(db,orgId,{employmentId:first.employmentId,method:'accrue',effectiveFrom:'2026-01-01',reason:'Test'}),/governing vacation program/);
    await assert.rejects(()=>db.execute(sql`insert into payroll_vacation_terms(org_id,employment_id,plan_id,method,effective_from,reason) values(${orgId},${first.employmentId},${randomUUID()},'accrue','2027-01-01','Invalid program')`),refusal(/vacation program/));
  });
  await t.test('Cross-program reads retain employee and legal-entity fences',async()=>{
    assert.equal((await listBenefitsProgramParticipants(db,orgId,actorId,{employeePartyId:first.workerPartyId})).length,2);
    await restrictRole(orgId,'benefits_reader',[h.org.subsidiaryId]);
    const participants=await listBenefitsProgramParticipants(db,orgId,actorId);assert.equal(participants.length,2);assert.ok(participants.every(p=>p.employmentId===first.employmentId));
    await assert.rejects(()=>getBenefitsProgramWorkspace(db,orgId,actorId,randomUUID()),/unavailable in your organization/);
  });
  await t.test('Ledger delivery preserves denomination and never implies payment',async()=>{
    await db.execute(sql`insert into entitlement_ledger(org_id,plan_id,employment_id,employee_party_id,movement_date,amount,kind) values(${orgId},${vacationId},${first.employmentId},${first.workerPartyId},'2026-01-01',10,'opening')`);
    const [entry]=await listBenefitsProgramActivity(db,orgId,actorId,{programId:vacationId});assert.equal(entry?.unit,'money');assert.equal(entry?.currency,null);assert.equal(entry?.payrollProcessed,false);
    await assert.rejects(()=>db.execute(sql`update entitlement_plans set unit='hours' where org_id=${orgId} and id=${vacationId}`),refusal(/cannot change its balance unit or direction/));
  });
  await t.test('Runtime RLS cannot read another organization program identity',async()=>{
    const rows=await withOrgTransaction(randomUUID(),async ()=>(await db.execute(sql`select id from hrm_benefit_catalog where id=${planId}`)).rows);assert.equal(rows.length,0);
  });
  await t.test('Payroll-off preserves native history and hides entitlement operations',async()=>{
    await setFeatures(orgId,{payroll:false});assert.equal((await listBenefitsProgramCatalog(db,orgId,actorId)).length,2);
    assert.equal((await listBenefitsProgramParticipants(db,orgId,actorId)).length,1);
    await assert.rejects(()=>getBenefitsProgramWorkspace(db,orgId,actorId,vacationId),/Enable Payroll/);
    assert.equal((await db.execute(sql`select id from payroll_vacation_terms where org_id=${orgId}`)).rows.length,2);
  });
}));
