import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { worklistApprovals } from "./approval-worklist.ts";
import { submitForApproval } from "./submit.ts";
import { OUTBOUND_PAYMENT_RUN_SUBJECT_KIND } from "./payment-runs-adapter.ts";
import { submitPaymentRun } from "../payments/operations.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
} from "../testing/fixtures.ts";

/**
 * The approvals worklist must show everything awaiting the caller — not just
 * Flows gates. Documents sitting in pending_approval with no pending gate
 * (migrated rows, abandoned runs, legacy direct writes) are invisible to
 * worklistGates, so an approver would see [] while work waits. The unified
 * reader returns gates (payment runs among them) AND gateless document
 * approvals, deduplicated so a gated document appears once (through its
 * gate), and never shows a caller their own submissions.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

/** A payment run submitted into its approval flow by `submitterId`. */
async function seedSubmittedRun(orgId: string, bankId: string, submitterId: string): Promise<string> {
  const formatId = randomUUID();
  const profileId = randomUUID();
  const runId = randomUUID();
  await db.execute(sql`
    insert into payment_formats
      (id, org_id, code, name, rail, direction, file_extension, content_type, created_by, updated_by)
    values (${formatId}, ${orgId}, 'W7-WIRE', 'Worklist wire', 'wire', 'credit', 'txt', 'text/plain',
            ${submitterId}, ${submitterId})`);
  await db.execute(sql`
    insert into payment_bank_profiles
      (id, org_id, name, bank_account_id, payment_format_id, currency, created_by, updated_by)
    values (${profileId}, ${orgId}, 'Worklist profile', ${bankId}, ${formatId}, 'CAD', ${submitterId}, ${submitterId})`);
  await db.execute(sql`
    insert into payment_runs
      (id, org_id, run_number, bank_account_id, payment_bank_profile_id, method,
       direction, purpose, currency, status, payment_count, total_amount, created_by, updated_by)
    values (${runId}, ${orgId}, 'W7-RUN', ${bankId}, ${profileId}, 'wire',
            'outbound', 'vendor_payments', 'CAD', 'draft', 1, '250.0000', ${submitterId}, ${submitterId})`);
  const submitted = await submitPaymentRun(runId, orgId, submitterId);
  assert.equal(submitted.gated, true);
  return runId;
}

