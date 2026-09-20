import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  seedDraftDocument,
  type ScratchOrg,
  type FlowActors,
} from "../testing/fixtures.ts";
import { submitForApproval } from "./submit.ts";
import { decideGate, DecisionFailedError, GateError, ReleaseError } from "./gates.ts";
import { FIELD_TICKET_SUBJECT_KIND } from "./field-tickets-adapter.ts";
import { registerFlowApprovalReleaseHandler } from "./approval-release-hook.ts";

/**
 * Release atomicity + refusal propagation for decideGate. A failed release
 * used to resolve to { ok:true, runStatus:'failed' } while committing the
 * ambient transaction — leaving write-before-throw adapter partials in the
 * database and stranding the subject (retrying the run is wrong: the gate
 * checkpoint is already stamped, so a re-drive skips release and completes
 * vacuously). The contract is now atomic rollback of the whole decide unit:
 *
 *   • a write-before-throw release throws ReleaseError stating the decision
 *     was NOT recorded;
 *   • the gate stays pending, the subject stays pending_approval, the run is
 *     NOT marked failed, and no audit evidence for the decision exists —
 *     this attempt recorded nothing, so it cannot be conflated with an
 *     earlier separate (successful) decision;
 *   • the same decision retried after repairing the cause completes
 *     normally (the recovery property — no run.ts changes needed).
 *
 * The field-ticket release delegates to the registered product handler, so a
 * test handler that performs a REAL material write and then throws exercises
 * the actual engine transaction behavior against a disposable database — no
 * mocks, no source-text assertions. The unified contract covers every
 * post-flip stage (resume setup, branch execution, release): a post-gate
 * test below runs a branch of [successful notify, failing send_email] to
 * prove the first action's effect row AND its effect checkpoint both roll
 * back, then proves exactly-once recovery (one notification, one evidence
 * row, one queued email) when the same decision is retried after repair.
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

/** A flow whose approve branch carries one send_email action past the gate. */
function branchGraph(approverId: string, mailTo: Array<{ type: "email"; email: string }>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "trigger", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
      {
        id: "gate",
        position: { x: 220, y: 0 },
        data: {
          kind: "gate",
          gate: {
            title: "Approval",
            assignees: [{ type: "user", userId: approverId }],
            mode: "any",
          },
        },
      },
      {
        id: "note",
        position: { x: 440, y: 0 },
        data: {
          kind: "action",
          action: {
            action: "notify",
            to: [{ type: "user", userId: approverId }],
            title: "Branch ping",
            body: "the approve branch ran",
          },
        },
      },
      {
        id: "doomed",
        position: { x: 660, y: 0 },
        data: {
          kind: "action",
          action: { action: "send_email", to: mailTo, subject: "post-approval note", body: "hello" },
        },
      },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "gate", sourceHandle: "next" },
      { id: "e2", source: "gate", target: "note", sourceHandle: "approve" },
      { id: "e3", source: "note", target: "doomed", sourceHandle: "next" },
    ],
  };
}

async function seedBranchFlow(orgId: string, approverId: string): Promise<{ flowId: string }> {
  const flowId = randomUUID();
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${flowId}, ${orgId}, ${"Test approval with branch"}, 'vendor_bill', true,
            ${JSON.stringify(branchGraph(approverId, [{ type: "email", email: "not-an-address" }]))}::jsonb)`);
  return { flowId };
}

/** Repair the branch by dropping the failing action (and its edge) wholesale. */
async function repairBranchFlow(flowId: string, approverId: string): Promise<void> {
  const seeded = branchGraph(approverId, [{ type: "email", email: "not-an-address" }]);
  const nodes = (seeded.nodes as Array<Record<string, unknown>>).filter((n) => n.id !== "doomed");
  const edges = (seeded.edges as Array<Record<string, unknown>>).filter((e) => e.target !== "doomed");
  await db.execute(sql`
    update flows set graph = ${JSON.stringify({ ...seeded, nodes, edges })}::jsonb where id = ${flowId}`);
}

async function decisionNotifyCount(runId: string, gateId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from scheduler_outbox
     where kind = 'flow_email' and occurrence_key = ${`${runId}:decision-notify:${gateId}`}
  `));
  return r.rows[0]?.n ?? 0;
}

/** In-app rows written by the branch's first (successful) notify action. */
async function branchPingCount(orgId: string, userId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from notifications
     where org_id = ${orgId} and user_id = ${userId} and kind = 'flow' and title = 'Branch ping'
  `));
  return r.rows[0]?.n ?? 0;
}

/**
 * Stamped branch-action checkpoints for a run. The submit-time gate
 * checkpoint shares the run but its key carries ':gate:', never ':action:',
 * so this counts only branch-action completions.
 */
async function branchCheckpointCount(runId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from flow_run_effects
     where run_id = ${runId} and effect_key like '%:action:%'
  `));
  return r.rows[0]?.n ?? 0;
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

