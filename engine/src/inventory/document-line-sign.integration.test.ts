import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A negative-quantity inventory line on an invoice or bill is not a return.
 * The loader used to absorb the sign and issue stock at full cost (invoice)
 * or price the receipt at a negative unit cost (bill). Both legs now refuse
 * before posting, naming the credit/return flow that actually restores stock.
 */

const depsFor = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function draftApprovedDocument(
  org: ScratchOrg,
  kind: "customer_invoice" | "vendor_bill",
  line: { quantity: string; unitPrice: string; amount: string },
): Promise<{ documentId: string; lineId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  const partyId = kind === "customer_invoice" ? org.customerId : org.vendorId;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values (${documentId}, ${org.orgId}, ${kind},
            ${`NEG-${documentId.slice(0, 8)}`}, ${partyId}, ${org.subsidiaryId},
            ${org.date}, ${org.date}, 'CAD', 1, 'draft',
            ${line.amount}, '0', ${line.amount}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.fifo},
            ${kind === "customer_invoice" ? org.accounts.revenue : null},
            ${line.quantity}, ${line.unitPrice}, ${line.amount},
            '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`);
  await db.execute(sql`
    update documents set status = 'approved'
     where id = ${documentId} and org_id = ${org.orgId}`);
  return { documentId, lineId };
}

async function movementCount(orgId: string, lineId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from inventory_movements
     where org_id = ${orgId} and document_line_id = ${lineId}`));
  return r.rows[0]!.n;
}

test("a negative-quantity invoice line is refused and points to the customer credit return flow", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { documentId, lineId } = await draftApprovedDocument(org, "customer_invoice", {
      quantity: "-1",
      unitPrice: "100",
      amount: "-100",
    });
    await assert.rejects(
      postDocument(documentId, depsFor(org)),
      /negative quantity.*not a return.*customer credit with custom\.inventoryReturn evidence/s,
    );
    assert.equal(await movementCount(org.orgId, lineId), 0, "no stock may move on a refused line");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a negative-quantity bill line is refused and points to the vendor credit return flow", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { documentId, lineId } = await draftApprovedDocument(org, "vendor_bill", {
      quantity: "-1",
      unitPrice: "100",
      amount: "-100",
    });
    await assert.rejects(
      postDocument(documentId, depsFor(org)),
      /negative quantity.*not a return.*vendor credit with custom\.inventoryReturn evidence/s,
    );
    assert.equal(await movementCount(org.orgId, lineId), 0, "no stock may move on a refused line");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