test("unified worklist shows gates, gateless documents, and payment runs", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    await seedApprovalFlow(org.orgId, {
      subjectKind: OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    // Gated document: gate pending, visible through the gate only.
    const gatedId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    const submitted = await submitForApproval("vendor_bill", gatedId);
    assert.equal(submitted.gated, true);
    // Gateless document: pending_approval with no flow run behind it.
    const gatelessId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await db.execute(sql`update documents set status='pending_approval', submitted_by=${actors.submitterId},
      submitted_at=now(), updated_by=${actors.submitterId}, updated_at=now()
      where id=${gatelessId} and org_id=${org.orgId}`);
    const runId = await seedSubmittedRun(org.orgId, org.accounts.bank, actors.submitterId);

    const items = await worklistApprovals(org.orgId, actors.approver1Id, {
      roles: ["approver"],
      allowedSubsidiaryIds: null,
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    assert.equal(byId.get(gatedId)?.kind, undefined, "gated document must not also appear as a document row");
    const gateHit = items.find((item) => item.kind === "flow_gate" && item.gate.subjectId === gatedId);
    assert.ok(gateHit, "pending gate must appear");
    assert.equal(byId.get(gatelessId)?.kind, "document", "gateless pending document must appear");
    const runGate = items.find((item) => item.kind === "flow_gate" && item.gate.subjectId === runId);
    assert.equal(runGate?.kind === "flow_gate" && runGate.gate.subjectKind, OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
      "a payment run awaiting approval appears through its gate");

    // The submitter cannot approve their own work anywhere.
    const own = await worklistApprovals(org.orgId, actors.submitterId, {
      roles: ["accountant"],
      allowedSubsidiaryIds: null,
    });
    assert.deepEqual(own, [], "submitter sees none of their own submissions");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function seedPendingBudget(
  orgId: string,
  bookId: string,
  periodId: string,
  accountId: string,
  submitterId: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into budget_scenarios
      (id, org_id, book_id, fiscal_year, name, kind, status, created_by, updated_by)
    values (${id}, ${orgId}, ${bookId}, 2026, ${name}, 'budget', 'draft', ${submitterId}, ${submitterId})`);
  await db.execute(sql`
    insert into budget_lines (org_id, scenario_id, account_id, period_id, amount, created_by, updated_by)
    values (${orgId}, ${id}, ${accountId}, ${periodId}, '140000.0000', ${submitterId}, ${submitterId})`);
  await db.execute(sql`
    update budget_scenarios set status = 'pending_approval', revision = revision + 1,
           submitted_at = now(), submitted_by = ${submitterId},
           updated_at = now(), updated_by = ${submitterId}
     where id = ${id} and org_id = ${orgId}`);
  return id;
}

/**
 * A budget submitted through the direct maker/checker path creates
 * no flow gate, so the approvals inbox (which reads this union) showed an
 * empty worklist while the budget waited. Pending scenarios must appear for
 * approvers — never for the submitter, never twice when a gate does exist.
 */
test("unified worklist shows gateless pending budgets", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const pendingId = await seedPendingBudget(
      org.orgId, org.bookId, org.periodId, org.accounts.revenue, actors.submitterId, "FY2026 operating",
    );
    const draftId = randomUUID();
    await db.execute(sql`
      insert into budget_scenarios
        (id, org_id, book_id, fiscal_year, name, kind, status, created_by, updated_by)
      values (${draftId}, ${org.orgId}, ${org.bookId}, 2026, 'Draft never submitted', 'budget',
              'draft', ${actors.submitterId}, ${actors.submitterId})`);

    const items = await worklistApprovals(org.orgId, actors.approver1Id, {
      roles: ["approver"],
      allowedSubsidiaryIds: null,
      includeBudgets: true,
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    const row = byId.get(pendingId);
    assert.equal(row?.kind, "budget", "gateless pending budget must appear");
    if (row?.kind === "budget") {
      assert.equal(row.budget.name, "FY2026 operating");
      assert.equal(row.budget.total, "140000.0000");
    }
    assert.equal(byId.get(draftId)?.kind, undefined, "draft budgets must not appear");

    // Without the budgets grant the leg stays out of the worklist.
    const unscoped = await worklistApprovals(org.orgId, actors.approver1Id, {
      roles: ["approver"],
      allowedSubsidiaryIds: null,
    });
    assert.ok(!unscoped.some((item) => item.kind === "budget"), "budget leg needs includeBudgets");

    // The submitter cannot approve their own budget.
    const own = await worklistApprovals(org.orgId, actors.submitterId, {
      roles: ["accountant"],
      allowedSubsidiaryIds: null,
      includeBudgets: true,
    });
    assert.ok(!own.some((item) => item.id === pendingId), "submitter must not see their own budget");

    // A gated budget rides its gate, never a second budget row.
    const { flowId } = await seedApprovalFlow(org.orgId, {
      subjectKind: "budget_scenario",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const runId = randomUUID();
    await db.execute(sql`
      insert into flow_runs
        (id, org_id, flow_id, subject_kind, subject_id, trigger, status, context,
         started_at, created_at, updated_at)
      values (${runId}, ${org.orgId}, ${flowId}, 'budget_scenario', ${pendingId}, 'manual',
              'waiting', '{}'::jsonb, now(), now(), now())`);
    await db.execute(sql`
      insert into flow_gates
        (org_id, flow_id, run_id, node_id, subject_kind, subject_id, title,
         assignee_user_id, group_key, status, created_at, updated_at)
      values (${org.orgId}, ${flowId}, ${runId}, 'gate', 'budget_scenario', ${pendingId},
              'Budget approval', ${actors.approver1Id}, 'g1', 'pending', now(), now())`);
    const rerouted = await worklistApprovals(org.orgId, actors.approver1Id, {
      roles: ["approver"],
      allowedSubsidiaryIds: null,
      includeBudgets: true,
    });
    const dupes = rerouted.filter((item) => item.id === pendingId || (item.kind === "flow_gate" && item.gate.subjectId === pendingId));
    assert.equal(dupes.length, 1, "gated budget must appear exactly once");
    assert.equal(dupes[0]?.kind, "flow_gate", "gated budget must appear through its gate");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
