import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sum, toUnits } = await import("@openbooks/engine/src/money/money.ts");
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} = await import("@openbooks/engine/src/testing/fixtures.ts");
import type { ScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
const {
  ConversionError,
  convertOrder,
  receivePurchaseOrder,
  ORDER_CONVERSION_NOTHING_BILLABLE,
  ORDER_LINE_ITEM_WITHOUT_COSTING_PROFILE,
} = await import("./order-cycle.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * A conversion into a bill or invoice must never reduce the payable or
 * receivable without saying so. Stock lines on a purchase order bill only
 * their received-and-unbilled quantity, and on a sales order only their
 * shipped-and-unbilled quantity; anything the new document does not carry
 * is either refused by line with a remedy, or returned and recorded as an
 * explicit shortfall whose amount closes the order total exactly.
 */

type SeedLine = {
  itemId: string | null;
  accountId: string | null;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  amount: string;
  stockLocationId: string | null;
};

async function seedApprovedOrder(
  org: ScratchOrg,
  actorId: string,
  kind: "quote" | "sales_order" | "purchase_order",
  number: string,
  lines: SeedLine[],
): Promise<{ id: string; lineIds: string[] }> {
  const id = randomUUID();
  const totalText = sum(lines.map((line) => line.amount));
  const partyId = kind === "purchase_order" ? org.vendorId : org.customerId;
  const lineIds = lines.map(() => randomUUID());
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, status, subtotal, tax_total, total,
         created_by, updated_by)
      values (
        ${id}, ${org.orgId}, ${kind}, ${number}, ${partyId},
        ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', ${totalText}, '0', ${totalText},
        ${actorId}, ${actorId}
      )
    `);
    for (const [index, line] of lines.entries()) {
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description,
           quantity, unit, quantity_billed, quantity_fulfilled, unit_price, amount,
           tax_input_amount, tax_amount, stock_location_id, created_by, updated_by)
        values (
          ${lineIds[index]}, ${org.orgId}, ${id}, ${index + 1}, ${line.itemId}, ${line.accountId}, ${line.description},
          ${line.quantity}, ${line.unit}, '0', '0', ${line.unitPrice}, ${line.amount},
          ${line.amount}, '0', ${line.stockLocationId}, ${actorId}, ${actorId}
        )
      `);
    }
    await db.execute(sql`
      update documents set status = 'approved', updated_by = ${actorId}
       where id = ${id} and org_id = ${org.orgId}
    `);
  });
  return { id, lineIds };
}

async function seedUnprofiledInventoryItem(org: ScratchOrg, name: string): Promise<string> {
  const itemId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation, income_account_id)
    values (${itemId}, ${org.orgId}, 'inventory', ${name}, false, true, '{}'::jsonb, 'billing', 'normal', ${org.accounts.revenue})
  `));
  return itemId;
}

async function addCostingProfile(org: ScratchOrg, itemId: string, baseUnit: string): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    insert into item_inventory_profiles
      (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
       variance_account_id, received_not_billed_account_id, standard_cost, base_unit, unit_conversions)
    values (${randomUUID()}, ${org.orgId}, ${itemId}, 'fifo', 'none', ${org.accounts.invAsset}, ${org.accounts.cogs},
            ${org.accounts.adjustment}, ${org.accounts.adjustment}, ${org.accounts.clearing}, null, ${baseUnit}, '{}'::jsonb)
  `));
}

async function documentsOf(org: ScratchOrg, kind: string): Promise<Array<{ id: string; total: string }>> {
  return withBypassContext(async () => (await db.execute<{ id: string; total: string }>(sql`
    select id, total::text as total from documents
     where org_id = ${org.orgId} and kind = ${kind}
     order by created_at, id
  `)).rows);
}

async function linesOf(org: ScratchOrg, documentId: string): Promise<Array<{ quantity: string; amount: string; quantity_billed: string }>> {
  return withBypassContext(async () => (await db.execute<{ quantity: string; amount: string; quantity_billed: string }>(sql`
    select quantity::text as quantity, amount::text as amount, quantity_billed::text as quantity_billed
      from document_lines
     where org_id = ${org.orgId} and document_id = ${documentId}
     order by line_number
  `)).rows);
}

