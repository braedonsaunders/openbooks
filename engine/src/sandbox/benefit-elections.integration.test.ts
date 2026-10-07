import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgTransaction } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { decideGate } from "../flows/gates.ts";
import { electEnrollment, endEnrollment } from "../hrm/benefits/enrollments.ts";
import { assertDedicatedFixtureDatabase, hasEphemeralDatabaseMarker, createScratchOrg, createScratchUser, dropScratchOrg, seedApprovalFlow } from "../testing/fixtures.ts";
import { enableFeatures, grantPermissions, seedEmployment, seedPlan, seededContributionTerms, seedWindow } from "../testing/hrm-harness.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

installEngineSeams();
const DB = !!process.env.OPENBOOKS_DB_URL;
const evidenceTables = ["hrm_benefit_enrollments", "hrm_benefit_enrollment_terms", "hrm_benefit_payroll_inputs"] as const;

async function sourceEvidence(orgId: string) {
  return Promise.all(evidenceTables.map(async table => ({ table, rows: (await db.execute<{ evidence: string }>(sql`
    select to_jsonb(source_row)::text as evidence from ${sql.identifier(table)} source_row where org_id=${orgId} order by id`)).rows })));
}

async function seedElections(org: Awaited<ReturnType<typeof createScratchOrg>>, actorId: string) {
  await enableFeatures(org.orgId, ["hrm"]);
  await grantPermissions(org.orgId, actorId, ["hrm.benefits.read", "hrm.benefits.manage"]);
  const approverId = await createScratchUser(org.orgId, "Coverage approver", `coverage_${randomUUID()}`);
  await grantPermissions(org.orgId, approverId, ["hrm.benefits.read", "hrm.benefits.manage"]);
  await seedApprovalFlow(org.orgId, { subjectKind: "hrm_benefit_enrollment", assignees: [{ type: "user", userId: approverId }], mode: "any", preventSelfApproval: true });
  const windowId = await seedWindow(org.orgId);
  const elections: string[] = [];
  for (const approvalMode of ["none", "flows"] as const) {
    const employment = await seedEmployment(org.orgId, org.subsidiaryId, { displayName: `Coverage ${approvalMode}` });
    const plan = await seedPlan(org.orgId, { currency: "CAD", approval_mode: approvalMode });
    const terms = (await seededContributionTerms(org.orgId, plan.planId)).map(term => ({ ...term,
      sourceDecimal: term.electedRate, provenance: { reason: "Signed coverage election", sourceIdentity: "private-election-reference" } }));
    const election = await electEnrollment({ orgId: org.orgId, actorId, employmentId: employment.employmentId,
      planId: plan.planId, windowId, effectiveFrom: "2026-03-01", contributionTerms: terms });
    if (approvalMode === "flows") {
      assert.equal(election.status, "pending_approval");
      const gates = (await db.execute<{ id: string }>(sql`select id from flow_gates where org_id=${org.orgId}
        and subject_kind='hrm_benefit_enrollment' and subject_id=${election.id} and status='pending'`)).rows;
      assert.equal(gates.length, 1);
      await decideGate({ gateId: gates[0]!.id, userId: approverId, decision: "approved" });
    } else assert.equal(election.status, "active");
    assert.equal((await db.execute<{ status: string }>(sql`select status from hrm_benefit_enrollments
      where org_id=${org.orgId} and id=${election.id}`)).rows[0]!.status, "active");
    elections.push(election.id);
  }
  // Reconstruct retained override metadata and one pre-retirement queue row
  // on the dedicated fixture database only. Approval and financial terms above
  // were produced by the real native workflow, not by these fixture changes.
  await assertDedicatedFixtureDatabase();
  await withMaintenanceTransaction(null, async () => {
    const marker = (await db.execute<{ marker: string | null }>(sql`select shobj_description(oid,'pg_database') as marker
      from pg_database where datname=current_database()`)).rows[0]?.marker;
    assert.equal(hasEphemeralDatabaseMarker(marker, process.env.OPENBOOKS_TEST_DB_MARKER), true);
    await db.execute(sql`alter table hrm_benefit_enrollment_terms disable trigger benefit_recurring_subject_trigger`);
    await db.execute(sql`alter table hrm_benefit_enrollment_terms disable trigger benefit_term_history_trigger`);
    assert.equal((await db.execute(sql`update hrm_benefit_enrollment_terms set
      override_reason='Signed override for private-election-reference',override_approved_by=${approverId},override_approved_at=now()
      where org_id=${org.orgId} and id=(select id from hrm_benefit_enrollment_terms
        where org_id=${org.orgId} and enrollment_id=${elections[1]} order by id limit 1) returning id`)).rows.length, 1);
    await db.execute(sql`alter table hrm_benefit_enrollment_terms enable trigger benefit_term_history_trigger`);
    await db.execute(sql`alter table hrm_benefit_enrollment_terms enable trigger benefit_recurring_subject_trigger`);
    await db.execute(sql`alter table hrm_benefit_payroll_inputs disable trigger benefit_monthly_queue_retired_trigger`);
    assert.equal((await db.execute(sql`insert into hrm_benefit_payroll_inputs
      (org_id,enrollment_id,employee_party_id,employment_id,kind,pay_component_id,amount,currency,coverage_from,coverage_to,status,voided_at,void_reason,created_by,updated_by)
      select e.org_id,e.id,w.worker_party_id,e.employment_id,'benefit_deduction',r.pay_component_id,'250.0000',e.currency,
        '2026-03-01','2026-03-31','voided',now(),'Superseded by native contribution calculation',${actorId},${actorId}
      from hrm_benefit_enrollments e join worker_employments w on w.org_id=e.org_id and w.id=e.employment_id
      join hrm_benefit_contribution_rules r on r.org_id=e.org_id and r.plan_id=e.plan_id and r.kind='employee_deduction'
      where e.org_id=${org.orgId} and e.id=${elections[0]} returning id`)).rows.length, 1);
    // Validate the retained row's deferred tenant references before restoring
    // its INSERT guard; PostgreSQL refuses ALTER TABLE with pending events.
    await db.execute(sql`set constraints all immediate`);
    await db.execute(sql`alter table hrm_benefit_payroll_inputs enable trigger benefit_monthly_queue_retired_trigger`);
  });
  return { elections, approverId };
}

