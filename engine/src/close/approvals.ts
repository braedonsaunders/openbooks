import { CloseError } from "./period-policy.ts";
import { advancedCloseEnabled } from "./features.ts";
import { sql } from "drizzle-orm";
import { db, withOrg, type SqlExecutor } from "../platform/db.ts";
import { periodFingerprint } from "./readiness.ts";
import { refreshCloseRun } from "./run-automation.ts";
async function assertCloseReadyForApproval(
  executor: SqlExecutor,
  orgId: string,
  runId: string,
): Promise<void> {
  const blockers = (await executor.execute<{ tasks: string; exceptions: string }>(sql`
    select
      (select count(*) from close_run_tasks where run_id = ${runId} and org_id = ${orgId} and gate_type = 'hard'
        and task_type <> 'approval'
        and key not in ('lock-subledgers','lock-gl','publish-package')
        and status not in ('complete','waived')) as tasks,
      (select count(*) from close_exceptions where run_id = ${runId} and org_id = ${orgId} and status = 'open'
        and severity in ('error','critical')) as exceptions
  `));
  if (
    Number(blockers.rows[0]?.tasks ?? 0) > 0 ||
    Number(blockers.rows[0]?.exceptions ?? 0) > 0
  ) {
    throw new CloseError(
      "hard-gated tasks and critical exceptions must be resolved before approval",
    );
  }
}

/** Owner-managed close approval. This is deliberately not a silent bypass of
 * segregation of duties: it is available only while Advanced close controls
 * are off, requires an explicit attestation, fingerprints the ledger state,
 * and records an append-only signoff before the lock can be applied. */
export async function attestOwnerManagedClose(
  orgId: string,
  runId: string,
  actorId: string,
  comment: string,
): Promise<void> {
  if (await advancedCloseEnabled(orgId)) {
    throw new CloseError("Advanced close controls require independent approval");
  }
  const attestation = comment.trim();
  if (attestation.length < 10 || attestation.length > 1000) {
    throw new CloseError("enter an attestation reason between 10 and 1,000 characters");
  }
  await refreshCloseRun(orgId, runId, actorId);
  await withOrg(orgId, async () => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`close-attestation:${runId}`}))`);
    const run = (await db.execute<{ status: string; data_fingerprint: string | null }>(sql`
      select status, data_fingerprint from close_runs
       where id=${runId} and org_id=${orgId} for update
    `));
    const row = run.rows[0];
    if (!row) throw new CloseError("close run not found");
    if (row.status !== "in_progress") {
      throw new CloseError("only an in-progress close run can be attested");
    }
    if (!row.data_fingerprint) throw new CloseError("validate the close run before attesting");
    await assertCloseReadyForApproval(db, orgId, runId);
    await db.execute(sql`
      update close_runs set status='approved', current_stage='lock', approved_at=now(),
             approved_by=${actorId}, updated_at=now(), updated_by=${actorId}
       where id=${runId} and org_id=${orgId}
    `);
    await db.execute(sql`
      insert into close_signoffs
        (org_id, run_id, signoff_type, decision, comment, data_fingerprint, signed_by)
      values (${orgId}, ${runId}, 'approve', 'approved', ${attestation}, ${row.data_fingerprint}, ${actorId})
    `);
    await db.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${orgId}, ${runId}, 'run.owner_attested', ${actorId},
              ${JSON.stringify({ source: "owner_managed", comment: attestation })}::jsonb)
    `);
  });
}

