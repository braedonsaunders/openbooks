import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import test from "node:test";

// The dashboard "Pending approvals" tile links to /inbox — the
// unified worklist — so its number must BE the unified count (Flows gates,
// payment runs among them, + gateless document-status approvals). It counted
// only flow_gates, so it under-reported whenever a document waited outside a
// gate, disagreeing with both the worklist page and get_vitals on the same
// data.
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ intl: true });

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedApprovalFlow, seedDraftDocument, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { submitForApproval } = await import("@openbooks/engine/src/flows/submit.ts");
const { OUTBOUND_PAYMENT_RUN_SUBJECT_KIND } = await import("@openbooks/engine/src/flows/payment-runs-adapter.ts");
const { submitPaymentRun } = await import("@openbooks/engine/src/payments/operations.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
type Authz = import("@/lib/authz.ts").Authz;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Approver One", orgId,
      roles: [{ key: "approver", name: "approver" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(["flows.approve", "ap.approve", "ar.read", "dashboard.read"]),
    allowedSubsidiaryIds: null,
  };
}

test("dashboard pending-approvals tile counts the unified worklist, not just gates", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    for (const subjectKind of ["vendor_bill", OUTBOUND_PAYMENT_RUN_SUBJECT_KIND]) {
      await withBypassContext(() => seedApprovalFlow(org.orgId, {
        subjectKind,
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      }));
    }
    // One gated document (visible through its gate).
    const gatedId = await withBypassContext(() => seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId }));
    await withOrgContext(org.orgId, () => submitForApproval("vendor_bill", gatedId));
    // One gateless document in pending_approval with no flow run behind it.
    const gatelessId = await withBypassContext(() => seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId }));
    await withBypassContext(() => db.execute(sql`update documents set status='pending_approval', submitted_by=${actors.submitterId},
      submitted_at=now(), updated_by=${actors.submitterId}, updated_at=now()
      where id=${gatelessId} and org_id=${org.orgId}`));
    // One payment run awaiting approval through its flow.
    const formatId = randomUUID();
    const profileId = randomUUID();
    const runId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into payment_formats
          (id, org_id, code, name, rail, direction, file_extension, content_type, created_by, updated_by)
        values (${formatId}, ${org.orgId}, 'P06-WIRE', 'Dashboard wire', 'wire', 'credit', 'txt', 'text/plain',
                ${actors.submitterId}, ${actors.submitterId})`);
      await db.execute(sql`
        insert into payment_bank_profiles
          (id, org_id, name, bank_account_id, payment_format_id, currency, created_by, updated_by)
        values (${profileId}, ${org.orgId}, 'Dashboard profile', ${org.accounts.bank}, ${formatId}, 'CAD',
                ${actors.submitterId}, ${actors.submitterId})`);
      await db.execute(sql`
        insert into payment_runs
          (id, org_id, run_number, bank_account_id, payment_bank_profile_id, method,
           direction, purpose, currency, status, payment_count, total_amount, created_by, updated_by)
        values (${runId}, ${org.orgId}, 'P06-DASH', ${org.accounts.bank}, ${profileId}, 'wire',
                'outbound', 'vendor_payments', 'CAD', 'draft', 1, '250.0000',
                ${actors.submitterId}, ${actors.submitterId})`);
    });
    await withOrgContext(org.orgId, () => submitPaymentRun(runId, org.orgId, actors.submitterId));

    // The tile reader takes its org from the authz object but its SQL runs
    // through the ambient connection scope, exactly as the dashboard route
    // provides in production.
    const metrics = await withOrgContext(org.orgId, () => loadDashboardMetrics(authzFor(org.orgId, actors.approver1Id)));
    assert.equal(metrics.pendingApprovals, 3, "tile must count gate + gateless document + payment-run gate");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