function refusal(code: string, message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ConversionError, `expected a ConversionError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  };
}

test("a purchase-order bill never drops an inventory line: refused without a costing profile, withheld explicitly until received", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Payables Clerk", "admin"));
    const steel = await seedUnprofiledInventoryItem(org, "Steel rod");
    const po = await seedApprovedOrder(org, actorId, "purchase_order", "PO-SHORTFALL-1", [
      { itemId: steel, accountId: org.accounts.invAsset, description: "Steel rod", quantity: "3648", unit: "lb", unitPrice: "4.85", amount: "17692.80", stockLocationId: org.stockLocationId },
      { itemId: null, accountId: org.accounts.adjustment, description: "Freight", quantity: "1", unit: null, unitPrice: "640", amount: "640", stockLocationId: null },
    ]);
    const orderTotal = toUnits("18332.80");

    // ---- No costing profile: refused by line, exactly like the receipt ----
    await assert.rejects(
      convertOrder(org.orgId, actorId, po.id, "vendor_bill"),
      refusal(
        ORDER_LINE_ITEM_WITHOUT_COSTING_PROFILE,
        /^Purchase-order line 1 \(Steel rod\) is an inventory item without a costing profile, so it cannot be received or billed — add a costing profile to the item, receive the line, then convert to a bill again$/,
      ),
    );
    await assert.rejects(
      convertOrder(org.orgId, actorId, po.id, "purchase_receipt"),
      /Purchase-order line 1 is an inventory item without a costing profile/,
    );
    assert.equal((await documentsOf(org, "vendor_bill")).length, 0, "a refused conversion creates no bill");
    assert.deepEqual((await linesOf(org, po.id)).map((line) => toUnits(line.quantity_billed)), [0n, 0n]);

    // ---- Profiled but unreceived: the bill carries freight and says so ----
    await addCostingProfile(org, steel, "lb");
    const first = await convertOrder(org.orgId, actorId, po.id, "vendor_bill");
    assert.equal(first.kind, "vendor_bill");
    assert.ok(first.withheldLines, "a partial bill must report what it left on the order");
    assert.equal(first.withheldLines.length, 1);
    const withheld = first.withheldLines[0]!;
    assert.equal(withheld.lineNumber, 1);
    assert.equal(withheld.sourceLineId, po.lineIds[0]);
    assert.equal(withheld.itemName, "Steel rod");
    assert.equal(withheld.reason, "awaiting_receipt");
    assert.equal(toUnits(withheld.orderedQuantity), toUnits("3648"));
    assert.equal(toUnits(withheld.fulfilledQuantity), 0n);
    assert.equal(toUnits(withheld.convertedQuantity), 0n);
    assert.equal(toUnits(withheld.withheldQuantity), toUnits("3648"));
    assert.equal(toUnits(withheld.withheldAmount), toUnits("17692.80"));
    assert.equal(toUnits(first.withheldTotal ?? "0"), toUnits("17692.80"));

    const bills = await documentsOf(org, "vendor_bill");
    assert.equal(bills.length, 1);
    assert.equal(toUnits(bills[0]!.total), toUnits("640"));
    assert.equal(toUnits(bills[0]!.total) + toUnits(first.withheldTotal ?? "0"), orderTotal, "bill plus explicit shortfall equals the order total");
    const evidence = await withBypassContext(async () => (await db.execute<{ custom: { conversionShortfall?: { withheldLines: unknown[]; withheldTotal: string } } }>(sql`
      select custom from documents where id = ${first.id} and org_id = ${org.orgId}
    `)).rows[0]!);
    assert.equal(evidence.custom.conversionShortfall?.withheldLines.length, 1, "the bill records the line it does not carry");
    const audit = await withBypassContext(async () => (await db.execute<{ changes: { mode: string; withheldTotal: string; withheldLines: unknown[] }; actor_id: string }>(sql`
      select changes, actor_id from audit_log
       where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${first.id}
         and changes->>'mode' = 'order_converted'
    `)).rows);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor_id, actorId);
    assert.equal(toUnits(audit[0]!.changes.withheldTotal), toUnits("17692.80"));
    assert.deepEqual((await linesOf(org, po.id)).map((line) => toUnits(line.quantity_billed)), [0n, toUnits("1")], "the steel stays open on the order");

    // ---- Replay: nothing billable left, refused by line; no second bill ----
    await assert.rejects(
      convertOrder(org.orgId, actorId, po.id, "vendor_bill"),
      refusal(
        ORDER_CONVERSION_NOTHING_BILLABLE,
        /^Received quantities do not cover any line yet: purchase-order line 1 \(Steel rod\) has 3648 open to bill and 0 received — record the goods receipt \(Convert to Goods receipt\), then convert to a bill$/,
      ),
    );
    assert.equal((await documentsOf(org, "vendor_bill")).length, 1, "a replayed conversion never mints a duplicate bill");

    // ---- Partial receipt: bill the received part, report the remainder ----
    await withBypassContext(() => receivePurchaseOrder(org.orgId, actorId, po.id, {
      receiptDate: org.date,
      idempotencyKey: "shortfall-receipt-1000",
      lines: [{ sourceLineId: po.lineIds[0]!, quantity: "1000" }],
    }));
    const second = await convertOrder(org.orgId, actorId, po.id, "vendor_bill");
    const secondLines = await linesOf(org, second.id);
    assert.equal(secondLines.length, 1);
    assert.equal(toUnits(secondLines[0]!.quantity), toUnits("1000"));
    assert.equal(toUnits(secondLines[0]!.amount), toUnits("4850"));
    assert.equal(second.withheldLines?.length, 1);
    assert.equal(toUnits(second.withheldLines![0]!.fulfilledQuantity), toUnits("1000"));
    assert.equal(toUnits(second.withheldLines![0]!.previouslyBilledQuantity), 0n);
    assert.equal(toUnits(second.withheldLines![0]!.withheldQuantity), toUnits("2648"));
    assert.equal(toUnits(second.withheldTotal ?? "0"), toUnits("12842.80"));

    // ---- Final receipt: the last bill closes the order exactly ----
    await withBypassContext(() => receivePurchaseOrder(org.orgId, actorId, po.id, {
      receiptDate: org.date,
      idempotencyKey: "shortfall-receipt-2648",
      lines: [{ sourceLineId: po.lineIds[0]!, quantity: "2648" }],
    }));
    const third = await convertOrder(org.orgId, actorId, po.id, "vendor_bill");
    assert.equal(third.withheldLines, undefined, "a complete conversion reports no shortfall");
    const billed = (await documentsOf(org, "vendor_bill")).reduce((acc, bill) => acc + toUnits(bill.total), 0n);
    assert.equal(billed, orderTotal, "every bill together equals the purchase-order total");
    await assert.rejects(convertOrder(org.orgId, actorId, po.id, "vendor_bill"), /Every line is already fully converted/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a sales-order invoice reports unshipped stock and refuses an uncosted inventory line", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billing Clerk", "admin"));
    const so = await seedApprovedOrder(org, actorId, "sales_order", "SO-SHORTFALL-1", [
      { itemId: org.items.fifo, accountId: org.accounts.revenue, description: "FIFO Widget", quantity: "5", unit: "ea", unitPrice: "20", amount: "100", stockLocationId: org.stockLocationId },
      { itemId: null, accountId: org.accounts.revenue, description: "Installation", quantity: "1", unit: null, unitPrice: "100", amount: "100", stockLocationId: null },
    ]);
    const invoice = await convertOrder(org.orgId, actorId, so.id, "customer_invoice");
    assert.deepEqual(
      (await linesOf(org, invoice.id)).map((line) => [toUnits(line.quantity), toUnits(line.amount)]),
      [[toUnits("1"), toUnits("100")]],
      "only the service line is invoiced before shipment",
    );
    assert.equal(invoice.withheldLines?.length, 1);
    assert.equal(invoice.withheldLines![0]!.reason, "awaiting_shipment");
    assert.equal(toUnits(invoice.withheldLines![0]!.withheldQuantity), toUnits("5"));
    const invoiceTotal = (await documentsOf(org, "customer_invoice"))[0]!.total;
    assert.equal(toUnits(invoiceTotal) + toUnits(invoice.withheldTotal ?? "0"), toUnits("200"));
    await assert.rejects(
      convertOrder(org.orgId, actorId, so.id, "customer_invoice"),
      refusal(ORDER_CONVERSION_NOTHING_BILLABLE, /^Shipped quantities do not cover any line yet: sales-order line 1 \(FIFO Widget\) has 5 open to bill and 0 shipped — fulfill the order/),
    );
    assert.equal((await documentsOf(org, "customer_invoice")).length, 1);

    const bare = await seedUnprofiledInventoryItem(org, "Loose gasket");
    const uncosted = await seedApprovedOrder(org, actorId, "sales_order", "SO-SHORTFALL-2", [
      { itemId: null, accountId: org.accounts.revenue, description: "Installation", quantity: "1", unit: null, unitPrice: "100", amount: "100", stockLocationId: null },
      { itemId: bare, accountId: org.accounts.revenue, description: "Loose gasket", quantity: "2", unit: "ea", unitPrice: "5", amount: "10", stockLocationId: org.stockLocationId },
    ]);
    await assert.rejects(
      convertOrder(org.orgId, actorId, uncosted.id, "customer_invoice"),
      refusal(ORDER_LINE_ITEM_WITHOUT_COSTING_PROFILE, /^Sales-order line 2 \(Loose gasket\) is an inventory item without a costing profile, so it cannot be shipped or invoiced — add a costing profile to the item, fulfill the line, then convert to an invoice again$/),
    );
    assert.equal((await documentsOf(org, "customer_invoice")).length, 1, "the refused order creates no invoice");
    assert.deepEqual((await linesOf(org, uncosted.id)).map((line) => toUnits(line.quantity_billed)), [0n, 0n]);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an estimate converts every line to an invoice and refuses an uncosted inventory line", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Estimator", "admin"));
    const quote = await seedApprovedOrder(org, actorId, "quote", "EST-SHORTFALL-1", [
      { itemId: org.items.fifo, accountId: org.accounts.revenue, description: "FIFO Widget", quantity: "3", unit: "ea", unitPrice: "20", amount: "60", stockLocationId: org.stockLocationId },
      { itemId: null, accountId: org.accounts.revenue, description: "Installation", quantity: "1", unit: null, unitPrice: "100", amount: "100", stockLocationId: null },
    ]);
    const invoice = await convertOrder(org.orgId, actorId, quote.id, "customer_invoice");
    assert.equal(invoice.withheldLines, undefined, "estimates bill on the ordered remainder");
    assert.deepEqual(
      (await linesOf(org, invoice.id)).map((line) => [toUnits(line.quantity), toUnits(line.amount)]),
      [[toUnits("3"), toUnits("60")], [toUnits("1"), toUnits("100")]],
    );
    assert.equal(toUnits((await documentsOf(org, "customer_invoice"))[0]!.total), toUnits("160"), "the invoice equals the estimate total");
    await assert.rejects(convertOrder(org.orgId, actorId, quote.id, "customer_invoice"), /Every line is already fully converted/);

    const bare = await seedUnprofiledInventoryItem(org, "Loose gasket");
    const uncosted = await seedApprovedOrder(org, actorId, "quote", "EST-SHORTFALL-2", [
      { itemId: bare, accountId: org.accounts.revenue, description: "Loose gasket", quantity: "2", unit: "ea", unitPrice: "5", amount: "10", stockLocationId: org.stockLocationId },
    ]);
    await assert.rejects(
      convertOrder(org.orgId, actorId, uncosted.id, "customer_invoice"),
      refusal(ORDER_LINE_ITEM_WITHOUT_COSTING_PROFILE, /^Estimate line 1 \(Loose gasket\) is an inventory item without a costing profile, so it cannot be invoiced — add a costing profile to the item, then convert again$/),
    );
    assert.equal((await documentsOf(org, "customer_invoice")).length, 1);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
