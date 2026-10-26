import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import { EQUITY_ACTION_SUBJECT_KIND } from "../flows/equity-actions-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { db } from "../platform/db.ts";
import { dropScratchOrgReporting, seedApprovalFlow } from "../testing/fixtures.ts";
import {
  accountBalance,
  applied,
  equityRefusal as refusal,
  setupEquityWorld,
  type EquityWorld,
} from "../testing/equity-world.ts";
import { releaseEquityActionFlowApproval } from "./action-release.ts";
import { postCompensationRun } from "./compensation-run.ts";
import { recordEquityAccountPolicy } from "./account-policy.ts";
import { recordSecurityEvent } from "./events.ts";
import { pendingEquityActions } from "./governance.ts";
import { ledgerPositions } from "./positions.ts";
import { loadCapTableView } from "./read-model.ts";
import { issueSecurity } from "./securities.ts";
import { changePlanReserve, createPlan, recordSplit } from "./structure.ts";

// The equity release handler registers on the engine seams; without it a
// decided gate strands on a not-registered refusal instead of releasing.
installEngineSeams();

const DB = !!process.env.OPENBOOKS_DB_URL;

const manage = (w: EquityWorld) => ({ orgId: w.org.orgId, actorId: w.managerId });

async function shares(w: EquityWorld, quantity = "1000") {
  return issueSecurity({
    ...manage(w),
    subsidiaryId: w.org.subsidiaryId,
    kind: "share",
    holderPartyId: w.holderId,
    issueDate: "2026-07-01",
    shareClassId: w.commonClassId,
    quantity,
    pricePerShare: "1",
    considerationAccountId: w.org.accounts.bank,
  });
}

async function request(orgId: string, id: string) {
  return (
    await db.execute<{
      status: string;
      action: string;
      released_without_approval: boolean;
      requested_by: string;
      decided_by: string | null;
      decision_comment: string | null;
    }>(
      sql`
    select status, action, released_without_approval, requested_by, decided_by, decision_comment
      from equity_action_requests where org_id = ${orgId} and id = ${id}`,
      "objects",
    )
  )[0]!;
}

async function openGates(orgId: string, subjectId: string) {
  return await db.execute<{ id: string; assignee_user_id: string | null; subject_kind: string }>(
    sql`
    select id, assignee_user_id, subject_kind from flow_gates
     where org_id = ${orgId} and subject_id = ${subjectId} and status in ('pending', 'escalated')`,
    "objects",
  );
}

async function auditActions(orgId: string, requestId: string): Promise<string[]> {
  return (
    await db.execute<{ action: string }>(
      sql`
    select action from audit_log where org_id = ${orgId} and row_id = ${requestId} order by at, id`,
      "objects",
    )
  ).map((row) => row.action);
}

async function count(
  orgId: string,
  table: "equity_splits" | "equity_security_events" | "equity_action_requests",
): Promise<number> {
  return Number(
    (
      await db.execute<{ n: string }>(
        sql`select count(*)::text as n from ${sql.identifier(table)} where org_id = ${orgId}`,
        "objects",
      )
    )[0]!.n,
  );
}

