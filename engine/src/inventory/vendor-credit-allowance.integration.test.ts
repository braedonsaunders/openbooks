import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { getOnHand } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { InventoryError } from "./contracts.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import { applyDocumentEdit, createDocument } from "../ledger/document-write.ts";
import { loadDocumentEditCurrent } from "../ledger/document-service.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const depsFor = (org: ScratchOrg) => ({
  control: {
    ar: org.accounts.ar,
    ap: org.accounts.ap,
    bank: org.accounts.bank,
  },
});

/**
 * Live-Postgres: a vendor credit for damaged or overpriced goods that are
 * never shipped back.
 *
 * A stocked line must still choose: either the receipt the goods return from
 * (stock moves at carried cost) or an explicit allowance (no goods returned).
 * The allowance settles commercially to the item's purchase price variance
 * account and moves no stock — exactly like a bill price difference settles
 * to variance without touching cost layers — so carried cost is never
 * adjusted for goods that stayed.
 */

async function vendorBillReceiptLine(org: ScratchOrg, itemId: string): Promise<string> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values
      (${documentId}, ${org.orgId}, 'vendor_bill',
       ${`BILL-ALLOW-${documentId.slice(0, 8)}`}, ${org.vendorId}, ${org.subsidiaryId},
       ${org.date}, ${org.date}, 'CAD', 1, 'draft', '0', '0', '0', '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom,
       tax_overridden)
    values
      (${lineId}, ${org.orgId}, ${documentId}, 1, ${itemId},
       ${org.accounts.clearing}, '0', '0', '0', '0', false, '0', '0',
       ${org.stockLocationId}, '{}'::jsonb, false)
  `);
  return lineId;
}

async function receiveStock(org: ScratchOrg): Promise<string> {
  const receipt = await receiveInventory(org.orgId, null, {
    itemId: org.items.fifo,
    stockLocationId: org.stockLocationId,
    quantity: "10",
    unitCost: "2",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
    documentLineId: await vendorBillReceiptLine(org, org.items.fifo),
  });
  return receipt.movementId;
}

async function glBalance(orgId: string, accountId: string): Promise<string> {
  return (await db.execute<{ balance: string }>(sql`
    select coalesce(sum(amount), 0)::text as balance
      from journal_lines
     where org_id = ${orgId} and account_id = ${accountId}
  `)).rows[0]!.balance;
}

async function layerValue(orgId: string, itemId: string): Promise<string> {
  return (await db.execute<{ value: string }>(sql`
    select coalesce(sum(round(remaining_quantity * unit_cost, 4)), 0)::text as value
      from cost_layers
     where org_id = ${orgId} and item_id = ${itemId}
  `)).rows[0]!.value;
}

async function returnMovements(orgId: string, documentId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from inventory_movements movement
      join document_lines line on line.id = movement.document_line_id
     where movement.org_id = ${orgId}
       and line.document_id = ${documentId}
       and movement.kind = 'return'`)).rows[0]!.n;
}

