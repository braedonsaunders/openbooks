import { installEngineSeams } from "@openbooks/engine/composition/install";
installEngineSeams();
import assert from "node:assert/strict";
import test from "node:test";

// The picker uses the native hand-off authority: an authorized direct
// assignee or an operator holding flows.manage may delegate a live gate.
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgTransaction } = await import("@openbooks/engine/platform/db");
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  grantScratchPermissions,
  seedDraftDocument,
  seedApprovalFlow,
} = await import("@openbooks/engine/testing/fixtures");
const { submitForApproval } = await import("@openbooks/engine/flows/submit");
const { gateDelegateOptions } = await import("./gate-delegates.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function pendingChangeGate(
  orgId: string,
  subsidiaryId: string,
  submitterId: string,
  assignee: { userId?: string; role?: string },
): Promise<string> {
  await grantScratchPermissions(orgId, submitterId, ["ar.create"]);
  const documentId = await seedDraftDocument(orgId, {
    kind: "customer_invoice",
    createdBy: submitterId,
  });
  await db.execute(
    sql`update documents set subsidiary_id=${subsidiaryId} where org_id=${orgId} and id=${documentId}`,
  );
  const { flowId } = await seedApprovalFlow(orgId, {
    subjectKind: "customer_invoice",
    mode: "any",
    assignees: assignee.userId
      ? [{ type: "user", userId: assignee.userId }]
      : [{ type: "role", role: assignee.role! }],
  });
  await withOrgTransaction(orgId, () =>
    submitForApproval("customer_invoice", documentId, submitterId),
  );
  const gates = await db.execute<{ id: string }>(
    sql`select id from flow_gates
    where org_id=${orgId} and flow_id=${flowId} and subject_id=${documentId} and status='pending'`,
    "objects",
  );
  assert.equal(gates.length, 1);
  const gateId = gates[0]!.id;
  return gateId;
}

test(
  "authorized direct assignees and Flow managers are offered Delegate on a pending gate",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const { submitter, assignee, reviewer, admin, direct, byRole } = await withBypassContext(
        async () => {
          const submitter = await createScratchUser(
            org.orgId,
            "Asset Accountant",
            "asset_accountant",
          );
          const assignee = await createScratchUser(org.orgId, "Controller", "gate_reviewer");
          await grantScratchPermissions(org.orgId, assignee, ["ar.approve"]);
          const reviewer = await createScratchUser(org.orgId, "Flow Manager", "flow_manager");
          await grantScratchPermissions(org.orgId, reviewer, ["flows.manage", "flows.approve"]);
          const admin = await createScratchUser(org.orgId, "Organization Admin", "admin");
          const direct = await pendingChangeGate(org.orgId, org.subsidiaryId, submitter, {
            userId: assignee,
          });
          const byRole = await pendingChangeGate(org.orgId, org.subsidiaryId, submitter, {
            role: "gate_reviewer",
          });
          return { submitter, assignee, reviewer, admin, direct, byRole };
        },
      );
      const names = async (viewer: string, gate: string | null) =>
        (await withBypassContext(() => gateDelegateOptions(org.orgId, viewer, gate))).map(
          (option) => option.name,
        );

      const offered = await names(assignee, direct);
      assert.ok(offered.length > 0, "the direct assignee may hand the gate on");
      assert.ok(!offered.includes("Controller"), "never to themselves");
      assert.ok((await names(admin, direct)).length > 0, "an organization admin may delegate it");
      assert.ok(
        (await names(reviewer, direct)).length > 0,
        "the native Flow-management grant authorizes hand-off",
      );
      assert.deepEqual(await names(submitter, direct), []);
      // Role targeting resolves to a frozen user assignment in the native plan.
      assert.ok(
        (await names(assignee, byRole)).length > 0,
        "the resolved role assignee may hand off their own gate",
      );
      assert.ok((await names(admin, byRole)).length > 0);
      assert.deepEqual(await names(admin, null), [], "no pending gate, no picker");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
