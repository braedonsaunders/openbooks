import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { getOnHand } from "./position.ts";
import { restoredReturnCost } from "./documents-customer-credits.ts";
import { parseCustomerCreditInventoryReturnSelection } from "./customer-credit-return-lines.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { SYSTEM_ACTOR_ID } from "../banking/banking.ts";
import { issueInventory, receiveInventory } from "./movements.ts";
import { ensureLot, ensureSerial } from "./tracking.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { reverseInventoryMovement } from "./reversal.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Live-Postgres: a customer credit that returns stock.
 *
 * posting-dispatch handled customer_invoice (issues), vendor_bill (receipts)
 * and vendor_credit (returns), but had no customer_credit branch at all — so a
 * sales return reversed revenue and left the goods outside inventory forever,
 * with COGS still carrying the cost of units the customer had sent back.
 *
 * The valuation rule asserted here is that units come back at the cost they
 * LEFT at, not at today's cost: the credit's selling price is a separate
 * commercial fact and never touches inventory.
 */

const depsFor = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function glBalance(orgId: string, accountId: string): Promise<string> {
  return (
    await db.execute<{ balance: string }>(
      sql`
    select coalesce(sum(amount), 0)::text as balance
      from journal_lines
     where org_id = ${orgId} and account_id = ${accountId}
  `,
      "objects",
    )
  )[0]!.balance;
}

