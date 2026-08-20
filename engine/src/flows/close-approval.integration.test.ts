import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  ensureCloseDefaults,
  refreshCloseRun,
  requestCloseApproval,
} from "../close.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
  type FlowActors,
  type ScratchOrg,
} from "../test-fixtures.ts";
import { decideGate } from "./gates.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function withCloseRun(
  fn: (fixture: ScratchOrg, actors: FlowActors, runId: string) => Promise<void>,
): Promise<void> {
  const fixture = await createScratchOrg();
  try {
    const actors = await seedFlowActors(fixture.orgId);
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(
           settings,
           '{features}',
           coalesce(settings->'features', '{}'::jsonb) || '{"advancedClose":true}'::jsonb,
           true
         )
       where id = ${fixture.orgId}
    `);
    const defaults = await ensureCloseDefaults(fixture.orgId, actors.submitterId);
    await db.execute(sql`delete from flows where org_id = ${fixture.orgId} and subject_kind = 'close_run'`);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into close_runs
        (org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
         current_stage, target_close_date, scope, started_at, started_by, created_by, updated_by)
      values (${fixture.orgId}, ${fixture.periodId}, ${fixture.bookId}, ${defaults.blueprintId},
              ${defaults.reportingPackageId}, 'in_progress', 'review', '2026-08-05',
              '{}'::jsonb, now(), ${actors.submitterId}, ${actors.submitterId}, ${actors.submitterId})
      returning id
    `));
    await fn(fixture, actors, inserted.rows[0]!.id);
  } finally {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local openbooks.sandbox_wipe = 'on'`);
      await tx.execute(sql`set constraints all deferred`);
      await tx.execute(sql`update orgs set env_kind = 'sandbox' where id = ${fixture.orgId}`);
      for (const table of [
        "close_reopen_requests",
        "close_exceptions",
        "close_automation_executions",
        "close_run_tasks",
        "close_runs",
        "close_blueprint_dependencies",
        "close_blueprint_steps",
        "close_automation_rules",
        "close_policies",
        "close_reporting_packages",
        "close_blueprints",
        "close_task_evidence",
        "close_signoffs",
        "close_events",
      ]) {
        await tx.execute(sql`delete from ${sql.raw(table)} where org_id = ${fixture.orgId}`);
      }
    });
    await dropScratchOrg(fixture.orgId);
  }
}

async function closeStatus(runId: string): Promise<{
  status: string;
  approvedBy: string | null;
  approvedAt: Date | null;
}> {
  const result = (await db.execute<{ status: string; approvedBy: string | null; approvedAt: Date | null }>(sql`
    select status, approved_by as "approvedBy", approved_at as "approvedAt"
      from close_runs where id = ${runId}
  `));
  return result.rows[0]!;
}

test("close approval is flow-routed, forbids the initiator, and reopens after ledger change", { skip: !DB }, async () => {
  await withCloseRun(async (fixture, actors, runId) => {
    await seedApprovalFlow(fixture.orgId, {
      subjectKind: "close_run",
      assignees: [
        { type: "user", userId: actors.submitterId },
        { type: "user", userId: actors.approver1Id },
      ],
      mode: "any",
      // Close overrides this authored opt-out: independence is invariant.
      preventSelfApproval: false,
      gateTitle: "Final close review",
    });

    const submitted = await requestCloseApproval(fixture.orgId, runId, actors.submitterId);
    assert.equal(submitted.approvals, 1);
    assert.equal((await closeStatus(runId)).status, "review");

    const gates = (await db.execute<{ id: string; assigneeUserId: string }>(sql`
      select id, assignee_user_id as "assigneeUserId" from flow_gates
       where subject_kind = 'close_run' and subject_id = ${runId} and status = 'pending'
    `));
    assert.equal(gates.rows.some((gate) => gate.assigneeUserId === actors.submitterId), false);

    const independentGate = gates.rows.find((gate) => gate.assigneeUserId === actors.approver1Id)!;
    await decideGate({ gateId: independentGate.id, decision: "approved", userId: actors.approver1Id });
    const approved = await closeStatus(runId);
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvedBy, actors.approver1Id);
    assert.ok(approved.approvedAt);

    const signoffs = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from close_signoffs
       where run_id = ${runId} and decision = 'approved'
    `));
    assert.equal(signoffs.rows[0]!.count, 1);

    await seedDraftDocument(fixture.orgId, {
      kind: "journal",
      createdBy: actors.submitterId,
      number: "AFTER-APPROVAL",
    });
    await refreshCloseRun(fixture.orgId, runId, actors.submitterId);
    const reopened = await closeStatus(runId);
    assert.equal(reopened.status, "in_progress");
    assert.equal(reopened.approvedBy, null);
    assert.equal(reopened.approvedAt, null);
  });
});

test("a close flow can require four independent approvals", { skip: !DB }, async () => {
  await withCloseRun(async (fixture, actors, runId) => {
    const approvers = [actors.approver1Id, actors.approver2Id, actors.adminId, actors.outsiderId];
    await seedApprovalFlow(fixture.orgId, {
      subjectKind: "close_run",
      assignees: approvers.map((userId) => ({ type: "user" as const, userId })),
      mode: "all",
      preventSelfApproval: true,
      gateTitle: "Four-person close approval",
    });
    const submitted = await requestCloseApproval(fixture.orgId, runId, actors.submitterId);
    assert.equal(submitted.approvals, 4);

    const gates = (await db.execute<{ id: string; assigneeUserId: string }>(sql`
      select id, assignee_user_id as "assigneeUserId" from flow_gates
       where subject_kind = 'close_run' and subject_id = ${runId} and status = 'pending'
    `));
    for (const approverId of approvers) {
      const gate = gates.rows.find((row) => row.assigneeUserId === approverId)!;
      await decideGate({ gateId: gate.id, decision: "approved", userId: approverId });
    }
    assert.equal((await closeStatus(runId)).status, "approved");
  });
});
