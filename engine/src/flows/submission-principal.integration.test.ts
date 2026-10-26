import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  grantScratchPermissions,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
} from "../testing/fixtures.ts";
import { decideGate } from "./gates.ts";
import { submitAndReleaseIfUngated } from "./submit.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test(
  "interactive submission requires its actual authorized actor and cannot borrow the record author",
  enabled,
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await assert.rejects(
        submitAndReleaseIfUngated("vendor_bill", id, null),
        /named authorized operator/,
      );
      await assert.rejects(
        submitAndReleaseIfUngated("vendor_bill", id, null, { source: "sync" }),
        /native unattended source/,
      );
      await assert.rejects(
        submitAndReleaseIfUngated("vendor_bill", id, actors.outsiderId),
        /not found/,
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where org_id=${org.orgId} and id=${id}`,
            "objects",
          )
        )[0]?.status,
        "draft",
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from flow_submissions where org_id=${org.orgId} and subject_id=${id}`,
            "objects",
          )
        ).length,
        0,
      );
      assert.equal(
        (await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId)).autoApproved,
        true,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "native scheduled submission retains system provenance under zero or configured tenant gates",
  enabled,
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const zero = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      assert.equal(
        (await submitAndReleaseIfUngated("vendor_bill", zero, null, { source: "schedule" }))
          .autoApproved,
        true,
      );
      const receipt = (
        await db.execute<{ actor_id: string | null; source: string }>(
          sql`select actor_id,context->>'event_source' as source
      from flow_submissions where org_id=${org.orgId} and subject_id=${zero}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(receipt, { actor_id: null, source: "schedule" });
      await grantScratchPermissions(org.orgId, actors.approver1Id, ["ap.approve", "ap.post"]);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "all",
      });
      const gated = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      assert.equal(
        (await submitAndReleaseIfUngated("vendor_bill", gated, null, { source: "schedule" })).gated,
        true,
      );
      const before = (
        await db.execute<{ status: string; submitted_by: string | null }>(
          sql`select status,submitted_by from documents
      where org_id=${org.orgId} and id=${gated}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(before, { status: "pending_approval", submitted_by: null });
      const gate = (
        await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${gated} and status='pending'`,
          "objects",
        )
      )[0]!;
      await decideGate({ gateId: gate.id, userId: actors.approver1Id, decision: "approved" });
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where org_id=${org.orgId} and id=${gated}`,
            "objects",
          )
        )[0]?.status,
        "approved",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
