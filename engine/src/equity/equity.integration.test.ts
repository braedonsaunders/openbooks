import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  accountBalance,
  applied,
  entryLines,
  equityRefusal as refusal,
  setEquityFeature as setFeature,
  setupEquityWorld as setupWorld,
} from "../testing/equity-world.ts";
import { postCompensationRun, previewCompensationRun } from "./compensation-run.ts";
import type { EquityError } from "./errors.ts";
import { recordSecurityEvent } from "./events.ts";
import { loadCapTableView, loadSecurityDetail } from "./read-model.ts";
import { issueSecurity } from "./securities.ts";
import { createPlan } from "./structure.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "shares issued for cash post a balanced equity entry: cash, share capital at par and APIC",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const issued = await issueSecurity({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        kind: "share",
        holderPartyId: w.holderId,
        issueDate: w.org.date,
        shareClassId: w.commonClassId,
        quantity: "4000000",
        pricePerShare: "0.0010",
        considerationAccountId: w.org.accounts.bank,
      });
      assert.ok(issued.journalEntryId, "the cash issuance posted");
      const entry = (
        await db.execute<{ origin: string; status: string }>(
          sql`
      select origin, status from journal_entries where org_id = ${w.org.orgId} and id = ${issued.journalEntryId}`,
          "objects",
        )
      )[0]!;
      assert.equal(entry.origin, "equity");
      assert.equal(entry.status, "posted");
      const lines = await entryLines(w.org.orgId, issued.journalEntryId!);
      const total = lines.reduce((sum, line) => sum + BigInt(line.amount.replace(".", "")), 0n);
      assert.equal(total, 0n, "the entry balances");
      assert.equal(await accountBalance(w.org.orgId, w.org.accounts.bank), "4000.0000");
      assert.equal(
        await accountBalance(w.org.orgId, w.accounts.common),
        "-400.0000",
        "par value: 4,000,000 × 0.0001",
      );
      assert.equal(await accountBalance(w.org.orgId, w.accounts.apic), "-3600.0000");
      const audit = (
        await db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from audit_log where org_id = ${w.org.orgId} and row_id = ${issued.id} and action = 'equity.security.issue'`,
          "objects",
        )
      )[0]!;
      assert.equal(audit.n, "1", "the issuance is audited");
      const view = await loadCapTableView({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        asOf: w.org.date,
      });
      assert.equal(view.table.totals.outstanding, "4000000");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a cash issuance without an equity account policy refuses with the Setup remedy and writes nothing",
  { skip: !DB },
  async () => {
    const w = await setupWorld({ policy: false });
    try {
      await assert.rejects(
        issueSecurity({
          orgId: w.org.orgId,
          actorId: w.managerId,
          subsidiaryId: w.org.subsidiaryId,
          kind: "share",
          holderPartyId: w.holderId,
          issueDate: w.org.date,
          shareClassId: w.commonClassId,
          quantity: "1000",
          pricePerShare: "1",
          considerationAccountId: w.org.accounts.bank,
        }),
        (error: unknown) =>
          refusal("equity_account_policy_missing")(error) &&
          (error as EquityError).remedy.includes("Setup → Equity accounts"),
      );
      const count = (
        await db.execute<{ n: string }>(
          sql`select count(*)::text as n from equity_securities where org_id = ${w.org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.equal(count.n, "0");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

/** The trigger's refusal arrives as the driver error's cause, under the failed-query wrapper. */
function refusedAsRetainedHistory(error: unknown): boolean {
  const cause = (error as { cause?: { message?: unknown } }).cause;
  return /retained history/.test(String(cause?.message ?? (error as Error).message));
}

test(
  "equity records are retained history: updates and deletes refuse at the database",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const issued = await issueSecurity({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        kind: "share",
        holderPartyId: w.holderId,
        issueDate: w.org.date,
        shareClassId: w.commonClassId,
        quantity: "1000",
        pricePerShare: "1",
        considerationAccountId: w.org.accounts.bank,
      });
      await assert.rejects(
        db.execute(
          sql`update equity_securities set quantity = 2000 where org_id = ${w.org.orgId} and id = ${issued.id}`,
        ),
        refusedAsRetainedHistory,
      );
      await assert.rejects(
        db.execute(
          sql`delete from equity_securities where org_id = ${w.org.orgId} and id = ${issued.id}`,
        ),
        refusedAsRetainedHistory,
      );
      await assert.rejects(
        db.execute(
          sql`update equity_share_classes set par_value = 1 where org_id = ${w.org.orgId} and id = ${w.commonClassId}`,
        ),
        refusedAsRetainedHistory,
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a void with no Equity action Flow applies at once on the bookkeeping duty, reverses the entry and removes the shares",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const issued = await issueSecurity({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        kind: "share",
        holderPartyId: w.holderId,
        issueDate: w.org.date,
        shareClassId: w.commonClassId,
        quantity: "1000",
        pricePerShare: "1",
        considerationAccountId: w.org.accounts.bank,
      });
      const voidInput = {
        orgId: w.org.orgId,
        securityId: issued.id,
        kind: "void" as const,
        effectiveOn: w.org.date,
        reason: "Entered against the wrong holder",
      };
      // Deciding Flow approvals is not the duty to record equity actions.
      await assert.rejects(
        recordSecurityEvent({ ...voidInput, actorId: w.approverId }),
        refusal("equity_forbidden"),
      );
      const voided = await recordSecurityEvent({ ...voidInput, actorId: w.managerId });
      assert.equal(voided.status, "applied");
      assert.ok(voided.reversalEntryId, "the issuance entry is reversed");
      const request = (
        await db.execute<{
          status: string;
          released_without_approval: boolean;
          decided_by: string | null;
          requested_by: string;
        }>(
          sql`
      select status, released_without_approval, decided_by, requested_by from equity_action_requests
       where org_id = ${w.org.orgId} and id = ${voided.requestId}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(
        request,
        {
          status: "applied",
          released_without_approval: true,
          decided_by: null,
          requested_by: w.managerId,
        },
        "the request records that no approval applied",
      );
      const original = (
        await db.execute<{ status: string }>(
          sql`
      select status from journal_entries where org_id = ${w.org.orgId} and id = ${issued.journalEntryId}`,
          "objects",
        )
      )[0]!;
      assert.equal(original.status, "reversed");
      assert.equal(await accountBalance(w.org.orgId, w.org.accounts.bank), "0.0000");
      const view = await loadCapTableView({
        orgId: w.org.orgId,
        actorId: w.approverId,
        subsidiaryId: w.org.subsidiaryId,
        asOf: w.org.date,
      });
      assert.equal(view.table.totals.outstanding, "0");
      await assert.rejects(
        recordSecurityEvent({ ...voidInput, actorId: w.managerId }),
        refusal("equity_security_void"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "equity reads and writes stay inside the organization and require the equity duties",
  { skip: !DB },
  async () => {
    const a = await setupWorld();
    const b = await setupWorld();
    try {
      const issued = await issueSecurity({
        orgId: a.org.orgId,
        actorId: a.managerId,
        subsidiaryId: a.org.subsidiaryId,
        kind: "share",
        holderPartyId: a.holderId,
        issueDate: a.org.date,
        shareClassId: a.commonClassId,
        quantity: "1000",
        pricePerShare: "1",
        considerationAccountId: a.org.accounts.bank,
      });
      await assert.rejects(
        loadSecurityDetail({
          orgId: b.org.orgId,
          actorId: b.managerId,
          securityId: issued.id,
          asOf: a.org.date,
        }),
        refusal("equity_security_unknown"),
      );
      await assert.rejects(
        recordSecurityEvent({
          orgId: b.org.orgId,
          actorId: b.managerId,
          securityId: issued.id,
          kind: "void",
          effectiveOn: b.org.date,
          reason: "Cross-tenant attempt",
        }),
        refusal("equity_security_unknown"),
      );
      await assert.rejects(
        issueSecurity({
          orgId: b.org.orgId,
          actorId: b.managerId,
          subsidiaryId: a.org.subsidiaryId,
          kind: "share",
          holderPartyId: b.holderId,
          issueDate: b.org.date,
          shareClassId: a.commonClassId,
          quantity: "1",
          pricePerShare: "1",
          considerationAccountId: b.org.accounts.bank,
        }),
        refusal("equity_entity_unknown"),
      );
      await assert.rejects(
        loadCapTableView({
          orgId: a.org.orgId,
          actorId: a.outsiderId,
          subsidiaryId: a.org.subsidiaryId,
          asOf: a.org.date,
        }),
        refusal("equity_forbidden"),
      );
      await setFeature(a.org.orgId, "equity", false);
      await assert.rejects(
        issueSecurity({
          orgId: a.org.orgId,
          actorId: a.managerId,
          subsidiaryId: a.org.subsidiaryId,
          kind: "share",
          holderPartyId: a.holderId,
          issueDate: a.org.date,
          shareClassId: a.commonClassId,
          quantity: "1",
          pricePerShare: "1",
          considerationAccountId: a.org.accounts.bank,
        }),
        refusal("equity_feature_off"),
      );
    } finally {
      await dropScratchOrgReporting(a.org.orgId);
      await dropScratchOrgReporting(b.org.orgId);
    }
  },
);

test(
  "an option exercise reclassifies its grant-date value and the compensation run is idempotent and balanced",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const plan = await createPlan({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        code: "EIP",
        name: "Equity incentive plan",
        shareClassId: w.commonClassId,
        effectiveOn: "2026-01-01",
        reservedShares: "1000000",
        recycleForfeited: true,
        recycleExpired: true,
        recycleRepurchased: false,
      });
      const option = await issueSecurity({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        kind: "option",
        holderPartyId: w.holderId,
        issueDate: "2026-01-01",
        shareClassId: w.commonClassId,
        planId: plan.id,
        quantity: "4800",
        pricePerShare: "1.0000",
        optionType: "nso",
        expirationDate: "2036-01-01",
        vestingStart: "2026-01-01",
        vestingMonths: 48,
        cliffMonths: 0,
        vestingFrequency: "monthly",
        valuation: {
          sharePrice: "1",
          volatilityPercent: "50",
          riskFreeRatePercent: "4",
          expectedTermYears: "6",
          dividendYieldPercent: "0",
          attribution: "straight_line",
        },
      });
      assert.equal(option.journalEntryId, null, "a grant posts nothing");
      const preview = await previewCompensationRun({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        throughDate: w.org.date,
      });
      assert.equal(preview.lines.length, 1);
      const run = applied(
        await postCompensationRun({
          orgId: w.org.orgId,
          actorId: w.managerId,
          subsidiaryId: w.org.subsidiaryId,
          throughDate: w.org.date,
        }),
      );
      assert.equal(run.total, preview.total, "the run posts what the preview measured");
      assert.ok(run.journalEntryId);
      const lines = await entryLines(w.org.orgId, run.journalEntryId!);
      assert.deepEqual(
        lines.map((line) => line.account_id).sort(),
        [w.accounts.apicShareBased, w.accounts.expense].sort(),
      );
      assert.equal(await accountBalance(w.org.orgId, w.accounts.expense), run.total);
      const replay = applied(
        await postCompensationRun({
          orgId: w.org.orgId,
          actorId: w.managerId,
          subsidiaryId: w.org.subsidiaryId,
          throughDate: w.org.date,
        }),
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.runId, run.runId);
      assert.equal(
        await accountBalance(w.org.orgId, w.accounts.expense),
        run.total,
        "a replay posts nothing more",
      );
      await assert.rejects(
        postCompensationRun({
          orgId: w.org.orgId,
          actorId: w.approverId,
          subsidiaryId: w.org.subsidiaryId,
          throughDate: w.org.date,
        }),
        refusal("equity_forbidden"),
      );
      const exercised = await recordSecurityEvent({
        orgId: w.org.orgId,
        actorId: w.managerId,
        securityId: option.id,
        kind: "exercise",
        effectiveOn: w.org.date,
        quantity: "100",
        considerationAccountId: w.org.accounts.bank,
      });
      assert.ok(exercised.resultingSecurityId && exercised.journalEntryId);
      const exerciseLines = await entryLines(w.org.orgId, exercised.journalEntryId!);
      assert.equal(
        exerciseLines.reduce((sum, line) => sum + BigInt(line.amount.replace(".", "")), 0n),
        0n,
        "the exercise entry balances",
      );
      assert.ok(
        exerciseLines.some(
          (line) => line.account_id === w.accounts.apicShareBased && !line.amount.startsWith("-"),
        ),
        "share-based paid-in capital is relieved",
      );
      await assert.rejects(
        recordSecurityEvent({
          orgId: w.org.orgId,
          actorId: w.managerId,
          securityId: option.id,
          kind: "exercise",
          effectiveOn: w.org.date,
          quantity: "4800",
          considerationAccountId: w.org.accounts.bank,
        }),
        refusal("equity_event_exceeds_vested"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "concurrent grants against one pool serialize: the one that would exhaust it refuses",
  { skip: !DB },
  async () => {
    const w = await setupWorld();
    try {
      const plan = await createPlan({
        orgId: w.org.orgId,
        actorId: w.managerId,
        subsidiaryId: w.org.subsidiaryId,
        code: "SMALL",
        name: "Small plan",
        shareClassId: w.commonClassId,
        effectiveOn: "2026-01-01",
        reservedShares: "1000",
        recycleForfeited: true,
        recycleExpired: true,
        recycleRepurchased: false,
      });
      const grant = () =>
        issueSecurity({
          orgId: w.org.orgId,
          actorId: w.managerId,
          subsidiaryId: w.org.subsidiaryId,
          kind: "rsu",
          holderPartyId: w.holderId,
          issueDate: w.org.date,
          shareClassId: w.commonClassId,
          planId: plan.id,
          quantity: "700",
          valuation: { sharePrice: "1", attribution: "straight_line" },
        });
      const outcomes = await Promise.allSettled([grant(), grant()]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const rejected = outcomes.find(
        (outcome) => outcome.status === "rejected",
      ) as PromiseRejectedResult;
      assert.ok(refusal("equity_pool_exhausted")(rejected.reason));
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
