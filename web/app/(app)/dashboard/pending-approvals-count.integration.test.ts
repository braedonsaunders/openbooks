import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The dashboard "Pending approvals" tile links to /approvals?tab=all — the
// unified worklist — so its number must BE the unified count (Flows gates +
// gateless document-status approvals + pending pay runs). It counted only
// flow_gates, so it under-reported whenever a document waited outside a gate
// or a pay run awaited approval, disagreeing with both the worklist page and
// get_vitals on the same data.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedApprovalFlow, seedDraftDocument, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { submitForApproval } = await import("@openbooks/engine/src/flows/submit.ts");
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
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "vendor_bill",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    // One gated document (visible through its gate).
    const gatedId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await submitForApproval("vendor_bill", gatedId);
    // One gateless document in pending_approval with no flow run behind it.
    const gatelessId = await seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actors.submitterId });
    await db.execute(sql`update documents set status='pending_approval', submitted_by=${actors.submitterId},
      submitted_at=now(), updated_by=${actors.submitterId}, updated_at=now()
      where id=${gatelessId} and org_id=${org.orgId}`);
    // One status-based pay run awaiting approval.
    const runId = randomUUID();
    await db.execute(sql`
      insert into payment_runs
        (id, org_id, run_number, bank_account_id, subsidiary_id, method,
         direction, purpose, currency, status, payment_count, total_amount,
         submitted_at, submitted_by, created_by, updated_by)
      values (${runId}, ${org.orgId}, 'P06-DASH', ${org.accounts.bank}, ${org.subsidiaryId}, 'eft',
              'outbound', 'vendor_payments', 'CAD', 'pending_approval', 1,
              '250.0000', now(), ${actors.submitterId}, ${actors.submitterId}, ${actors.submitterId})`);

    const metrics = await loadDashboardMetrics(authzFor(org.orgId, actors.approver1Id));
    assert.equal(metrics.pendingApprovals, 3, "tile must count gate + gateless document + pay run");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
