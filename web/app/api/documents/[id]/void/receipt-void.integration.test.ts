import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { toUnits } from "@openbooks/engine/money/money";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import {
  DocumentVoidError,
  requestDocumentVoid,
  suggestVoidReversalDate,
} from "@openbooks/engine/ledger/document-void";
import { setPeriodLockState } from "@openbooks/engine/periods/period-locks";
import { getOnHand } from "@openbooks/engine/testing/inventory/position";
import { issueInventory } from "@openbooks/engine/inventory/movements";
import { receivePurchaseOrder } from "../../../../../lib/order-cycle.ts";
import { convertOrder } from "../../../../../lib/order-cycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const REASON = "phantom full-quantity receipt from the blind convert path";
const PAST_DATE = "2026-07-10";

async function seedApprovedPo(
  orgId: string,
  actorId: string,
  vendorId: string,
  subsidiaryId: string,
  documentDate: string,
  itemId: string,
  assetAccountId: string,
  stockLocationId: string,
  number: string,
): Promise<{ orderId: string; lineId: string }> {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${orderId}, ${orgId}, 'purchase_order', ${number}, ${vendorId},
      ${subsidiaryId}, ${documentDate}, 'CAD', 'draft', '20', '0', '20',
      ${actorId}, ${actorId}
    )`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (
      ${lineId}, ${orgId}, ${orderId}, 1, ${itemId}, ${assetAccountId}, 'Widget',
      '10', 'ea', '2', '20', '0', '0', '0', ${stockLocationId}, '{}'::jsonb
    )`);
  // Approved lines are storage-immutable: issue the order only after its
  // lines exist.
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
     where id = ${orderId} and org_id = ${orgId}`);
  return { orderId, lineId };
}

async function receiveFull(
  orgId: string,
  actorId: string,
  orderId: string,
  lineId: string,
  receiptDate: string,
): Promise<{ id: string; documentNumber: string }> {
  return receivePurchaseOrder(orgId, actorId, orderId, {
    receiptDate,
    idempotencyKey: randomUUID(),
    lines: [{ sourceLineId: lineId, quantity: "10" }],
  });
}

async function receiptFacts(orgId: string, receiptId: string, lineId: string) {
  const rows = (
    await db.execute<{
      status: string;
      received: string;
      movements: number;
      reversals: number;
    }>(
      sql`
      select (select status from documents where id = ${receiptId}) as status,
             (select quantity_fulfilled::text from document_lines where id = ${lineId}) as received,
             (select count(*)::int from inventory_movements movement
               join document_lines line on line.id = movement.document_line_id and line.org_id = movement.org_id
              where movement.org_id = ${orgId} and line.document_id = ${receiptId}
                and movement.kind = 'receipt' and movement.status = 'posted') as movements,
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
  return rows;
}

/** Every account the receipt touched must net to exactly zero after the void. */
async function receiptGlNetsToZero(orgId: string, receiptId: string): Promise<void> {
  const rows = await db.execute<{ account: string; net: string }>(
    sql`
      with receipt_movements as (
        select movement.id, movement.journal_entry_id
          from inventory_movements movement
          join document_lines docline
            on docline.id = movement.document_line_id and docline.org_id = movement.org_id
         where movement.org_id = ${orgId} and docline.document_id = ${receiptId}
      ),
      void_entries as (
        select journal_entry_id as entry_id from receipt_movements
        union
        select reversal.journal_entry_id
          from inventory_movements reversal
          join receipt_movements movement on movement.id = reversal.reverses_movement_id
         where reversal.org_id = ${orgId}
      )
      select line.account_id::text as account, sum(line.amount)::text as net
        from journal_lines line
        join void_entries on void_entries.entry_id = line.entry_id
       where line.org_id = ${orgId}
       group by line.account_id`,
    "objects",
  );
  assert.ok(rows.length > 0, "the receipt and its reversal must leave journal evidence");
  for (const row of rows) {
    assert.equal(
      row.net,
      "0.0000",
      `account ${row.account} must net to zero across receipt + reversal`,
    );
  }
}

/**
 * Voiding a posted goods receipt reverses its stock and GL in the receipt's
 * own period, restores the order's received quantity, and leaves no second
 * reversal behind: a repeated request refuses instead of posting again.
 */
