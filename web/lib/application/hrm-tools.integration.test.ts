import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors, seedApprovalFlow } =
  await import("@openbooks/engine/testing/fixtures");
const { enableHrm, grantPermissions, linkPerson, seedEmployment } =
  await import("@openbooks/engine/testing/hrm-harness");
const { HRM_CHANGE_REQUEST_SUBJECT_KIND } =
  await import("@openbooks/schema/src/hrm-change-requests.ts");
const { findEmploymentsByParty, getEmploymentAsOf, getEmploymentRecord } =
  await import("@openbooks/engine/hrm/employment-read");
const { listExports } = await import("@openbooks/engine/hrm/documents");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(
  orgId: string,
  userId: string,
  role: string,
  permissions: string[],
): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "HRM test actor",
        orgId,
        roles: [{ key: role, name: role }],
        envKind: "sandbox",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function setHrmEnabled(orgId: string, enabled: boolean): Promise<void> {
  const result = await db.execute<{ id: string }>(
    sql`
    update orgs set settings = jsonb_set(settings, '{features,hrm}', ${JSON.stringify(enabled)}::jsonb, true)
     where id = ${orgId}
     returning id
  `,
    "objects",
  );
  assert.equal(result.length, 1, "the scratch organization feature setting was updated");
}

test(
  "HRM tools hire without a Flow, submit and approve a change, and queue a subject export",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const secondOrg = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      const secondActors = await withBypassContext(() => seedFlowActors(secondOrg.orgId));
      await withBypassContext(async () => {
        await enableHrm(org.orgId, "hrmDocuments");
        await enableHrm(secondOrg.orgId);
        await grantPermissions(org.orgId, actors.approver1Id, ["hrm.employment.approve"]);
        await linkPerson(org.orgId, actors.adminId, "HR Operator");
        await linkPerson(org.orgId, actors.approver1Id, "HR Approver");
      });
      const worker = await withBypassContext(() =>
        seedEmployment(org.orgId, org.subsidiaryId, {
          displayName: "Workforce Tool Hire",
          employeeRole: true,
          withVersion: false,
        }),
      );
      const hr = ctxFor(org.orgId, actors.adminId, "admin", [
        "hrm.employment.manage",
        "hrm.employment.read",
        "hrm.documents.manage",
        "hrm.documents.read",
        "hrm.self.read",
      ]);
      const approver = ctxFor(org.orgId, actors.approver1Id, "approver", [
        "flows.approve",
        "hrm.employment.read",
        "hrm.employment.approve",
      ]);
      const run = (context: ApplicationContext, name: string, input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () =>
          executeApplicationTool(applicationTool(name)!, context, input),
        );

      const hireInput = {
        workerPartyId: worker.workerPartyId,
        employerSubsidiaryId: org.subsidiaryId,
        effectiveFrom: "2026-09-01",
        initialAssignment: { assignmentKey: "primary", jobTitle: "Associate" },
        reason: "Hire to fill the workforce opening",
        idempotencyKey: "hrm-hire-lifecycle-001",
      };
      const hired = await run(hr, "create_employment", hireInput);
      assert.equal(hired.replayed, false);
      const employmentId = String(hired.employmentId);
      const hireRead = await withOrgContext(org.orgId, () =>
        getEmploymentAsOf({
          orgId: org.orgId,
          actorId: actors.adminId,
          employmentId,
          effectiveDate: "2026-09-01",
          knownAt: new Date().toISOString(),
        }),
      );
      assert.equal(hireRead.assignments[0]?.jobTitle, "Associate");

      const replayedHire = await run(hr, "create_employment", hireInput);
      assert.equal(replayedHire.replayed, true);
      assert.deepEqual(
        await withOrgContext(org.orgId, () =>
          findEmploymentsByParty({
            orgId: org.orgId,
            actorId: actors.adminId,
            workerPartyId: worker.workerPartyId,
          }),
        ),
        [employmentId],
      );

      const scopedChangeFlow = await withBypassContext(() =>
        seedApprovalFlow(org.orgId, {
          subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "any",
        }),
      );
      assert.ok(scopedChangeFlow.flowId);

      const request = await run(hr, "create_change_request", {
        employmentId,
        payload: {
          kind: "assignment_change",
          assignmentKey: "primary",
          jobTitle: "Senior Associate",
          effectiveFrom: "2026-10-01",
        },
        idempotencyKey: "hrm-change-create-001",
      });
      const submitted = await run(hr, "submit_change_request", {
        requestId: request.requestId,
        reason: "Promotion approved for the next effective period",
        idempotencyKey: "hrm-change-submit-001",
      });
      assert.equal(submitted.status, "pending_approval");

      const worklist = await run(approver, "list_approvals", {});
      const approvals = worklist.approvals as Array<{ id: string; subjectId: string }>;
      const gate = approvals.find((item) => item.subjectId === request.requestId);
      assert.ok(gate, "the configured Flow exposes an approval gate to its assigned approver");
      await run(approver, "decide_approval", {
        gateId: gate.id,
        decision: "approved",
        comment: "Approved after the role review",
        idempotencyKey: "hrm-change-approve-001",
      });
      const currentRecord = await withOrgContext(org.orgId, () =>
        getEmploymentRecord({
          orgId: org.orgId,
          actorId: actors.adminId,
          employmentId,
          effectiveDate: "2026-10-01",
          knownAt: new Date().toISOString(),
        }),
      );
      assert.equal(currentRecord.asOf?.assignments[0]?.jobTitle, "Senior Associate");
      assert.equal(
        currentRecord.changeRequests.find((item) => item.id === request.requestId)?.status,
        "applied",
      );

      const exportResult = await run(hr, "request_data_subject_export", {
        partyId: worker.workerPartyId,
        idempotencyKey: "hrm-dsar-request-001",
      });
      const exports = await withOrgContext(org.orgId, () =>
        listExports({
          orgId: org.orgId,
          actorId: actors.adminId,
          partyId: worker.workerPartyId,
        }),
      );
      assert.ok(
        exports.some((item) => item.id === exportResult.exportId && item.status === "queued"),
        "the native export read shows the queued request",
      );

      await assert.rejects(
        run(ctxFor(org.orgId, actors.adminId, "admin", []), "create_employment", {
          ...hireInput,
          workerPartyId: randomUUID(),
          idempotencyKey: "hrm-no-permission-001",
        }),
        /forbidden/i,
      );

      const featureWorker = await withBypassContext(() =>
        seedEmployment(org.orgId, org.subsidiaryId, {
          displayName: "Feature Gate Person",
          employeeRole: true,
          withVersion: false,
        }),
      );
      await withBypassContext(() => setHrmEnabled(org.orgId, false));
      try {
        await assert.rejects(
          run(hr, "create_employment", {
            ...hireInput,
            workerPartyId: featureWorker.workerPartyId,
            idempotencyKey: "hrm-feature-off-001",
          }),
          /disabled|not found|feature/i,
        );
      } finally {
        await withBypassContext(() => setHrmEnabled(org.orgId, true));
      }

      const isolated = ctxFor(secondOrg.orgId, secondActors.adminId, "admin", [
        "hrm.employment.manage",
      ]);
      await assert.rejects(
        withOrgContext(secondOrg.orgId, () =>
          executeApplicationTool(applicationTool("correct_employment_start")!, isolated, {
            employmentId,
            correctedStart: "2026-09-01",
            reason: "Check tenant isolation on employment corrections",
            idempotencyKey: "hrm-cross-org-001",
          }),
        ),
        /not found|not visible/i,
      );
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(secondOrg.orgId);
    }
  },
);
