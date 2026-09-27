import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// The approvals worklist must show everything awaiting the caller — Flows
// gates, gateless document-status approvals, and pending pay runs — and
// get_vitals must count that same set. Previously listApprovalWorklist only
// saw Flows gates, so an approver saw [] while documents sat pending.
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedApprovalFlow, seedDraftDocument, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { submitForApproval } = await import("@openbooks/engine/src/flows/submit.ts");
const { decideApproval, listApprovalWorklist } = await import("./approvals.ts");
const { orgVitals } = await import("./vitals.ts");
const { resolveApprovalSubjects } = await import("../approval-subjects.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(orgId: string, userId: string, roleKeys: string[], permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId, email: `${userId}@test`, name: "Test", orgId,
        roles: roleKeys.map((key) => ({ key, name: key })),
        envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
        homeUserId: userId, homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function seed(orgId: string, subsidiaryId: string, bankId: string, actors: { submitterId: string; approver1Id: string }) {
  await seedApprovalFlow(orgId, {
    subjectKind: "vendor_bill",
    assignees: [{ type: "user", userId: actors.approver1Id }],
    mode: "any",
  });
  const gatedId = await seedDraftDocument(orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
  await submitForApproval("vendor_bill", gatedId);
  const gateless = async (): Promise<string> => {
    const id = await seedDraftDocument(orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await db.execute(sql`update documents set status='pending_approval', submitted_by=${actors.submitterId},
      submitted_at=now(), updated_by=${actors.submitterId}, updated_at=now()
      where id=${id} and org_id=${orgId}`);
    return id;
  };
  const gatelessId = await gateless();
  const sodId = await gateless();
  const runId = randomUUID();
  await db.execute(sql`
    insert into payment_runs
      (id, org_id, run_number, bank_account_id, subsidiary_id, method,
       direction, purpose, currency, status, payment_count, total_amount,
       submitted_at, submitted_by, created_by, updated_by)
    values (${runId}, ${orgId}, 'W7-RUN', ${bankId}, ${subsidiaryId}, 'eft',
            'outbound', 'vendor_payments', 'CAD', 'pending_approval', 1,
            '250.0000', now(), ${actors.submitterId}, ${actors.submitterId}, ${actors.submitterId})`);
  return { gatedId, gatelessId, sodId, runId };
}

async function docStatus(id: string): Promise<string | null> {
  const r = (await db.execute<{ status: string }>(sql`select status from documents where id = ${id}`));
  return r.rows[0]?.status ?? null;
}

test("worklist unifies gates, gateless documents, and pay runs; vitals counts the same set", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const ids = await withBypassContext(() => seed(org.orgId, org.subsidiaryId, org.accounts.bank, actors));
    const approver = ctxFor(org.orgId, actors.approver1Id, ["approver"], ["flows.approve", "ap.approve"]);
    // The worklist readers rely on ambient org scope (production provides it
    // per request); the document-decide path below self-scopes instead, so
    // only these calls need the explicit boundary.
    const items = await withOrgContext(org.orgId, () => listApprovalWorklist(approver));
    const kinds = new Map(items.map((item) => [item.id, item.kind]));
    assert.equal(items.filter((item) => item.kind === "flow_gate").length, 1, "one pending gate");
    assert.equal(kinds.get(ids.gatelessId), "document", "gateless document listed once");
    assert.ok(!kinds.has(ids.gatedId), "gated document not duplicated as a document row");
    assert.equal(kinds.get(ids.runId), "pay_run", "pending pay run listed");
    const vitals = await withOrgContext(org.orgId, () => orgVitals(approver));
    assert.deepEqual(vitals.approvals, { available: true, pending: items.length }, "vitals counts the unified set");
    // The benchmark case: an admin holding no assignment sees no gates, but
    // must still see the gateless work instead of [].
    const admin = ctxFor(org.orgId, actors.adminId, ["admin"], ["flows.approve", "ap.approve"]);
    const adminItems = await withOrgContext(org.orgId, () => listApprovalWorklist(admin));
    assert.equal(adminItems.filter((item) => item.kind === "flow_gate").length, 0, "no gate assigned to admin");
    assert.equal(
      adminItems.filter((item) => item.kind === "document" || item.kind === "pay_run").length,
      items.length - 1,
      "admin still sees every gateless approval",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

const approvalSubjectCases = [{ label: "approval subject summaries", register: async () => {
  const kind = "hrm_employment_change_request";
  const text = Object.assign((key: string) => ({
    "me.requestKinds.hire": "Hire", "queue.columns.effective": "Effective",
  }[key] ?? key), { has: (key: string) => key === "me.requestKinds.hire" || key === "queue.columns.effective" });
  async function seedHire(orgId: string, subsidiaryId: string) {
    const partyId = randomUUID(), employmentId = randomUUID(), requestId = randomUUID();
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active)
      values (${partyId}, ${orgId}, 'person', 'Dana Employee', true)`);
    await db.execute(sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id)
      values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId})`);
    await db.execute(sql`insert into hrm_employment_change_requests
      (id, org_id, employment_id, expected_employment_revision, payload, payload_digest, payload_schema_version, status)
      values (${requestId}, ${orgId}, ${employmentId}, 1,
        '{"kind":"hire","status":"active","effectiveFrom":"2026-10-01","effectiveTo":null}'::jsonb,
        repeat('0', 64), '1', 'draft')`);
    return requestId;
  }
  test("approval subject resolution supplies the employee and decision summary", { skip: !DB }, async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const id = await withBypassContext(() => seedHire(org.orgId, org.subsidiaryId));
      const details = await withBypassContext(() => resolveApprovalSubjects(org.orgId, [{ kind, subjectId: id }], text));
      const detail = details.get(`${kind}:${id}`);
      assert.ok(detail);
      assert.equal(detail.partyName, "Dana Employee");
      assert.equal(detail.summary, "Hire · Effective 2026-10-01");
    } finally { await dropScratchOrg(org.orgId); }
  });
  test("unresolvable approval subjects stay absent", { skip: !DB }, async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const details = await withBypassContext(() => resolveApprovalSubjects(org.orgId, [
        { kind: "close_run", subjectId: randomUUID() },
        { kind, subjectId: "not-a-uuid" },
        { kind, subjectId: randomUUID() },
      ], text));
      assert.equal(details.size, 0);
    } finally { await dropScratchOrg(org.orgId); }
  });
}}] as const;
for (const row of approvalSubjectCases) await row.register();