test(
  "an allowance credit posts with no stock movement to the variance account",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "AP clerk", "admin");
        const receiptId = await receiveStock(org);
        assert.ok(receiptId);
        const created = await createDocument({
          orgId: org.orgId,
          userId: actor,
          kind: "vendor_credit",
          key: randomUUID(),
          body: {
            partyId: org.vendorId,
            documentDate: org.date,
            lines: [
              {
                accountId: org.accounts.adjustment,
                itemId: org.items.fifo,
                quantity: "4",
                unitPrice: "2.5",
                amount: "10",
                stockLocationId: org.stockLocationId,
                inventoryAllowance: true,
              },
            ],
          },
          subsidiaryId: org.subsidiaryId,
          requestBody: { kind: "vendor_credit" },
        });
        assert.equal(created.status, "created");
        await db.execute(sql`
          update documents set status = 'approved'
           where id = ${created.id} and org_id = ${org.orgId}`);
        await postDocument(created.id, depsFor(org));
        // No stock moved: no return movement, layers and on-hand untouched.
        assert.equal(await returnMovements(org.orgId, created.id), 0);
        assert.equal(toUnits(await layerValue(org.orgId, org.items.fifo)), toUnits("20"));
        const onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
        assert.equal(toUnits(onHand.quantity), toUnits("10"));
        assert.equal(toUnits(onHand.value), toUnits("20"));
        // The full commercial amount settles to the variance account while
        // AP reflects the credit — with no return journal debiting it back.
        assert.equal(toUnits(await glBalance(org.orgId, org.accounts.adjustment)), toUnits("-10"));
        assert.equal(toUnits(await glBalance(org.orgId, org.accounts.ap)), toUnits("10"));
        assert.equal(toUnits(await glBalance(org.orgId, org.accounts.invAsset)), toUnits("20"));
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a stocked vendor-credit line with no choice refuses on save",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "AP clerk", "admin");
        await receiveStock(org);
        await assert.rejects(
          () =>
            createDocument({
              orgId: org.orgId,
              userId: actor,
              kind: "vendor_credit",
              key: randomUUID(),
              body: {
                partyId: org.vendorId,
                documentDate: org.date,
                lines: [
                  {
                    accountId: org.accounts.adjustment,
                    itemId: org.items.fifo,
                    quantity: "4",
                    unitPrice: "2.5",
                    amount: "10",
                    stockLocationId: org.stockLocationId,
                  },
                ],
              },
              subsidiaryId: org.subsidiaryId,
              requestBody: { kind: "vendor_credit" },
            }),
          (error: unknown) =>
            error instanceof DocumentEditError &&
            error.status === 422 &&
            /Line 1 \(FIFO Widget\) is a stocked item: choose the receipt the goods are returned from, or post the credit as an allowance/.test(
              error.message,
            ),
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a return source plus an allowance on one line refuses on save",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "AP clerk", "admin");
        const receiptId = await receiveStock(org);
        await assert.rejects(
          () =>
            createDocument({
              orgId: org.orgId,
              userId: actor,
              kind: "vendor_credit",
              key: randomUUID(),
              body: {
                partyId: org.vendorId,
                documentDate: org.date,
                lines: [
                  {
                    accountId: org.accounts.adjustment,
                    itemId: org.items.fifo,
                    quantity: "4",
                    unitPrice: "2.5",
                    amount: "10",
                    stockLocationId: org.stockLocationId,
                    inventoryReturnSource: { movementId: receiptId },
                    inventoryAllowance: true,
                  },
                ],
              },
              subsidiaryId: org.subsidiaryId,
              requestBody: { kind: "vendor_credit" },
            }),
          /cannot be both/,
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an allowance without a variance account refuses with the remedy",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "AP clerk", "admin");
        await receiveStock(org);
        await db.execute(sql`
          update item_inventory_profiles
             set variance_account_id = null, adjustment_account_id = null
           where org_id = ${org.orgId} and item_id = ${org.items.fifo}`);
        const created = await createDocument({
          orgId: org.orgId,
          userId: actor,
          kind: "vendor_credit",
          key: randomUUID(),
          body: {
            partyId: org.vendorId,
            documentDate: org.date,
            lines: [
              {
                accountId: org.accounts.adjustment,
                itemId: org.items.fifo,
                quantity: "4",
                unitPrice: "2.5",
                amount: "10",
                stockLocationId: org.stockLocationId,
                inventoryAllowance: true,
              },
            ],
          },
          subsidiaryId: org.subsidiaryId,
          requestBody: { kind: "vendor_credit" },
        });
        await db.execute(sql`
          update documents set status = 'approved'
           where id = ${created.id} and org_id = ${org.orgId}`);
        await assert.rejects(
          () => postDocument(created.id, depsFor(org)),
          (error: unknown) =>
            error instanceof InventoryError &&
            /no purchase price variance account/.test(error.message),
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a credit with returned goods posts through the write path and relieves the chosen receipt",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "AP clerk", "admin");
        const receiptId = await receiveStock(org);
        const created = await createDocument({
          orgId: org.orgId,
          userId: actor,
          kind: "vendor_credit",
          key: randomUUID(),
          body: {
            partyId: org.vendorId,
            documentDate: org.date,
            lines: [
              {
                accountId: org.accounts.adjustment,
                itemId: org.items.fifo,
                quantity: "4",
                unitPrice: "2.5",
                amount: "10",
                stockLocationId: org.stockLocationId,
                inventoryReturnSource: { movementId: receiptId },
              },
            ],
          },
          subsidiaryId: org.subsidiaryId,
          requestBody: { kind: "vendor_credit" },
        });
        // An edit that keeps the chosen source saves cleanly.
        const current = (await loadDocumentEditCurrent(created.id, org.orgId))!;
        await applyDocumentEdit(
          created.id,
          current,
          {
            expectedUpdatedAt: current.updatedAt,
            lines: [
              {
                accountId: org.accounts.adjustment,
                itemId: org.items.fifo,
                quantity: "4",
                unitPrice: "2.5",
                amount: "10",
                stockLocationId: org.stockLocationId,
                inventoryReturnSource: { movementId: receiptId },
              },
            ],
          },
          { orgId: org.orgId, userId: actor, source: "ui", runFlows: false },
        );
        await db.execute(sql`
          update documents set status = 'approved'
           where id = ${created.id} and org_id = ${org.orgId}`);
        await postDocument(created.id, depsFor(org));
        assert.equal(await returnMovements(org.orgId, created.id), 1);
        const onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
        assert.equal(toUnits(onHand.quantity), toUnits("6"));
        assert.equal(toUnits(onHand.value), toUnits("12"));
        assert.equal(toUnits(await layerValue(org.orgId, org.items.fifo)), toUnits("12"));
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
