import { requestCloseApproval } from "./approvals.ts";
import { installEngineSeams } from "../composition/install.ts";
import { decideGate } from "../flows/gates.ts";
import { withdrawApprovalCommand } from "../flows/command-approval.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { refreshCloseRun, runCloseAutomations } from "./run-automation.ts";
import { addCloseEvidence, updateCloseTask } from "./tasks.ts";

import {
  dropScratchOrg,
  seedApprovalFlow,
  grantScratchPermissions,
  seedDraftDocument,
} from "../testing/fixtures.ts";
import {
  setupCloseAutomationHarness,
  type CloseAutomationHarness,
} from "../testing/hrm-harness.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type Harness = CloseAutomationHarness;

async function setupCompleteTaskHarness(
  fingerprint: string | null = "fp-complete-task",
): Promise<Harness> {
  // A null fingerprint stores NULL, leaving the run unvalidated for the refusal test.
  const h = await setupCloseAutomationHarness(fingerprint as string);
  installEngineSeams();
  await grantScratchPermissions(h.orgId, h.submitterId, ["close.run", "close.approve"]);
  await grantScratchPermissions(h.orgId, h.approver1Id, ["close.approve"]);
  await db.execute(
    sql`update orgs set settings=jsonb_set(settings,'{features,continuousClose}','true'::jsonb,true) where id=${h.orgId}`,
  );
  return h;
}

async function insertTask(
  h: Harness,
  key: string,
  overrides: {
    ownerId?: string | null;
    reviewerId?: string | null;
    status?: string;
    completionMode?: string;
    taskType?: string;
    evidenceRequired?: boolean;
    gateType?: string;
  } = {},
): Promise<string> {
  return (
    await db.execute<{ id: string }>(
      sql`
    insert into close_run_tasks
      (org_id, run_id, key, title, workstream, task_type, completion_mode, gate_type,
       status, sort_order, owner_id, reviewer_id, evidence_required, created_by, updated_by)
    values (${h.orgId}, ${h.runId}, ${key}, ${key}, 'execute', ${overrides.taskType ?? "action"},
            ${overrides.completionMode ?? "manual"}, ${overrides.gateType ?? "hard"},
            ${overrides.status ?? "ready"}, 10,
            ${overrides.ownerId === undefined ? h.submitterId : overrides.ownerId},
            ${overrides.reviewerId ?? null},
            ${overrides.evidenceRequired ?? false}, ${h.adminId}, ${h.adminId})
    returning id`,
      "objects",
    )
  )[0]!.id;
}

async function taskState(h: Harness, taskId: string) {
  return (
    await db.execute<{
      status: string;
      completed_by: string | null;
      reviewer_id: string | null;
    }>(
      sql`
    select status, completed_by, reviewer_id from close_run_tasks where id = ${taskId}`,
      "objects",
    )
  )[0]!;
}

async function taskAuditCount(h: Harness, taskId: string): Promise<number> {
  return (
    await db.execute<{ n: number }>(
      sql`
    select count(*)::int as n from close_events
     where org_id = ${h.orgId} and run_id = ${h.runId} and task_id = ${taskId}
       and event_type like 'task.%'`,
      "objects",
    )
  )[0]!.n;
}

async function taskSignoffCount(h: Harness, taskId: string): Promise<number> {
  return (
    await db.execute<{ n: number }>(
      sql`
    select count(*)::int as n from close_signoffs
     where org_id = ${h.orgId} and run_id = ${h.runId} and task_id = ${taskId}`,
      "objects",
    )
  )[0]!.n;
}

async function insertRule(h: Harness): Promise<void> {
  await db.execute(sql`
    insert into close_automation_rules
      (org_id, name, trigger, action, conditions, config, is_active)
    values (${h.orgId}, 'auto-complete', 'task_ready', 'complete_task', '{}'::jsonb, '{}'::jsonb, true)`);
}

