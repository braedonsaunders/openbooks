import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { extendCost } from "./costing.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { applyPurchaseReceiptInventory } from "./documents-purchasing.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A bill's cost layer must carry the line's extended amount exactly. The
 * receipt used to store quantity × a rounded rate ($100.00 / 3 → a 99.9999
 * layer against 100.00 debited), stranding a penny outside the layer — or a
 * phantom COGS true-up leg when nothing was short.
 */

const depsFor = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function glBalance(org: ScratchOrg, accountId: string): Promise<bigint> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(l.amount), 0)::text as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${org.orgId} and l.account_id = ${accountId}
       and e.status = 'posted'`));
  return toUnits(r.rows[0]!.bal);
}

async function layerTotal(orgId: string, itemId: string): Promise<bigint> {
  const rows = (await db.execute<{ remaining: string; unit_cost: string }>(sql`
    select remaining_quantity::text as remaining, unit_cost::text from cost_layers
     where org_id = ${orgId} and item_id = ${itemId}`)).rows;
  return rows.reduce((sum, row) => sum + toUnits(extendCost(row.remaining, row.unit_cost)), 0n);
}

async function draftApprovedBill(
  org: ScratchOrg,
  itemId: string,
  line: { quantity: string; unitPrice: string; amount: string },
): Promise<string> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values (${documentId}, ${org.orgId}, 'vendor_bill',
            ${`EXACT-${documentId.slice(0, 8)}`}, ${org.vendorId}, ${org.subsidiaryId},
            ${org.date}, ${org.date}, 'CAD', 1, 'draft',
            ${line.amount}, '0', ${line.amount}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
    values (${randomUUID()}, ${org.orgId}, ${documentId}, 1, ${itemId}, null,
            ${line.quantity}, ${line.unitPrice}, ${line.amount},
            '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`);
  await db.execute(sql`
    update documents set status = 'approved'
     where id = ${documentId} and org_id = ${org.orgId}`);
  return documentId;
}

/** An inventory item whose profile has no received-not-billed account. */
async function directAssetItem(org: ScratchOrg): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation, income_account_id)
    values (${id}, ${org.orgId}, 'inventory', 'Direct Widget', false, true, '{}'::jsonb, 'billing', 'normal', ${org.accounts.revenue})`);
  await db.execute(sql`
    insert into item_inventory_profiles
      (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
       variance_account_id, received_not_billed_account_id, standard_cost, base_unit, unit_conversions)
    values (${randomUUID()}, ${org.orgId}, ${id}, 'fifo', 'none', ${org.accounts.invAsset}, ${org.accounts.cogs},
            ${org.accounts.adjustment}, ${org.accounts.adjustment}, null, null, 'ea', '{}'::jsonb)`);
  return id;
}

test("a $100 / 3 bill line stores a 100.00 layer, not 99.9999", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const itemId = await directAssetItem(org);
    const billId = await draftApprovedBill(org, itemId, {
      quantity: "3",
      unitPrice: "33.3333",
      amount: "100",
    });
    await postDocument(billId, depsFor(org));
    assert.equal(await glBalance(org, org.accounts.invAsset), toUnits("100"), "GL debited 100.00");
    assert.equal(await glBalance(org, org.accounts.cogs), toUnits("0"), "no phantom true-up in COGS");
    assert.equal(await layerTotal(org.orgId, itemId), toUnits("100"), "layer total equals the GL amount exactly");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a goods receipt carries the order's extended amount exactly", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const documentId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, posting_date, currency, fx_rate, status,
         subtotal, tax_total, total, custom)
      values (${documentId}, ${org.orgId}, 'purchase_receipt',
              ${`GR-EXACT-${documentId.slice(0, 8)}`}, ${org.vendorId}, ${org.subsidiaryId},
              ${org.date}, ${org.date}, 'CAD', 1, 'draft',
              '100', '0', '100', '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id,
         quantity, unit_price, amount, tax_amount, is_billable,
         quantity_fulfilled, quantity_billed, stock_location_id, custom, tax_overridden)
      values (${randomUUID()}, ${org.orgId}, ${documentId}, 1, ${org.items.fifo}, null,
              '3', '33.3333', '100',
              '0', false, '0', '0', ${org.stockLocationId},
              '{"receipt": {"sourceLineId": "po-line-1"}}'::jsonb, false)`);
    await db.execute(sql`
      update documents set status = 'approved'
       where id = ${documentId} and org_id = ${org.orgId}`);
    // The applier joins its caller's transaction (the journal balance fence
    // sees the whole entry); post the receipt inside one like production.
    const count = await db.transaction((tx) =>
      applyPurchaseReceiptInventory(
        tx, org.orgId, null, documentId, org.date, org.subsidiaryId,
      ),
    );
    assert.equal(count, 1);
    assert.equal(await glBalance(org, org.accounts.invAsset), toUnits("100"));
    assert.equal(await glBalance(org, org.accounts.clearing), toUnits("-100"));
    assert.equal(await glBalance(org, org.accounts.cogs), toUnits("0"), "no rounding penny in COGS");
    assert.equal(await layerTotal(org.orgId, org.items.fifo), toUnits("100"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