for (const masked of [false, true]) test(`${masked ? "masked" : "full"} sandbox preserves approved Benefits elections and refuses fabricated history`, { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `Coverage ${randomUUID()}`;
  let assertionFailed = false;
  let assertionFailure: unknown;
  try {
    const actorId = await createScratchUser(org.orgId, "Sandbox owner", "admin");
    const { elections, approverId } = await seedElections(org, actorId);
    const original = await sourceEvidence(org.orgId);
    const created = await createSandbox({ productionOrgId: org.orgId, name: sandboxName,
      tier: masked ? "masked" : "full", masked, createdBy: actorId, lifecycleAuthority: { actorId } });
    const target = created.sandboxOrgId;
    const assertCopy = async () => {
      assert.equal((await db.execute<{ status: string }>(sql`select status from sandboxes where id=${created.sandboxId}`)).rows[0]!.status, "ready");
      const copied = (await db.execute<{ status: string; matched: boolean; protected: boolean; flow_bound: boolean }>(sql`
        select e.status,
          (e.id=ob_rebase(original.id,o.sandbox_seed) and e.plan_id=ob_rebase(original.plan_id,o.sandbox_seed)
           and e.employment_id=ob_rebase(original.employment_id,o.sandbox_seed) and e.window_id=ob_rebase(original.window_id,o.sandbox_seed)
           and e.elected_by=ob_rebase(original.elected_by,o.sandbox_seed) and e.submitted_by=ob_rebase(original.submitted_by,o.sandbox_seed)
           and e.currency=original.currency and e.effective_from=original.effective_from and e.effective_to is not distinct from original.effective_to
           and e.submitted_at=original.submitted_at and e.class_key is not distinct from original.class_key
           and e.match_eligible is not distinct from original.match_eligible) as matched,
          (case when ${masked} then e.submission_snapshot is null and e.decision_snapshot is null
           else e.submission_snapshot->>'planId'=e.plan_id::text and e.submission_snapshot->>'employmentId'=e.employment_id::text
            and e.decision_snapshot->>'outcome'='approved' and e.decision_snapshot->>'mode'=original.decision_snapshot->>'mode'
            and (select bool_and((c->>'ruleId')::uuid in (select rule_id from hrm_benefit_enrollment_terms where org_id=e.org_id and enrollment_id=e.id))
              from jsonb_array_elements(e.submission_snapshot->'contributions') c) end) as protected,
          (case when original.flow_run_id is null then e.flow_run_id is null else
            e.flow_run_id=ob_rebase(original.flow_run_id,o.sandbox_seed) and exists(select 1 from flow_runs f
             where f.org_id=e.org_id and f.id=e.flow_run_id and f.subject_id=e.id and f.created_by=e.submitted_by
              and f.context->>'planId'=e.plan_id::text and f.context->>'employmentId'=e.employment_id::text
              and exists(select 1 from flow_gates g where g.org_id=f.org_id and g.run_id=f.id and g.subject_id=e.id
                and g.status='approved' and g.decided_by=ob_rebase(${approverId}::uuid,o.sandbox_seed))) end) as flow_bound
        from hrm_benefit_enrollments e join orgs o on o.id=e.org_id
        join hrm_benefit_enrollments original on original.org_id=o.sandbox_of and e.id=ob_rebase(original.id,o.sandbox_seed)
        where e.org_id=${target}`)).rows;
      assert.equal(copied.length, 2);
      assert.deepEqual(copied.map(row => row.status), ["active", "active"]);
      assert.ok(copied.every(row => row.matched && row.protected && row.flow_bound));
      const terms = (await db.execute<{ matched: boolean }>(sql`select
        (t.enrollment_id=ob_rebase(original.enrollment_id,o.sandbox_seed) and t.rule_id=ob_rebase(original.rule_id,o.sandbox_seed)
         and t.election_mode=original.election_mode and t.elected_rate is not distinct from original.elected_rate
         and t.effective_from=original.effective_from and t.effective_to is not distinct from original.effective_to
         and t.created_by=ob_rebase(original.created_by,o.sandbox_seed)
         and t.override_approved_by is not distinct from ob_rebase(original.override_approved_by,o.sandbox_seed)
         and t.override_approved_at is not distinct from original.override_approved_at
         and case when ${masked} then t.provenance='{}'::jsonb and t.source_decimal is null
          and t.override_reason is not distinct from case when original.override_reason is null then null else 'REDACTED' end
         else t.provenance=original.provenance and t.source_decimal=original.source_decimal
          and t.override_reason is not distinct from original.override_reason end) as matched
        from hrm_benefit_enrollment_terms t join orgs o on o.id=t.org_id
        join hrm_benefit_enrollment_terms original on original.org_id=o.sandbox_of and t.id=ob_rebase(original.id,o.sandbox_seed)
        where t.org_id=${target}`)).rows;
      assert.equal(terms.length, 4);
      assert.ok(terms.every(row => row.matched));
      const queue = (await db.execute<{ matched: boolean }>(sql`select
        (q.enrollment_id=ob_rebase(original.enrollment_id,o.sandbox_seed) and q.employee_party_id=ob_rebase(original.employee_party_id,o.sandbox_seed)
         and q.pay_component_id=ob_rebase(original.pay_component_id,o.sandbox_seed) and q.employment_id=ob_rebase(original.employment_id,o.sandbox_seed)
         and q.amount=original.amount and q.currency=original.currency and q.status=original.status
         and q.coverage_from=original.coverage_from and q.coverage_to=original.coverage_to and q.void_reason=original.void_reason) as matched
        from hrm_benefit_payroll_inputs q join orgs o on o.id=q.org_id
        join hrm_benefit_payroll_inputs original on original.org_id=o.sandbox_of and q.id=ob_rebase(original.id,o.sandbox_seed)
        where q.org_id=${target}`)).rows;
      assert.deepEqual(queue, [{ matched: true }]);
      assert.deepEqual(await sourceEvidence(org.orgId), original);
    };
    await assertCopy();
    const inserts = [
      { table: "hrm_benefit_enrollments", patch: { id: randomUUID() }, refusal: /Create a benefit election.*plan approval setting/ },
      { table: "hrm_benefit_enrollments", patch: { employment_id: randomUUID() }, refusal: /Create a benefit election.*plan approval setting/ },
      { table: "hrm_benefit_enrollments", patch: { plan_id: randomUUID() }, refusal: /Create a benefit election.*plan approval setting/ },
      { table: "hrm_benefit_enrollments", patch: { effective_from: "2026-04-01" }, refusal: /Create a benefit election.*plan approval setting/ },
      { table: "hrm_benefit_enrollments", patch: { decision_snapshot: { outcome: "approved", mode: "human", runId: randomUUID() } }, refusal: /Create a benefit election.*plan approval setting/ },
      { table: "hrm_benefit_enrollment_terms", patch: { elected_rate: "251.0000000000" }, refusal: /Submitted contribution elections are immutable.*record action/ },
      { table: "hrm_benefit_enrollment_terms", patch: { rule_id: randomUUID() }, refusal: /Submitted contribution elections are immutable.*record action/ },
      { table: "hrm_benefit_payroll_inputs", patch: { amount: "251.0000" }, refusal: /Monthly benefit input generation has been replaced.*contribution terms/ },
    ] as const;
    for (const { table, patch, refusal } of inserts) {
      await assert.rejects(withMaintenanceTransaction(null, async () => {
        await db.execute(sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
        await db.execute(sql`insert into ${sql.identifier(table)} select (jsonb_populate_record(null::${sql.identifier(table)},
          (select to_jsonb(source_row) from ${sql.identifier(table)} source_row where org_id=${target} order by id limit 1) || ${JSON.stringify(patch)}::jsonb)).*`);
      }), error => errorChainMatches(error, refusal));
      await assertCopy();
    }
    for (const scope of [org.orgId, target]) {
      await assert.rejects(withOrgTransaction(scope, async () => {
        await db.execute(sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
        await db.execute(sql`insert into hrm_benefit_enrollments select (jsonb_populate_record(null::hrm_benefit_enrollments,
          (select to_jsonb(e) from hrm_benefit_enrollments e where org_id=${scope} order by id limit 1) || jsonb_build_object('id',${randomUUID()}::uuid))).*`);
      }), error => errorChainMatches(error, /Create a benefit election.*plan approval setting/));
    }
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      await db.execute(sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
      await db.execute(sql`insert into hrm_benefit_enrollments select (jsonb_populate_record(null::hrm_benefit_enrollments,
        (select to_jsonb(e) from hrm_benefit_enrollments e where org_id=${org.orgId} order by id limit 1)
        || jsonb_build_object('id',${randomUUID()}::uuid))).*`);
    }), error => errorChainMatches(error, /Create a benefit election.*plan approval setting/));
    for (const { table, refusal } of [
      { table: "hrm_benefit_enrollment_terms", refusal: /Submitted contribution elections are immutable.*record action/ },
      { table: "hrm_benefit_payroll_inputs", refusal: /Monthly benefit input generation has been replaced.*contribution terms/ },
    ] as const) await assert.rejects(withOrgTransaction(target, async () => {
      await db.execute(sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
      await db.execute(sql`insert into ${sql.identifier(table)} select (jsonb_populate_record(null::${sql.identifier(table)},
        (select to_jsonb(source_row) from ${sql.identifier(table)} source_row where org_id=${target} order by id limit 1)
        || jsonb_build_object('id',${randomUUID()}::uuid))).*`);
    }), error => errorChainMatches(error, refusal));
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      await db.execute(sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
      await db.execute(sql`update hrm_benefit_enrollments set decision_snapshot='{"outcome":"rejected"}'::jsonb where org_id=${target} and flow_run_id is not null`);
    }), error => errorChainMatches(error, masked ? /Benefit workflow evidence must match/ : /Benefit approval decisions are immutable/));
    for (const scope of [org.orgId, target]) await assert.rejects(withMaintenanceTransaction(null, async () => {
      await db.execute(sql`select set_config('openbooks.clone','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
      await db.execute(sql`update hrm_benefit_enrollment_terms set elected_rate='251.0000' where org_id=${scope}`);
    }), error => errorChainMatches(error, /Submitted contribution elections are immutable.*record action/));
    await assertCopy();
    await refreshSandbox(created.sandboxId, { keepCustomizations: false, authority: { actorId } });
    await assertCopy();
    if (!masked) {
      const copy = (await db.execute<{ id: string; actor_id: string }>(sql`select ob_rebase(${elections[1]}::uuid,sandbox_seed) as id,
        ob_rebase(${actorId}::uuid,sandbox_seed) as actor_id from orgs where id=${target}`)).rows[0]!;
      const ended = await endEnrollment({ orgId: target, actorId: copy.actor_id, enrollmentId: copy.id,
        endedOn: "2026-12-31", reason: "Coverage ended after copied workflow approval" });
      assert.equal(ended.status, "ended", "the copied approval graph must support its ordinary native record action");
      assert.deepEqual(await sourceEvidence(org.orgId), original);
    }
  } catch (error) {
    assertionFailed = true;
    assertionFailure = error;
    throw error;
  } finally {
    try {
      const shells = (await db.execute<{ id: string }>(sql`select id from sandboxes where production_org_id=${org.orgId} and name=${sandboxName}`)).rows;
      assert.ok(shells.length <= 1);
      for (const shell of shells) await deleteSandbox(shell.id);
      await dropScratchOrg(org.orgId);
    } catch (cleanupFailure) {
      if (assertionFailed) {
        throw new AggregateError([assertionFailure, cleanupFailure],
          "Benefits election assertions and sandbox cleanup both failed.", { cause: assertionFailure });
      }
      throw cleanupFailure;
    }
  }
});