// Validate the run so tasks carry the genuine ledger fingerprint. Without
// this, the post-completion refresh would see a fingerprint drift, invalidate
// the just-completed task, and re-drive it — two completions for one firing.
// The rule is inserted only after stabilization so setup itself fires nothing.
async function stabilize(h: Harness): Promise<void> {
  await refreshCloseRun(h.orgId, h.runId, h.submitterId);
  await insertRule(h);
}

function fire(h: Harness, taskId: string, actorId: string | null) {
  return runCloseAutomations({
    orgId: h.orgId,
    runId: h.runId,
    taskId,
    trigger: "task_ready",
    eventKey: `complete-task:${randomUUID()}`,
    actorId: actorId ?? undefined,
  });
}

test(
  "automation completes an authorized reviewerless manual task with task audit",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness();
    try {
      const taskId = await insertTask(h, "plain");
      await stabilize(h);
      const outcome = await fire(h, taskId, h.submitterId);
      assert.equal(outcome.completed, 1);
      assert.equal(outcome.failed, 0);
      const task = await taskState(h, taskId);
      assert.equal(task.status, "complete");
      assert.equal(task.completed_by, h.submitterId);
      // The automation writes the same task-level audit event as the manual
      // path, and no review signoff: completing is not approving.
      assert.equal(await taskAuditCount(h, taskId), 1);
      const eventType = (
        await db.execute<{ event_type: string }>(
          sql`
      select event_type from close_events
       where org_id = ${h.orgId} and run_id = ${h.runId} and task_id = ${taskId}
         and event_type like 'task.%'`,
          "objects",
        )
      )[0]!.event_type;
      assert.equal(eventType, "task.complete");
      assert.equal(await taskSignoffCount(h, taskId), 0);
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);

test(
  "all ten tenant gates govern close task release and self-approval follows their frozen policy",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness();
    try {
      const taskId = await insertTask(h, "flow-reviewed", { reviewerId: h.approver1Id });
      for (let index = 0; index < 10; index++)
        await seedApprovalFlow(h.orgId, {
          subjectKind: "close_task",
          assignees: [{ type: "user", userId: h.submitterId }],
          mode: "all",
          preventSelfApproval: false,
        });
      const command = {
        orgId: h.orgId,
        runId: h.runId,
        taskId,
        actorId: h.submitterId,
        action: "complete" as const,
      };
      await updateCloseTask(command);
      assert.equal((await taskState(h, taskId)).status, "submitted");
      await updateCloseTask(command);
      assert.equal(
        await taskAuditCount(h, taskId),
        1,
        "an exact pending replay creates no duplicate submission event",
      );
      const gates = await db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${h.orgId} and subject_kind='close_task' and subject_id=${taskId} order by id`,
        "objects",
      );
      await assert.rejects(
        decideGate({ gateId: gates[0]!.id, userId: h.adminId, decision: "approved" }),
        /not an approver/,
      );
      assert.equal(gates.length, 10);
      for (const gate of gates) {
        assert.equal((await taskState(h, taskId)).status, "submitted");
        await decideGate({ gateId: gate.id, userId: h.submitterId, decision: "approved" });
      }
      const completed = await taskState(h, taskId);
      assert.equal(completed.status, "complete");
      assert.equal(completed.completed_by, h.submitterId);
      assert.equal(await taskSignoffCount(h, taskId), 1);
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);

test(
  "recalling a close task restores preparation while retaining its earlier gate decisions",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness();
    try {
      const taskId = await insertTask(h, "recall");
      for (let index = 0; index < 2; index++)
        await seedApprovalFlow(h.orgId, {
          subjectKind: "close_task",
          assignees: [{ type: "user", userId: h.approver1Id }],
          mode: "all",
        });
      await updateCloseTask({
        orgId: h.orgId,
        runId: h.runId,
        taskId,
        actorId: h.submitterId,
        action: "complete",
      });
      const gates = await db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${h.orgId} and subject_id=${taskId} order by id`,
        "objects",
      );
      await decideGate({ gateId: gates[0]!.id, userId: h.approver1Id, decision: "approved" });
      await withdrawApprovalCommand({
        orgId: h.orgId,
        actorId: h.submitterId,
        subjectKind: "close_task",
        subjectId: taskId,
        reason: "Add the remaining reconciliation evidence",
      });
      assert.equal((await taskState(h, taskId)).status, "in_progress");
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from flow_gates where org_id=${h.orgId} and id=${gates[0]!.id}`,
            "objects",
          )
        )[0]?.status,
        "approved",
      );
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);

test(
  "automation submits the same tenant Flow without releasing the task before its gates",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness();
    try {
      const taskId = await insertTask(h, "flow-automation");
      await seedApprovalFlow(h.orgId, {
        subjectKind: "close_task",
        assignees: [{ type: "user", userId: h.approver1Id }],
        mode: "all",
      });
      await stabilize(h);
      const owner = await fire(h, taskId, h.submitterId);
      assert.equal(owner.completed, 1);
      assert.equal(owner.failed, 0);
      assert.equal((await taskState(h, taskId)).status, "submitted");
      assert.equal(await taskSignoffCount(h, taskId), 0);
      const other = await fire(h, taskId, h.adminId);
      assert.equal(other.failed, 1);
      assert.equal((await taskState(h, taskId)).status, "submitted");
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);

test(
  "automation refuses blocked, non-owned, evidence-gated, and computed tasks",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness();
    try {
      const ownedId = await insertTask(h, "owned");
      const evidenceId = await insertTask(h, "needs-evidence", { evidenceRequired: true });
      const computedId = await insertTask(h, "computed", { completionMode: "computed" });
      await stabilize(h);
      // A blocked task is seeded after stabilization: dependency resolution
      // recomputes readiness from blueprint links, so seeding it earlier would
      // flip this link-free task back to ready before the refusal is probed.
      const blockedId = await insertTask(h, "blocked", { status: "blocked" });
      const blockedOutcome = await fire(h, blockedId, h.submitterId);
      assert.equal(blockedOutcome.failed, 1);
      assert.equal((await taskState(h, blockedId)).status, "blocked");
      const strangerOutcome = await fire(h, ownedId, h.adminId);
      assert.equal(strangerOutcome.failed, 1);
      assert.equal((await taskState(h, ownedId)).status, "ready");

      const bareOutcome = await fire(h, evidenceId, h.submitterId);
      assert.equal(bareOutcome.failed, 1);
      assert.equal((await taskState(h, evidenceId)).status, "ready");
      // The named remedy works: attach evidence, then automation completes.
      await addCloseEvidence({
        orgId: h.orgId,
        runId: h.runId,
        taskId: evidenceId,
        actorId: h.submitterId,
        evidenceType: "note",
        label: "reconciliation note",
      });
      const remediedOutcome = await fire(h, evidenceId, h.submitterId);
      assert.equal(remediedOutcome.completed, 1);
      assert.equal((await taskState(h, evidenceId)).status, "complete");

      const computedOutcome = await fire(h, computedId, h.submitterId);
      assert.equal(computedOutcome.failed, 1);
      assert.equal((await taskState(h, computedId)).status, "ready");
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);

test(
  "automation refuses to complete when the close run is not validated",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness(null);
    try {
      const taskId = await insertTask(h, "unvalidated");
      await insertRule(h);
      const outcome = await fire(h, taskId, h.submitterId);
      assert.equal(outcome.failed, 1);
      assert.equal((await taskState(h, taskId)).status, "ready");
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);

for (const count of [0, 10])
  test(
    `close run approval tasks reflect exactly ${count} tenant Flow gates`,
    { skip: !DB },
    async () => {
      const h = await setupCompleteTaskHarness();
      try {
        const taskId = await insertTask(h, "run-approval", { taskType: "approval" });
        for (let index = 0; index < count; index++)
          await seedApprovalFlow(h.orgId, {
            subjectKind: "close_run",
            assignees: [{ type: "user", userId: h.submitterId }],
            mode: "all",
            preventSelfApproval: false,
          });
        const result = await requestCloseApproval(h.orgId, h.runId, h.submitterId);
        assert.equal(result.approvals, count);
        const state = async () =>
          (
            await db.execute<{ status: string }>(
              sql`select status from close_runs where org_id=${h.orgId} and id=${h.runId}`,
              "objects",
            )
          )[0]!.status;
        assert.equal(await state(), count ? "review" : "approved");
        if (count)
          await assert.rejects(
            updateCloseTask({
              orgId: h.orgId,
              runId: h.runId,
              taskId,
              actorId: h.submitterId,
              action: "complete",
            }),
            /close run through its native Flow/,
          );
        const gates = await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${h.orgId} and subject_kind='close_run' and subject_id=${h.runId} order by id`,
          "objects",
        );
        assert.equal(gates.length, count);
        for (const gate of gates) {
          assert.equal(await state(), "review");
          await decideGate({ gateId: gate.id, userId: h.submitterId, decision: "approved" });
        }
        assert.equal(await state(), "approved");
        const task = (
          await db.execute<{ status: string; reviewed_by: string | null }>(
            sql`select status,reviewed_by from close_run_tasks where org_id=${h.orgId} and id=${taskId}`,
            "objects",
          )
        )[0]!;
        assert.equal(task.status, "complete");
        assert.equal(task.reviewed_by, count ? h.submitterId : null);
        assert.equal(
          (
            await db.execute(
              sql`select id from flow_gates where org_id=${h.orgId} and subject_kind='close_task' and subject_id=${taskId}`,
              "objects",
            )
          ).length,
          0,
          "the parent approval has one authoritative Flow subject",
        );
      } finally {
        await dropScratchOrg(h.orgId);
      }
    },
  );