test("a write-before-throw release rolls back the whole decision and the same decision recovers", { skip: !DB }, async () => {
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

      await assert.rejects(
        decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id }),
        (e: unknown) => {
          assert.ok(e instanceof ReleaseError, `expected ReleaseError, got ${String(e)}`);
          assert.match(e.message, /simulated release failure after partial write/);
          assert.match(e.message, /was not recorded/, "the refusal states the decision was not recorded");
          assert.match(e.message, /retry your decision/, "the refusal names the truthful remedy");
          return true;
        },
        "a release failure must throw ReleaseError, not resolve to success",
      );

      // This attempt recorded nothing: gate still pending, subject untouched,
      // run NOT failed, no decision evidence — not conflated with any earlier
      // separate decision.
      assert.equal((await gateRows(ticketId))[0]!.status, "pending");
      assert.equal(await docStatus(ticketId), "pending_approval");
      const run = await runRow(gate!.runId);
      assert.notEqual(run.status, "failed", "a rolled-back attempt must not mark the run failed");
      assert.equal(await decisionAuditCount(gate!.id), 0, "no decision evidence may persist");

      // Repair the cause and retry the SAME decision: it completes normally.
      restoreBenignReleaseHandler();
      const retry = await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id });
      assert.equal(retry.ok, true);
      assert.equal(retry.resumed, "approve");
      assert.equal(retry.runStatus, "completed");
      assert.equal((await gateRows(ticketId))[0]!.status, "approved");
      assert.equal(await decisionAuditCount(gate!.id), 1, "exactly one decision evidence row exists");
    } finally {
      restoreBenignReleaseHandler();
    }
  });
});

test("an outer caller that swallows ReleaseError and commits still records nothing", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    registerFlowApprovalReleaseHandler(FIELD_TICKET_SUBJECT_KIND, async ({ subjectId, ctx }) => {
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
      await submitForApproval("field_ticket", ticketId);
      const [gate] = await gateRows(ticketId);

      // The exact swallowed-error topology this slice must handle: withOrg
      // joins the outer ambient transaction, the outer scope catches the
      // refusal, and the outer transaction commits anyway.
      await withOrgTransaction(org.orgId, async () => {
        await assert.rejects(
          decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id }),
          (e: unknown) => e instanceof ReleaseError,
          "a release failure must throw ReleaseError",
        );
      });

      // The whole-decision savepoint already removed the attempt's writes, so
      // the outer commit preserved nothing from it.
      assert.equal((await gateRows(ticketId))[0]!.status, "pending");
      assert.equal(await docStatus(ticketId), "pending_approval");
      assert.equal(await decisionAuditCount(gate!.id), 0, "no decision evidence may persist");
      const run = await runRow(gate!.runId);
      assert.notEqual(run.status, "failed", "a rolled-back attempt must not mark the run failed");

      restoreBenignReleaseHandler();
      const retry = await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id });
      assert.equal(retry.ok, true);
      assert.equal(retry.runStatus, "completed");
      assert.equal((await gateRows(ticketId))[0]!.status, "approved");
    } finally {
      restoreBenignReleaseHandler();
    }
  });
});

test("a post-gate branch failure rolls back release and branch, then recovers on re-decide", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    // vendor_bill uses the real documents release (no test handler): the
    // pre-action release genuinely lands, then the approve branch runs a
    // successful notify followed by a send_email that resolves to zero
    // recipients and throws.
    const { flowId } = await seedBranchFlow(org.orgId, actors.approver1Id);
    const docId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    const submit = await submitForApproval("vendor_bill", docId);
    assert.equal(submit.gated, true, "submit created a gate");
    const [gate] = await gateRows(docId);

    await assert.rejects(
      decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id }),
      (e: unknown) => {
        assert.ok(e instanceof DecisionFailedError, `expected DecisionFailedError, got ${String(e)}`);
        assert.match(e.message, /no recipients resolved/);
        assert.match(e.message, /was not recorded/, "the refusal states the decision was not recorded");
        assert.match(e.message, /retry your decision/, "the refusal names the truthful remedy");
        return true;
      },
      "a branch failure must throw, not resolve to success",
    );

    // The whole unit rolled back — including the pre-action release that had
    // already landed, the first action's notification row and checkpoint,
    // and the retracted submitter email, which never reached the outbox.
    assert.equal((await gateRows(docId))[0]!.status, "pending");
    assert.equal(await docStatus(docId), "pending_approval");
    assert.equal(await decisionAuditCount(gate!.id), 0, "no decision evidence may persist");
    const run = await runRow(gate!.runId);
    assert.notEqual(run.status, "failed", "a rolled-back attempt must not mark the run failed");
    assert.equal(await decisionNotifyCount(gate!.runId, gate!.id), 0, "no submitter email may be queued");
    assert.equal(await branchPingCount(org.orgId, actors.approver1Id), 0, "the first action's effect rolled back");
    assert.equal(await branchCheckpointCount(gate!.runId), 0, "the first action's checkpoint rolled back");

    // Repair the branch and retry the SAME decision: release, branch, and
    // notification all land exactly once.
    await repairBranchFlow(flowId, actors.approver1Id);
    const retry = await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id });
    assert.equal(retry.ok, true);
    assert.equal(retry.resumed, "approve");
    assert.equal(retry.runStatus, "completed");
    assert.equal((await gateRows(docId))[0]!.status, "approved");
    assert.equal(await docStatus(docId), "approved");
    assert.equal(await decisionAuditCount(gate!.id), 1, "exactly one decision evidence row exists");
    assert.equal(await decisionNotifyCount(gate!.runId, gate!.id), 1, "the recovered decision queues one email");
    assert.equal(await branchPingCount(org.orgId, actors.approver1Id), 1, "the branch effect fired exactly once");
    assert.equal(await branchCheckpointCount(gate!.runId), 1, "the branch checkpoint stamped exactly once");
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
    assert.equal(res.ok, true);
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
    assert.equal(res.ok, true);
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
