import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { floorKitQuantity, kitAvailableFromComponents } from "./kits.ts";
import { getAvailableToPromise } from "./availability.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { adjustInventory, receiveInventory } from "./movements.ts";
import { getOnHand } from "./position.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const run = <T>(work: () => Promise<T>) => withBypassContext(work);

/**
 * Live-Postgres: kits sell as virtual bundles of their components.
 *
 * A `kit` item holds no stock of its own — shipping one issues each
 * component at line quantity × recipe quantity, availability divides every
 * component's stock by its recipe quantity and takes the minimum, and a
 * return restores each component at the cost its units left at. Revenue
 * stays on the kit line; allocation of revenue to components is out of
 * scope.
 */

const depsFor = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function glBalance(orgId: string, accountId: string): Promise<string> {
  return (await db.execute<{ balance: string }>(sql`
    select coalesce(sum(amount), 0)::text as balance
      from journal_lines
     where org_id = ${orgId} and account_id = ${accountId}
  `)).rows[0]!.balance;
}

async function stockedComponent(org: ScratchOrg, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation, income_account_id)
    values (${id}, ${org.orgId}, 'inventory', ${name}, false, true, '{}'::jsonb, 'billing', 'normal', ${org.accounts.revenue})`);
  await db.execute(sql`
    insert into item_inventory_profiles
      (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
       variance_account_id, received_not_billed_account_id, standard_cost, base_unit, unit_conversions)
    values (${randomUUID()}, ${org.orgId}, ${id}, 'fifo', 'none', ${org.accounts.invAsset}, ${org.accounts.cogs},
            ${org.accounts.adjustment}, ${org.accounts.adjustment}, ${org.accounts.clearing}, null, 'ea', '{}'::jsonb)`);
  return id;
}

async function kitItem(org: ScratchOrg, name: string, components: { itemId: string; quantityPer: string }[]): Promise<string> {
  const id = await stockedComponent(org, name);
  await db.execute(sql`update items set kind = 'kit' where id = ${id} and org_id = ${org.orgId}`);
  let sortOrder = 0;
  for (const component of components) {
    await db.execute(sql`
      insert into bom_components (id, org_id, assembly_item_id, component_item_id, quantity_per, sort_order)
      values (${randomUUID()}, ${org.orgId}, ${id}, ${component.itemId}, ${component.quantityPer}, ${sortOrder})`);
    sortOrder += 1;
  }
  return id;
}

async function receive(org: ScratchOrg, itemId: string, quantity: string, unitCost: string): Promise<void> {
  await receiveInventory(org.orgId, null, {
    itemId,
    stockLocationId: org.stockLocationId,
    quantity,
    unitCost,
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
}

/** Post a standalone invoice carrying one kit line; its posting explodes the kit. */
async function postKitInvoice(
  org: ScratchOrg,
  input: { kitId: string; quantity: string; unitPrice: string; amount: string },
): Promise<{ documentId: string; lineId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values
      (${documentId}, ${org.orgId}, 'customer_invoice',
       ${`INV-KIT-${documentId.slice(0, 8)}`}, ${org.customerId}, ${org.subsidiaryId},
       ${org.date}, ${org.date}, 'CAD', 1, 'draft', ${input.amount}, '0',
       ${input.amount}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
    values
      (${lineId}, ${org.orgId}, ${documentId}, 1, ${input.kitId},
       ${org.accounts.revenue}, ${input.quantity}, ${input.unitPrice},
       ${input.amount}, '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`);
  await db.execute(sql`
    update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  await postDocument(documentId, depsFor(org));
  return { documentId, lineId };
}

async function kitIssueMovements(orgId: string, lineId: string): Promise<{ id: string; item_id: string; quantity: string; total_value: string; idempotency_key: string }[]> {
  return (await db.execute<{ id: string; item_id: string; quantity: string; total_value: string; idempotency_key: string }>(sql`
    select id, item_id, quantity::text as quantity, total_value::text as total_value, idempotency_key
      from inventory_movements
     where org_id = ${orgId} and document_line_id = ${lineId} and kind = 'issue'
     order by item_id`)).rows;
}

test("kit quantities floor to whole kits", () => {
  assert.equal(floorKitQuantity("8.0000", "2.0000"), "4.0000");
  assert.equal(floorKitQuantity("7.0000", "2.0000"), "3.0000");
  assert.equal(floorKitQuantity("0.0000", "1.0000"), "0.0000");
  assert.equal(floorKitQuantity("-1.0000", "2.0000"), "-1.0000");
  assert.throws(() => floorKitQuantity("4.0000", "0.0000"), /recipe quantity must be positive/);
  assert.equal(
    kitAvailableFromComponents([
      { quantityPer: "1.0000", available: "8.0000" },
      { quantityPer: "2.0000", available: "6.0000" },
    ]),
    "3.0000",
  );
});

test(
  "shipping a kit issues its components with correct costs, never the kit",
  { skip: !DB },
  async () => {
    const org = await run(() => createScratchOrg());
    try {
      await run(async () => {
        const kettle = await stockedComponent(org, "Kettle");
        const mug = await stockedComponent(org, "Mug");
        const starter = await kitItem(org, "Starter set", [
          { itemId: kettle, quantityPer: "1.0000" },
          { itemId: mug, quantityPer: "2.0000" },
        ]);
        await receive(org, kettle, "10", "4");
        await receive(org, mug, "10", "6");

        const sale = await postKitInvoice(org, { kitId: starter, quantity: "2", unitPrice: "25", amount: "50" });
        const issues = await kitIssueMovements(org.orgId, sale.lineId);
        assert.equal(issues.length, 2);
        assert.ok(issues.every((issue) => issue.item_id !== starter), "no movement may carry the kit item");
        const byItem = new Map(issues.map((issue) => [issue.item_id, issue]));
        assert.equal(byItem.get(kettle)?.quantity, "-2.0000");
        assert.equal(byItem.get(kettle)?.total_value, "-8.0000");
        assert.equal(byItem.get(mug)?.quantity, "-4.0000");
        assert.equal(byItem.get(mug)?.total_value, "-24.0000");
        assert.ok(
          byItem.get(kettle)?.idempotency_key !== byItem.get(mug)?.idempotency_key,
          "each component carries its own posting-effect key",
        );
        assert.equal(await glBalance(org.orgId, org.accounts.cogs), "32.0000");
        assert.equal((await getOnHand(org.orgId, kettle, org.stockLocationId)).quantity, "8.0000");
        assert.equal((await getOnHand(org.orgId, mug, org.stockLocationId)).quantity, "6.0000");

        // Re-running the post-commit drain finds every component movement.
        const { applyInventoryIssuesForInvoice } = await import("./documents-sales.ts");
        const replayed = await applyInventoryIssuesForInvoice(
          org.orgId, null, sale.documentId, org.date, org.subsidiaryId,
        );
        assert.equal(replayed, 0);
        assert.equal((await kitIssueMovements(org.orgId, sale.lineId)).length, 2);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "kit availability is the limiting component, net of kit demand",
  { skip: !DB },
  async () => {
    const org = await run(() => createScratchOrg());
    try {
      await run(async () => {
        await db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
                 || '{"orders": true, "warehousing": true, "fulfillment": true}'::jsonb) where id = ${org.orgId}`);
        const kettle = await stockedComponent(org, "Kettle");
        const mug = await stockedComponent(org, "Mug");
        const starter = await kitItem(org, "Starter set", [
          { itemId: kettle, quantityPer: "1.0000" },
          { itemId: mug, quantityPer: "2.0000" },
        ]);
        await receive(org, kettle, "10", "4");
        await receive(org, mug, "10", "6");

        const atp = () => getAvailableToPromise(db, org.orgId, { itemId: starter, subsidiaryId: org.subsidiaryId });
        assert.equal((await atp()).available, "5.0000");
        assert.equal((await atp()).onHand, "0.0000");

        // An issued order owing two kits commits its components, not the kit.
        const orderId = randomUUID();
        await db.execute(sql`
          insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status, subsidiary_id)
          values (${orderId}, ${org.orgId}, 'sales_order', 'SO-KIT-1', ${org.customerId}, ${org.date}, 'CAD', 'draft', ${org.subsidiaryId})`);
        await db.execute(sql`
          insert into document_lines (id, org_id, document_id, line_number, item_id, description, quantity, unit,
                                      unit_price, amount, tax_amount, stock_location_id, custom)
          values (${randomUUID()}, ${org.orgId}, ${orderId}, 1, ${starter}, 'Starter set', '2', 'ea',
                  '25', '50', '0', ${org.stockLocationId}, '{}'::jsonb)`);
        await db.execute(sql`update documents set status = 'approved' where id = ${orderId} and org_id = ${org.orgId}`);

        assert.equal((await atp()).available, "3.0000");
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "returning a kit restocks its components at their original issue cost",
  { skip: !DB },
  async () => {
    const org = await run(() => createScratchOrg());
    try {
      await run(async () => {
        const kettle = await stockedComponent(org, "Kettle");
        const mug = await stockedComponent(org, "Mug");
        const starter = await kitItem(org, "Starter set", [
          { itemId: kettle, quantityPer: "1.0000" },
          { itemId: mug, quantityPer: "2.0000" },
        ]);
        await receive(org, kettle, "10", "4");
        await receive(org, mug, "10", "6");
        const sale = await postKitInvoice(org, { kitId: starter, quantity: "2", unitPrice: "25", amount: "50" });
        const sources = await kitIssueMovements(org.orgId, sale.lineId);
        assert.equal(sources.length, 2);

        const creditId = randomUUID();
        const creditLineId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, party_id, subsidiary_id,
             document_date, posting_date, currency, fx_rate, status,
             subtotal, tax_total, total, custom)
          values
            (${creditId}, ${org.orgId}, 'customer_credit',
             ${`CM-KIT-${creditId.slice(0, 8)}`}, ${org.customerId}, ${org.subsidiaryId},
             ${org.date}, ${org.date}, 'CAD', 1, 'draft', '25', '0', '25', '{}'::jsonb)`);
        await db.execute(sql`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, account_id,
             quantity, unit_price, amount, tax_amount, is_billable,
             quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
          values
            (${creditLineId}, ${org.orgId}, ${creditId}, 1, ${starter},
             ${org.accounts.revenue}, '1', '25', '25', '0', false, '0', '0', ${org.stockLocationId},
             ${JSON.stringify({
               inventoryReturn: {
                 kitComponents: sources.map((source) => ({ sourceIssueMovementId: source.id })),
               },
             })}::jsonb, false)`);
        await db.execute(sql`
          update documents set status = 'approved' where id = ${creditId} and org_id = ${org.orgId}`);
        await postDocument(creditId, depsFor(org));

        const receipts = (await db.execute<{ item_id: string; quantity: string; total_value: string }>(sql`
          select item_id, quantity::text as quantity, total_value::text as total_value
            from inventory_movements
           where org_id = ${org.orgId} and document_line_id = ${creditLineId} and kind = 'receipt'
           order by item_id`)).rows;
        assert.equal(receipts.length, 2);
        const byItem = new Map(receipts.map((receipt) => [receipt.item_id, receipt]));
        assert.equal(byItem.get(kettle)?.quantity, "1.0000");
        assert.equal(byItem.get(kettle)?.total_value, "4.0000");
        assert.equal(byItem.get(mug)?.quantity, "2.0000");
        assert.equal(byItem.get(mug)?.total_value, "12.0000");
        assert.equal((await getOnHand(org.orgId, kettle, org.stockLocationId)).quantity, "9.0000");
        assert.equal((await getOnHand(org.orgId, mug, org.stockLocationId)).quantity, "8.0000");
        assert.equal(await glBalance(org.orgId, org.accounts.cogs), "16.0000");

        // Re-running the return drain restores nothing twice.
        const { applyInventoryReturnsForCustomerCredit } = await import("./documents-customer-credits.ts");
        const replayed = await applyInventoryReturnsForCustomerCredit(
          org.orgId, null, creditId, org.date, org.subsidiaryId,
        );
        assert.equal(replayed, 0);

        // Returning more than the sources still hold is refused by name.
        const overId = randomUUID();
        const overLineId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, party_id, subsidiary_id,
             document_date, posting_date, currency, fx_rate, status,
             subtotal, tax_total, total, custom)
          values
            (${overId}, ${org.orgId}, 'customer_credit',
             ${`CM-KIT-${overId.slice(0, 8)}`}, ${org.customerId}, ${org.subsidiaryId},
             ${org.date}, ${org.date}, 'CAD', 1, 'draft', '50', '0', '50', '{}'::jsonb)`);
        await db.execute(sql`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, account_id,
             quantity, unit_price, amount, tax_amount, is_billable,
             quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
          values
            (${overLineId}, ${org.orgId}, ${overId}, 1, ${starter},
             ${org.accounts.revenue}, '2', '25', '50', '0', false, '0', '0', ${org.stockLocationId},
             ${JSON.stringify({
               inventoryReturn: {
                 kitComponents: sources.map((source) => ({ sourceIssueMovementId: source.id })),
               },
             })}::jsonb, false)`);
        await db.execute(sql`
          update documents set status = 'approved' where id = ${overId} and org_id = ${org.orgId}`);
        await assert.rejects(postDocument(overId, depsFor(org)), /exceeds the unreturned quantity/);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "receiving or adjusting a kit is refused by name",
  { skip: !DB },
  async () => {
    const org = await run(() => createScratchOrg());
    try {
      await run(async () => {
        const starter = await kitItem(org, "Starter set", [
          { itemId: await stockedComponent(org, "Kettle"), quantityPer: "1.0000" },
        ]);
        await assert.rejects(
          receive(org, starter, "1", "4"),
          /kits hold no stock; receive the components/,
        );
        await assert.rejects(
          adjustInventory(org.orgId, null, {
            itemId: starter,
            stockLocationId: org.stockLocationId,
            quantityDelta: "1",
            subsidiaryId: org.subsidiaryId,
            date: org.date,
          }),
          /kits hold no stock; receive the components/,
        );

        // A vendor bill naming the kit is refused before its journal posts.
        const billId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, party_id, subsidiary_id,
             document_date, posting_date, currency, fx_rate, status,
             subtotal, tax_total, total, custom)
          values
            (${billId}, ${org.orgId}, 'vendor_bill',
             ${`BILL-KIT-${billId.slice(0, 8)}`}, ${org.vendorId}, ${org.subsidiaryId},
             ${org.date}, ${org.date}, 'CAD', 1, 'draft', '10', '0', '10', '{}'::jsonb)`);
        await db.execute(sql`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, account_id,
             quantity, unit_price, amount, tax_amount, is_billable,
             quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
          values
            (${randomUUID()}, ${org.orgId}, ${billId}, 1, ${starter},
             ${org.accounts.ap}, '1', '10', '10', '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`);
        await db.execute(sql`
          update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
        await assert.rejects(postDocument(billId, depsFor(org)), /kits hold no stock; receive the components/);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
