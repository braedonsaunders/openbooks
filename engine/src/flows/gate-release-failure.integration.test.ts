import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  type ScratchOrg,
  type FlowActors,
} from "../test-fixtures.ts";
import { submitForApproval } from "./submit.ts";
import { decideGate, GateError } from "./gates.ts";
import { FIELD_TICKET_SUBJECT_KIND } from "./field-tickets-adapter.ts";
import { registerFlowApprovalReleaseHandler } from "./approval-release-hook.ts";

/**
 * Refusal propagation + release atomicity for decideGate — the native Flows
 * defects where a failed release/execute resolved to { ok:true, runStatus:
 * 'failed' } and a write-before-throw adapter left partial effects committed.
 *
 * The field-ticket release delegates to the registered product handler
 * (approval-release-hook), so a test handler that performs a REAL material
 * write and then throws exercises the actual engine transaction behavior
 * against a disposable database — no mocks, no source-text assertions:
 *
 *   • the refusal reaches the caller (ok:false with the recorded decision,
 *     the resumed branch, the failed run id, and an actionable error);
 *   • the decision and its audit evidence stay committed;
 *   • the partial release write rolls back (the ticket never leaves
 *     pending_approval);
 *   • the run is marked failed with the raw cause.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedDraftFieldTicket(orgId: string, createdBy: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, currency,
       subtotal, tax_total, total, created_by)
    values (${id}, ${orgId}, 'field_ticket', 'draft', ${`FT-${id.slice(0, 8)}`},
            '2026-07-15', 'CAD', '10.00', '0.00', '10.00', ${createdBy})`);
  await db.execute(sql`
    insert into field_tickets
      (document_id, org_id, period, period_start, period_end, submitted_by)
    values (${id}, ${orgId}, 'shift', '2026-07-14', '2026-07-14', ${createdBy})`);
  return id;
}

type GateRow = { id: string; status: string; runId: string };

async function gateRows(subjectId: string): Promise<GateRow[]> {
  const r = (await db.execute<GateRow>(sql`
    select id, status, run_id as "runId" from flow_gates
     where subject_id = ${subjectId} order by created_at
  `));
  return r.rows;
}

async function docStatus(id: string): Promise<string | null> {
  const r = (await db.execute<{ status: string }>(sql`select status from documents where id = ${id}`));
  return r.rows[0]?.status ?? null;
}

async function runRow(id: string): Promise<{ status: string; error: string | null }> {
  const r = (await db.execute<{ status: string; error: string | null }>(sql`
    select status, error from flow_runs where id = ${id}
  `));
  return r.rows[0]!;
}

async function decisionAuditCount(gateId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where table_name = 'flow_gates' and row_id = ${gateId} and action = 'update'
  `));
  return r.rows[0]?.n ?? 0;
}

async function withOrgFixture(fn: (org: ScratchOrg, actors: FlowActors) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await fn(org, actors);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

/** Restore a benign handler so the throwing one cannot leak into other tests. */
function restoreBenignReleaseHandler(): void {
  registerFlowApprovalReleaseHandler(FIELD_TICKET_SUBJECT_KIND, async () => {});
}

test("a write-before-throw release rolls back its partial write and refuses truthfully", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    registerFlowApprovalReleaseHandler(FIELD_TICKET_SUBJECT_KIND, async ({ subjectId, ctx }) => {
      // A material partial effect: move the ticket toward released, then crash.
      await db.execute(sql`update documents set status = 'approved' where id = ${subjectId} and org_id = ${ctx.orgId}`);
      throw new Error("simulated release failure after partial write");
    });
    try {
      await seedApprovalFlow(org.orgId, {
        subjectKind: FIELD_TICKET_SUBJECT_KIND,
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const ticketId = await seedDraftFieldTicket(org.orgId, actors.submitterId);
      const submit = await submitForApproval("field_ticket", ticketId);
      assert.equal(submit.gated, true, "submit created a gate");
      const [gate] = await gateRows(ticketId);

      const res = await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id });
      if (res.ok) throw new Error(`expected a refusal, got success: ${JSON.stringify(res)}`);
      assert.equal(res.decision, "approved", "the refusal carries the recorded decision");
      assert.equal(res.resumed, "approve", "the refusal carries the resumed branch");
      assert.equal(res.runStatus, "failed");
      assert.equal(res.decisionRecorded, true);
      assert.match(res.error, /simulated release failure after partial write/);
      assert.match(res.error, /retry the failed run/, "the refusal names the retry remedy");

      // The decision itself remains recorded with its audit evidence.
      assert.equal((await gateRows(ticketId))[0]!.status, "approved");
      assert.equal(await decisionAuditCount(gate!.id), 1, "decision evidence commits with the flip");
      // The partial release write rolled back: the ticket never left pending_approval.
      assert.equal(await docStatus(ticketId), "pending_approval");
      // The run is marked failed with the raw cause, under the returned run id.
      const run = await runRow(res.runId);
      assert.equal(run.status, "failed");
      assert.match(run.error ?? "", /simulated release failure after partial write/);
    } finally {
      restoreBenignReleaseHandler();
    }
  });
});

test("a successful field-ticket approval still resolves ok:true", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    restoreBenignReleaseHandler();
    await seedApprovalFlow(org.orgId, {
      subjectKind: FIELD_TICKET_SUBJECT_KIND,
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const ticketId = await seedDraftFieldTicket(org.orgId, actors.submitterId);
    await submitForApproval("field_ticket", ticketId);
    const [gate] = await gateRows(ticketId);

    const res = await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id });
    if (!res.ok) throw new Error(`expected success, got refusal: ${JSON.stringify(res)}`);
    assert.equal(res.resumed, "approve");
    assert.equal(res.runStatus, "completed");
    assert.equal((await gateRows(ticketId))[0]!.status, "approved");
  });
});

test("a field-ticket rejection still resolves ok:true", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    restoreBenignReleaseHandler();
    await seedApprovalFlow(org.orgId, {
      subjectKind: FIELD_TICKET_SUBJECT_KIND,
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const ticketId = await seedDraftFieldTicket(org.orgId, actors.submitterId);
    await submitForApproval("field_ticket", ticketId);
    const [gate] = await gateRows(ticketId);

    const res = await decideGate({ gateId: gate!.id, decision: "rejected", userId: actors.approver1Id, comment: "hours wrong" });
    if (!res.ok) throw new Error(`expected success, got refusal: ${JSON.stringify(res)}`);
    assert.equal(res.resumed, "reject");
    assert.equal(res.runStatus, "completed");
    assert.equal((await gateRows(ticketId))[0]!.status, "rejected");
  });
});

test("an unauthorized decider is still refused before any branch runs", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    restoreBenignReleaseHandler();
    await seedApprovalFlow(org.orgId, {
      subjectKind: FIELD_TICKET_SUBJECT_KIND,
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const ticketId = await seedDraftFieldTicket(org.orgId, actors.submitterId);
    await submitForApproval("field_ticket", ticketId);
    const [gate] = await gateRows(ticketId);

    await assert.rejects(
      decideGate({ gateId: gate!.id, decision: "approved", userId: actors.outsiderId }),
      (e: unknown) => e instanceof GateError && /not an approver/.test(e.message),
      "a non-approver must be refused with a GateError",
    );
    assert.equal((await gateRows(ticketId))[0]!.status, "pending", "the refused gate stays pending");
  });
});
