import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { decideGate } from "../flows/gates.ts";
import {
  INBOUND_PAYMENT_RUN_SUBJECT_KIND,
  OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
} from "../flows/payment-runs-adapter.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { submitPaymentRun } from "./operations.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
  type FlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

// The payment-run release handler registers on the engine seams; without it
// a decided gate strands on a not-registered refusal instead of releasing.
installEngineSeams();

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function withOrg(fn: (org: ScratchOrg, actors: FlowActors) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    await fn(org, await seedFlowActors(org.orgId));
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

/** A non-empty draft run on an active profile: the shape a submit accepts. */
async function seedDraftRun(
  org: ScratchOrg,
  makerId: string,
  direction: "outbound" | "inbound" = "outbound",
): Promise<string> {
  const formatId = randomUUID();
  const profileId = randomUUID();
  const runId = randomUUID();
  await db.execute(sql`
    insert into payment_formats
      (id, org_id, code, name, rail, direction, file_extension, content_type, created_by, updated_by)
    values (${formatId}, ${org.orgId}, ${`APR-${formatId.slice(0, 8)}`}, 'Approval test wire',
            'wire', 'credit', 'txt', 'text/plain', ${makerId}, ${makerId})`);
  await db.execute(sql`
    insert into payment_bank_profiles
      (id, org_id, name, bank_account_id, payment_format_id, currency, created_by, updated_by)
    values (${profileId}, ${org.orgId}, ${`Approval test profile ${profileId.slice(0, 8)}`},
            ${org.accounts.bank}, ${formatId}, 'CAD', ${makerId}, ${makerId})`);
  await db.execute(sql`
    insert into payment_runs
      (id, org_id, run_number, bank_account_id, payment_bank_profile_id, method, direction,
       purpose, currency, status, payment_count, total_amount, created_by, updated_by)
    values (${runId}, ${org.orgId}, ${`APR-${runId.slice(0, 8)}`}, ${org.accounts.bank}, ${profileId},
            ${direction === "inbound" ? "direct_debit" : "wire"}, ${direction},
            ${direction === "inbound" ? "customer_collections" : "vendor_payments"},
            'CAD', 'draft', 1, '25', ${makerId}, ${makerId})`);
  return runId;
}

async function runState(orgId: string, runId: string) {
  return (await db.execute<{
    status: string;
    submitted_by: string | null;
    approved_by: string | null;
    approved: boolean;
    rejected_by: string | null;
    rejection_reason: string | null;
  }>(sql`
    select status, submitted_by, approved_by, approved_at is not null as approved,
           rejected_by, rejection_reason
      from payment_runs where id = ${runId} and org_id = ${orgId}`)).rows[0]!;
}

async function runEvents(orgId: string, runId: string) {
  return (await db.execute<{ event_type: string; actor_id: string | null; to_status: string | null; details: Record<string, unknown> }>(sql`
    select event_type, actor_id, to_status, details from payment_events
     where payment_run_id = ${runId} and org_id = ${orgId}
     order by created_at, id`)).rows;
}

async function openGates(orgId: string, runId: string) {
  return (await db.execute<{ id: string; subject_kind: string }>(sql`
    select id, subject_kind from flow_gates
     where org_id = ${orgId} and subject_id = ${runId} and status in ('pending', 'escalated')`)).rows;
}

test("with no payment-run flow, a submitted run is approved at once and says why", { skip: !DB }, async () => {
  await withOrg(async (org, actors) => {
    const runId = await seedDraftRun(org, actors.submitterId);
    const outcome = await submitPaymentRun(runId, org.orgId, actors.submitterId);
    assert.deepEqual(outcome, { status: "approved", gated: false });
    const state = await runState(org.orgId, runId);
    assert.equal(state.status, "approved");
    assert.equal(state.approved, true);
    // Nobody approved it: the organization has no approval policy for runs.
    assert.equal(state.approved_by, null);
    const [submitted] = await runEvents(org.orgId, runId);
    assert.equal(submitted?.event_type, "run_submitted");
    assert.equal(submitted?.to_status, "approved");
    assert.equal(submitted?.details.approval, "not_required");
    assert.deepEqual(await openGates(org.orgId, runId), []);
  });
});

test("a payment-run flow parks the run until an independent approver releases it", { skip: !DB }, async () => {
  await withOrg(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
      assignees: [{ type: "role", role: "approver" }],
      mode: "any",
    });
    // The maker holds the approver role, so only separation of duties keeps
    // them off their own run; the submitter is a third person.
    const runId = await seedDraftRun(org, actors.approver1Id);
    assert.deepEqual(await submitPaymentRun(runId, org.orgId, actors.submitterId), {
      status: "pending_approval",
      gated: true,
    });
    const [gate] = await openGates(org.orgId, runId);
    assert.equal(gate?.subject_kind, OUTBOUND_PAYMENT_RUN_SUBJECT_KIND);

    const before = await runState(org.orgId, runId);
    await assert.rejects(decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver1Id }));
    assert.deepEqual(await runState(org.orgId, runId), before, "the maker's refused decision changes nothing");

    await decideGate({ gateId: gate!.id, decision: "approved", userId: actors.approver2Id });
    const state = await runState(org.orgId, runId);
    assert.equal(state.status, "approved");
    assert.equal(state.submitted_by, actors.submitterId);
    assert.equal(state.approved_by, actors.approver2Id);
    const approved = (await runEvents(org.orgId, runId)).filter((e) => e.event_type === "run_approved");
    assert.equal(approved.length, 1);
    assert.equal(approved[0]!.actor_id, actors.approver2Id);
    assert.equal(approved[0]!.details.source, "flow");
  });
});

