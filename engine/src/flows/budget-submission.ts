import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { routeSubjectSubmission } from "./submission-policy.ts";
import { completedGateDecisionPolicy } from "./approval-decision-policy.ts";
import { cancelDispatchRuns } from "./dispatch-result.ts";

export class BudgetApprovalError extends Error {
  readonly status = 409;
}

async function lockBudget(
  orgId: string,
  actorId: string,
  id: string,
  permission: string,
) {
  const scope = await lockActorCommandAuthority(
    db,
    orgId,
    actorId,
    null,
    permission,
  );
  if (!(await lockAndCheckOrgFeature(db, orgId, "budgets")))
    throw new BudgetApprovalError(
      "Turn on Budgets in Company Settings → Features.",
    );
  const budget = (
    await db.execute<{
      status: string;
      revision: number;
      submitted_by: string | null;
    }>(sql`
    select status, revision, submitted_by from budget_scenarios where org_id=${orgId} and id=${id} for update
  `)
  ).rows[0];
  if (!budget) throw new BudgetApprovalError("Budget not found.");
  const entities = (
    await db.execute<{ subsidiary_id: string | null }>(sql`
    select distinct subsidiary_id from budget_lines where org_id=${orgId} and scenario_id=${id}
  `)
  ).rows;
  if (
    scope !== null &&
    entities.some((row) => !row.subsidiary_id || !scope.has(row.subsidiary_id))
  )
    throw new BudgetApprovalError(
      "This action requires access to every legal entity in the budget.",
    );
  return budget;
}

export async function submitBudgetScenario(
  orgId: string,
  actorId: string,
  id: string,
  expectedRevision: number,
) {
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, "budget_scenario", id);
    const budget = await lockBudget(orgId, actorId, id, "budgets.manage");
    if (budget.status !== "draft" || budget.revision !== expectedRevision)
      throw new BudgetApprovalError(
        "The budget changed. Reload the draft before submitting it.",
      );
    const lines = await db.execute(
      sql`select 1 from budget_lines where org_id=${orgId} and scenario_id=${id} and amount<>0 limit 1`,
    );
    if (!lines.rows.length)
      throw new BudgetApprovalError(
        "Add at least one nonzero budget line before submitting.",
      );
    const routing = await routeSubjectSubmission({
      orgId,
      actorId,
      subjectKind: "budget_scenario",
      subjectId: id,
    });
    const changed = await db.execute(sql`
      update budget_scenarios set status='pending_approval', revision=revision+1,
        submitted_at=now(), submitted_by=${actorId}, submission_policy=${JSON.stringify(routing.policy)}::jsonb,
        updated_at=now(), updated_by=${actorId}
      where org_id=${orgId} and id=${id} and status='draft' and revision=${expectedRevision} returning id
    `);
    if (changed.rows.length !== 1)
      throw new BudgetApprovalError("The budget changed during submission.");
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${orgId},'budget_scenarios',${id},'update',${JSON.stringify({ event: "submitted", submissionId: routing.submissionId, policy: routing.policy })}::jsonb,${actorId})`);
    if (routing.policy.kind === "ungated")
      await releaseBudgetScenario(orgId, actorId, id, "approved");
    return (
      await db.execute<{ status: string; revision: number }>(
        sql`select status,revision from budget_scenarios where org_id=${orgId} and id=${id}`,
      )
    ).rows[0]!;
  });
}

export async function releaseBudgetScenario(
  orgId: string,
  actorId: string,
  id: string,
  outcome: "approved" | "rejected",
  approvalRunId?: string,
  comment?: string | null,
) {
  const decision = await completedGateDecisionPolicy(db, {
    orgId,
    actorId,
    subjectKind: "budget_scenario",
    subjectId: id,
    outcome,
    approvalRunId,
  });
  const budget = await lockBudget(
    orgId,
    actorId,
    id,
    decision ? "budgets.approve" : "budgets.manage",
  );
  if (budget.status !== "pending_approval")
    throw new BudgetApprovalError("Only a submitted budget can be released.");
  const ungated =
    !approvalRunId &&
    outcome === "approved" &&
    budget.submitted_by === actorId &&
    (
      await db.execute<{
        allowed: boolean;
      }>(sql`select public.flow_ungated_submission_authorized(${orgId},'budget_scenario',${id},${actorId},
      jsonb_build_object('revision',${budget.revision - 1}::integer)) as allowed`)
    ).rows[0]?.allowed === true;
  if (!decision && !ungated)
    throw new BudgetApprovalError(
      "Complete the configured native Flow gates before deciding this budget.",
    );
  const to = outcome === "approved" ? "approved" : "draft";
  const changed =
    await db.execute(sql`update budget_scenarios set status=${to},revision=revision+1,
    approved_at=case when ${to}='approved' then now() else null end,
    approved_by=case when ${to}='approved' then ${actorId}::uuid else null end,
    submitted_by=case when ${to}='draft' then null else submitted_by end,
    submitted_at=case when ${to}='draft' then null else submitted_at end,
    submission_policy=case when ${to}='draft' then null else submission_policy end,
    updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and id=${id} and status='pending_approval' and revision=${budget.revision} returning id`);
  if (changed.rows.length !== 1)
    throw new BudgetApprovalError(
      "The submitted budget changed before release.",
    );
  await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${orgId},'budget_scenarios',${id},'update',${JSON.stringify({ event: outcome, from: "pending_approval", to, mode: decision ? "gated" : "ungated", approvalRunId: approvalRunId ?? null, comment: comment ?? null })}::jsonb,${actorId})`);
}

export async function withdrawBudgetScenario(
  orgId: string,
  actorId: string,
  id: string,
  expectedRevision: number,
) {
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, "budget_scenario", id);
    const budget = await lockBudget(orgId, actorId, id, "budgets.manage");
    if (
      budget.status !== "pending_approval" ||
      budget.revision !== expectedRevision
    )
      throw new BudgetApprovalError(
        "Reload the submitted budget before withdrawing it.",
      );
    const runs = (
      await db.execute<{ id: string }>(
        sql`select id from flow_runs where org_id=${orgId} and subject_kind='budget_scenario' and subject_id=${id} and status in ('running','waiting') order by id for update`,
      )
    ).rows;
    await cancelDispatchRuns(
      orgId,
      runs.map((run) => run.id),
      { actorId },
    );
    const changed =
      await db.execute(sql`update budget_scenarios set status='draft',revision=revision+1,submission_policy=null,
      submitted_at=null,submitted_by=null,updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and id=${id} and revision=${expectedRevision} returning status,revision`);
    if (changed.rows.length !== 1)
      throw new BudgetApprovalError(
        "The submitted budget changed before withdrawal.",
      );
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${orgId},'budget_scenarios',${id},'update','{"event":"withdrawn","from":"pending_approval","to":"draft"}'::jsonb,${actorId})`);
    return changed.rows[0];
  });
}
