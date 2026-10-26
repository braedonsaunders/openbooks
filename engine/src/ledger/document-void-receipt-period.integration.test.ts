import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { postDocument } from "./posting-document.ts";
import { DocumentVoidError, requestDocumentVoid } from "./document-void.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import { createOrderDraft, receivePurchaseOrder } from "../../../web/lib/order-cycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const REASON = "supplier billed the wrong delivery";

async function seedReceipt(): Promise<{
  orgId: string;
  actorId: string;
  date: string;
  openDate: string;
  orderId: string;
  lineId: string;
  receiptId: string;
  itemId: string;
  locationId: string;
  revenueId: string;
  customerId: string;
  subsidiaryId: string;
  ap: string;
  ar: string;
  bank: string;
}> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Void Clerk", "admin");
  const order = await createOrderDraft(org.orgId, actorId, "purchase_order", randomUUID(), null);
  const lineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (${lineId}, ${org.orgId}, ${order.id}, 1, ${org.items.fifo}, ${org.accounts.invAsset},
            'Widget', '10', 'ea', '2', '20', '0', '0', '0', ${org.stockLocationId}, '{}'::jsonb)`);
  await db.execute(sql`
    update documents set status = 'approved', party_id = ${org.vendorId}, subsidiary_id = ${org.subsidiaryId},
           document_date = ${org.date}, subtotal = '20', total = '20'
     where id = ${order.id} and org_id = ${org.orgId}`);
  const receipt = await receivePurchaseOrder(org.orgId, actorId, order.id, {
    receiptDate: org.date,
    idempotencyKey: randomUUID(),
    lines: [{ sourceLineId: lineId, quantity: "10" }],
  });
  // A later open period, then the receipt's own period closes for payables.
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
       starts_on, ends_on, is_adjustment, custom)
    select ${randomUUID()}, ${org.orgId}, fiscal_calendar_id,
           2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, '{}'::jsonb
      from accounting_periods where id = ${org.periodId}`);
  await setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "ap",
    state: "closed",
    actorId,
    reason: "closed-period void control",
  });
  return {
    orgId: org.orgId,
    actorId,
    date: org.date,
    openDate: "2026-08-15",
    orderId: order.id,
    lineId,
    receiptId: receipt.id,
    itemId: org.items.fifo,
    locationId: org.stockLocationId,
    revenueId: org.accounts.revenue,
    customerId: org.customerId,
    subsidiaryId: org.subsidiaryId,
    ap: org.accounts.ap,
    ar: org.accounts.ar,
    bank: org.accounts.bank,
  };
}

async function receiptState(orgId: string, receiptId: string, lineId: string) {
  return (
    await db.execute<{ status: string; received: string; reversals: number }>(
      sql`
    select (select status from documents where id = ${receiptId}) as status,
           (select quantity_fulfilled::text from document_lines where id = ${lineId}) as received,
           (select count(*)::int from inventory_movements reversal
             join inventory_movements movement
               on movement.id = reversal.reverses_movement_id and movement.org_id = reversal.org_id
             join document_lines line on line.id = movement.document_line_id and line.org_id = movement.org_id
            where reversal.org_id = ${orgId} and line.document_id = ${receiptId}
              and reversal.kind = 'return' and reversal.status = 'posted') as reversals
  `,
      "objects",
    )
  )[0]!;
}

/**
 * A goods-receipt void dated inside a closed payables period must refuse
 * with the typed closed-period refusal — never post its reversal into
 * the lock. The void dialog renders that refusal with the receipt left
 * approved and nothing reversed.
 */
test(
  "a receipt void in a closed period refuses typed and voids nothing",
  { skip: !DB },
  async () => {
    const seed = await seedReceipt();
    try {
      const failure = await requestDocumentVoid({
        documentId: seed.receiptId,
        orgId: seed.orgId,
        actorId: seed.actorId,
        reason: REASON,
        reversalDate: seed.date,
      }).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(failure instanceof DocumentVoidError, "the closed period blocks the void");
      assert.equal(failure.code, "reversal-period-closed");
      assert.match(failure.message, /reversal period for .* is closed/);
      const after = await receiptState(seed.orgId, seed.receiptId, seed.lineId);
      assert.equal(after.status, "approved", "the refused receipt stays voidable");
      assert.equal(after.reversals, 0, "the refused void reverses nothing");
      assert.equal(toUnits(after.received), toUnits("10"), "the order line keeps its cover");
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);

/**
 * The same receipt voids with an open-period reversal date: the refusal
 * is date-dependent, and the reversal lands in the open period.
 */
test("the same receipt voids with an open-period reversal date", { skip: !DB }, async () => {
  const seed = await seedReceipt();
  try {
    const outcome = await requestDocumentVoid({
      documentId: seed.receiptId,
      orgId: seed.orgId,
      actorId: seed.actorId,
      reason: REASON,
      reversalDate: seed.openDate,
    });
    assert.equal(outcome.status, "voided");
    const after = await receiptState(seed.orgId, seed.receiptId, seed.lineId);
    assert.equal(after.status, "voided");
    assert.equal(after.reversals, 1);
    const landing = (
      await db.execute<{ posting: string; period: string }>(
        sql`
      select entry.posting_date::date::text as posting, period.name as period
        from inventory_movements reversal
        join journal_entries entry on entry.id = reversal.journal_entry_id and entry.org_id = reversal.org_id
        join accounting_periods period on period.id = entry.period_id
       where reversal.org_id = ${seed.orgId} and reversal.kind = 'return' and reversal.status = 'posted'
       order by reversal.created_at desc limit 1`,
        "objects",
      )
    )[0]!;
    assert.equal(landing.posting, seed.openDate);
    assert.equal(landing.period, "2026-08");
  } finally {
    await dropScratchOrg(seed.orgId);
  }
});

/**
 * The period fence runs before the stock unwind: a consumed receipt
 * dated inside a closed period refuses closed-period first, so the
 * dialog can offer another date before naming dependents.
 */
test(
  "a consumed receipt in a closed period refuses closed-period first",
  { skip: !DB },
  async () => {
    const seed = await seedReceipt();
    try {
      const invoiceId = randomUUID();
      await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, status, subtotal, tax_total, total, custom, created_by, updated_by)
      values (${invoiceId}, ${seed.orgId}, 'customer_invoice', 'INV-M38-P1', ${seed.customerId},
              ${seed.subsidiaryId}, ${seed.date}, 'CAD', 'draft', '20', '0', '20',
              '{}'::jsonb, ${seed.actorId}, ${seed.actorId})`);
      await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
         unit, unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed,
         stock_location_id, custom)
      values (${randomUUID()}, ${seed.orgId}, ${invoiceId}, 1, ${seed.itemId}, ${seed.revenueId},
              'Widget', '4', 'ea', '5', '20', '0', '0', '0', ${seed.locationId}, '{}'::jsonb)`);
      await db.execute(sql`
      update documents set status = 'approved' where id = ${invoiceId} and org_id = ${seed.orgId}`);
      await postDocument(invoiceId, { control: { ar: seed.ar, ap: seed.ap, bank: seed.bank } });
      const failure = await requestDocumentVoid({
        documentId: seed.receiptId,
        orgId: seed.orgId,
        actorId: seed.actorId,
        reason: REASON,
        reversalDate: seed.date,
      }).then(
        () => null,
        (cause: unknown) => cause,
      );
      assert.ok(failure instanceof DocumentVoidError);
      assert.equal(
        failure.code,
        "reversal-period-closed",
        "the period fence runs before the stock unwind",
      );
    } finally {
      await dropScratchOrg(seed.orgId);
    }
  },
);