test("a rejected payment run carries its reason, and a rejection without one is refused", { skip: !DB }, async () => {
  await withOrg(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const runId = await seedDraftRun(org, actors.submitterId);
    await submitPaymentRun(runId, org.orgId, actors.submitterId);
    const [gate] = await openGates(org.orgId, runId);

    const before = await runState(org.orgId, runId);
    await assert.rejects(
      decideGate({ gateId: gate!.id, decision: "rejected", userId: actors.approver1Id }),
      /a rejection reason is required/,
    );
    assert.deepEqual(await runState(org.orgId, runId), before);

    await decideGate({ gateId: gate!.id, decision: "rejected", userId: actors.approver1Id, comment: "duplicate batch" });
    const state = await runState(org.orgId, runId);
    assert.equal(state.status, "rejected");
    assert.equal(state.rejected_by, actors.approver1Id);
    assert.equal(state.rejection_reason, "duplicate batch");
    const rejected = (await runEvents(org.orgId, runId)).filter((e) => e.event_type === "run_rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.details.reason, "duplicate batch");
  });
});

test("a payment-run flow that cannot route refuses the submit by name and leaves the run in draft", { skip: !DB }, async () => {
  await withOrg(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
      assignees: [{ type: "role", role: "role_nobody_holds" }],
      mode: "any",
    });
    const runId = await seedDraftRun(org, actors.submitterId);
    await assert.rejects(
      submitPaymentRun(runId, org.orgId, actors.submitterId),
      (error: unknown) => error instanceof PaymentError && /approval routing failed/.test(error.message),
    );
    assert.equal((await runState(org.orgId, runId)).status, "draft");
    assert.deepEqual(await openGates(org.orgId, runId), []);
  });
});

test("collection runs approve under their own subject, not the payment-run flow", { skip: !DB }, async () => {
  await withOrg(async (org, actors) => {
    await seedApprovalFlow(org.orgId, {
      subjectKind: OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
      assignees: [{ type: "role", role: "approver" }],
      mode: "any",
    });
    const collectionRunId = await seedDraftRun(org, actors.submitterId, "inbound");
    assert.deepEqual(await submitPaymentRun(collectionRunId, org.orgId, actors.submitterId), {
      status: "approved",
      gated: false,
    });

    await seedApprovalFlow(org.orgId, {
      subjectKind: INBOUND_PAYMENT_RUN_SUBJECT_KIND,
      assignees: [{ type: "role", role: "approver" }],
      mode: "any",
    });
    const gatedCollectionId = await seedDraftRun(org, actors.submitterId, "inbound");
    await submitPaymentRun(gatedCollectionId, org.orgId, actors.submitterId);
    const [gate] = await openGates(org.orgId, gatedCollectionId);
    assert.equal(gate?.subject_kind, INBOUND_PAYMENT_RUN_SUBJECT_KIND);
  });
});