test(
  "with no Equity action Flow a governed action applies at once and records that no approval applied",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const issued = await shares(w);
      const key = `void-${randomUUID()}`;
      const voidInput = {
        ...manage(w),
        securityId: issued.id,
        kind: "void" as const,
        effectiveOn: "2026-07-10",
        reason: "Entered against the wrong holder",
        idempotencyKey: key,
      };
      const voided = await recordSecurityEvent(voidInput);
      assert.equal(voided.status, "applied");
      assert.ok(voided.requestId && voided.eventId && voided.reversalEntryId);
      assert.deepEqual(await request(w.org.orgId, voided.requestId), {
        status: "applied",
        action: "void",
        released_without_approval: true,
        requested_by: w.managerId,
        decided_by: null,
        decision_comment: null,
      });
      assert.deepEqual(await auditActions(w.org.orgId, voided.requestId), [
        "equity.action.applied",
      ]);
      assert.equal(await accountBalance(w.org.orgId, w.org.accounts.bank), "0.0000");
      // A retry with the same key returns the action recorded; nothing applies twice.
      const retried = await recordSecurityEvent(voidInput);
      assert.equal(retried.replayed, true);
      assert.equal(retried.requestId, voided.requestId);
      assert.equal(retried.eventId, voided.eventId);
      assert.equal(await count(w.org.orgId, "equity_action_requests"), 1);
      // Ungoverned activity never becomes a request.
      const plan = await createPlan({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        code: "EIP",
        name: "Equity incentive plan",
        shareClassId: w.commonClassId,
        effectiveOn: "2026-01-01",
        reservedShares: "1000",
        recycleForfeited: true,
        recycleExpired: true,
        recycleRepurchased: false,
      });
      const reserve = await changePlanReserve({
        ...manage(w),
        planId: plan.id,
        effectiveOn: "2026-07-15",
        shareDelta: "500",
        reason: "Board increased the pool",
      });
      assert.equal(reserve.status, "applied");
      assert.ok(reserve.id);
      assert.deepEqual(
        await pendingEquityActions({ ...manage(w), subsidiaryId: w.org.subsidiaryId }),
        [],
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "an Equity action Flow holds a split until an independent approver approves it, then applies it on the requester's authority",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await seedApprovalFlow(w.org.orgId, {
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        assignees: [{ type: "user", userId: w.approverId }],
        mode: "any",
      });
      const issued = await shares(w);
      const split = {
        ...manage(w),
        shareClassId: w.commonClassId,
        effectiveOn: "2026-08-01",
        ratioNumerator: "2",
        ratioDenominator: "1",
        reason: "Two-for-one forward split",
      };
      const held = await recordSplit(split);
      assert.equal(held.status, "pending_approval");
      assert.equal(held.id, null);
      assert.equal(
        await count(w.org.orgId, "equity_splits"),
        0,
        "nothing applies while the action waits",
      );
      const table = await loadCapTableView({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        asOf: "2026-08-01",
      });
      assert.equal(table.table.totals.outstanding, "1000");
      const pending = await pendingEquityActions({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
      });
      assert.deepEqual(
        pending.map((row) => [row.id, row.action, row.subjectId, row.requestedBy]),
        [[held.requestId, "split", w.commonClassId, w.managerId]],
      );
      assert.deepEqual(await auditActions(w.org.orgId, held.requestId), [
        "equity.action.submitted",
      ]);
      await assert.rejects(
        recordSplit(split),
        refusal("equity_action_pending"),
        "one pending split per class",
      );

      const gates = await openGates(w.org.orgId, held.requestId);
      assert.equal(gates.length, 1);
      assert.equal(gates[0]!.subject_kind, EQUITY_ACTION_SUBJECT_KIND);
      await decideGate({ gateId: gates[0]!.id, decision: "approved", userId: w.approverId });

      assert.deepEqual(await request(w.org.orgId, held.requestId), {
        status: "applied",
        action: "split",
        released_without_approval: false,
        requested_by: w.managerId,
        decided_by: w.approverId,
        decision_comment: null,
      });
      assert.equal(await count(w.org.orgId, "equity_splits"), 1);
      const createdBy = (
        await db.execute<{ created_by: string }>(
          sql`select created_by from equity_splits where org_id = ${w.org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.equal(
        createdBy.created_by,
        w.managerId,
        "the split is recorded on the requester's authority",
      );
      const after = await loadCapTableView({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        asOf: "2026-08-01",
      });
      assert.equal(after.table.totals.outstanding, "2000");
      const ledger = await ledgerPositions(db, w.org.orgId, w.org.subsidiaryId, "2026-08-01");
      assert.deepEqual(
        ledger.get(`s:${issued.id}`),
        { shares: 2000n, asConverted: 2000n },
        "the released split restates the position ledger in the same transaction",
      );
      assert.deepEqual(await auditActions(w.org.orgId, held.requestId), [
        "equity.action.submitted",
        "equity.action.approved",
      ]);
      assert.deepEqual(
        await pendingEquityActions({ ...manage(w), subsidiaryId: w.org.subsidiaryId }),
        [],
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "the tenant policy excludes the equity requester, and rejection keeps its reason and applies nothing",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await seedApprovalFlow(w.org.orgId, {
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        mode: "any",
        preventSelfApproval: true,
        assignees: [
          { type: "user", userId: w.managerId },
          { type: "user", userId: w.approverId },
        ],
      });
      const issued = await shares(w);
      const key = `repurchase-${randomUUID()}`;
      const buyback = {
        ...manage(w),
        securityId: issued.id,
        kind: "repurchase" as const,
        effectiveOn: "2026-07-10",
        quantity: "400",
        amount: "400",
        considerationAccountId: w.org.accounts.bank,
        reason: "Founder buyback",
        idempotencyKey: key,
      };
      const held = await recordSecurityEvent(buyback);
      assert.equal(held.status, "pending_approval");
      assert.equal(held.eventId, null);
      // The authored Flow excludes the requester from its independent gate.
      const gates = await openGates(w.org.orgId, held.requestId!);
      assert.deepEqual(
        gates.map((gate) => gate.assignee_user_id),
        [w.approverId],
      );
      const approverGate = gates[0]!;
      await assert.rejects(
        decideGate({ gateId: approverGate.id, decision: "approved", userId: w.managerId }),
      );
      assert.equal((await request(w.org.orgId, held.requestId!)).status, "pending_approval");
      // Calling the release handler directly cannot manufacture a gate decision.
      await assert.rejects(
        releaseEquityActionFlowApproval({
          subjectId: held.requestId!,
          outcome: "approved",
          ctx: { orgId: w.org.orgId, userId: w.managerId },
        }),
        refusal("equity_action_routing_failed"),
      );
      await assert.rejects(
        releaseEquityActionFlowApproval({
          subjectId: held.requestId!,
          outcome: "rejected",
          comment: " ",
          ctx: { orgId: w.org.orgId, userId: w.approverId },
        }),
        refusal("equity_action_routing_failed"),
      );
      await decideGate({
        gateId: approverGate.id,
        decision: "rejected",
        userId: w.approverId,
        comment: "The board did not approve the buyback",
      });
      const rejected = await request(w.org.orgId, held.requestId!);
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.decided_by, w.approverId);
      assert.equal(rejected.decision_comment, "The board did not approve the buyback");
      assert.equal(
        await count(w.org.orgId, "equity_security_events"),
        0,
        "a rejected repurchase records nothing",
      );
      assert.equal(await accountBalance(w.org.orgId, w.accounts.treasury), "0.0000");
      assert.deepEqual(await auditActions(w.org.orgId, held.requestId!), [
        "equity.action.submitted",
        "equity.action.rejected",
      ]);
      await assert.rejects(
        recordSecurityEvent(buyback),
        refusal("equity_action_rejected"),
        "a rejected key is not retried into an action",
      );
      // Decided history is retained: it neither changes again nor disappears.
      await assert.rejects(
        db.execute(
          sql`update equity_action_requests set status = 'applied' where org_id = ${w.org.orgId} and id = ${held.requestId}`,
        ),
      );
      await assert.rejects(
        db.execute(
          sql`delete from equity_action_requests where org_id = ${w.org.orgId} and id = ${held.requestId}`,
        ),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a gated action is validated in full when it is recorded, and a run waits for its decision",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await seedApprovalFlow(w.org.orgId, {
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        assignees: [{ type: "user", userId: w.approverId }],
        mode: "any",
      });
      const issued = await shares(w);
      // A repurchase of more shares than are outstanding refuses now, not after approval, and leaves no request.
      await assert.rejects(
        recordSecurityEvent({
          ...manage(w),
          securityId: issued.id,
          kind: "repurchase",
          effectiveOn: "2026-07-10",
          quantity: "5000",
          amount: "5000",
          considerationAccountId: w.org.accounts.bank,
          reason: "Too many",
        }),
        refusal("equity_event_exceeds_holding"),
      );
      assert.equal(await count(w.org.orgId, "equity_action_requests"), 0);

      // An award whose cost the run recognizes: a run with nothing due refuses before it is submitted.
      await issueSecurity({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        kind: "rsu",
        holderPartyId: w.holderId,
        issueDate: "2026-07-01",
        shareClassId: w.commonClassId,
        quantity: "1200",
        vestingStart: "2026-07-01",
        vestingMonths: 12,
        cliffMonths: 0,
        vestingFrequency: "monthly",
        valuation: { sharePrice: "1.00", attribution: "straight_line" },
      });
      const run = await postCompensationRun({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        throughDate: "2026-07-31",
      });
      assert.equal(run.status, "pending_approval");
      assert.equal(
        (
          await db.execute(
            sql`select 1 from equity_compensation_runs where org_id = ${w.org.orgId}`,
            "objects",
          )
        ).length,
        0,
      );
      await assert.rejects(
        postCompensationRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-07-31",
        }),
        refusal("equity_action_pending"),
      );
      const [gate] = await openGates(w.org.orgId, run.requestId!);
      assert.ok(gate);
      await decideGate({ gateId: gate.id, decision: "approved", userId: w.approverId });
      assert.equal(
        (
          await db.execute(
            sql`select 1 from equity_compensation_runs where org_id = ${w.org.orgId}`,
            "objects",
          )
        ).length,
        1,
      );
      const replay = applied(
        await postCompensationRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-07-31",
        }),
      );
      assert.equal(
        replay.replayed,
        true,
        "a posted run is returned as it stands, with no new request",
      );
      assert.equal(await count(w.org.orgId, "equity_action_requests"), 1);
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "an equity account policy version is a governed action: applied at once without a Flow, held with one",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const a = w.accounts;
      const version = (effectiveFrom: string) => ({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        effectiveFrom,
        commonStockAccountId: a.common,
        preferredStockAccountId: a.preferred,
        apicAccountId: a.apic,
        apicShareBasedAccountId: a.apicShareBased,
        compensationExpenseAccountId: a.expense,
        treasuryStockAccountId: a.treasury,
        convertibleInstrumentsAccountId: a.convertible,
        interestExpenseAccountId: a.interestExpense,
        accruedInterestAccountId: a.accruedInterest,
        earlyExerciseDepositAccountId: a.deposit,
        reason: "Map the note and deposit accounts",
      });
      await assert.rejects(
        recordEquityAccountPolicy({ ...version("2026-08-01"), actorId: w.approverId }),
        refusal("equity_forbidden"),
      );
      const direct = await recordEquityAccountPolicy(version("2026-08-01"));
      assert.equal(direct.status, "applied");
      assert.ok(direct.id);
      const row = (
        await db.execute<{ created_by: string; interest_expense_account_id: string | null }>(
          sql`
      select created_by, interest_expense_account_id from equity_account_policies where org_id = ${w.org.orgId} and id = ${direct.id}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(row, {
        created_by: w.managerId,
        interest_expense_account_id: a.interestExpense,
      });

      await seedApprovalFlow(w.org.orgId, {
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        assignees: [{ type: "user", userId: w.approverId }],
        mode: "any",
      });
      const held = await recordEquityAccountPolicy(version("2026-09-01"));
      assert.equal(held.status, "pending_approval");
      assert.equal(held.id, null);
      await assert.rejects(
        recordEquityAccountPolicy(version("2026-09-01")),
        refusal("equity_action_pending"),
        "one pending version per legal entity and date",
      );
      const [gate] = await openGates(w.org.orgId, held.requestId);
      assert.ok(gate);
      await decideGate({ gateId: gate.id, decision: "approved", userId: w.approverId });
      const versions = await db.execute<{ effective_from: string }>(
        sql`
      select effective_from::text as effective_from from equity_account_policies where org_id = ${w.org.orgId} order by effective_from`,
        "objects",
      );
      assert.deepEqual(
        versions.map((row) => row.effective_from),
        ["2026-01-01", "2026-08-01", "2026-09-01"],
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
