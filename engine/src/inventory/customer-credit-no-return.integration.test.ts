import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { getOnHand } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createDocument } from "../ledger/document-write.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const depsFor = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

/**
 * Live-Postgres: the sales-side mirror of the vendor allowance choice.
 *
 * A customer-credit line either names the shipment the goods are returned
 * from ("goods returned to stock", restocked at the cost the units left at)
 * or carries the explicit no-goods-returned choice ("no goods returned",
 * settling commercially exactly like a line that never chose a return).
 */

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
  const issue = (await db.execute<{ id: string }>(sql`
    select id from inventory_movements
     where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'issue'`)).rows[0];
  assert.ok(issue, "posting the invoice should have issued the stock");
  return { documentId, lineId, issueMovementId: issue.id };
}

async function glBalance(orgId: string, accountId: string): Promise<string> {
  return (await db.execute<{ balance: string }>(sql`
    select coalesce(sum(amount), 0)::text as balance
      from journal_lines
     where org_id = ${orgId} and account_id = ${accountId}
  `)).rows[0]!.balance;
}

async function receiptMovements(orgId: string, documentId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from inventory_movements movement
      join document_lines line on line.id = movement.document_line_id
     where movement.org_id = ${orgId}
       and line.document_id = ${documentId}
       and movement.kind = 'receipt'`)).rows[0]!.n;
}

test(
  "an explicit no-goods-returned choice posts commercial-only with no restock",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "4",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
      await postInvoiceShipping(org, {
        itemId: org.items.fifo,
        quantity: "10",
        unitPrice: "25",
        amount: "250",
      });
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "AR clerk", "admin");
        const created = await createDocument({
          orgId: org.orgId,
          userId: actor,
          kind: "customer_credit",
          key: randomUUID(),
          body: {
            partyId: org.customerId,
            documentDate: org.date,
            lines: [
              {
                accountId: org.accounts.revenue,
                itemId: org.items.fifo,
                quantity: "4",
                unitPrice: "25",
                amount: "100",
                stockLocationId: org.stockLocationId,
                inventoryAllowance: true,
              },
            ],
          },
          subsidiaryId: org.subsidiaryId,
          requestBody: { kind: "customer_credit" },
        });
        assert.equal(created.status, "created");
        await db.execute(sql`
          update documents set status = 'approved'
           where id = ${created.id} and org_id = ${org.orgId}`);
        await postDocument(created.id, depsFor(org));
        // Nothing comes back: no receipt movement and the shelves stay empty.
        assert.equal(await receiptMovements(org.orgId, created.id), 0);
        const onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
        assert.equal(toUnits(onHand.quantity), toUnits("0"));
        // Revenue reverses the 100 commercially while COGS keeps the shipped cost.
        assert.equal(toUnits(await glBalance(org.orgId, org.accounts.revenue)), toUnits("-150"));
        assert.equal(toUnits(await glBalance(org.orgId, org.accounts.cogs)), toUnits("40"));
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "goods returned through the write path restock at the shipment's cost",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
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
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "AR clerk", "admin");
        const created = await createDocument({
          orgId: org.orgId,
          userId: actor,
          kind: "customer_credit",
          key: randomUUID(),
          body: {
            partyId: org.customerId,
            documentDate: org.date,
            lines: [
              {
                accountId: org.accounts.revenue,
                itemId: org.items.fifo,
                quantity: "4",
                unitPrice: "25",
                amount: "100",
                stockLocationId: org.stockLocationId,
                inventoryReturnSource: { movementId: shipment.issueMovementId },
              },
            ],
          },
          subsidiaryId: org.subsidiaryId,
          requestBody: { kind: "customer_credit" },
        });
        await db.execute(sql`
          update documents set status = 'approved'
           where id = ${created.id} and org_id = ${org.orgId}`);
        await postDocument(created.id, depsFor(org));
        assert.equal(await receiptMovements(org.orgId, created.id), 1);
        const onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
        assert.equal(toUnits(onHand.quantity), toUnits("4"));
        assert.equal(toUnits(onHand.value), toUnits("16"));
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a return source plus no-goods-returned on one line refuses on save",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
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
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "AR clerk", "admin");
        await assert.rejects(
          () =>
            createDocument({
              orgId: org.orgId,
              userId: actor,
              kind: "customer_credit",
              key: randomUUID(),
              body: {
                partyId: org.customerId,
                documentDate: org.date,
                lines: [
                  {
                    accountId: org.accounts.revenue,
                    itemId: org.items.fifo,
                    quantity: "4",
                    unitPrice: "25",
                    amount: "100",
                    stockLocationId: org.stockLocationId,
                    inventoryReturnSource: { movementId: shipment.issueMovementId },
                    inventoryAllowance: true,
                  },
                ],
              },
              subsidiaryId: org.subsidiaryId,
              requestBody: { kind: "customer_credit" },
            }),
          /cannot be both/,
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
