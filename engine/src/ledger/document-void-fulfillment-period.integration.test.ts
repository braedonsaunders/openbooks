import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { DocumentVoidError, requestDocumentVoid } from "./document-void.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import {
  createOrderDraft,
  fulfillSalesOrder,
  receivePurchaseOrder,
} from "../../../web/lib/order-cycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const REASON = "customer cancelled before dispatch";

async function seedShipment(): Promise<{
  orgId: string;
  actorId: string;
  date: string;
  openDate: string;
  salesOrderId: string;
  salesLineId: string;
  fulfillmentId: string;
}> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Void Clerk", "admin");
  const purchase = await createOrderDraft(org.orgId, actorId, "purchase_order", randomUUID(), null);
  const poLineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (${poLineId}, ${org.orgId}, ${purchase.id}, 1, ${org.items.fifo}, ${org.accounts.invAsset},
            'Widget', '10', 'ea', '2', '20', '0', '0', '0', ${org.stockLocationId}, '{}'::jsonb)`);
  await db.execute(sql`
    update documents set status = 'approved', party_id = ${org.vendorId}, subsidiary_id = ${org.subsidiaryId},
           document_date = ${org.date}, subtotal = '20', total = '20'
     where id = ${purchase.id} and org_id = ${org.orgId}`);
  await receivePurchaseOrder(org.orgId, actorId, purchase.id, {
    receiptDate: org.date,
    idempotencyKey: randomUUID(),
    lines: [{ sourceLineId: poLineId, quantity: "10" }],
  });
  const sales = await createOrderDraft(org.orgId, actorId, "sales_order", randomUUID(), null);
  const salesLineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (${salesLineId}, ${org.orgId}, ${sales.id}, 1, ${org.items.fifo}, ${org.accounts.revenue},
            'Widget', '4', 'ea', '5', '20', '0', '0', '0', ${org.stockLocationId}, '{}'::jsonb)`);
  await db.execute(sql`
    update documents set status = 'approved', party_id = ${org.customerId}, subsidiary_id = ${org.subsidiaryId},
           document_date = ${org.date}, subtotal = '20', total = '20'
     where id = ${sales.id} and org_id = ${org.orgId}`);
  const fulfillment = await fulfillSalesOrder(org.orgId, actorId, sales.id, {
    fulfillmentDate: org.date,
    idempotencyKey: randomUUID(),
    lines: [{ sourceLineId: salesLineId, quantity: "4" }],
  });
  // A later open period, then the shipment's own period closes for receivables.
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
       starts_on, ends_on, is_adjustment, custom)
    select ${randomUUID()}, ${org.orgId}, fiscal_calendar_id,
           2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, '{}'::jsonb
      from accounting_periods where id = ${org.periodId}`);
  await setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "ar",
    state: "closed",
    actorId,
    reason: "closed-period void control",
  });
  return {
    orgId: org.orgId,
    actorId,
    date: org.date,
    openDate: "2026-08-15",
    salesOrderId: sales.id,
    salesLineId,
    fulfillmentId: fulfillment.id,
  };
}

async function shipmentState(orgId: string, fulfillmentId: string, salesLineId: string) {
  return (
    await db.execute<{ status: string; shipped: string; reversals: number }>(
      sql`
    select (select status from documents where id = ${fulfillmentId}) as status,
           (select quantity_fulfilled::text from document_lines where id = ${salesLineId}) as shipped,
           (select count(*)::int from inventory_movements reversal
             join inventory_movements movement
               on movement.id = reversal.reverses_movement_id and movement.org_id = reversal.org_id
             join document_lines line on line.id = movement.document_line_id and line.org_id = movement.org_id
            where reversal.org_id = ${orgId} and line.document_id = ${fulfillmentId}
              and reversal.kind = 'return' and reversal.status = 'posted') as reversals
  `,
      "objects",
    )
  )[0]!;
}

/**
 * A shipment void dated inside a closed receivables period refuses with
 * the same typed closed-period refusal as a goods receipt — one shared
 * fence for both order-shipment unwinds — and voids nothing.
 */
test(
  "a fulfillment void in a closed period refuses typed and voids nothing",
  { skip: !DB },
  async () => {
    const seed = await seedShipment();
    try {
      const failure = await requestDocumentVoid({
        documentId: seed.fulfillmentId,
        orgId: seed.orgId,
        actorId: seed.actorId,
        reason: REASON,
        reversalDate: seed.date,
      }).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(failure instanceof DocumentVoidError, "the closed period blocks the void");
      assert.equal(failure.code, "reversal-period-closed");
      assert.match(failure.message, /reversal period for .* is closed/);
      const after = await shipmentState(seed.orgId, seed.fulfillmentId, seed.salesLineId);
      assert.equal(after.status, "approved", "the refused shipment stays voidable");
      assert.equal(after.reversals, 0, "the refused void reverses nothing");
      assert.equal(toUnits(after.shipped), toUnits("4"), "the sales order keeps its shipped cover");
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * The same shipment voids with an open-period reversal date: the refusal
 * is date-dependent, and the sales order is shippable again.
 */
test("the same shipment voids with an open-period reversal date", { skip: !DB }, async () => {
  const seed = await seedShipment();
  try {
    const outcome = await requestDocumentVoid({
      documentId: seed.fulfillmentId,
      orgId: seed.orgId,
      actorId: seed.actorId,
      reason: REASON,
      reversalDate: seed.openDate,
    });
    assert.equal(outcome.status, "voided");
    const after = await shipmentState(seed.orgId, seed.fulfillmentId, seed.salesLineId);
    assert.equal(after.status, "voided");
    assert.equal(after.reversals, 1);
    assert.equal(toUnits(after.shipped), toUnits("0"), "the sales order is shippable again");
  } finally {
    await dropScratchOrg(seed.orgId);
  }
});
