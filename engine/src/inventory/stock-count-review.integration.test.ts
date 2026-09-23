import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { receiveInventory } from "./movements.ts";
import { isStockCountReviewRequired } from "./stock-count-gates.ts";
import {
  createStockCount,
  postStockCount,
  recordCountedQuantity,
  startStockCount,
  submitStockCountForReview,
} from "./stock-counts.ts";
import { InventoryError } from "./contracts.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * IN11: stock-count "review" was not a maker/checker control — one user
 * could create, count, submit, and post their own variance under the same
 * items.post grant. With the "require a different user to post stock
 * counts" Setup switch ON, the contributor cannot post (refused by name)
 * and a second user posts with the review decision audited. OFF (default)
 * keeps today's behaviour and audits that no independent review happened.
 */

async function setReviewRequired(orgId: string, on: boolean): Promise<void> {
  // Single-level set: nested jsonb_set path creation is not relied upon.
  const updated = (await db.execute<{ id: string }>(sql`
    update orgs
       set settings = jsonb_set(
             coalesce(settings, '{}'::jsonb),
             '{approvals}',
             coalesce(settings->'approvals', '{}'::jsonb) || jsonb_build_object('requireStockCountReview', to_jsonb(${on}::boolean))
           )
     where id = ${orgId}
    returning id`));
  assert.equal(updated.rows.length, 1);
}

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
  const lineId = (await db.execute<{ id: string }>(sql`
    select id from stock_count_lines where org_id = ${org.orgId} and stock_count_id = ${count.id}`)).rows[0]!.id;
  await recordCountedQuantity(org.orgId, actorId, { countId: count.id, lineId, countedQuantity: counted });
  await submitStockCountForReview(org.orgId, actorId, count.id);
  return { countId: count.id, lineId };
}

type PostAudit = {
  operation: string;
  review: {
    required: boolean;
    postedBy: string | null;
    contributors: string[];
    totalVariance: string;
    lineCount: number;
  };
  note?: string;
};

async function postAudits(orgId: string, countId: string): Promise<PostAudit[]> {
  return (await db.execute<{ changes: PostAudit }>(sql`
    select changes from audit_log
     where org_id = ${orgId} and table_name = 'stock_counts' and row_id = ${countId}
     order by at, id`)).rows.map((row) => row.changes);
}

async function countStatus(orgId: string, countId: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`
    select status from stock_counts where org_id = ${orgId} and id = ${countId}`)).rows[0]!.status;
}

test("ON: the contributor cannot post their own count — refused by name, nothing posted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setReviewRequired(org.orgId, true);
    const amina = await createScratchUser(org.orgId, "Amina Counter", "counter");
    const { countId } = await openReviewedCount(org, amina, "9");
    const movementsBefore = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from inventory_movements where org_id = ${org.orgId}`)).rows[0]!.n;
    await assert.rejects(
      withOrgTransaction(org.orgId, () => postStockCount(org.orgId, amina, countId)),
      (e: unknown) => {
        assert.ok(e instanceof InventoryError, "self-post must refuse as InventoryError (HTTP 422)");
        assert.match((e as Error).message, /Amina Counter/, "the refusal must name the contributor");
        assert.match((e as Error).message, /independent review/, "the refusal must name the control");
        assert.match((e as Error).message, /different user/, "the refusal must name the remedy");
        return true;
      },
    );
    assert.equal(await countStatus(org.orgId, countId), "review", "the count stays in review");
    assert.equal(
      (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from inventory_movements where org_id = ${org.orgId}`)).rows[0]!.n,
      movementsBefore,
      "no adjustment may post",
    );
    assert.deepEqual(await postAudits(org.orgId, countId), [], "a refused post audits nothing");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("ON: a second user posts, and the review decision is audited", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setReviewRequired(org.orgId, true);
    const amina = await createScratchUser(org.orgId, "Amina Counter", "counter");
    const boris = await createScratchUser(org.orgId, "Boris Reviewer", "reviewer");
    const { countId } = await openReviewedCount(org, amina, "9");
    const posted = await withOrgTransaction(org.orgId, () => postStockCount(org.orgId, boris, countId));
    assert.equal(posted.status, "posted");
    const audits = await postAudits(org.orgId, countId);
    assert.equal(audits.length, 1, "exactly one post audit row");
    assert.equal(audits[0]!.operation, "post");
    assert.equal(audits[0]!.review.required, true);
    assert.equal(audits[0]!.review.postedBy, boris, "the reviewer is recorded");
    assert.deepEqual(audits[0]!.review.contributors, [amina], "the contributor is recorded");
    assert.equal(audits[0]!.review.totalVariance, "-1.0000", "the decided variance is recorded");
    assert.equal(audits[0]!.review.lineCount, 1);
    assert.equal(audits[0]!.note, undefined, "no without-review note when review happened");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("OFF: self-post works as today and audits that no independent review happened", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setReviewRequired(org.orgId, false);
    const amina = await createScratchUser(org.orgId, "Amina Counter", "counter");
    const { countId } = await openReviewedCount(org, amina, "9");
    const posted = await withOrgTransaction(org.orgId, () => postStockCount(org.orgId, amina, countId));
    assert.equal(posted.status, "posted", "OFF keeps today's self-post behaviour");
    const audits = await postAudits(org.orgId, countId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.review.required, false);
    assert.equal(audits[0]!.review.postedBy, amina);
    assert.equal(audits[0]!.note, "posted without independent review");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("unset switch behaves as OFF, and only a true boolean enables the gate", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await isStockCountReviewRequired(org.orgId, db), false, "absent reads as OFF");
    for (const junk of ["yes", "1", "TRUE", "on"]) {
      await db.execute(sql`
        update orgs set settings = jsonb_set(
              coalesce(settings, '{}'::jsonb),
              '{approvals}',
              coalesce(settings->'approvals', '{}'::jsonb) || jsonb_build_object('requireStockCountReview', to_jsonb(${junk}::text))
            )
         where id = ${org.orgId}`);
      assert.equal(
        await isStockCountReviewRequired(org.orgId, db),
        false,
        `junk value ${junk} must not enable the gate`,
      );
    }
    await setReviewRequired(org.orgId, true);
    assert.equal(await isStockCountReviewRequired(org.orgId, db), true, "boolean true enables the gate");

    // And the default path posts without review friction.
    await setReviewRequired(org.orgId, false);
    const amina = await createScratchUser(org.orgId, "Amina Counter", "counter");
    const { countId } = await openReviewedCount(org, amina, "9");
    const posted = await withOrgTransaction(org.orgId, () => postStockCount(org.orgId, amina, countId));
    assert.equal(posted.status, "posted");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
