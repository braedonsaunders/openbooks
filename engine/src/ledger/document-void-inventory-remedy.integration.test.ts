import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { reverseInventoryMovement } from "../inventory/reversal.ts";
import { adjustInventory } from "../inventory/movements.ts";
import { getOnHand } from "../inventory/position.ts";
import { createPaymentDocument, updateDraftPayment } from "../payments/payment-documents.ts";
import { postPaymentWithApplications } from "../payments/payment-posting.ts";
import { creditItemsForParty, openItemsForParty } from "../payments/payment-queries.ts";
import { sameCurrencyAllocation } from "../payments/settlement-policy.ts";
import { postDocument } from "./posting-document.ts";
import { DocumentVoidError, requestDocumentVoid } from "./document-void.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Legacy revenue-only refusal — byte-identical preservation target. */
const LEGACY_REVENUE_MESSAGE =
  "this transaction has inventory or revenue-recognition subledger activity — use the dedicated return/cancellation workflow: revenue contracts cancel from Revenue → contract → Cancel recognition (POST /api/revenue/cancel-recognition)";

type LineSeed = {
  itemId: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  accountId?: string | null;
  stockLocationId?: string | null;
  lineProjectId?: string | null;
  lineLocationId?: string | null;
};

async function seedApprovedDoc(
  org: ScratchOrg,
  kind: string,
  number: string,
  partyId: string,
  lines: LineSeed[],
  header: { projectId?: string | null; locationId?: string | null } = {},
): Promise<string> {
  const documentId = randomUUID();
  const total = fromUnits(lines.reduce((sum, line) => sum + toUnits(line.amount), 0n));
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, project_id, location_id, custom)
    values (${documentId}, ${org.orgId}, ${kind}, ${number},
            ${partyId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
            'CAD', 1, 'draft', ${total}, '0', ${total},
            ${header.projectId ?? null}, ${header.locationId ?? null},
            '{}'::jsonb)`);
  for (const [index, line] of lines.entries()) {
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id, quantity,
         unit_price, amount, tax_amount, project_id, location_id, is_billable,
         quantity_fulfilled, quantity_billed, stock_location_id, custom,
         tax_overridden, extra_dims)
      values (${randomUUID()}, ${org.orgId}, ${documentId}, ${index + 1},
              ${line.itemId}, ${line.accountId ?? null}, ${line.quantity},
              ${line.unitPrice}, ${line.amount}, '0',
              ${line.lineProjectId ?? null}, ${line.lineLocationId ?? null},
              false, '0', '0', ${line.stockLocationId ?? null},
              '{}'::jsonb, false, '{}'::jsonb)`);
  }
  await db.execute(sql`
    update documents set status = 'approved'
     where id = ${documentId} and org_id = ${org.orgId}`);
  return documentId;
}

/** The service item carries a 12-month term: provision the schedule's months. */
async function seedRecognitionTermPeriods(org: ScratchOrg): Promise<void> {
  const calendar = await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id
      from accounting_periods
     where id = ${org.periodId} and org_id = ${org.orgId}`);
  const fiscalCalendarId = calendar.rows[0]?.fiscal_calendar_id;
  assert.ok(fiscalCalendarId);
  const periods = [
    [2026, 8, "2026-08-01", "2026-08-31"],
    [2026, 9, "2026-09-01", "2026-09-30"],
    [2026, 10, "2026-10-01", "2026-10-31"],
    [2026, 11, "2026-11-01", "2026-11-30"],
    [2026, 12, "2026-12-01", "2026-12-31"],
    [2027, 1, "2027-01-01", "2027-01-31"],
    [2027, 2, "2027-02-01", "2027-02-28"],
    [2027, 3, "2027-03-01", "2027-03-31"],
    [2027, 4, "2027-04-01", "2027-04-30"],
    [2027, 5, "2027-05-01", "2027-05-31"],
    [2027, 6, "2027-06-01", "2027-06-30"],
  ] as const;
  for (const [fiscalYear, periodNumber, startsOn, endsOn] of periods) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      values (${randomUUID()}, ${org.orgId}, ${fiscalCalendarId}, ${fiscalYear},
              ${periodNumber}, ${startsOn.slice(0, 7)}, ${startsOn}, ${endsOn},
              false, '{}'::jsonb)`);
  }
}

async function seedRevenueProject(org: ScratchOrg, code: string): Promise<string> {
  const projectId = randomUUID();
  await db.execute(sql`
    insert into projects
      (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${code},
            ${code}, ${org.customerId}, 'active', true, '{}'::jsonb)`);
  return projectId;
}

async function docState(orgId: string, documentId: string) {
  return (await db.execute<{
    status: string;
    void_requested_at: string | null;
    reversal_entry_id: string | null;
  }>(sql`
    select status, void_requested_at::text, reversal_entry_id::text
      from documents where id = ${documentId} and org_id = ${orgId}
  `)).rows[0]!;
}

