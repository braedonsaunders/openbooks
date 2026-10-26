import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { getOnHand } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import { loadDocumentInventoryLines } from "./document-lines.ts";
import { applyPurchaseReceiptInventory } from "./documents-purchasing.ts";
import {
  applyInventoryIssuesForInvoice,
  applySalesFulfillmentInventoryIssues,
} from "./documents-sales.ts";
import { applyInventoryReturnsForCustomerCredit } from "./documents-customer-credits.ts";
import { applyInventoryReturnsForVendorCredit } from "./documents-vendor-credits.ts";

import { toUnits } from "../money/money.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Unit identity is one shared rule, not string equality per movement path.
 * Every document-driven stock movement loads its lines through
 * loadDocumentInventoryLines, which folds unit spellings through
 * normalizeInventoryUnit before converting to the item's base unit — so a
 * line raised as "Each" against a base unit of "ea" posts 1:1 whether it
 * arrives as a receipt, a fulfilment, a shipment leg, a return, a cash
 * sale, or an invoice. A genuinely unmapped unit still refuses naming the
 * line. One test per movement kind below pins that shared rule at each
 * kind's own applier.
 */

type StockKind =
  | "purchase_receipt"
  | "sales_fulfillment"
  | "customer_invoice"
  | "cash_sale"
  | "customer_credit"
  | "vendor_credit";