export async function requestCloseApproval(
  orgId: string,
  runId: string,
  actorId: string,
): Promise<{ approvals: number }> {
  if (!(await advancedCloseEnabled(orgId))) {
    throw new CloseError("enable Advanced close controls to use independent approval routing");
  }
  await refreshCloseRun(orgId, runId, actorId);
  const outcome = await withOrg(orgId, async () => {
    // Serialize the status check, gate creation, and transition to review so a
    // double-click or concurrent request can never create duplicate approvals.
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`close-approval:${runId}`}))`);
    const run = (await db.execute<{ status: string; data_fingerprint: string | null }>(sql`
      select status, data_fingerprint from close_runs
       where id = ${runId} and org_id = ${orgId} for update
    `));
    if (!run.rows[0]) throw new CloseError("close run not found");
    if (run.rows[0].status === "review") {
      const pending = (await db.execute<{ count: number }>(sql`
        select count(*)::int as count from flow_gates
         where org_id = ${orgId} and subject_kind = 'close_run' and subject_id = ${runId}
           and status in ('pending','escalated')
      `));
      if (Number(pending.rows[0]?.count ?? 0) > 0)
        throw new CloseError("close approval is already in progress");
    } else if (run.rows[0].status !== "in_progress") {
      throw new CloseError("only an in-progress close run can be submitted for approval");
    }
    await assertCloseReadyForApproval(db, orgId, runId);

    const { runRecordFlows } = await import("../flows/index.ts");
    const result = await runRecordFlows(
      { kind: "on_submit", source: "ui" },
      "close_run",
      runId,
      { orgId, userId: actorId },
    );
    if (result.failed || result.gatesCreated === 0) {
      const flowRunIds = result.runs.map((item) => item.runId);
      if (flowRunIds.length > 0) {
        await db.execute(sql`
          update flow_gates set status = 'cancelled', updated_at = now(), updated_by = ${actorId}
           where run_id in (
             select jsonb_array_elements_text(${JSON.stringify(flowRunIds)}::jsonb)::uuid
           ) and org_id = ${orgId} and status in ('pending','escalated')
        `);
        await db.execute(sql`
          update flow_runs set status = 'cancelled', finished_at = now(), updated_at = now(), updated_by = ${actorId}
           where id in (
             select jsonb_array_elements_text(${JSON.stringify(flowRunIds)}::jsonb)::uuid
           ) and org_id = ${orgId} and status in ('running','waiting')
        `);
      }
      return {
        approvals: 0,
        error: result.failed
          ? "close approval routing failed"
          : "no enabled close approval flow produced an approval gate",
      };
    }

    await db.execute(sql`
      update close_runs set status = 'review', current_stage = 'review',
             approved_at = null, approved_by = null, updated_at = now(), updated_by = ${actorId}
       where id = ${runId} and org_id = ${orgId}
    `);
    await db.execute(sql`
      update close_run_tasks set status = 'submitted', data_fingerprint = ${run.rows[0].data_fingerprint},
             completed_at = null, completed_by = null, reviewed_at = null, reviewed_by = null,
             updated_at = now(), updated_by = ${actorId}
       where run_id = ${runId} and org_id = ${orgId} and task_type = 'approval'
         and status not in ('waived')
    `);
    await db.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${orgId}, ${runId}, 'run.approval_requested', ${actorId},
              ${JSON.stringify({ approvals: result.gatesCreated, flowRuns: result.runs.map((item) => item.runId) })}::jsonb)
    `);
    return { approvals: result.gatesCreated, error: null };
  });
  if (outcome.error) throw new CloseError(outcome.error);
  return { approvals: outcome.approvals };
}

