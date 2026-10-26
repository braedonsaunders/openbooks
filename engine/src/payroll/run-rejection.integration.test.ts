import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { decideGate } from "../flows/gates.ts";
import { submitForApproval, withdrawDocumentSubmission } from "../flows/submit.ts";
import { payRunRejection } from "./approval.ts";
import { seedAdoption, calculatedRun } from "./filing-test-fixtures.ts";
import {
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
  grantScratchPermissions,
} from "../testing/fixtures.ts";

/**
 * A rejected pay run names its rejecter and reason until it is resubmitted.
 *
 * The rejection is the Flows gate's own decision record, read back through
 * payRunRejection; a resubmission opens a new submission, so the earlier
 * rejection stops being current.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function pendingGateId(subjectId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from flow_gates
     where subject_id = ${subjectId} and status = 'pending'
     order by created_at`,
    "objects",
  );
  assert.equal(rows.length, 1, `expected one pending gate, got ${rows.length}`);
  return rows[0]!.id;
}

async function userName(userId: string): Promise<string> {
  const rows = await db.execute<{ name: string }>(
    sql`select name from users where id = ${userId}`,
    "objects",
  );
  return rows[0]!.name;
}

test(
  "a rejected pay run reports the rejecter and reason until it is resubmitted",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const actors = await seedFlowActors(fx.orgId);
      for (const actorId of [actors.submitterId, actors.approver1Id])
        await grantScratchPermissions(fx.orgId, actorId, ["payroll.manage"]);
      await seedApprovalFlow(fx.orgId, {
        subjectKind: "pay_run",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "any",
      });
      const submitted = { ...fx, actorId: actors.submitterId };
      const { input } = await calculatedRun(submitted);
      await submitForApproval("pay_run", input.documentId, actors.submitterId);
      assert.equal(
        await payRunRejection(fx.orgId, input.documentId),
        null,
        "a parked run has no rejection yet",
      );

      await decideGate({
        gateId: await pendingGateId(input.documentId),
        decision: "rejected",
        userId: actors.approver1Id,
        comment: "wrong period",
      });
      const rejection = await payRunRejection(fx.orgId, input.documentId);
      assert.ok(rejection, "the rejected run must report its rejection");
      assert.equal(rejection.rejectedBy, await userName(actors.approver1Id));
      assert.equal(rejection.reason, "wrong period");
      assert.ok(
        !Number.isNaN(Date.parse(rejection.rejectedAt)),
        "the decision time is an ISO timestamp",
      );

      // Resubmitting opens a new submission, and withdrawing that one returns the
      // run to draft: the earlier rejection is no longer the current one.
      await submitForApproval("pay_run", input.documentId, actors.submitterId);
      await withdrawDocumentSubmission({
        documentId: input.documentId,
        orgId: fx.orgId,
        actorId: actors.submitterId,
        actorIsApprover: false,
        reason: "recalling to correct the inputs",
      });
      assert.equal(
        await payRunRejection(fx.orgId, input.documentId),
        null,
        "a withdrawn resubmission is not a rejection",
      );
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);