test("decide paths resolve each subject kind with separation of duties", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const ids = await withBypassContext(() => seed(org.orgId, org.subsidiaryId, org.accounts.bank, actors));
    const approver = ctxFor(org.orgId, actors.approver1Id, ["approver"], ["flows.approve", "ap.approve"]);
    const submitter = ctxFor(org.orgId, actors.submitterId, ["accountant"], ["flows.approve", "ap.approve"]);

    const decided = await decideApproval(approver, {
      documentId: ids.gatelessId, decision: "approved", idempotencyKey: randomUUID(),
    });
    assert.equal(decided.replayed, false);
    assert.equal(await withOrgContext(org.orgId, () => docStatus(ids.gatelessId)), "approved");

    await assert.rejects(
      decideApproval(submitter, { documentId: ids.sodId, decision: "approved", idempotencyKey: randomUUID() }),
      // The refusal names the MAKER as well as the submitter — authorship
      // never rebinds, so a third-party submit cannot launder the author's
      // own approval. Matching the shared clause rather than one role keeps
      // this green when the message names both.
      /cannot approve their own document/,
      "submitter cannot self-approve a pending document",
    );

    // A routed document refuses the direct path.
    await assert.rejects(
      decideApproval(approver, { documentId: ids.gatedId, decision: "approved", idempotencyKey: randomUUID() }),
      /routed/,
      "gated documents decide through their gate",
    );

    // The pay-run subject lookup shares the worklist's ambient-scope
    // assumption (unscoped it throws approval-not-found); the document
    // decides above self-scope via withOrgTransaction and stay raw.
    const run = await withOrgContext(org.orgId, () => decideApproval(approver, {
      paymentRunId: ids.runId, decision: "approved", idempotencyKey: randomUUID(),
    }));
    assert.equal((run.result as { status: string }).status, "approved");
    const runStatus = (await withOrgContext(org.orgId, () => db.execute<{ status: string }>(sql`select status from payment_runs where id = ${ids.runId}`))).rows[0]?.status;
    assert.equal(runStatus, "approved");

    // Submitter self-approval of the run is refused.
    const runId2 = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into payment_runs
        (id, org_id, run_number, bank_account_id, subsidiary_id, method,
         direction, purpose, currency, status, payment_count, total_amount,
         submitted_at, submitted_by, created_by, updated_by)
      values (${runId2}, ${org.orgId}, 'W7-RUN2', ${org.accounts.bank}, ${org.subsidiaryId}, 'eft',
              'outbound', 'vendor_payments', 'CAD', 'pending_approval', 1,
              '10.0000', now(), ${actors.submitterId}, ${actors.submitterId}, ${actors.submitterId})`));
    await assert.rejects(
      withOrgContext(org.orgId, () => decideApproval(submitter, { paymentRunId: runId2, decision: "approved", idempotencyKey: randomUUID() })),
      /submitter cannot approve/,
      "run submitter cannot self-approve",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