test(
  "changed manual evidence refuses the final close decision and a native recall permits fresh review",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness();
    try {
      const taskId = await insertTask(h, "review-statements");
      await insertTask(h, "parent-approval", { taskType: "approval" });
      await refreshCloseRun(h.orgId, h.runId, h.submitterId);
      await updateCloseTask({
        orgId: h.orgId,
        runId: h.runId,
        taskId,
        actorId: h.submitterId,
        action: "complete",
      });
      for (let index = 0; index < 2; index++)
        await seedApprovalFlow(h.orgId, {
          subjectKind: "close_run",
          assignees: [{ type: "user", userId: h.approver1Id }],
          mode: "all",
        });
      await requestCloseApproval(h.orgId, h.runId, h.submitterId);
      const gates = await db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${h.orgId} and subject_kind='close_run' and subject_id=${h.runId} order by id`,
        "objects",
      );
      await decideGate({ gateId: gates[0]!.id, userId: h.approver1Id, decision: "approved" });
      await addCloseEvidence({
        orgId: h.orgId,
        runId: h.runId,
        taskId,
        actorId: h.submitterId,
        evidenceType: "note",
        label: "Updated statement review evidence",
      });
      await assert.rejects(
        decideGate({ gateId: gates[1]!.id, userId: h.approver1Id, decision: "approved" }),
        /close evidence changed/i,
      );
      await withdrawApprovalCommand({
        orgId: h.orgId,
        actorId: h.submitterId,
        subjectKind: "close_run",
        subjectId: h.runId,
        reason: "Review the additional statement evidence",
      });
      const retained = (
        await db.execute<{ status: string }>(
          sql`select status from flow_gates where org_id=${h.orgId} and id=${gates[0]!.id}`,
          "objects",
        )
      )[0]!;
      assert.equal(retained.status, "approved", "recall preserves earlier recorded decisions");
      await requestCloseApproval(h.orgId, h.runId, h.submitterId);
      const fresh = await db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${h.orgId} and subject_kind='close_run' and subject_id=${h.runId} and status='pending' order by id`,
        "objects",
      );
      assert.equal(fresh.length, 2);
      for (const gate of fresh)
        await decideGate({ gateId: gate.id, userId: h.approver1Id, decision: "approved" });
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from close_runs where org_id=${h.orgId} and id=${h.runId}`,
            "objects",
          )
        )[0]?.status,
        "approved",
      );
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);

test(
  "ledger revalidation cancels stale task gates before invalidating preparation and preserves prior decisions",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness();
    try {
      const taskId = await insertTask(h, "reconcile-ledger");
      await refreshCloseRun(h.orgId, h.runId, h.submitterId);
      for (let index = 0; index < 2; index++)
        await seedApprovalFlow(h.orgId, {
          subjectKind: "close_task",
          assignees: [{ type: "user", userId: h.approver1Id }],
          mode: "all",
        });
      await updateCloseTask({
        orgId: h.orgId,
        runId: h.runId,
        taskId,
        actorId: h.submitterId,
        action: "complete",
      });
      const gates = await db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${h.orgId} and subject_id=${taskId} order by id`,
        "objects",
      );
      await decideGate({ gateId: gates[0]!.id, userId: h.approver1Id, decision: "approved" });
      await seedDraftDocument(h.orgId, { kind: "vendor_bill", createdBy: h.submitterId });
      const revalidated = await refreshCloseRun(h.orgId, h.runId, h.submitterId);
      assert.equal(revalidated.invalidated, 1);
      assert.equal((await taskState(h, taskId)).status, "invalidated");
      const retained = (
        await db.execute<{ status: string }>(
          sql`select status from flow_gates where org_id=${h.orgId} and id=${gates[0]!.id}`,
          "objects",
        )
      )[0]!;
      assert.equal(retained.status, "approved");
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from flow_gates where org_id=${h.orgId} and id=${gates[1]!.id}`,
            "objects",
          )
        )[0]?.status,
        "cancelled",
      );
      await updateCloseTask({
        orgId: h.orgId,
        runId: h.runId,
        taskId,
        actorId: h.submitterId,
        action: "complete",
      });
      const fresh = await db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${h.orgId} and subject_id=${taskId} and status='pending' order by id`,
        "objects",
      );
      assert.equal(fresh.length, 2);
      for (const gate of fresh)
        await decideGate({ gateId: gate.id, userId: h.approver1Id, decision: "approved" });
      assert.equal((await taskState(h, taskId)).status, "complete");
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);

