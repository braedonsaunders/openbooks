import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { receiveInventory } from "./movements.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Document line units convert to the item's base unit through the item's
 * costing-profile conversions. Before this, the loader never read dl.unit:
 * a bill for "2 box @ $240" (12 each/box) received 2 each @ $120 instead of
 * 24 each @ $10. An unconvertible unit refuses; it never assumes 1:1.
 */

const depsFor = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function setConversions(org: ScratchOrg, conversions: string): Promise<void> {
  await db.execute(sql`
    update item_inventory_profiles set unit_conversions = ${conversions}::jsonb
     where org_id = ${org.orgId} and item_id = ${org.items.fifo}`);
}

async function draftApprovedDocument(
  org: ScratchOrg,
  kind: "customer_invoice" | "vendor_bill",
  line: { quantity: string; unit: string | null; unitPrice: string; amount: string },
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
            ${`UOM-${documentId.slice(0, 8)}`}, ${partyId}, ${org.subsidiaryId},
            ${org.date}, ${org.date}, 'CAD', 1, 'draft',
            ${line.amount}, '0', ${line.amount}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.fifo},
            ${kind === "customer_invoice" ? org.accounts.revenue : null},
            ${line.quantity}, ${line.unit}, ${line.unitPrice}, ${line.amount},
            '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`);
  await db.execute(sql`
    update documents set status = 'approved'
     where id = ${documentId} and org_id = ${org.orgId}`);
  return { documentId, lineId };
}

async function glBalance(org: ScratchOrg, accountId: string): Promise<bigint> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(l.amount), 0)::text as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${org.orgId} and l.account_id = ${accountId}
       and e.status = 'posted'`));
  return toUnits(r.rows[0]!.bal);
}

test("a bill line in boxes receives base units at the converted unit cost", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setConversions(org, '{"box": 12}');
    const { documentId, lineId } = await draftApprovedDocument(org, "vendor_bill", {
      quantity: "2",
      unit: "box",
      unitPrice: "120",
      amount: "240",
    });
    await postDocument(documentId, depsFor(org));
    const movement = (await db.execute<{ quantity: string; unit_cost: string; total_value: string }>(sql`
      select quantity::text, unit_cost::text, total_value::text from inventory_movements
       where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'receipt'`)).rows[0]!;
    assert.equal(toUnits(movement.quantity), toUnits("24"), "2 box x 12 = 24 each");
    assert.equal(toUnits(movement.unit_cost), toUnits("10"), "$240 over 24 each");
    assert.equal(toUnits(movement.total_value), toUnits("240"));
    const layer = (await db.execute<{ remaining: string; unit_cost: string }>(sql`
      select remaining_quantity::text as remaining, unit_cost::text from cost_layers
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`)).rows[0]!;
    assert.equal(toUnits(layer.remaining), toUnits("24"));
    assert.equal(await glBalance(org, org.accounts.invAsset), toUnits("240"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an invoice line in boxes issues base units", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setConversions(org, '{"box": 12}');
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId,
      quantity: "24", unitCost: "10", subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const { documentId, lineId } = await draftApprovedDocument(org, "customer_invoice", {
      quantity: "2",
      unit: "box",
      unitPrice: "15",
      amount: "30",
    });
    await postDocument(documentId, depsFor(org));
    const movement = (await db.execute<{ quantity: string }>(sql`
      select quantity::text from inventory_movements
       where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'issue'`)).rows[0]!;
    assert.equal(toUnits(movement.quantity), toUnits("-24"), "2 box x 12 = 24 each issued");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a line in an unconvertible unit is refused, never assumed 1:1", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setConversions(org, '{"box": 12}');
    const { documentId, lineId } = await draftApprovedDocument(org, "vendor_bill", {
      quantity: "2",
      unit: "crate",
      unitPrice: "120",
      amount: "240",
    });
    await assert.rejects(
      postDocument(documentId, depsFor(org)),
      /unit "crate" with no conversion to the item's base unit "ea"/,
    );
    const count = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from inventory_movements
       where org_id = ${org.orgId} and document_line_id = ${lineId}`)).rows[0]!.n;
    assert.equal(count, 0, "no stock may move on a refused line");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
