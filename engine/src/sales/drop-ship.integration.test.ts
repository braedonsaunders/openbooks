import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { getAvailableToPromise } from "../inventory/availability.ts";
import { toUnits } from "../money/money.ts";
import { salesOrderLineRemainders } from "../records/order-line-remainders.ts";
import { backorderPosition } from "./backorders.ts";
import { DropShipRefusal, routeDropShipLine, unrouteDropShipLine } from "./drop-ship.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("drop-ship routing refuses invalid lines and removes routed demand from stock views", { skip: !DB }, async () => {
  // bypass: cross-org-by-design — createScratchOrg initializes an organization before its tenant context exists.
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Drop-ship Clerk", "admin"));
    const orderId = randomUUID();
    const lineId = randomUUID();
    const serviceOrderId = randomUUID();
    const serviceLineId = randomUUID();
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
          || '{"orders":true,"inventory":true,"warehousing":true,"fulfillment":true,"dropShipping":true}'::jsonb)
         where id = ${org.orgId}`);
      for (const [id, number, itemId, quantity] of [
        [orderId, "DS-SO-1", org.items.fifo, "4"],
        [serviceOrderId, "DS-SO-2", org.items.service, "1"],
      ] as const) {
        await db.execute(sql`
          insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency, status)
          values (${id}, ${org.orgId}, 'sales_order', ${number}, ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft')`);
        await db.execute(sql`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, description, quantity, unit, unit_price, amount, tax_amount, stock_location_id)
          values (${id === orderId ? lineId : serviceLineId}, ${org.orgId}, ${id}, 1, ${itemId}, 'Item', ${quantity}, 'ea', '10', '40', '0', ${org.stockLocationId})`);
        await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${id}`);
      }
    });

    const input = { orgId: org.orgId, actorId, salesOrderId: orderId, salesOrderLineId: lineId, allowedSubsidiaryIds: null };
    await withOrgContext(org.orgId, () => assert.rejects(
      routeDropShipLine({ ...input, salesOrderId: serviceOrderId, salesOrderLineId: serviceLineId }),
      (error: unknown) => error instanceof DropShipRefusal && error.code === "not_a_stock_line" && Boolean(error.remedy),
    ));
    await withOrgContext(org.orgId, () => routeDropShipLine(input));
    await withOrgContext(org.orgId, () => assert.rejects(
      routeDropShipLine(input),
      (error: unknown) => error instanceof DropShipRefusal && error.code === "already_routed" && Boolean(error.remedy),
    ));
    assert.deepEqual(await withOrgContext(org.orgId, () => salesOrderLineRemainders(db, org.orgId, { lineId })), []);
    assert.deepEqual(await withOrgContext(org.orgId, () => backorderPosition(db, org.orgId, { documentId: orderId, allowedSubsidiaryIds: null })), []);
    assert.equal(toUnits((await withOrgContext(org.orgId, () => getAvailableToPromise(db, org.orgId, {
      itemId: org.items.fifo,
      subsidiaryId: org.subsidiaryId,
    }))).committed), toUnits("0"));

    await withOrgContext(org.orgId, () => unrouteDropShipLine(input));
    assert.equal((await withOrgContext(org.orgId, () => salesOrderLineRemainders(db, org.orgId, { lineId }))).length, 1);
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update documents set status = 'draft' where id = ${orderId} and org_id = ${org.orgId}`);
      await db.execute(sql`update document_lines set quantity_fulfilled = '1' where id = ${lineId} and org_id = ${org.orgId}`);
      await db.execute(sql`update documents set status = 'approved' where id = ${orderId} and org_id = ${org.orgId}`);
    });
    await withOrgContext(org.orgId, () => assert.rejects(
      routeDropShipLine(input),
      (error: unknown) => error instanceof DropShipRefusal && error.code === "already_fulfilled" && Boolean(error.remedy),
    ));
  } finally {
    await withOrgContext(org.orgId, () => dropScratchOrg(org.orgId));
  }
});
