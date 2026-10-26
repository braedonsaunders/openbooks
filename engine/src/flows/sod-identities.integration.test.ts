import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
  seedPayrollParty,
} from "../testing/fixtures.ts";
import { submitAndReleaseIfUngated } from "./submit.ts";
import { decideGate } from "./gates.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };
for (const allowSelf of [false, true]) {
  test(
    `a person's second login follows the tenant's ${allowSelf ? "permissive" : "independent"} gate policy`,
    DB,
    async () => {
      const org = await createScratchOrg();
      try {
        const actors = await seedFlowActors(org.orgId);
        const person = randomUUID();
        await seedPayrollParty(org.orgId, person, {
          kind: "person",
          displayName: "Proposal author",
          isActive: true,
        });
        await db.execute(
          sql`update users set party_id=${person} where org_id=${org.orgId} and id in(${actors.submitterId},${actors.approver1Id})`,
        );
        await seedApprovalFlow(org.orgId, {
          subjectKind: "vendor_bill",
          mode: "any",
          preventSelfApproval: !allowSelf,
          assignees: [
            { type: "user", userId: actors.approver1Id },
            { type: "user", userId: actors.approver2Id },
          ],
        });
        const id = await seedDraftDocument(org.orgId, {
          kind: "vendor_bill",
          createdBy: actors.submitterId,
        });
        await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
        const gates = await db.execute<{ id: string; assignee_user_id: string }>(
          sql`select id,assignee_user_id from flow_gates where org_id=${org.orgId} and subject_id=${id} and status='pending'`,
          "objects",
        );
        assert.deepEqual(
          new Set(gates.map((g) => g.assignee_user_id)),
          new Set(allowSelf ? [actors.approver1Id, actors.approver2Id] : [actors.approver2Id]),
        );
        const actingUser = allowSelf ? actors.approver1Id : actors.approver2Id;
        const gate = gates.find((g) => g.assignee_user_id === actingUser);
        assert.ok(gate);
        await decideGate({
          gateId: gate.id,
          decision: "approved",
          userId: actingUser,
        });
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
}

test(
  "linking a configured approver to the author after submission cannot evade the frozen independent gate",
  DB,
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const person = randomUUID();
      await seedPayrollParty(org.orgId, person, {
        kind: "person",
        displayName: "Shared identity",
        isActive: true,
      });
      await db.execute(
        sql`update users set party_id=${person} where org_id=${org.orgId} and id=${actors.submitterId}`,
      );
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        mode: "all",
        preventSelfApproval: true,
        assignees: [{ type: "user", userId: actors.approver1Id }],
      });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
      const gate = (
        await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${id} and status='pending'`,
          "objects",
        )
      )[0];
      assert.ok(gate);
      await db.execute(
        sql`update users set party_id=${person} where org_id=${org.orgId} and id=${actors.approver1Id}`,
      );
      await assert.rejects(
        decideGate({
          gateId: gate.id,
          decision: "approved",
          userId: actors.approver1Id,
        }),
        /own submission|self-approval/,
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from flow_gates where org_id=${org.orgId} and id=${gate.id}`,
            "objects",
          )
        )[0]?.status,
        "pending",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
