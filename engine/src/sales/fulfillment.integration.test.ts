import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { getAvailableToPromise } from "../inventory/availability.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, seedApprovalFlow, type ScratchOrg } from "../testing/fixtures.ts";
import {
  FulfillmentRefusal,
  createPickList,
  getFulfillmentDocument,
  pickCandidates,
  releasePickList,
  voidPickList,
} from "./fulfillment.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function enableFulfillment(orgId: string): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
           || '{"warehousing": true, "fulfillment": true}'::jsonb) where id = ${orgId}`));
}

/** A bin inside the scratch org's MAIN warehouse. */
async function bin(org: ScratchOrg, code: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into stock_locations (id, org_id, location_id, parent_id, code, kind, is_active)
    values (${id}, ${org.orgId}, ${org.locationId}, ${org.stockLocationId}, ${code}, 'bin', true)`));
  return id;
}

/** An issued sales order with one stock line shipping from MAIN. */
async function issuedOrder(org: ScratchOrg, userId: string, number: string, quantity: string, amount: string) {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status,
                             subsidiary_id, subtotal, tax_total, total, created_by)
      values (${orderId}, ${org.orgId}, 'sales_order', ${number}, ${org.customerId}, ${org.date}, 'CAD', 'draft',
              ${org.subsidiaryId}, '0', '0', '0', ${userId})`);
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description,
                                  quantity, unit, unit_price, amount, tax_amount, stock_location_id)
      values (${lineId}, ${org.orgId}, ${orderId}, 1, ${org.items.fifo}, ${org.accounts.revenue}, 'Widget',
              ${quantity}, 'ea', '10', ${amount}, '0', ${org.stockLocationId})`);
    await db.execute(sql`
      update documents set status = 'approved', subtotal = ${amount}, total = ${amount}
       where id = ${orderId} and org_id = ${org.orgId}`);
  });
  return { orderId, lineId };
}

test("pick lists hold bins by name, release through Flows, and stay in their organization", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const other = await withBypassContext(() => createScratchOrg());
  try {
    await enableFulfillment(org.orgId);
    await enableFulfillment(other.orgId);
    const userId = await withBypassContext(() => createScratchUser(org.orgId, "Picker", "admin"));
    const binA = await bin(org, "A1");
    await withBypassContext(() => receiveInventory(org.orgId, userId, {
      itemId: org.items.fifo, stockLocationId: binA, quantity: "10", unitCost: "2",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }));
    const first = await issuedOrder(org, userId, "SO-9001", "8", "80");
    const second = await issuedOrder(org, userId, "SO-9002", "6", "60");
    const pick = (orderId: string, lineId: string, quantity: string) =>
      withOrg(org.orgId, () => db.transaction((tx) => createPickList(tx, org.orgId, userId, {
        salesOrderId: orderId, lines: [{ salesOrderLineId: lineId, binId: binA, quantity }], allowedSubsidiaryIds: null,
      })));
    const release = (orgId: string, pickListId: string) =>
      releasePickList(orgId, userId, { pickListId, allowedSubsidiaryIds: null });

    const held = await pick(first.orderId, first.lineId, "6");
    assert.equal((await release(org.orgId, held.id)).status, "approved");
    const [candidate] = (await withOrg(org.orgId, () => pickCandidates(db, org.orgId, first.orderId, null)))!.lines;
    assert.deepEqual(
      [candidate!.open, candidate!.heldByPickLists, candidate!.pickable, candidate!.bins.map((b) => [b.binCode, b.onHand])].map(String),
      ["8.00000000", "6.00000000", "2.00000000", "A1,10.0000"],
    );
    // The released pick list's 6 is part of the 14 committed: reported as
    // reserved, never subtracted from available a second time.
    const atp = await withOrg(org.orgId, () =>
      getAvailableToPromise(db, org.orgId, { subsidiaryId: org.subsidiaryId, itemId: org.items.fifo }));
    assert.deepEqual([atp.onHand, atp.committed, atp.reserved, atp.available], ["10.0000", "14.0000", "6.0000", "-4.0000"]);

    // A second pick list on the same bin is refused at release, naming the
    // bin, the stock, the pick list holding it and what was requested.
    const blocked = await pick(second.orderId, second.lineId, "6");
    await assert.rejects(release(org.orgId, blocked.id), (error: unknown) => {
      assert.ok(error instanceof FulfillmentRefusal);
      assert.equal(error.code, "bin_short");
      assert.equal(error.status, 409);
      assert.match(error.message, new RegExp(`^Bin A1 holds 10 of .+, 6 reserved by ${held.documentNumber}; ${blocked.documentNumber} requests 6$`));
      assert.match(error.remedy ?? "", /Pick from another bin, receive or transfer stock into this bin, or ship what is available/);
      return true;
    });
    assert.equal(await statusOf(org.orgId, blocked.id), "draft", "a refused release changes nothing");

    // A draft still counts against the order line, so the smaller pick waits
    // for the refused one to be voided; the gated release then pauses.
    await assert.rejects(pick(second.orderId, second.lineId, "4"), { code: "exceeds_open_quantity" });
    await withOrg(org.orgId, () => db.transaction((tx) =>
      voidPickList(tx, org.orgId, userId, { pickListId: blocked.id, reason: "bin short", allowedSubsidiaryIds: null })));
    await withBypassContext(() => seedApprovalFlow(org.orgId, { subjectKind: "pick_list", assignees: [{ type: "submitter" }], mode: "any" }));
    const gated = await pick(second.orderId, second.lineId, "4");
    assert.equal((await release(org.orgId, gated.id)).status, "pending_approval");
    assert.equal(await statusOf(org.orgId, gated.id), "pending_approval");

    // Another organization neither reads nor releases the pick list.
    assert.equal(await withOrg(other.orgId, () => getFulfillmentDocument(db, other.orgId, held.id, null)), null);
    await assert.rejects(release(other.orgId, held.id), { code: "not_found", status: 404 });

    // Once complete, a pick list is final.
    await withBypassContext(() => db.execute(sql`
      update fulfillment_documents set stage = 'done', completed_at = now(), completed_by = ${userId}
       where org_id = ${org.orgId} and document_id = ${held.id}`));
    await assert.rejects(
      withOrg(org.orgId, () => db.transaction((tx) =>
        voidPickList(tx, org.orgId, userId, { pickListId: held.id, reason: "too late", allowedSubsidiaryIds: null }))),
      (error: unknown) => error instanceof FulfillmentRefusal && error.code === "wrong_stage"
        && /is complete and cannot be voided/.test(error.message) && /Void the sales fulfilment/.test(error.remedy ?? ""),
    );
  } finally {
    await dropScratchOrg(other.orgId);
    await dropScratchOrg(org.orgId);
  }
});

async function statusOf(orgId: string, documentId: string): Promise<string> {
  return withBypassContext(async () => (await db.execute<{ status: string }>(sql`
    select status from documents where org_id = ${orgId} and id = ${documentId}`)).rows[0]!.status);
}