test(
  "close status writes cannot replace native Flow approval or atomic period locking",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness();
    const { errorChainMatches } = await import("../testing/error-chain.ts");
    const { closeApprovedRun } = await import("./run-completion.ts");
    try {
      await assert.rejects(
        db.execute(sql`update close_runs set status='approved',approved_at=now(),approved_by=${h.submitterId},updated_by=${h.submitterId}
    where org_id=${h.orgId} and id=${h.runId}`),
        (error) => errorChainMatches(error, /complete every configured Flow gate/),
      );
      await requestCloseApproval(h.orgId, h.runId, h.submitterId);
      await assert.rejects(
        db.execute(sql`update close_runs set approved_by=${h.adminId},updated_by=${h.adminId}
    where org_id=${h.orgId} and id=${h.runId}`),
        (error) => errorChainMatches(error, /actual actor and timestamp/),
      );
      await assert.rejects(
        db.execute(sql`update close_runs set status='closed',closed_at=now(),closed_by=${h.submitterId},updated_by=${h.submitterId}
    where org_id=${h.orgId} and id=${h.runId}`),
        (error) => errorChainMatches(error, /every scoped subledger and GL lock/),
      );
      await assert.rejects(
        db.execute(sql`update close_runs set status='published',published_at=now(),published_by=${h.submitterId},updated_by=${h.submitterId}
    where org_id=${h.orgId} and id=${h.runId}`),
        (error) => errorChainMatches(error, /native publication command/),
      );
      await closeApprovedRun(h.orgId, h.runId, h.submitterId);
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from close_runs where org_id=${h.orgId} and id=${h.runId}`,
            "objects",
          )
        )[0]?.status,
        "closed",
      );
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from period_locks l join close_runs r
    on r.org_id=l.org_id and r.period_id=l.period_id and r.book_id=l.book_id
    where r.org_id=${h.orgId} and r.id=${h.runId} and l.subsidiary_id is null and l.state='closed'`,
            "objects",
          )
        )[0]?.count,
        6,
      );
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);

