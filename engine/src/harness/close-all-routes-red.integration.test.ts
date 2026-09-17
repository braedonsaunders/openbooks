import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../db.ts";
import { CLOSE_MODULES, setPeriodLockState } from "../close.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { receiveInventory, InventoryError } from "../inventory.ts";
import { PostingError, postDocument } from "../posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Anti-false-green for the period-close invariant: locks must prevent posting
 * into the locked period BY EVERY ROUTE THAT CAN POST, not just the one a
 * given suite happened to exercise. The corpus already pins bill/AP
 * (posting-closed-period), check/AP and deposit+transfer/banking
 * (close.test.ts), and the draft→posted module fence for a sourced entry
 * (close-posting-module-fence). This file closes the matrix on one scratch
 * org with ALL modules shut: the two core claim routes (bill/AP,
 * invoice/AR), a banking route through the full approval flow (transfer),
 * the storage backstop directly (a sourceless draft→posted flip, GL-only by
 * design), and a non-document engine route (an inventory receipt, which
 * fences GL at the application boundary with a named InventoryError).
 *
 * Deliberately NOT re-covered here: check/deposit (close.test.ts), the
 * sourced-entry flip (module-fence), and the heavyweight engine routes that
 * need their own fixtures to run at all (payroll posting, depreciation runs,
 * revenue recognition, FX revaluation, allocation runs, lease actions, tax
 * provision) — each of those must still cross the same je_guard GL backstop
 * on its draft→posted flip, and each deserves its own close-dated test
 * beside its own fixtures rather than a line in this matrix.
 */

function chainMatches(error: unknown, pattern: RegExp): boolean {
  const messages: string[] = [];
  for (
    let current: unknown = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    messages.push(String((current as { message?: unknown }).message ?? ""));
  }
  return pattern.test(messages.join(" | "));
}

const POST_DEPS = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function approvedBill(org: ScratchOrg, actor: string, number: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
       currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'vendor_bill', 'draft', ${number},
            ${org.subsidiaryId}, ${org.vendorId}, ${org.date},
            'CAD', 1, '100.0000', '0', '100.0000', ${actor})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.adjustment}, '1', '100.0000', '100.0000', '0')`);
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`);
  return id;
}

async function approvedInvoice(org: ScratchOrg, actor: string, number: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
       currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${number},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date},
            'CAD', 1, '100.0000', '0', '100.0000', ${actor})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
    values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '1', '100.0000', '100.0000', '0')`);
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`);
  return id;
}

async function approvedTransfer(org: ScratchOrg, actor: string, number: string): Promise<string> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id,
       document_date, currency, subtotal, tax_total, total, created_by)
    values (${documentId}, ${org.orgId}, 'transfer', 'draft', ${number},
            ${org.subsidiaryId}, ${org.date}, 'CAD', '10', '0', '10', ${actor})`);
  // Kernel contract: line 1 = destination carrying the amount, line 2 =
  // source naming only its account with zero.
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, subsidiary_id,
       amount, quantity, unit_price, tax_amount, tax_input_amount)
    values (${org.orgId}, ${documentId}, 1, ${org.accounts.bank}, ${org.subsidiaryId},
            '10', '1', '10', '0', '10'),
           (${org.orgId}, ${documentId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId},
            '0', '1', '0', '0', '0')`);
  await withOrgTransaction(org.orgId, async () => {
    const released = await submitAndReleaseIfUngated("transfer", documentId, actor);
    assert.equal(released.autoApproved, true);
  });
  return documentId;
}

async function draftManualEntry(org: ScratchOrg, actor: string): Promise<string> {
  const entry = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
       memo, status, origin, created_by, updated_by)
    values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entry},
            ${org.date}, ${org.periodId}, 'all-routes close probe', 'draft', 'manual',
            ${actor}, ${actor})`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
    values (${org.orgId}, ${entry}, 1, ${org.accounts.adjustment}, ${org.subsidiaryId}, 100, 'CAD', 100, 1, false),
           (${org.orgId}, ${entry}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, -100, 'CAD', -100, 1, false)`);
  return entry;
}

test("an all-closed period refuses every posting route", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Close prover", "admin");

    // Validity control: the bill route genuinely posts before anything closes.
    const controlBill = await approvedBill(org, actor, "BILL-ROUTES-OPEN");
    await postDocument(controlBill, POST_DEPS(org));
    const controlState = await db.execute<{ status: string }>(
      sql`select status from documents where id = ${controlBill}`,
    );
    assert.equal(controlState.rows[0]!.status, "posted");

    // Shut every module; GL goes last (the closer refuses GL before its
    // subledgers, so a loop in declared order would trip its own guard).
    for (const module of [...CLOSE_MODULES].sort((a, b) => (a === "gl" ? 1 : b === "gl" ? -1 : 0))) {
      await setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module,
        state: "closed",
        actorId: actor,
        reason: "t3 all-routes probe: every module shut",
      });
    }

    // Bill (AP) and invoice (AR) through the document kernel.
    const bill = await approvedBill(org, actor, "BILL-ROUTES-SHUT");
    await assert.rejects(
      postDocument(bill, POST_DEPS(org)),
      (error: unknown) =>
        error instanceof PostingError && chainMatches(error, /AP is closed for this period and accounting book/),
    );
    const invoice = await approvedInvoice(org, actor, "INV-ROUTES-SHUT");
    await assert.rejects(
      postDocument(invoice, POST_DEPS(org)),
      (error: unknown) =>
        error instanceof PostingError && chainMatches(error, /AR is closed for this period and accounting book/),
    );

    // Transfer (banking) through the full approval flow + kernel.
    const transfer = await approvedTransfer(org, actor, "TRF-ROUTES-SHUT");
    await assert.rejects(
      withOrgTransaction(org.orgId, () => postDocument(transfer, POST_DEPS(org), { deferEffects: true })),
      (error: unknown) => chainMatches(error, /BANKING is closed/),
    );

    // Sourceless manual journal: no document module to check, so the
    // storage GL backstop is the only fence — and it must hold.
    const manual = await draftManualEntry(org, actor);
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'posted', posted_by = ${actor} where id = ${manual}`),
      (error: unknown) => chainMatches(error, /period is closed for GL posting/),
    );

    // Non-document engine route: an inventory receipt fences GL itself.
    await assert.rejects(
      receiveInventory(org.orgId, null, {
        itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "5", unitCost: "2.00",
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      }),
      (error: unknown) => error instanceof InventoryError && chainMatches(error, /GL is closed/),
    );

    // Atomicity spot-check: the refused bill sits approved with no partial
    // journal behind it.
    const untouched = await withBypassContext(async () => {
      const r = await db.execute<{ status: string; entries: number }>(sql`
        select status,
               (select count(*)::int from journal_entries where source_document_id = ${bill}) as entries
          from documents where id = ${bill} and org_id = ${org.orgId}`);
      return r.rows[0]!;
    });
    assert.deepEqual(untouched, { status: "approved", entries: 0 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
