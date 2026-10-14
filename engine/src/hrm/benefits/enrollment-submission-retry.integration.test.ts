import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../platform/db.ts';
import { grantScratchPermissions } from '../../testing/fixtures.ts';
import { setupHarness,withHarness,seedEmployment,seedPlan,seededContributionTerms,enableHrm } from '../../testing/hrm-harness.ts';
import { installEngineSeams } from '../../composition/install.ts';
import { runRecordFlows,retryFlowRun } from '../../flows/run.ts';
import { recordEnrollmentContributionTerms } from './contributions.ts';
import { completeBenefitEnrollmentSubmission } from './enrollments.ts';

const spec={users:[{key:'actorId',name:'Benefits submission operator',handle:'benefits_submission_operator',permissions:['hrm.benefits.read','hrm.benefits.manage'],link:true}]} as const;
const trigger={id:'submit',position:{x:0,y:0},data:{kind:'trigger',trigger:{trigger:'on_submit'}}};
test('failed enrollment submission retries its exact original elections into active coverage once',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  await withHarness(()=>setupHarness(spec),async h=>{
    installEngineSeams();await grantScratchPermissions(h.org.orgId,h.actorId,['flows.manage']);await enableHrm(h.org.orgId,'flows');
    const {employmentId}=await seedEmployment(h.org.orgId,h.org.subsidiaryId);
    const {planId}=await seedPlan(h.org.orgId,{approval_mode:'flows'}),enrollmentId=randomUUID(),flowId=randomUUID();
    // The fixture retains the native submitted boundary, with actual elections
    // and a real dispatch failure; every storage guard remains enabled.
    assert.equal((await db.execute(sql`insert into hrm_benefit_enrollments
      (id,org_id,employment_id,plan_id,status,effective_from,currency,elected_by,created_by,updated_by)
      values(${enrollmentId},${h.org.orgId},${employmentId},${planId},'elected','2026-03-01','USD',${h.actorId},${h.actorId},${h.actorId}) returning id`)).rows.length,1);
    await recordEnrollmentContributionTerms(db,h.org.orgId,h.actorId,enrollmentId,'2026-03-01',null,await seededContributionTerms(h.org.orgId,planId));
    assert.equal((await db.execute(sql`update hrm_benefit_enrollments set submitted_by=${h.actorId},submitted_at=now(),updated_by=${h.actorId},
      submission_snapshot=public.benefit_enrollment_submission_source(org_id,id)
      where org_id=${h.org.orgId} and id=${enrollmentId} and status='elected' returning id`)).rows.length,1);
    const graph={schemaVersion:1,nodes:[trigger,{id:'unavailable',position:{x:200,y:0},data:{kind:'gate',gate:{title:'Benefits decision',assignees:[{type:'user',userId:randomUUID()}],mode:'any',preventSelfApproval:true}}}],
      edges:[{id:'submit-unavailable',source:'submit',target:'unavailable',sourceHandle:'next'}]};
    assert.equal((await db.execute(sql`insert into flows(id,org_id,name,subject_kind,enabled,graph)
      values(${flowId},${h.org.orgId},'Benefits election policy','hrm_benefit_enrollment',true,${JSON.stringify(graph)}::jsonb) returning id`)).rows.length,1);
    const dispatched=await runRecordFlows({kind:'on_submit',source:'script'},'hrm_benefit_enrollment',enrollmentId,{orgId:h.org.orgId,userId:h.actorId});
    assert.equal(dispatched.failed,true);assert.equal(dispatched.runs.length,1);assert.equal(dispatched.gatesCreated,0);
    const runId=dispatched.runs[0]!.runId;assert.equal(dispatched.runs[0]!.status,'failed');
    assert.equal((await db.execute(sql`update hrm_benefit_enrollments set status='pending_approval',flow_run_id=${runId},updated_by=${h.actorId}
      where org_id=${h.org.orgId} and id=${enrollmentId} and status='elected' returning id`)).rows.length,1);
    const evidence=async()=>({
      proposal:(await db.execute(sql`select submission_snapshot,submitted_by,submitted_at,flow_run_id,employment_id,plan_id,effective_from,effective_to,currency
        from hrm_benefit_enrollments where org_id=${h.org.orgId} and id=${enrollmentId}`)).rows,
      terms:(await db.execute(sql`select to_jsonb(t) as snapshot from hrm_benefit_enrollment_terms t where org_id=${h.org.orgId} and enrollment_id=${enrollmentId} order by id`)).rows,
    });
    const original=await evidence();
    const current={schemaVersion:1,ungatedOutcome:'apply',nodes:[trigger],edges:[]};
    assert.equal((await db.execute(sql`update flows set graph=${JSON.stringify(current)}::jsonb where org_id=${h.org.orgId} and id=${flowId} returning id`)).rows.length,1);
    const result=await retryFlowRun(runId,{orgId:h.org.orgId,userId:h.actorId});assert.equal(result.status,'completed');
    const active=(await db.execute<{status:string;decision:Record<string,unknown>}>(sql`select status,decision_snapshot as decision
      from hrm_benefit_enrollments where org_id=${h.org.orgId} and id=${enrollmentId}`)).rows;
    assert.equal(active.length,1);assert.equal(active[0]!.status,'active');assert.equal(active[0]!.decision.mode,'automatic');assert.equal(active[0]!.decision.runId,runId);
    assert.deepEqual(await evidence(),original);
    const counts=async()=>({events:(await db.execute(sql`select id from hrm_benefit_events where org_id=${h.org.orgId} and enrollment_id=${enrollmentId} and kind='activated'`)).rows,
      runs:(await db.execute(sql`select id from flow_runs where org_id=${h.org.orgId} and subject_id=${enrollmentId}`)).rows});
    const once=await counts();assert.equal(once.events.length,1);assert.deepEqual(once.runs,[{id:runId}]);
    assert.deepEqual(await completeBenefitEnrollmentSubmission({orgId:h.org.orgId,actorId:h.actorId,enrollmentId,runId,mode:'automatic'}),{status:'active'});
    assert.deepEqual(await evidence(),original);assert.deepEqual(await counts(),once);
    await assert.rejects(retryFlowRun(runId,{orgId:h.org.orgId,userId:h.actorId}),/failed/);assert.deepEqual(await counts(),once);
  });
});
