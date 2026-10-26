import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedDraftDocument,
  seedFlowActors,
  seedApprovalFlow,
} from "../testing/fixtures.ts";
import { submitAndReleaseIfUngated } from "./submit.ts";
import { decideGate } from "./gates.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "no Flow releases a vendor bill even when prior company settings contain an approval flag",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{approvals}',
      '{"requireVendorBillApproval":true}'::jsonb) where id=${org.orgId}`);
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      const result = await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
      assert.equal(result.flowError, null);
      assert.equal(result.autoApproved, true);
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where org_id=${org.orgId} and id=${id}`,
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

test(
  "ten applicable Flows require all ten approvals before a bill releases",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      for (let i = 0; i < 10; i++)
        await seedApprovalFlow(org.orgId, {
          subjectKind: "vendor_bill",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "all",
          gateTitle: `Review ${i + 1}`,
        });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      const result = await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
      assert.equal(result.gated, true);
      const gates = await db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${id} and status='pending' order by id`,
        "objects",
      );
      assert.equal(gates.length, 10);
      for (const [index, gate] of gates.entries()) {
        await decideGate({
          gateId: gate.id,
          decision: "approved",
          userId: actors.approver1Id,
        });
        assert.equal(
          (
            await db.execute<{ status: string }>(
              sql`select status from documents where org_id=${org.orgId} and id=${id}`,
              "objects",
            )
          )[0]?.status,
          index === 9 ? "approved" : "pending_approval",
        );
      }
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
