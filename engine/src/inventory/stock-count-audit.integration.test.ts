import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { receiveInventory } from "./movements.ts";
import {
  createStockCount,
  postStockCount,
  recordCountedQuantity,
  recountStockCountLine,
  startStockCount,
  submitStockCountForReview,
} from "./stock-counts.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * IN7: counted-quantity edits left no audit trail — record overwrote in
 * place and recount cleared the prior observation with only updated_by/at
 * to show. Every change and recount now commits an immutable audit event
 * (actor, time, before, after, reason) that survives posting and is
 * readable from the house audit_log.
 */

type AuditEvent = {
  actor_id: string | null;
  at: string;
  changes: {
    operation: string;
    countId: string;
    reason: string | null;
    before: { countedQuantity: string | null; expectedQuantity: string };
    after: { countedQuantity: string | null; expectedQuantity: string };
  };
};

async function lineAudit(orgId: string, lineId: string): Promise<AuditEvent[]> {
  return (await db.execute<AuditEvent>(sql`
    select actor_id, at::text as at, changes
      from audit_log
     where org_id = ${orgId} and table_name = 'stock_count_lines' and row_id = ${lineId}
     order by at, id`)).rows;
}

async function openCountingLine(org: ScratchOrg): Promise<{ countId: string; lineId: string }> {
  await receiveInventory(org.orgId, null, {
    itemId: org.items.fifo,
    stockLocationId: org.stockLocationId,
    quantity: "10",
    unitCost: "4",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
  const count = await createStockCount(org.orgId, null, {
    locationId: org.locationId,
    subsidiaryId: org.subsidiaryId,
    countedOn: org.date,
    lines: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
  });
  await startStockCount(org.orgId, null, count.id);
  const lineId = (await db.execute<{ id: string }>(sql`
    select id from stock_count_lines where org_id = ${org.orgId} and stock_count_id = ${count.id}`)).rows[0]!.id;
  return { countId: count.id, lineId };
}

test("a correction keeps the first counter's observation with actor, time, before, after, and reason", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { countId, lineId } = await openCountingLine(org);
    await recordCountedQuantity(org.orgId, null, { countId, lineId, countedQuantity: "10" });
    await recordCountedQuantity(org.orgId, null, {
      countId,
      lineId,
      countedQuantity: "7",
      reason: "second pass found three units already staged",
    });
    const trail = await lineAudit(org.orgId, lineId);
    assert.equal(trail.length, 2, "first record and correction each leave one event");
    assert.deepEqual(trail[0]!.changes.before, { countedQuantity: null, expectedQuantity: "10.0000" });
    assert.deepEqual(trail[0]!.changes.after, { countedQuantity: "10.0000", expectedQuantity: "10.0000" });
    assert.equal(trail[0]!.changes.reason, null, "a first record carries no correction reason");
    assert.equal(trail[1]!.changes.operation, "record");
    assert.deepEqual(trail[1]!.changes.before, { countedQuantity: "10.0000", expectedQuantity: "10.0000" });
    assert.deepEqual(trail[1]!.changes.after, { countedQuantity: "7.0000", expectedQuantity: "10.0000" });
    assert.equal(trail[1]!.changes.reason, "second pass found three units already staged");
    assert.ok(trail[1]!.at, "the event carries its time");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a recount keeps the cleared observation, and the whole trail survives posting", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { countId, lineId } = await openCountingLine(org);
    await recordCountedQuantity(org.orgId, null, { countId, lineId, countedQuantity: "7" });
    await recountStockCountLine(org.orgId, null, { countId, lineId });
    const before = await lineAudit(org.orgId, lineId);
    assert.equal(before.length, 2, "record and recount each leave one event");
    const recount = before[1]!;
    assert.equal(recount.changes.operation, "recount");
    assert.deepEqual(recount.changes.before, { countedQuantity: "7.0000", expectedQuantity: "10.0000" });
    assert.deepEqual(recount.changes.after, { countedQuantity: null, expectedQuantity: "10.0000" });
    assert.match(recount.changes.reason ?? "", /recount/, "a recount always carries a reason");

    // The recount cleared the observation: re-record, submit, post.
    await recordCountedQuantity(org.orgId, null, { countId, lineId, countedQuantity: "9" });
    await submitStockCountForReview(org.orgId, null, countId);
    const posted = await withOrgTransaction(org.orgId, () => postStockCount(org.orgId, null, countId));
    assert.equal(posted.status, "posted");

    const trail = await lineAudit(org.orgId, lineId);
    assert.equal(trail.length, 3, "the trail survives posting: record, recount, re-record");
    assert.deepEqual(
      trail.map((e) => e.changes.after.countedQuantity),
      ["7.0000", null, "9.0000"],
      "the posted -1 variance reads against the full observation history",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
