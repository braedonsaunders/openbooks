import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { decideGate } from "../flows/gates.ts";
import { runRecordFlows } from "../flows/run.ts";
import {
  INBOUND_PAYMENT_RUN_SUBJECT_KIND,
  OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
} from "../flows/payment-runs-adapter.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { releasePaymentRunApproval, submitPaymentRun } from "./operations.ts";
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

test("payment runs retain explicit solo approval after an authored policy change", { skip: !DB }, async () => {
  for (const direction of ["outbound", "inbound"] as const) {
    await withOrg(async (org, actors) => {
      const subjectKind = direction === "outbound" ? OUTBOUND_PAYMENT_RUN_SUBJECT_KIND : INBOUND_PAYMENT_RUN_SUBJECT_KIND;
      const { flowId } = await seedApprovalFlow(org.orgId, { subjectKind,
        assignees: [{ type: "user", userId: actors.submitterId }], mode: "any", preventSelfApproval: false });
      const runId = await seedDraftRun(org, actors.submitterId, direction);
      assert.equal((await submitPaymentRun(runId, org.orgId, actors.submitterId)).gated, true);
      const [gate] = await openGates(org.orgId, runId);
      assert.ok(gate);
      await assert.rejects(releasePaymentRunApproval({ orgId: org.orgId, runId,
        actorId: actors.submitterId, outcome: "approved", approvalRunId: gate.run_id }), /completed gate decision/);
      await db.execute(sql`update flows set graph=jsonb_set(graph,'{nodes,1,data,gate,preventSelfApproval}','true'::jsonb)
        where org_id=${org.orgId} and id=${flowId}`);
      await decideGate({ gateId: gate.id, decision: "approved", userId: actors.submitterId });
      const state = await runState(org.orgId, runId);
      assert.equal(state.status, "approved");
      assert.equal(state.approved_by, actors.submitterId);
      assert.ok((await runEvents(org.orgId, runId)).some(event => event.actor_id === actors.submitterId));
    });
  }
});

test("a legacy payment gate cannot acquire solo authority from the current flow", { skip: !DB }, async () => {
  await withOrg(async (org, actors) => {
    await seedApprovalFlow(org.orgId, { subjectKind: OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
      assignees: [{ type: "user", userId: actors.submitterId }, { type: "user", userId: actors.approver2Id }],
      mode: "any", preventSelfApproval: false });
    const runId = await seedDraftRun(org, actors.submitterId);
    await submitPaymentRun(runId, org.orgId, actors.submitterId);
    await db.execute(sql`update flow_runs set context=context-'submissionPolicy'
      where org_id=${org.orgId} and subject_id=${runId}`);
    const gate = (await openGates(org.orgId, runId)).find(row => row.assignee_user_id === actors.submitterId);
    assert.ok(gate);
    await assert.rejects(decideGate({ gateId: gate.id, decision: "approved", userId: actors.submitterId }), /own submission/);
    assert.equal((await runState(org.orgId, runId)).status, "pending_approval");
  });
});

test("bank details release under an explicit frozen solo policy with audit evidence", { skip: !DB }, async () => {
  await withOrg(async (org, actors) => {
    const { flowId } = await seedApprovalFlow(org.orgId, { subjectKind: "party_bank_account", trigger: "on_create",
      assignees: [{ type: "user", userId: actors.submitterId }], mode: "any", preventSelfApproval: false });
    const id = randomUUID();
    await db.execute(sql`insert into party_bank_accounts(id,org_id,party_id,approval_status,is_active,created_by,submitted_by)
      values(${id},${org.orgId},${org.vendorId},'pending',false,${actors.submitterId},${actors.submitterId})`);
    await runRecordFlows({ kind: "on_create" }, "party_bank_account", id, { orgId: org.orgId, userId: actors.submitterId });
    const [gate] = await openGates(org.orgId, id);
    assert.ok(gate);
    await db.execute(sql`update flows set graph=jsonb_set(graph,'{nodes,1,data,gate,preventSelfApproval}','true'::jsonb)
      where org_id=${org.orgId} and id=${flowId}`);
    await decideGate({ gateId: gate.id, decision: "approved", userId: actors.submitterId });
    const row = (await db.execute<{ approval_status: string; approved_by: string; is_active: boolean }>(sql`
      select approval_status,approved_by,is_active from party_bank_accounts where org_id=${org.orgId} and id=${id}`)).rows[0]!;
    assert.equal(row.approval_status, "approved");
    assert.equal(row.approved_by, actors.submitterId);
    assert.equal(row.is_active, true);
    const audit = (await db.execute(sql`select actor_id from audit_log where org_id=${org.orgId}
      and table_name='party_bank_accounts' and row_id=${id} and action='approve'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor_id, actors.submitterId);
  });
});

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
  return (await db.execute<{ id: string; subject_kind: string; assignee_user_id: string | null; run_id: string }>(sql`
    select id, subject_kind, assignee_user_id, run_id from flow_gates
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
    const gates = await openGates(org.orgId, runId);
    const gate = gates.find(row => row.assignee_user_id === actors.approver2Id);
    const makerGate = gates.find(row => row.assignee_user_id === actors.approver1Id);
    assert.ok(makerGate);
    assert.equal(gate?.subject_kind, OUTBOUND_PAYMENT_RUN_SUBJECT_KIND);

    const before = await runState(org.orgId, runId);
    await assert.rejects(decideGate({ gateId: makerGate.id, decision: "approved", userId: actors.approver1Id }));
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