export async function finalizeCloseFlowApproval(args: {
  orgId: string;
  runId: string;
  actorId: string | null;
  outcome: "approved" | "rejected";
}): Promise<void> {
  if (!args.actorId) throw new CloseError("a signed-in approver is required");
  // decideGate calls this inside its serialized, org-scoped transaction. Keep
  // every statement on that transaction instead of opening a nested one.
  const run = (await db.execute<{
      status: string;
      started_by: string | null;
      data_fingerprint: string | null;
      period_id: string;
      book_id: string;
      scope: { subsidiaryIds?: string[] };
      system_blueprint: boolean;
    }>(sql`
    select r.status,r.started_by,r.data_fingerprint,r.period_id,r.book_id,r.scope,
           b.name='close.defaultData.blueprint.name' as system_blueprint
      from close_runs r join close_blueprints b on b.id=r.blueprint_id and b.org_id=r.org_id
     where r.id = ${args.runId} and r.org_id = ${args.orgId} for update of r
  `));
  const row = run.rows[0];
  if (!row) throw new CloseError("close run not found");
  if (row.status !== "review")
    throw new CloseError("the close review changed and must be submitted again");
  if (row.started_by === args.actorId)
    throw new CloseError("the run initiator cannot provide final approval");

  const currentFingerprint = await periodFingerprint(
    args.orgId,
    row.period_id,
    row.book_id,
    row.scope?.subsidiaryIds ?? [],
    !row.system_blueprint || !row.scope?.subsidiaryIds?.length,
  );
  if (!row.data_fingerprint || row.data_fingerprint !== currentFingerprint) {
    await db.execute(sql`
      update close_run_tasks set status = 'invalidated', completed_at = null, completed_by = null,
             reviewed_at = null, reviewed_by = null, updated_at = now(), updated_by = ${args.actorId}
       where run_id = ${args.runId} and org_id = ${args.orgId}
         and status in ('complete','submitted') and data_fingerprint is not null
    `);
    await db.execute(sql`
      update flow_gates set status = 'cancelled', updated_at = now(), updated_by = ${args.actorId}
       where org_id = ${args.orgId} and subject_kind = 'close_run' and subject_id = ${args.runId}
         and status in ('pending','escalated')
    `);
    await db.execute(sql`
      update close_runs set status = 'in_progress', current_stage = 'review',
             data_fingerprint = ${currentFingerprint}, last_validated_at = now(),
             approved_at = null, approved_by = null, updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.runId} and org_id = ${args.orgId}
    `);
    await db.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${args.orgId}, ${args.runId}, 'run.data_changed', ${args.actorId},
              ${JSON.stringify({ source: "approval" })}::jsonb)
    `);
    throw new CloseError("the ledger changed during approval; revalidate and submit the close again");
  }

  if (args.outcome === "rejected") {
    await db.execute(sql`
      update close_runs set status = 'in_progress', current_stage = 'review',
             approved_at = null, approved_by = null, updated_at = now(), updated_by = ${args.actorId}
       where id = ${args.runId} and org_id = ${args.orgId}
    `);
    await db.execute(sql`
      update close_run_tasks set status = 'changes_requested', completed_at = null, completed_by = null,
             reviewed_at = now(), reviewed_by = ${args.actorId}, updated_at = now(), updated_by = ${args.actorId}
       where run_id = ${args.runId} and org_id = ${args.orgId} and task_type = 'approval' and status <> 'waived'
    `);
    await db.execute(sql`
      insert into close_events (org_id, run_id, event_type, actor_id, payload)
      values (${args.orgId}, ${args.runId}, 'run.approval_rejected', ${args.actorId}, '{}'::jsonb)
    `);
    return;
  }

  await assertCloseReadyForApproval(db, args.orgId, args.runId);
  await db.execute(sql`
    update close_runs set status = 'approved', current_stage = 'lock', approved_at = now(),
           approved_by = ${args.actorId}, updated_at = now(), updated_by = ${args.actorId}
     where id = ${args.runId} and org_id = ${args.orgId}
  `);
  await db.execute(sql`
    update close_run_tasks set status = 'complete', completed_at = now(), completed_by = ${args.actorId},
           reviewed_at = now(), reviewed_by = ${args.actorId}, data_fingerprint = ${row.data_fingerprint},
           updated_at = now(), updated_by = ${args.actorId}
     where run_id = ${args.runId} and org_id = ${args.orgId} and task_type = 'approval' and status <> 'waived'
  `);
  await db.execute(sql`
    insert into close_signoffs (org_id, run_id, signoff_type, decision, data_fingerprint, signed_by)
    values (${args.orgId}, ${args.runId}, 'approve', 'approved', ${row.data_fingerprint}, ${args.actorId})
  `);
  await db.execute(sql`
    insert into close_events (org_id, run_id, event_type, actor_id, payload)
    values (${args.orgId}, ${args.runId}, 'run.approved', ${args.actorId},
            ${JSON.stringify({ source: "flow" })}::jsonb)
  `);
}
