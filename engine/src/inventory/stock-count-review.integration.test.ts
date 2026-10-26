import { confirmCountObservation } from "../testing/inventory-counts.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { receiveInventory } from "./movements.ts";
import { decideGate } from "../flows/gates.ts";
import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
import {
  createStockCount,
  postStockCount,
  recordCountedQuantity,
  startStockCount,
  submitStockCountForReview,
} from "./stock-counts.ts";

import {
  createScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  grantScratchPermissions,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function openReviewedCount(
  org: ScratchOrg,
  actorId: string,
  counted: string,
): Promise<{ countId: string; lineId: string }> {
  await receiveInventory(org.orgId, actorId, {
    itemId: org.items.fifo,
    stockLocationId: org.stockLocationId,
    quantity: "10",
    unitCost: "4",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
  const count = await createStockCount(org.orgId, actorId, {
    locationId: org.locationId,
    subsidiaryId: org.subsidiaryId,
    countedOn: org.date,
    lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
  });
  await startStockCount(org.orgId, actorId, count.id);
  const lineId = (
    await db.execute<{ id: string }>(
      sql`
    select id from stock_count_lines where org_id = ${org.orgId} and stock_count_id = ${count.id}`,
      "objects",
    )
  )[0]!.id;
  await recordCountedQuantity(org.orgId, actorId, {
    countId: count.id,
    lineId,
    countedQuantity: counted,
  });
  await confirmCountObservation(org.orgId, count.id, lineId, counted, actorId);
  await submitStockCountForReview(org.orgId, actorId, count.id);
  return { countId: count.id, lineId };
}

async function nativeFixture(
  work: (org: ScratchOrg, actors: Awaited<ReturnType<typeof seedFlowActors>>) => Promise<void>,
) {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    for (const id of [actors.submitterId, actors.approver1Id])
      await grantScratchPermissions(org.orgId, id, ["items.read", "items.manage", "items.post"]);
    await work(org, actors);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}
async function postAudit(orgId: string, countId: string) {
  return await db.execute<{
    changes: {
      review: {
        policy: { kind: string; runIds: string[] };
        postedBy: string;
        totalVariance: string;
        lineCount: number;
      };
    };
  }>(
    sql`
 select changes from audit_log where org_id=${orgId} and table_name='stock_counts' and row_id=${countId} and changes->>'operation'='post'`,
    "objects",
  );
}

test(
  "a zero-gate stock count posts by its contributor with canonical routing and exact variance evidence",
  { skip: !DB },
  async () =>
    nativeFixture(async (org, actors) => {
      const { countId } = await openReviewedCount(org, actors.submitterId, "9");
      const posted = await withOrgTransaction(org.orgId, () =>
        postStockCount(org.orgId, actors.submitterId, countId),
      );
      assert.equal(posted.status, "posted");
      const audit = await postAudit(org.orgId, countId);
      assert.equal(audit.length, 1);
      assert.deepEqual(audit[0]?.changes.review, {
        policy: {
          version: 1,
          trigger: "on_submit",
          kind: "ungated",
          flowIds: [],
          runIds: [],
        },
        postedBy: actors.submitterId,
        totalVariance: "-1.0000",
        lineCount: 1,
      });
      const receipt = (
        await db.execute<{ allowed: boolean }>(
          sql`select public.flow_ungated_submission_authorized(${org.orgId},'stock_count',${countId},${actors.submitterId}) as allowed`,
          "objects",
        )
      )[0];
      assert.equal(receipt?.allowed, true);
      await assert.rejects(
        withOrgTransaction(org.orgId, () => postStockCount(org.orgId, actors.submitterId, countId)),
        /already posted/,
      );
      assert.equal((await postAudit(org.orgId, countId)).length, 1);
    }),
);

test(
  "ten stock-count Flow gates must all finish before posting and policy edits cannot skip pending decisions",
  { skip: !DB },
  async () =>
    nativeFixture(async (org, actors) => {
      for (let i = 0; i < 10; i++)
        await seedApprovalFlow(org.orgId, {
          subjectKind: "stock_count",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "all",
          preventSelfApproval: true,
        });
      const { countId } = await openReviewedCount(org, actors.submitterId, "9");
      const movementCount = async () =>
        (
          await db.execute<{ n: string }>(
            sql`select count(*)::text as n from inventory_movements where org_id=${org.orgId}`,
            "objects",
          )
        )[0]!.n;
      const before = await movementCount();
      const pending = await db.execute<{ id: string }>(
        sql`select id from flow_gates where org_id=${org.orgId} and subject_kind='stock_count' and subject_id=${countId} and status='pending' order by id`,
        "objects",
      );
      assert.equal(pending.length, 10);
      await db.execute(
        sql`update flows set enabled=false where org_id=${org.orgId} and subject_kind='stock_count'`,
      );
      for (const [index, gate] of pending.entries()) {
        await assert.rejects(
          withOrgTransaction(org.orgId, () =>
            postStockCount(org.orgId, actors.submitterId, countId),
          ),
          /Flow approvals/,
        );
        assert.equal(await movementCount(), before);
        assert.deepEqual(await postAudit(org.orgId, countId), []);
        await decideGate({
          gateId: gate.id,
          userId: actors.approver1Id,
          decision: "approved",
        });
        if (index < 9)
          assert.equal(
            (
              await db.execute<{ review_released: boolean }>(
                sql`select review_released from stock_counts where org_id=${org.orgId} and id=${countId}`,
                "objects",
              )
            )[0]?.review_released,
            false,
          );
      }
      const result = await withOrgTransaction(org.orgId, () =>
        postStockCount(org.orgId, actors.submitterId, countId),
      );
      assert.equal(result.status, "posted");
      const audit = await postAudit(org.orgId, countId);
      assert.equal(audit.length, 1);
      assert.equal(audit[0]?.changes.review.policy.kind, "gated");
      assert.equal(audit[0]?.changes.review.policy.runIds.length, 10);
    }),
);

test(
  "a tenant can explicitly allow its stock-count contributor to decide an assigned gate",
  { skip: !DB },
  async () =>
    nativeFixture(async (org, actors) => {
      await seedApprovalFlow(org.orgId, {
        subjectKind: "stock_count",
        assignees: [{ type: "user", userId: actors.submitterId }],
        mode: "all",
        preventSelfApproval: false,
      });
      const { countId } = await openReviewedCount(org, actors.submitterId, "9");
      const gate = (
        await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${countId} and status='pending'`,
          "objects",
        )
      )[0]!;
      await decideGate({
        gateId: gate.id,
        userId: actors.submitterId,
        decision: "approved",
      });
      assert.equal(
        (
          await withOrgTransaction(org.orgId, () =>
            postStockCount(org.orgId, actors.submitterId, countId),
          )
        ).status,
        "posted",
      );
    }),
);
