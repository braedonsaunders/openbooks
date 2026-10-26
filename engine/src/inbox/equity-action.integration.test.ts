import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import { loadStructure } from "../equity/read-model.ts";
import { changePlanReserve, createPlan } from "../equity/structure.ts";
import { pendingEquityActions, withdrawEquityAction } from "../equity/governance.ts";
import { EQUITY_ACTION_SUBJECT_KIND } from "../flows/equity-actions-adapter.ts";
import { decideGate, worklistGates } from "../flows/gates.ts";
import { db } from "../platform/db.ts";
import {
  createScratchUser,
  dropScratchOrgReporting,
  seedApprovalFlow,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { equityRefusal, setupEquityWorld, type EquityWorld } from "../testing/equity-world.ts";
import { actOnInboxItem, InboxError, listInbox } from "./index.ts";

// The equity release handler registers on the engine seams; without it an
// approved gate strands on a not-registered refusal instead of releasing.
installEngineSeams();

const DB = !!process.env.OPENBOOKS_DB_URL;
const AS_OF = "2026-07-20";

async function planWithPendingReserve(w: EquityWorld) {
  const plan = await createPlan({
    orgId: w.org.orgId,
    actorId: w.managerId,
    subsidiaryId: w.org.subsidiaryId,
    code: "EIP",
    name: "Equity incentive plan",
    shareClassId: w.commonClassId,
    effectiveOn: "2026-01-01",
    reservedShares: "4000000",
    recycleForfeited: true,
    recycleExpired: true,
    recycleRepurchased: false,
  });
  const held = await changePlanReserve({
    orgId: w.org.orgId,
    actorId: w.managerId,
    planId: plan.id,
    effectiveOn: "2026-07-15",
    shareDelta: "1000",
    reason: "Board approved a pool top-up",
  });
  assert.equal(held.status, "pending_approval");
  return { plan, requestId: held.requestId };
}

/** The plan's reserve through the native read path, after every change on file. */
async function reserved(w: EquityWorld, planId: string): Promise<string> {
  const structure = await loadStructure({
    orgId: w.org.orgId,
    actorId: w.managerId,
    subsidiaryId: w.org.subsidiaryId,
    asOf: "2026-12-31",
  });
  return structure.plans.find((plan) => plan.id === planId)!.reserved;
}

async function request(orgId: string, id: string) {
  return (
    await db.execute<{
      status: string;
      decided_by: string | null;
      decision_comment: string | null;
    }>(
      sql`
    select status, decided_by, decision_comment from equity_action_requests where org_id = ${orgId} and id = ${id}`,
      "objects",
    )
  )[0]!;
}

async function flowState(orgId: string, requestId: string) {
  const gates = await db.execute<{ status: string }>(
    sql`
    select status from flow_gates where org_id = ${orgId} and subject_kind = ${EQUITY_ACTION_SUBJECT_KIND} and subject_id = ${requestId}`,
    "objects",
  );
  const runs = await db.execute<{ status: string }>(
    sql`
    select status from flow_runs where org_id = ${orgId} and subject_kind = ${EQUITY_ACTION_SUBJECT_KIND} and subject_id = ${requestId}`,
    "objects",
  );
  return { gates: gates.map((row) => row.status), runs: runs.map((row) => row.status) };
}

const inbox = (w: EquityWorld, actorId: string) =>
  listInbox({ orgId: w.org.orgId, actorId, asOf: AS_OF }, { kinds: ["equity_action"] });

test(
  "a pending equity action reaches the approver's inbox and approving it there applies it",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await seedApprovalFlow(w.org.orgId, {
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        assignees: [{ type: "user", userId: w.approverId }],
        mode: "any",
      });
      const { plan, requestId } = await planWithPendingReserve(w);
      assert.equal(await reserved(w, plan.id), "4000000", "nothing applies while the action waits");

      // The approver holds only the equity grants, so the approvals union never
      // reaches them; their equity gate lists among their tasks.
      const items = await inbox(w, w.approverId);
      assert.equal(items.length, 1);
      const [item] = items;
      assert.equal(item!.kind, "equity_action");
      assert.match(item!.subtitle ?? "", /EIP/);
      assert.deepEqual(
        item!.actions.map((action) => action.key),
        ["approve", "reject"],
      );
      assert.equal(item!.subjectHref, `/equity?request=${requestId}`);
      assert.deepEqual(
        await inbox(w, w.managerId),
        [],
        "the requester is not an approver of its own action",
      );
      assert.deepEqual(await inbox(w, w.outsiderId), []);

      await actOnInboxItem(
        { orgId: w.org.orgId, actorId: w.approverId, asOf: AS_OF },
        item!.id,
        "approve",
      );
      assert.equal((await request(w.org.orgId, requestId)).status, "applied");
      assert.equal(await reserved(w, plan.id), "4001000", "the approved top-up is in the pool");
      assert.deepEqual(await inbox(w, w.approverId), [], "a decided action leaves the inbox");
      assert.deepEqual(
        await pendingEquityActions({
          orgId: w.org.orgId,
          actorId: w.managerId,
          subsidiaryId: w.org.subsidiaryId,
        }),
        [],
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test("rejecting from the inbox needs a reason and applies nothing", { skip: !DB }, async () => {
  const w = await setupEquityWorld();
  try {
    await seedApprovalFlow(w.org.orgId, {
      subjectKind: EQUITY_ACTION_SUBJECT_KIND,
      assignees: [{ type: "user", userId: w.approverId }],
      mode: "any",
    });
    const { plan, requestId } = await planWithPendingReserve(w);
    const [item] = await inbox(w, w.approverId);
    const ctx = { orgId: w.org.orgId, actorId: w.approverId, asOf: AS_OF };
    await assert.rejects(
      actOnInboxItem(ctx, item!.id, "reject"),
      (error: unknown) => error instanceof InboxError && error.code === "REASON_REQUIRED",
    );
    await actOnInboxItem(ctx, item!.id, "reject", "The board has not approved the top-up");
    assert.deepEqual(await request(w.org.orgId, requestId), {
      status: "rejected",
      decided_by: w.approverId,
      decision_comment: "The board has not approved the top-up",
    });
    assert.equal(await reserved(w, plan.id), "4000000");
  } finally {
    await dropScratchOrgReporting(w.org.orgId);
  }
});

test(
  "the tenant may authorize its equity requester to decide its assigned gate",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await grantScratchPermissions(w.org.orgId, w.managerId, ["equity.approve"]);
      await seedApprovalFlow(w.org.orgId, {
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        mode: "any",
        preventSelfApproval: false,
        assignees: [{ type: "user", userId: w.managerId }],
      });
      const { plan, requestId } = await planWithPendingReserve(w);
      const items = await inbox(w, w.managerId);
      assert.equal(items.length, 1);
      assert.deepEqual(await inbox(w, w.approverId), []);
      await actOnInboxItem(
        { orgId: w.org.orgId, actorId: w.managerId, asOf: AS_OF },
        items[0]!.id,
        "approve",
      );
      assert.equal((await request(w.org.orgId, requestId)).status, "applied");
      assert.equal(await reserved(w, plan.id), "4001000");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "the tenant may exclude its equity requester from its assigned approval gate",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await grantScratchPermissions(w.org.orgId, w.managerId, ["equity.approve"]);
      await seedApprovalFlow(w.org.orgId, {
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        mode: "any",
        preventSelfApproval: true,
        assignees: [
          { type: "user", userId: w.managerId },
          { type: "user", userId: w.approverId },
        ],
      });
      const { plan, requestId } = await planWithPendingReserve(w);
      assert.deepEqual(await inbox(w, w.managerId), []);
      assert.deepEqual(await worklistGates(w.org.orgId, w.managerId), []);
      const [item] = await inbox(w, w.approverId);
      await assert.rejects(
        actOnInboxItem(
          { orgId: w.org.orgId, actorId: w.managerId, asOf: AS_OF },
          item!.id,
          "approve",
        ),
        (error: unknown) => error instanceof InboxError && error.code === "NOT_FOUND",
      );
      await assert.rejects(
        decideGate({ gateId: item!.source.id, decision: "approved", userId: w.managerId }),
      );
      assert.equal((await request(w.org.orgId, requestId)).status, "pending_approval");
      assert.equal(await reserved(w, plan.id), "4000000");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a Flow naming an equity reviewer without approval authority refuses routing before release",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const reviewerId = await createScratchUser(
        w.org.orgId,
        "Read-only Reviewer",
        "equity_reader",
      );
      await db.execute(
        sql`update app_roles set permissions = '["equity.read"]'::jsonb where org_id = ${w.org.orgId} and key = 'equity_reader'`,
      );
      await seedApprovalFlow(w.org.orgId, {
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        assignees: [{ type: "user", userId: reviewerId }],
        mode: "any",
      });
      const before = await db.execute(
        sql`select id from equity_action_requests where org_id=${w.org.orgId}`,
        "objects",
      );
      await assert.rejects(planWithPendingReserve(w), /cannot approve this record/);
      assert.deepEqual(
        await db.execute(
          sql`select id from equity_action_requests where org_id=${w.org.orgId}`,
          "objects",
        ),
        before,
      );
      assert.deepEqual(await inbox(w, reviewerId), []);
      const structure = await loadStructure({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        asOf: "2026-12-31",
      });
      assert.equal(structure.plans.find((plan) => plan.code === "EIP")?.reserved, "4000000");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "the requester withdraws a pending equity action: its approval closes and nothing applies",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await seedApprovalFlow(w.org.orgId, {
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        assignees: [{ type: "user", userId: w.approverId }],
        mode: "any",
      });
      const { plan, requestId } = await planWithPendingReserve(w);
      await assert.rejects(
        db.execute(sql`update equity_action_requests set status='withdrawn',
      decided_by=${w.managerId},decided_at=now(),decision_comment='Withdraw this pending request'
      where org_id=${w.org.orgId} and id=${requestId}`),
        (error: unknown) =>
          error instanceof Error &&
          error.cause instanceof Error &&
          /after cancelling its native Flow gates/.test(error.cause.message),
      );

      await assert.rejects(
        withdrawEquityAction({
          orgId: w.org.orgId,
          actorId: w.approverId,
          requestId,
          reason: "Not mine to withdraw",
        }),
        equityRefusal("equity_withdraw_forbidden"),
      );
      await assert.rejects(
        withdrawEquityAction({ orgId: w.org.orgId, actorId: w.managerId, requestId, reason: "no" }),
        equityRefusal("equity_reason_required"),
      );

      const withdrawn = await withdrawEquityAction({
        orgId: w.org.orgId,
        actorId: w.managerId,
        requestId,
        reason: "Recorded against the wrong plan",
      });
      assert.equal(withdrawn.status, "withdrawn");
      assert.equal(withdrawn.cancelledRunIds.length, 1);
      assert.deepEqual(await request(w.org.orgId, requestId), {
        status: "withdrawn",
        decided_by: w.managerId,
        decision_comment: "Recorded against the wrong plan",
      });
      assert.deepEqual(await flowState(w.org.orgId, requestId), {
        gates: ["cancelled"],
        runs: ["cancelled"],
      });
      assert.equal(await reserved(w, plan.id), "4000000");
      assert.deepEqual(await inbox(w, w.approverId), [], "the approver has nothing left to decide");
      assert.deepEqual(
        await pendingEquityActions({
          orgId: w.org.orgId,
          actorId: w.managerId,
          subsidiaryId: w.org.subsidiaryId,
        }),
        [],
      );
      const audit = await db.execute<{
        action: string;
        changes: { reason?: string; before?: unknown; after?: unknown };
      }>(
        sql`
      select action, changes from audit_log where org_id = ${w.org.orgId} and row_id = ${requestId} order by at, id`,
        "objects",
      );
      assert.deepEqual(
        audit.map((row) => row.action),
        ["equity.action.submitted", "equity.action.withdrawn"],
      );
      assert.deepEqual(audit[1]!.changes.before, { status: "pending_approval" });
      assert.deepEqual(audit[1]!.changes.after, { status: "withdrawn" });

      await assert.rejects(
        withdrawEquityAction({
          orgId: w.org.orgId,
          actorId: w.managerId,
          requestId,
          reason: "Withdrawing a second time",
        }),
        equityRefusal("equity_action_decided"),
      );
      // The withdrawn request no longer blocks recording the action again.
      const again = await changePlanReserve({
        orgId: w.org.orgId,
        actorId: w.managerId,
        planId: plan.id,
        effectiveOn: "2026-07-16",
        shareDelta: "1000",
        reason: "Board approved a pool top-up",
      });
      assert.equal(again.status, "pending_approval");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