async function seedDocument(
  org: ScratchOrg,
  kind: StockKind,
  line: {
    quantity: string;
    unit: string | null;
    unitPrice: string;
    amount: string;
    custom?: Record<string, unknown>;
  },
): Promise<{ documentId: string; lineId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  const partyId =
    kind === "vendor_credit"
      ? org.vendorId
      : kind === "purchase_receipt"
        ? org.vendorId
        : org.customerId;
  // Goods-receipt and fulfilment legs name their source order line; the
  // alias rule is about the unit spelling, so any stable identity does.
  const evidence =
    kind === "purchase_receipt"
      ? { receipt: { sourceLineId: randomUUID() } }
      : kind === "sales_fulfillment"
        ? { fulfillment: { sourceLineId: randomUUID() } }
        : {};
  const custom = { ...evidence, ...(line.custom ?? {}) };
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values (${documentId}, ${org.orgId}, ${kind},
            ${`ALIAS-${documentId.slice(0, 8)}`}, ${partyId}, ${org.subsidiaryId},
            ${org.date}, ${org.date}, 'CAD', 1, 'draft',
            ${line.amount}, '0', ${line.amount}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.fifo},
            ${org.accounts.revenue},
            ${line.quantity}, ${line.unit}, ${line.unitPrice}, ${line.amount},
            '0', false, '0', '0', ${org.stockLocationId},
            ${JSON.stringify(custom)}::jsonb, false)`);
  await db.execute(sql`
    update documents set status = 'approved'
     where id = ${documentId} and org_id = ${org.orgId}`);
  return { documentId, lineId };
}

async function stockUp(org: ScratchOrg, quantity = "10"): Promise<void> {
  await receiveInventory(org.orgId, null, {
    itemId: org.items.fifo,
    stockLocationId: org.stockLocationId,
    quantity,
    unitCost: "2",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
}

async function movementQuantity(
  orgId: string,
  lineId: string,
  kind: string,
): Promise<string | null> {
  const row = (
    await db.execute<{ quantity: string }>(
      sql`
    select quantity::text as quantity from inventory_movements
     where org_id = ${orgId} and document_line_id = ${lineId} and kind = ${kind}
     order by created_at desc limit 1`,
      "objects",
    )
  )[0];
  return row?.quantity ?? null;
}

async function onHand(org: ScratchOrg): Promise<string> {
  return (await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity;
}

test("a receipt line raised in an aliased unit receives 1:1", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { documentId, lineId } = await seedDocument(org, "purchase_receipt", {
      quantity: "10",
      unit: "Each",
      unitPrice: "2",
      amount: "20",
    });
    const count = await db.transaction((tx) =>
      applyPurchaseReceiptInventory(tx, org.orgId, null, documentId, org.date, org.subsidiaryId),
    );
    assert.equal(count, 1);
    assert.equal(
      toUnits((await movementQuantity(org.orgId, lineId, "receipt")) ?? "missing"),
      toUnits("10"),
    );
    assert.equal(toUnits(await onHand(org)), toUnits("10"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a fulfilment line raised in an aliased unit issues 1:1", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await stockUp(org);
    const { documentId, lineId } = await seedDocument(org, "sales_fulfillment", {
      quantity: "10",
      unit: "Each",
      unitPrice: "0",
      amount: "0",
    });
    const count = await db.transaction((tx) =>
      applySalesFulfillmentInventoryIssues(
        tx,
        org.orgId,
        null,
        documentId,
        org.date,
        org.subsidiaryId,
      ),
    );
    assert.equal(count, 1);
    // Issues relieve stock: the movement carries the base quantity with a
    // negative sign, converted 1:1 from the aliased line unit.
    assert.equal(
      toUnits((await movementQuantity(org.orgId, lineId, "issue")) ?? "missing"),
      toUnits("-10"),
    );
    assert.equal(toUnits(await onHand(org)), toUnits("0"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "a shipment leg raised in an aliased unit loads at the base quantity",
  { skip: !DB },
  async () => {
    // Shipment completion records its legs as sales fulfilments through the
    // same applier above; this pins the shared loader for the leg shape.
    const org = await createScratchOrg();
    try {
      const { documentId } = await seedDocument(org, "sales_fulfillment", {
        quantity: "10",
        unit: "Each",
        unitPrice: "0",
        amount: "0",
        custom: { fulfillment: { sourceLineId: randomUUID() } },
      });
      const loaded = await loadDocumentInventoryLines(db, org.orgId, documentId);
      assert.equal(loaded.length, 1);
      assert.equal(
        toUnits(loaded[0]!.quantity),
        toUnits("10"),
        "the alias converts 1:1 to the base unit",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("an invoice line raised in an aliased unit issues 1:1", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await stockUp(org);
    const { documentId, lineId } = await seedDocument(org, "customer_invoice", {
      quantity: "10",
      unit: "Each",
      unitPrice: "25",
      amount: "250",
    });
    const count = await applyInventoryIssuesForInvoice(
      org.orgId,
      null,
      documentId,
      org.date,
      org.subsidiaryId,
    );
    assert.equal(count, 1);
    // Issues relieve stock: the movement carries the base quantity with a
    // negative sign, converted 1:1 from the aliased line unit.
    assert.equal(
      toUnits((await movementQuantity(org.orgId, lineId, "issue")) ?? "missing"),
      toUnits("-10"),
    );
    assert.equal(toUnits(await onHand(org)), toUnits("0"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a cash-sale line raised in an aliased unit issues 1:1", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await stockUp(org);
    const { documentId, lineId } = await seedDocument(org, "cash_sale", {
      quantity: "10",
      unit: "Each",
      unitPrice: "25",
      amount: "250",
    });
    const count = await applyInventoryIssuesForInvoice(
      org.orgId,
      null,
      documentId,
      org.date,
      org.subsidiaryId,
    );
    assert.equal(count, 1);
    // Issues relieve stock: the movement carries the base quantity with a
    // negative sign, converted 1:1 from the aliased line unit.
    assert.equal(
      toUnits((await movementQuantity(org.orgId, lineId, "issue")) ?? "missing"),
      toUnits("-10"),
    );
    assert.equal(toUnits(await onHand(org)), toUnits("0"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a sales-return line raised in an aliased unit restores 1:1", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await stockUp(org);
    const shipment = await seedDocument(org, "customer_invoice", {
      quantity: "10",
      unit: "ea",
      unitPrice: "25",
      amount: "250",
    });
    const issueCount = await applyInventoryIssuesForInvoice(
      org.orgId,
      null,
      shipment.documentId,
      org.date,
      org.subsidiaryId,
    );
    assert.equal(issueCount, 1);
    const issue = (
      await db.execute<{ id: string }>(
        sql`
      select id from inventory_movements
       where org_id = ${org.orgId} and document_line_id = ${shipment.lineId} and kind = 'issue'`,
        "objects",
      )
    )[0];
    assert.ok(issue, "the shipment must issue before it can be returned");
    const credit = await seedDocument(org, "customer_credit", {
      quantity: "10",
      unit: "Each",
      unitPrice: "25",
      amount: "250",
      custom: { inventoryReturn: { sourceIssueMovementId: issue.id } },
    });
    const count = await applyInventoryReturnsForCustomerCredit(
      org.orgId,
      null,
      credit.documentId,
      org.date,
      org.subsidiaryId,
    );
    assert.equal(count, 1);
    assert.equal(
      toUnits((await movementQuantity(org.orgId, credit.lineId, "receipt")) ?? "missing"),
      toUnits("10"),
    );
    assert.equal(toUnits(await onHand(org)), toUnits("10"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a purchase-return line raised in an aliased unit relieves 1:1", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const receipt = await seedDocument(org, "purchase_receipt", {
      quantity: "10",
      unit: "ea",
      unitPrice: "2",
      amount: "20",
    });
    const receiptCount = await db.transaction((tx) =>
      applyPurchaseReceiptInventory(
        tx,
        org.orgId,
        null,
        receipt.documentId,
        org.date,
        org.subsidiaryId,
      ),
    );
    assert.equal(receiptCount, 1);
    const receiptMovement = (
      await db.execute<{ id: string }>(
        sql`
      select id from inventory_movements
       where org_id = ${org.orgId} and document_line_id = ${receipt.lineId} and kind = 'receipt'`,
        "objects",
      )
    )[0];
    assert.ok(receiptMovement, "the receipt must post before it can be returned");
    const credit = await seedDocument(org, "vendor_credit", {
      quantity: "10",
      unit: "Each",
      unitPrice: "2",
      amount: "20",
      custom: { inventoryReturn: { sourceReceiptMovementId: receiptMovement.id } },
    });
    const count = await applyInventoryReturnsForVendorCredit(
      org.orgId,
      null,
      credit.documentId,
      org.date,
      org.subsidiaryId,
    );
    assert.equal(count, 1);
    assert.equal(
      toUnits((await movementQuantity(org.orgId, credit.lineId, "return")) ?? "missing"),
      toUnits("-10"),
    );
    assert.equal(toUnits(await onHand(org)), toUnits("0"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a genuinely unmapped unit still refuses on every document kind", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await stockUp(org);
    const invoice = await seedDocument(org, "customer_invoice", {
      quantity: "10",
      unit: "crate",
      unitPrice: "25",
      amount: "250",
    });
    await assert.rejects(
      applyInventoryIssuesForInvoice(
        org.orgId,
        null,
        invoice.documentId,
        org.date,
        org.subsidiaryId,
      ),
      /unit "crate" with no conversion to the item's base unit "ea"/,
    );
    assert.equal(await movementQuantity(org.orgId, invoice.lineId, "issue"), null);
    assert.equal(toUnits(await onHand(org)), toUnits("10"), "a refused issue moves nothing");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