test(
  "voiding a posted goods receipt reverses stock, GL and fulfilled counters",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Void Clerk", "admin");
      const { orderId, lineId } = await seedApprovedPo(
        org.orgId,
        actorId,
        org.vendorId,
        org.subsidiaryId,
        PAST_DATE,
        org.items.fifo,
        org.accounts.invAsset,
        org.stockLocationId,
        "PO-VOID-1",
      );
      const receipt = await receiveFull(org.orgId, actorId, orderId, lineId, PAST_DATE);
      const itemId = org.items.fifo;
      const before = await receiptFacts(org.orgId, receipt.id, lineId);
      assert.equal(before.status, "approved");
      assert.equal(toUnits(before.received), toUnits("10"));
      assert.equal(before.movements, 1);

      const outcome = await requestDocumentVoid({
        documentId: receipt.id,
        orgId: org.orgId,
        actorId,
        reason: REASON,
      });
      assert.equal(outcome.status, "voided");

      const after = await receiptFacts(org.orgId, receipt.id, lineId);
      assert.equal(after.status, "voided", "the receipt is marked voided");
      assert.equal(toUnits(after.received), toUnits("0"), "the order line is receivable again");
      assert.equal(after.reversals, 1, "one reversal movement mirrors the receipt movement");
      assert.equal(
        toUnits((await getOnHand(org.orgId, itemId, org.stockLocationId)).quantity),
        0n,
        "the received stock is removed exactly",
      );
      await receiptGlNetsToZero(org.orgId, receipt.id);

      const movementCount = (
        await db.execute<{ n: number }>(
          sql`
        select count(*)::int as n from inventory_movements where org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!.n;
      const again = await requestDocumentVoid({
        documentId: receipt.id,
        orgId: org.orgId,
        actorId,
        reason: REASON,
      }).then(
        () => null,
        (cause) => cause,
      );
      assert.ok(again instanceof DocumentVoidError, "a repeated void refuses instead of reposting");
      assert.equal(
        (
          await db.execute<{ n: number }>(
            sql`
          select count(*)::int as n from inventory_movements where org_id = ${org.orgId}`,
            "objects",
          )
        )[0]!.n,
        movementCount,
        "the refused repeat writes no movement",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "voiding a receipt whose stock was consumed refuses with its remedy",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Void Clerk", "admin");
      const { orderId, lineId } = await seedApprovedPo(
        org.orgId,
        actorId,
        org.vendorId,
        org.subsidiaryId,
        PAST_DATE,
        org.items.fifo,
        org.accounts.invAsset,
        org.stockLocationId,
        "PO-VOID-2",
      );
      const receipt = await receiveFull(org.orgId, actorId, orderId, lineId, PAST_DATE);
      await issueInventory(org.orgId, actorId, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "4",
        subsidiaryId: org.subsidiaryId,
        date: PAST_DATE,
      });
      const failure = await requestDocumentVoid({
        documentId: receipt.id,
        orgId: org.orgId,
        actorId,
        reason: REASON,
      }).then(
        () => null,
        (cause) => cause,
      );
      assert.ok(failure instanceof DocumentVoidError, "consumed stock blocks the void");
      assert.match(String(failure.message), /downstream consumption/);
      const after = await receiptFacts(org.orgId, receipt.id, lineId);
      assert.equal(after.status, "approved", "the refused receipt stays voidable");
      assert.equal(after.reversals, 0, "the refused void reverses nothing");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "voiding a receipt billed against its order refuses until the bill reverses",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Void Clerk", "admin");
      const { orderId, lineId } = await seedApprovedPo(
        org.orgId,
        actorId,
        org.vendorId,
        org.subsidiaryId,
        PAST_DATE,
        org.items.fifo,
        org.accounts.invAsset,
        org.stockLocationId,
        "PO-VOID-3",
      );
      const receipt = await receiveFull(org.orgId, actorId, orderId, lineId, PAST_DATE);
      await convertOrder(org.orgId, actorId, orderId, "vendor_bill");
      const failure = await requestDocumentVoid({
        documentId: receipt.id,
        orgId: org.orgId,
        actorId,
        reason: REASON,
      }).then(
        () => null,
        (cause) => cause,
      );
      assert.ok(failure instanceof DocumentVoidError, "billed quantities block the void");
      assert.match(String(failure.message), /already billed/);
      const after = await receiptFacts(org.orgId, receipt.id, lineId);
      assert.equal(after.status, "approved", "the refused receipt stays voidable");
      assert.equal(after.reversals, 0, "the refused void reverses nothing");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a closed receipt period moves the void default to the first open period",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Void Clerk", "admin");
      await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      select ${randomUUID()}, ${org.orgId}, fiscal_calendar_id,
             2026, 8, '2026-08', '2026-08-01', '2026-08-31', false,
             '{}'::jsonb
        from accounting_periods
       where id = ${org.periodId}
    `);
      const { orderId, lineId } = await seedApprovedPo(
        org.orgId,
        actorId,
        org.vendorId,
        org.subsidiaryId,
        PAST_DATE,
        org.items.fifo,
        org.accounts.invAsset,
        org.stockLocationId,
        "PO-VOID-4",
      );
      const receipt = await receiveFull(org.orgId, actorId, orderId, lineId, PAST_DATE);
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module: "ap",
        state: "closed",
        actorId,
        reason: "receipt void fallback control",
      });

      const suggestion = await suggestVoidReversalDate(db, org.orgId, {
        id: receipt.id,
        kind: "purchase_receipt",
        documentDate: PAST_DATE,
        subsidiaryId: org.subsidiaryId,
      });
      assert.equal(suggestion.originalDate, PAST_DATE);
      assert.equal(
        suggestion.suggestedDate,
        "2026-08-01",
        "the default moves to the first open period",
      );
      assert.equal(suggestion.fallbackToOpenPeriod, true, "the move is flagged for its notice");

      const outcome = await requestDocumentVoid({
        documentId: receipt.id,
        orgId: org.orgId,
        actorId,
        reason: REASON,
      });
      assert.equal(outcome.status, "voided");
      // The reservation date is consumed on completion: the reversal rows
      // carry the evidence instead.
      const stored = (
        await db.execute<{ reversalDate: string; postingDate: string }>(
          sql`
        select reversal.moved_at::date::text as "reversalDate",
               entry.posting_date::date::text as "postingDate"
          from inventory_movements reversal
          join inventory_movements movement
            on movement.id = reversal.reverses_movement_id and movement.org_id = reversal.org_id
          join document_lines line
            on line.id = movement.document_line_id and line.org_id = movement.org_id
          join journal_entries entry
            on entry.id = reversal.journal_entry_id and entry.org_id = reversal.org_id
         where reversal.org_id = ${org.orgId} and line.document_id = ${receipt.id}
           and reversal.kind = 'return'
         limit 1
      `,
          "objects",
        )
      )[0]!;
      assert.ok(stored, "the reversal movement and journal exist");
      assert.equal(stored.reversalDate, "2026-08-01");
      assert.equal(stored.postingDate, "2026-08-01", "the reversal posts in the open period");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