test(
  "closing refuses changed manual evidence and retains its invalidation without sealing any period",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness();
    const { closeApprovedRun } = await import("./run-completion.ts");
    try {
      const taskId = await insertTask(h, "retained-statement-review");
      await refreshCloseRun(h.orgId, h.runId, h.submitterId);
      await updateCloseTask({
        orgId: h.orgId,
        runId: h.runId,
        taskId,
        actorId: h.submitterId,
        action: "complete",
      });
      await requestCloseApproval(h.orgId, h.runId, h.submitterId);
      await db.execute(sql`insert into close_task_evidence(org_id,run_id,task_id,evidence_type,label,snapshot,content_hash,created_by,updated_by)
    values(${h.orgId},${h.runId},${taskId},'note','Additional retained source evidence','{}'::jsonb,encode(sha256(convert_to('{}','UTF8')),'hex'),${h.submitterId},${h.submitterId})`);
      await assert.rejects(
        closeApprovedRun(h.orgId, h.runId, h.submitterId),
        /approval evidence changed/,
      );
      assert.deepEqual(
        (
          await db.execute(
            sql`select status,approved_at,approved_by from close_runs where org_id=${h.orgId} and id=${h.runId}`,
            "objects",
          )
        )[0],
        { status: "in_progress", approved_at: null, approved_by: null },
      );
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from period_locks l join close_runs r
    on r.org_id=l.org_id and r.period_id=l.period_id and r.book_id=l.book_id
    where r.org_id=${h.orgId} and r.id=${h.runId} and l.state='closed'`,
            "objects",
          )
        )[0]?.count,
        0,
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from flow_submissions where org_id=${h.orgId} and subject_kind='close_run' and subject_id=${h.runId}`,
            "objects",
          )
        ).length,
        1,
        "the earlier decision receipt remains retained",
      );
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);

