import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { worklistApprovals } from "./approval-worklist.ts";
import { submitForApproval } from "./flows/submit.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
} from "./test-fixtures.ts";

/**
 * The approvals worklist must show everything awaiting the caller — not just
 * Flows gates. Documents sitting in pending_approval with no pending gate
 * (migrated rows, abandoned runs, legacy direct writes) and status-based
 * payment runs are invisible to worklistGates, so today an approver sees []
 * while work waits. The unified reader returns gates AND gateless document
 * approvals AND pending pay runs, deduplicated so a gated document appears
 * once (through its gate), and never shows a caller their own submissions.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedPendingRun(orgId: string, subsidiaryId: string, bankId: string, submitterId: string): Promise<string> {
  const runId = randomUUID();
  await db.execute(sql`
    insert into payment_runs
      (id, org_id, run_number, bank_account_id, subsidiary_id, method,
       direction, purpose, currency, status, payment_count, total_amount,
       submitted_at, submitted_by, created_by, updated_by)
    values (${runId}, ${orgId}, 'W7-RUN', ${bankId}, ${subsidiaryId}, 'eft',
            'outbound', 'vendor_payments', 'CAD', 'pending_approval', 1,
            '250.0000', now(), ${submitterId}, ${submitterId}, ${submitterId})`);
  return runId;
}

test("unified worklist shows gates, gateless documents, and pay runs", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
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
    const runId = await seedPendingRun(org.orgId, org.subsidiaryId, org.accounts.bank, actors.submitterId);

    const items = await worklistApprovals(org.orgId, actors.approver1Id, {
      roles: ["approver"],
      allowedSubsidiaryIds: null,
      includePayRuns: true,
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    assert.equal(byId.get(gatedId)?.kind, undefined, "gated document must not also appear as a document row");
    const gateHit = items.find((item) => item.kind === "flow_gate" && item.gate.subjectId === gatedId);
    assert.ok(gateHit, "pending gate must appear");
    assert.equal(byId.get(gatelessId)?.kind, "document", "gateless pending document must appear");
    assert.equal(byId.get(runId)?.kind, "pay_run", "pending pay run must appear");

    // The submitter cannot approve their own work anywhere.
    const own = await worklistApprovals(org.orgId, actors.submitterId, {
      roles: ["accountant"],
      allowedSubsidiaryIds: null,
      includePayRuns: true,
    });
    assert.deepEqual(own, [], "submitter sees none of their own submissions");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