async function journalCounts(orgId: string) {
  const entries = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}`)).rows[0]!.n;
  const lines = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_lines where org_id = ${orgId}`)).rows[0]!.n;
  return { entries, lines };
}

async function voidMessage(input: {
  orgId: string;
  documentId: string;
  actorId: string;
}): Promise<string | null> {
  try {
    await requestDocumentVoid({
      orgId: input.orgId,
      documentId: input.documentId,
      actorId: input.actorId,
      reason: "entered wrong figures",
    });
    return null;
  } catch (error) {
    assert.ok(error instanceof DocumentVoidError);
    return error.message;
  }
}

const depsFor = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

// F23/INVENTORY-2: a posted vendor bill carrying inventory receipt movements
// must be refused with a purchasing-domain remedy — never the revenue
// cancellation screen — and the refusal must survive a kernel reversal of
// the receipt, because the guard is existence-based and posted history is
// immutable.
test("voiding a posted inventory bill refuses with a purchasing remedy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const billId = await seedApprovedDoc(org, "vendor_bill", "BILL-INVREM-1", org.vendorId, [
      { itemId: org.items.fifo, quantity: "5", unitPrice: "2", amount: "10", stockLocationId: org.stockLocationId },
    ]);
    assert.ok(await postDocument(billId, depsFor(org)));
    const movements = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from inventory_movements movement
        join document_lines line on line.id = movement.document_line_id and line.org_id = movement.org_id
       where movement.org_id = ${org.orgId} and line.document_id = ${billId}`)).rows[0]!.n;
    assert.equal(movements, 1);

    const before = await journalCounts(org.orgId);
    const message = await voidMessage({ orgId: org.orgId, documentId: billId, actorId: actor });
    assert.ok(message, "void must be refused");
    assert.match(message, /remains posted and cannot be voided/);
    assert.match(message, /account-only vendor credit/);
    assert.match(message, /inventory adjustment account/);
    assert.match(message, /where cash is still due/);
    assert.match(message, /Inventory Adjust/);
    assert.match(message, /residual/);
    assert.doesNotMatch(message, /Revenue → contract → Cancel recognition/);
    assert.doesNotMatch(message, /reverse/);
    assert.doesNotMatch(message, /select .* receipt/i);

    // Zero status/journal mutations: the refusal rolls the void claim back.
    const state = await docState(org.orgId, billId);
    assert.equal(state.status, "posted");
    assert.equal(state.void_requested_at, null);
    assert.equal(state.reversal_entry_id, null);
    assert.deepEqual(await journalCounts(org.orgId), before);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("inventory bill refusal outlives kernel reversal of the receipt", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const billId = await seedApprovedDoc(org, "vendor_bill", "BILL-INVREM-2", org.vendorId, [
      { itemId: org.items.fifo, quantity: "5", unitPrice: "2", amount: "10", stockLocationId: org.stockLocationId },
    ]);
    assert.ok(await postDocument(billId, depsFor(org)));
    const mv = (await db.execute<{ id: string }>(sql`
      select movement.id from inventory_movements movement
        join document_lines line on line.id = movement.document_line_id and line.org_id = movement.org_id
       where movement.org_id = ${org.orgId} and line.document_id = ${billId}
         and movement.kind = 'receipt' and movement.status = 'posted'`));
    assert.equal(mv.rows.length, 1);
    await reverseInventoryMovement(org.orgId, actor, {
      movementId: mv.rows[0]!.id,
      reversalDate: org.date,
      reason: "probe reversal of bill receipt",
    });

    const message = await voidMessage({ orgId: org.orgId, documentId: billId, actorId: actor });
    assert.ok(message, "void must still be refused after reversal");
    assert.match(message, /account-only vendor credit/);
    assert.match(message, /remains posted and cannot be voided/);
    assert.doesNotMatch(message, /Revenue → contract → Cancel recognition/);
    assert.equal((await docState(org.orgId, billId)).status, "posted");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("revenue-only void refusal keeps the exact cancellation remedy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    await seedRecognitionTermPeriods(org);
    const projectId = await seedRevenueProject(org, "INVREM-REV");
    const invId = await seedApprovedDoc(org, "customer_invoice", "INV-INVREM-1", org.customerId, [
      {
        itemId: org.items.service, quantity: "1", unitPrice: "1200", amount: "1200",
        accountId: org.accounts.revenue,
      },
    ], { projectId, locationId: org.locationId });
    await postDocument(invId, depsFor(org));
    const obligations = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from performance_obligations
       where org_id = ${org.orgId} and status <> 'cancelled'
         and document_line_id in (select id from document_lines where document_id = ${invId})`)).rows[0]!.n;
    assert.equal(obligations, 1);

    const message = await voidMessage({ orgId: org.orgId, documentId: invId, actorId: actor });
    assert.equal(message, LEGACY_REVENUE_MESSAGE);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("mixed inventory and revenue void refusal names both subledgers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    await seedRecognitionTermPeriods(org);
    // The invoice auto-issues its stocked line on posting: receive cover first.
    const stockBillId = await seedApprovedDoc(org, "vendor_bill", "BILL-INVREM-STOCK", org.vendorId, [
      { itemId: org.items.fifo, quantity: "10", unitPrice: "2", amount: "20", stockLocationId: org.stockLocationId },
    ]);
    assert.ok(await postDocument(stockBillId, depsFor(org)));
    const projectId = await seedRevenueProject(org, "INVREM-MIX");
    const invId = await seedApprovedDoc(org, "customer_invoice", "INV-INVREM-2", org.customerId, [
      {
        itemId: org.items.fifo, quantity: "4", unitPrice: "5", amount: "20",
        accountId: org.accounts.revenue, stockLocationId: org.stockLocationId,
      },
      {
        itemId: org.items.service, quantity: "1", unitPrice: "1200", amount: "1200",
        accountId: org.accounts.revenue,
      },
    ], { projectId, locationId: org.locationId });
    await postDocument(invId, depsFor(org));
    const counts = (await db.execute<{ movements: number; obligations: number }>(sql`
      select (select count(*)::int from inventory_movements movement
               join document_lines line on line.id = movement.document_line_id and line.org_id = movement.org_id
              where movement.org_id = ${org.orgId} and line.document_id = ${invId}) as movements,
             (select count(*)::int from performance_obligations
               where org_id = ${org.orgId} and status <> 'cancelled'
                 and document_line_id in (select id from document_lines where document_id = ${invId})) as obligations`)).rows[0]!;
    assert.equal(counts.movements, 1);
    assert.equal(counts.obligations, 1);

    const message = await voidMessage({ orgId: org.orgId, documentId: invId, actorId: actor });
    assert.ok(message, "void must be refused");
    assert.match(message, /posted inventory movements/);
    assert.match(message, /remains posted/);
    assert.match(message, /Cancel recognition/);
    // An invoice is not a purchase: the vendor-credit remedy must not leak here.
    assert.doesNotMatch(message, /vendor credit/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function glBalance(orgId: string, accountId: string): Promise<string> {
  return (await db.execute<{ balance: string }>(sql`
    select coalesce(sum(amount), 0)::text as balance
      from journal_lines where org_id = ${orgId} and account_id = ${accountId}`)).rows[0]!.balance;
}

async function apOpenLine(orgId: string, entryId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    select id from journal_lines
     where org_id = ${orgId} and entry_id = ${entryId} and is_open_item`)).rows[0]!.id;
}

// Financial intent of this test: the vendor billed 10 for 5 units that cost
// 2 each, then credited back only 8 (restocking fee). This is a PARTIAL
// financial correction with a FULL stock removal — not a complete
// cancellation: the books must end with the vendor balance at zero, GRNI
// (received-not-billed clearing) at zero, stock at zero, and exactly the 2
// shortfall sitting in the item's inventory ADJUSTMENT account as a real
// residual loss. The adjustment account is read from the item's own
// inventory profile (the same configuration adjustInventory uses as its
// offset: adjustmentAccountId ?? cogsAccountId) — deliberately NOT the
// variance account the native vendor-return workflow uses, so this proof
// cannot borrow that workflow's policy. The fixture profile is re-pointed
// to a distinct variance account below to keep the two honest.
//
// Every leg is an existing surface: a financial-only vendor credit
// (account line, no stock item, hence no inventoryReturn evidence for the
// preflight or the web custom-field cleaner to demand or strip), a vendor
// payment carrying the credit application next to the remaining cash, and
// the Inventory Adjust action. A full credit with no cash due cannot be
// applied today — no standalone full-credit application operation exists —
// so the payment leg is conditional on cash still being due.
//
// What this test deliberately does NOT do: kernel-reversing the bill's
// receipt movement mirrors its receipt journal (DR clearing / CR
// inventory), which re-debits received-not-billed clearing and strands +10
// GRNI with no supporting goods — a mechanically permitted but
// accounting-incomplete stock leg for document-linked receipts. That is why
// the stock leg here is an adjust-out at carried cost, not a reversal. The
// original bill is never voided and stays posted throughout.
test("partial credit plus cash with full adjust-out leaves exactly the residual loss", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    // Give the fifo item a variance account DISTINCT from its adjustment
    // account, so the assertions below prove the correct offset was reused.
    const varianceAccountId = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${varianceAccountId}, ${org.orgId}, '5110', 'Purchase Price Variance', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    await db.execute(sql`
      update item_inventory_profiles set variance_account_id = ${varianceAccountId}
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`);
    const profile = (await db.execute<{ adjustment: string; variance: string }>(sql`
      select adjustment_account_id as adjustment, variance_account_id as variance
        from item_inventory_profiles
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`)).rows[0]!;
    assert.equal(profile.adjustment, org.accounts.adjustment);
    assert.notEqual(profile.variance, profile.adjustment);
    const billId = await seedApprovedDoc(org, "vendor_bill", "BILL-INVREM-E2E", org.vendorId, [
      { itemId: org.items.fifo, quantity: "5", unitPrice: "2", amount: "10", stockLocationId: org.stockLocationId },
    ]);
    const billEntry = await postDocument(billId, depsFor(org));
    const billLine = await apOpenLine(org.orgId, billEntry);
    // Bill: DR clearing 10 / CR AP 10; receipt: DR inventory 10 / CR
    // clearing 10. Clearing nets to zero; AP owes 10; stock holds 5 units.
    assert.equal(toUnits((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity), toUnits("5"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.ap)), toUnits("-10"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.clearing)), toUnits("0"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.invAsset)), toUnits("10"));

    // Credit 8 of the 10 to the item's own inventory adjustment account
    // (read from the profile, the same configuration the adjust leg uses):
    // DR AP 8 / CR adjustment 8. AP now owes 2.
    const creditId = await seedApprovedDoc(org, "vendor_credit", "VC-INVREM-E2E", org.vendorId, [
      { itemId: null, quantity: "1", unitPrice: "8", amount: "8", accountId: profile.adjustment },
    ]);
    const creditEntry = await postDocument(creditId, depsFor(org));
    const creditLine = await apOpenLine(org.orgId, creditEntry);
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.ap)), toUnits("-2"));

    // Settle through a real vendor payment: the credit-items reader
    // (GET /api/payments/credit-items?side=ap) lists the credit line and
    // PATCH /api/payments/[id] carries it as a credit allocation next to
    // the 2 cash. The bill and the credit both leave the open-item ledger.
    const listed = await creditItemsForParty(org.vendorId, "ap", org.orgId);
    assert.ok(listed.some((item) => item.lineId === creditLine), "credit must be listed as appliable");
    const payment = await createPaymentDocument({
      orgId: org.orgId, kind: "vendor_payment", createdBy: actor,
      partyId: org.vendorId, bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId, documentDate: org.date, currency: "CAD",
    });
    await updateDraftPayment(payment.id, {
      allocations: [sameCurrencyAllocation(billLine, "2")],
      creditAllocations: [{ fromLineId: creditLine, toLineId: billLine, amount: "8", sourceDocumentId: creditId }],
    }, actor, org.orgId);
    await db.execute(sql`update documents set status = 'approved' where id = ${payment.id} and org_id = ${org.orgId}`);
    await postPaymentWithApplications(payment.id, undefined, actor);
    const applied = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from applications
       where org_id = ${org.orgId} and unapplied_at is null
         and (from_line_id = ${creditLine} or from_line_id = ${billLine} or to_line_id = ${billLine})`)).rows[0]!.n;
    assert.equal(applied, 2);
    assert.deepEqual(
      (await openItemsForParty(org.vendorId, "ap", org.orgId)).map((item) => item.lineId),
      [],
    );
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.ap)), toUnits("0"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.bank)), toUnits("-2"));

    // Stock out at carried cost through the Inventory Adjust action (drawer
    // adjust): DR adjustment 10 / CR inventory 10. The adjustment account
    // nets the 8 credit against the 10 cost, holding exactly the 2
    // shortfall; clearing is never touched, so GRNI stays closed; stock
    // reaches zero. COGS and the distinct variance account must stay at
    // zero — neither leg may leak into them.
    await adjustInventory(org.orgId, actor, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId,
      quantityDelta: "-5", subsidiaryId: org.subsidiaryId, date: org.date,
      memo: "return units to vendor, credited short 2",
    });
    assert.equal(toUnits((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity), toUnits("0"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.invAsset)), toUnits("0"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.clearing)), toUnits("0"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.adjustment)), toUnits("2"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.cogs)), toUnits("0"));
    assert.equal(toUnits(await glBalance(org.orgId, varianceAccountId)), toUnits("0"));

    // The original bill was never voided and stays posted; with live
    // applications on it the void now refuses at the earlier applied-credits
    // fence rather than reaching the subledger guard.
    assert.equal((await docState(org.orgId, billId)).status, "posted");
    const message = await voidMessage({ orgId: org.orgId, documentId: billId, actorId: actor });
    assert.match(message ?? "", /live payments or credits applied/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