test(
  "period locking follows its current native duty independently from preparation",
  { skip: !DB },
  async () => {
    const h = await setupCompleteTaskHarness();
    const { closeApprovedRun } = await import("./run-completion.ts");
    const { withOrgTransaction } = await import("../platform/db.ts");
    const { actorHasPermission } = await import("../organization/actor-permissions.ts");
    try {
      await requestCloseApproval(h.orgId, h.runId, h.submitterId);
      await db.execute(
        sql`update user_permission_overrides set effect='deny' where org_id=${h.orgId} and user_id=${h.submitterId} and permission='close.approve'`,
      );
      await assert.rejects(closeApprovedRun(h.orgId, h.runId, h.submitterId));
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from close_runs where org_id=${h.orgId} and id=${h.runId}`,
            "objects",
          )
        )[0]?.status,
        "approved",
      );
      assert.equal(
        await withOrgTransaction(h.orgId, () =>
          actorHasPermission(db, h.orgId, h.approver1Id, "close.run"),
        ),
        false,
      );
      await closeApprovedRun(h.orgId, h.runId, h.approver1Id);
      assert.equal(
        (
          await db.execute<{ status: string; closed_by: string }>(
            sql`select status,closed_by from close_runs where org_id=${h.orgId} and id=${h.runId}`,
            "objects",
          )
        )[0]?.closed_by,
        h.approver1Id,
      );
    } finally {
      await dropScratchOrg(h.orgId);
    }
  },
);