/** Post an invoice carrying one inventory line; its posting issues the stock. */
async function postInvoiceShipping(
  org: ScratchOrg,
  input: { itemId: string; quantity: string; unitPrice: string; amount: string },
): Promise<{ documentId: string; lineId: string; issueMovementId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values
      (${documentId}, ${org.orgId}, 'customer_invoice',
       ${`INV-SHIP-${documentId.slice(0, 8)}`}, ${org.customerId}, ${org.subsidiaryId},
       ${org.date}, ${org.date}, 'CAD', 1, 'draft', ${input.amount}, '0',
       ${input.amount}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
    values
      (${lineId}, ${org.orgId}, ${documentId}, 1, ${input.itemId},
       ${org.accounts.revenue}, ${input.quantity}, ${input.unitPrice},
       ${input.amount}, '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`);
  await db.execute(sql`
    update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  await postDocument(documentId, depsFor(org));
  const issue = (
    await db.execute<{ id: string }>(
      sql`
    select id from inventory_movements
     where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'issue'`,
      "objects",
    )
  )[0];
  assert.ok(issue, "posting the invoice should have issued the stock");
  return { documentId, lineId, issueMovementId: issue.id };
}

/** An approved customer credit whose line claims a return of a shipment. */
async function createApprovedCustomerReturn(
  org: ScratchOrg,
  input: {
    itemId: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    sourceIssueMovementId: string;
    lotId?: string | null;
    serialId?: string | null;
    partyId?: string;
  },
): Promise<{ documentId: string; lineId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values
      (${documentId}, ${org.orgId}, 'customer_credit',
       ${`CM-RETURN-${documentId.slice(0, 8)}`}, ${input.partyId ?? org.customerId},
       ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1, 'draft',
       ${input.amount}, '0', ${input.amount}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
    values
      (${lineId}, ${org.orgId}, ${documentId}, 1, ${input.itemId},
       ${org.accounts.revenue}, ${input.quantity}, ${input.unitPrice},
       ${input.amount}, '0', false, '0', '0', ${org.stockLocationId},
       ${JSON.stringify({
         inventoryReturn: {
           sourceIssueMovementId: input.sourceIssueMovementId,
           ...(input.lotId ? { lotId: input.lotId } : {}),
           ...(input.serialId ? { serialId: input.serialId } : {}),
         },
       })}::jsonb, false)`);
  await db.execute(sql`
    update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  return { documentId, lineId };
}

test("cumulative proration restores a shipment's exact value across partial returns", () => {
  // 10 units that cost 100.0000 in total, returned 3 then 3 then 4. Naive
  // per-slice rounding of 100/10*3 would drift; cumulative proration cannot.
  const shipped = "10",
    value = "100";
  const first = restoredReturnCost(shipped, value, "0", "3");
  const second = restoredReturnCost(shipped, value, "3", "3");
  const third = restoredReturnCost(shipped, value, "6", "4");
  assert.equal(first, "30.0000");
  assert.equal(second, "30.0000");
  assert.equal(third, "40.0000");

  // A quantity that does not divide its value evenly: the slices must still
  // total the whole, with the residual landing in the last return.
  const odd = ["1", "1", "1"].reduce<{ returned: string; costs: string[] }>(
    (state, quantity) => {
      const cost = restoredReturnCost("3", "10", state.returned, quantity);
      return {
        returned: String(Number(state.returned) + Number(quantity)),
        costs: [...state.costs, cost],
      };
    },
    { returned: "0", costs: [] },
  );
  assert.deepEqual(odd.costs, ["3.3333", "3.3334", "3.3333"]);
  assert.equal(odd.costs.reduce((total, cost) => total + Number(cost), 0).toFixed(4), "10.0000");
});

test("customer-return evidence is strict about its shipment link", () => {
  const sourceIssueMovementId = "018f0f52-9800-7000-8000-000000000001";
  const lotId = "018f0f52-9800-7000-8000-000000000002";
  assert.deepEqual(
    parseCustomerCreditInventoryReturnSelection({
      inventoryReturn: { sourceIssueMovementId, lotId },
    }),
    { sourceIssueMovementId, lotId, serialId: null },
  );
  assert.throws(
    () => parseCustomerCreditInventoryReturnSelection({}),
    /is a stocked item: choose the shipment the goods are returned from/,
  );
  assert.throws(
    () =>
      parseCustomerCreditInventoryReturnSelection({
        inventoryReturn: { sourceIssueMovementId: "not-a-uuid" },
      }),
    /valid inventoryReturn\.sourceIssueMovementId/,
  );
});

test(
  "a customer credit restores stock at the shipment's cost, not the credit's price",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Inventory Controller", "admin");
      const { receiveInventory } = await import("./movements.ts");
      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "4",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
      const shipment = await postInvoiceShipping(org, {
        itemId: org.items.fifo,
        quantity: "10",
        unitPrice: "25",
        amount: "250",
      });
      assert.equal(
        (await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity,
        "0.0000",
      );
      const cogsAfterSale = await glBalance(org.orgId, org.accounts.cogs);
      assert.equal(cogsAfterSale, "40.0000");

      // The credit is raised at the selling price of 25/unit for 4 units.
      const credit = await createApprovedCustomerReturn(org, {
        itemId: org.items.fifo,
        quantity: "4",
        unitPrice: "25",
        amount: "100",
        sourceIssueMovementId: shipment.issueMovementId,
      });
      await postDocument(credit.documentId, depsFor(org));

      // Stock returns at 4.0000/unit (what it cost), not 25.0000 (what it sold
      // for): 4 units × 4.0000 = 16.0000 back into inventory and out of COGS.
      const onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
      assert.equal(onHand.quantity, "4.0000");
      assert.equal(onHand.unitCost, "4.0000");
      assert.equal(await glBalance(org.orgId, org.accounts.cogs), "24.0000");
      assert.equal(await glBalance(org.orgId, org.accounts.invAsset), "16.0000");

      const movement = (
        await db.execute<{ quantity: string; total_value: string }>(
          sql`
        select quantity::text, total_value::text from inventory_movements
         where org_id = ${org.orgId} and document_line_id = ${credit.lineId} and kind = 'receipt'`,
          "objects",
        )
      )[0];
      assert.equal(movement!.quantity, "4.0000");
      assert.equal(movement!.total_value, "16.0000");

      await assert.rejects(
        reverseInventoryMovement(org.orgId, actorId, {
          movementId: shipment.issueMovementId,
          reversalDate: org.date,
          reason: "Reverse shipment after its customer return",
        }),
        /customer-credit returns; reverse those credits before voiding the shipment/,
      );
      assert.equal(
        (await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity,
        "4.0000",
        "a refused shipment reversal leaves the customer-return stock unchanged",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "customer credits return serial-tracked shipments through explicit reversal evidence",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      for (const [itemId, tracking] of [
        [org.items.component, "serial"],
        [org.items.fifo, "lot_serial"],
      ] as const) {
        await db.execute(sql`
          update item_inventory_profiles set tracking = ${tracking}
           where org_id = ${org.orgId} and item_id = ${itemId}`);
        const lotId =
          tracking === "lot_serial"
            ? await ensureLot(
                org.orgId,
                itemId,
                `RETURN-${tracking}-${randomUUID().slice(0, 8)}`,
                null,
                null,
              )
            : null;
        const serialId = await ensureSerial(
          org.orgId,
          itemId,
          `RETURN-${tracking}-${randomUUID().slice(0, 8)}`,
          null,
          null,
        );
        await receiveInventory(org.orgId, null, {
          itemId,
          stockLocationId: org.stockLocationId,
          quantity: "1",
          unitCost: "4",
          subsidiaryId: org.subsidiaryId,
          offsetAccountId: org.accounts.clearing,
          date: org.date,
          lotId,
          serialId,
        });

        // The approved cash sale gives the issue its customer provenance;
        // issueInventory records the serial's posted shipment movement.
        const saleId = randomUUID();
        const saleLineId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, party_id, subsidiary_id,
             document_date, posting_date, currency, fx_rate, status,
             subtotal, tax_total, total, custom)
          values (${saleId}, ${org.orgId}, 'cash_sale', ${`CS-${saleId.slice(0, 8)}`},
            ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
            'CAD', 1, 'draft', '4', '0', '4', '{}'::jsonb)`);
        await db.execute(sql`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, account_id,
             quantity, unit_price, amount, tax_amount, is_billable,
             quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
          values (${saleLineId}, ${org.orgId}, ${saleId}, 1, ${itemId},
            ${org.accounts.revenue}, '1', '4', '4', '0', false, '1', '0',
            ${org.stockLocationId}, '{}'::jsonb, false)`);
        await db.execute(
          sql`update documents set status = 'approved' where id = ${saleId} and org_id = ${org.orgId}`,
        );
        const shipment = await issueInventory(org.orgId, null, {
          itemId,
          stockLocationId: org.stockLocationId,
          quantity: "1",
          subsidiaryId: org.subsidiaryId,
          date: org.date,
          documentLineId: saleLineId,
          lotId,
          serialId,
        });
        const credit = await createApprovedCustomerReturn(org, {
          itemId,
          quantity: "1",
          unitPrice: "4",
          amount: "4",
          sourceIssueMovementId: shipment.movementId,
          lotId,
          serialId,
        });
        await postDocument(credit.documentId, depsFor(org));

        const returned = (
          await db.execute<{
            status: string;
            current_stock_location_id: string | null;
            reverses_movement_id: string | null;
            created_by: string | null;
          }>(
            sql`
          select serial.status, serial.current_stock_location_id,
                 movement.reverses_movement_id, movement.created_by
            from serials serial
            join inventory_movements movement
              on movement.org_id = serial.org_id and movement.serial_id = serial.id
             and movement.document_line_id = ${credit.lineId}
           where serial.org_id = ${org.orgId} and serial.id = ${serialId}`,
            "objects",
          )
        )[0]!;
        assert.deepEqual(returned, {
          status: "in_stock",
          current_stock_location_id: org.stockLocationId,
          reverses_movement_id: shipment.movementId,
          created_by: SYSTEM_ACTOR_ID,
        });
      }
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "posting the same customer credit twice restores the stock exactly once",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { receiveInventory } = await import("./movements.ts");
      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "6",
        unitCost: "5",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
      const shipment = await postInvoiceShipping(org, {
        itemId: org.items.fifo,
        quantity: "6",
        unitPrice: "30",
        amount: "180",
      });
      const credit = await createApprovedCustomerReturn(org, {
        itemId: org.items.fifo,
        quantity: "2",
        unitPrice: "30",
        amount: "60",
        sourceIssueMovementId: shipment.issueMovementId,
      });
      await postDocument(credit.documentId, depsFor(org));
      const { applyInventoryReturnsForCustomerCredit } =
        await import("./documents-customer-credits.ts");
      // Replaying the post-commit effect must be a no-op, not a second receipt.
      const replayed = await applyInventoryReturnsForCustomerCredit(
        org.orgId,
        null,
        credit.documentId,
        org.date,
        org.subsidiaryId,
      );
      assert.equal(replayed, 0);
      assert.equal(
        (await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity,
        "2.0000",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "returning more than was shipped is refused before the credit posts",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { receiveInventory } = await import("./movements.ts");
      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "5",
        unitCost: "3",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
      const shipment = await postInvoiceShipping(org, {
        itemId: org.items.fifo,
        quantity: "5",
        unitPrice: "9",
        amount: "45",
      });
      const credit = await createApprovedCustomerReturn(org, {
        itemId: org.items.fifo,
        quantity: "6",
        unitPrice: "9",
        amount: "54",
        sourceIssueMovementId: shipment.issueMovementId,
      });
      await assert.rejects(
        () => postDocument(credit.documentId, depsFor(org)),
        /exceeds the unreturned quantity on its source shipment/,
      );
      // Nothing half-posted: the credit stays unposted and no stock moved back.
      const state = (
        await db.execute<{ status: string; movements: number }>(
          sql`
        select d.status,
               (select count(*)::int from inventory_movements m
                 join document_lines l on l.id = m.document_line_id
                where m.org_id = d.org_id and l.document_id = d.id) as movements
          from documents d where d.org_id = ${org.orgId} and d.id = ${credit.documentId}`,
          "objects",
        )
      )[0];
      assert.notEqual(state!.status, "posted");
      assert.equal(state!.movements, 0);
      assert.equal(
        (await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity,
        "0.0000",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a shipment to another customer cannot be returned on this customer's credit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { receiveInventory } = await import("./movements.ts");
      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "4",
        unitCost: "7",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
      const shipment = await postInvoiceShipping(org, {
        itemId: org.items.fifo,
        quantity: "4",
        unitPrice: "20",
        amount: "80",
      });
      const otherCustomer = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${otherCustomer}, ${org.orgId}, 'customer', 'Other Buyer', true, '{}'::jsonb)`);
      const credit = await createApprovedCustomerReturn(org, {
        itemId: org.items.fifo,
        quantity: "1",
        unitPrice: "20",
        amount: "20",
        sourceIssueMovementId: shipment.issueMovementId,
        partyId: otherCustomer,
      });
      await assert.rejects(
        () => postDocument(credit.documentId, depsFor(org)),
        /source shipment belongs to a different customer/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a credit line with no return evidence stays a purely financial credit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { receiveInventory } = await import("./movements.ts");
      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "3",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
      const documentId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status,
           subtotal, tax_total, total, custom)
        values
          (${documentId}, ${org.orgId}, 'customer_credit',
           ${`CM-GOODWILL-${documentId.slice(0, 8)}`}, ${org.customerId}, ${org.subsidiaryId},
           ${org.date}, ${org.date}, 'CAD', 1, 'draft', '25', '0', '25', '{}'::jsonb)`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount, tax_overridden)
        values (${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, '1', '25', '25', '0', false)`);
      await db.execute(sql`
        update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
      await postDocument(documentId, depsFor(org));

      const posted = (
        await db.execute<{ status: string }>(
          sql`
        select status from documents where id = ${documentId} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0];
      assert.equal(posted!.status, "posted");
      // A goodwill credit must not invent a stock movement.
      assert.equal(
        (await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity,
        "3.0000",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a customer return against a document-less shipment is refused by name",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      // Balance-forward stock shipped by a manual adjustment: a posted
      // issue with no source document, so no customer can be verified
      // against the credit's party.
      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "4",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
      const manualIssue = await issueInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      });
      const credit = await createApprovedCustomerReturn(org, {
        itemId: org.items.fifo,
        quantity: "4",
        unitPrice: "25",
        amount: "100",
        sourceIssueMovementId: manualIssue.movementId,
      });
      // The old code skipped the customer match for null-provenance
      // shipments and refunded a customer that never received the goods.
      await assert.rejects(
        () => postDocument(credit.documentId, depsFor(org)),
        (error: unknown) =>
          error instanceof PostingError &&
          /has no sales document behind it/.test(error.message) &&
          /without inventory-return evidence/.test(error.message),
      );
      const status = (
        await db.execute<{ status: string }>(
          sql`
        select status from documents where id = ${credit.documentId} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.equal(status.status, "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
