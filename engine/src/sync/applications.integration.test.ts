import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { recomputeOpenBalances, reconcileApplications } from "./applications.ts";
import { DocumentVoidError, requestDocumentVoid } from "../ledger/document-void.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "application reconciliation matches compatible lines when source line order differs",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const paymentDocumentId = randomUUID();
    const appliedDocumentId = randomUUID();
    const paymentEntryId = randomUUID();
    const appliedEntryId = randomUUID();
    const partyBId = randomUUID();
    const partyAId = randomUUID();
    const paymentLines = {
      partyB: randomUUID(),
      partyA: randomUUID(),
      bank: randomUUID(),
    };
    const appliedLines = {
      partyA: randomUUID(),
      partyB: randomUUID(),
      bank: randomUUID(),
    };
    try {
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values
          (${partyBId}, ${org.orgId}, 'customer', 'Party B', true, '{}'::jsonb),
          (${partyAId}, ${org.orgId}, 'customer', 'Party A', true, '{}'::jsonb)
      `);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, status, subtotal, tax_total,
           total, custom)
        values
          (${paymentDocumentId}, ${org.orgId}, 'customer_payment', 'PAY-ORDER',
           ${partyAId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 50, 0, 50, '{"sourceId":"payment-1"}'::jsonb),
          (${appliedDocumentId}, ${org.orgId}, 'invoice', 'INV-ORDER',
           ${partyAId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 50, 0, 50, '{"sourceId":"invoice-1"}'::jsonb)
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin)
        values
          (${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'PAY-ORDER', ${org.date}, ${org.periodId}, 'Payment order fixture',
           'draft', ${paymentDocumentId}, 'document'),
          (${appliedEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'INV-ORDER', ${org.date}, ${org.periodId}, 'Invoice order fixture',
           'draft', ${appliedDocumentId}, 'document')
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (${paymentLines.partyB}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, 25, 'CAD', 25, 1, ${partyBId}, true),
          (${paymentLines.partyA}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.ar},
           ${org.subsidiaryId}, 25, 'CAD', 25, 1, ${partyAId}, true),
          (${paymentLines.bank}, ${org.orgId}, ${paymentEntryId}, 3, ${org.accounts.bank},
           ${org.subsidiaryId}, -50, 'CAD', -50, 1, null, false),
          (${appliedLines.partyA}, ${org.orgId}, ${appliedEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, -25, 'CAD', -25, 1, ${partyAId}, true),
          (${appliedLines.partyB}, ${org.orgId}, ${appliedEntryId}, 2, ${org.accounts.ar},
           ${org.subsidiaryId}, -25, 'CAD', -25, 1, ${partyBId}, true),
          (${appliedLines.bank}, ${org.orgId}, ${appliedEntryId}, 3, ${org.accounts.bank},
           ${org.subsidiaryId}, 50, 'CAD', 50, 1, null, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id in (${paymentEntryId}, ${appliedEntryId})
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${paymentEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${paymentDocumentId}
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${appliedEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${appliedDocumentId}
      `);

      const first = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-1", appliedRef: "invoice-1", amount: "50", currency: "CAD" },
      ]);
      assert.deepEqual(first, {
        pairs: 1,
        inserted: 2,
        insertedAmount: "50.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });

      const matched = await db.execute<{ fromLineId: string; toLineId: string }>(sql`
        select from_line_id as "fromLineId", to_line_id as "toLineId"
          from applications
         where org_id = ${org.orgId}
         order by from_line_id
      `);
      assert.deepEqual(
        matched.rows,
        [
          { fromLineId: paymentLines.partyA, toLineId: appliedLines.partyA },
          { fromLineId: paymentLines.partyB, toLineId: appliedLines.partyB },
        ].sort((a, b) => a.fromLineId.localeCompare(b.fromLineId)),
      );

      const second = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-1", appliedRef: "invoice-1", amount: "50", currency: "CAD" },
      ]);
      assert.deepEqual(second, {
        pairs: 1,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 1,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation preserves foreign carrying values and realized FX evidence",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const paymentDocumentId = randomUUID();
    const appliedDocumentId = randomUUID();
    const paymentEntryId = randomUUID();
    const appliedEntryId = randomUUID();
    const paymentLineId = randomUUID();
    const paymentBankLineId = randomUUID();
    const appliedLineId = randomUUID();
    const appliedBankLineId = randomUUID();
    try {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, status, subtotal, tax_total,
           total, custom)
        values
          (${paymentDocumentId}, ${org.orgId}, 'customer_payment', 'PAY-FX',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'EUR', 'approved', 100, 0, 100, '{"sourceId":"payment-fx"}'::jsonb),
          (${appliedDocumentId}, ${org.orgId}, 'invoice', 'INV-FX',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'EUR', 'approved', 100, 0, 100, '{"sourceId":"invoice-fx"}'::jsonb)
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin)
        values
          (${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'PAY-FX', ${org.date}, ${org.periodId}, 'Foreign payment fixture',
           'draft', ${paymentDocumentId}, 'document'),
          (${appliedEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'INV-FX', ${org.date}, ${org.periodId}, 'Foreign invoice fixture',
           'draft', ${appliedDocumentId}, 'document')
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (${paymentLineId}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, 120, 'EUR', 100, 1.2, ${org.customerId}, true),
          (${paymentBankLineId}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, -120, 'CAD', -120, 1, null, false),
          (${appliedLineId}, ${org.orgId}, ${appliedEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, -110, 'EUR', -100, 1.1, ${org.customerId}, true),
          (${appliedBankLineId}, ${org.orgId}, ${appliedEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, 110, 'CAD', 110, 1, null, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id in (${paymentEntryId}, ${appliedEntryId})
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${paymentEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${paymentDocumentId}
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${appliedEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${appliedDocumentId}
      `);

      const first = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-fx", appliedRef: "invoice-fx", amount: "100", currency: "EUR" },
      ]);
      assert.deepEqual(first, {
        pairs: 1,
        inserted: 1,
        insertedAmount: "110.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });

      const applications = await db.execute<{
        amount: string;
        sourceAmount: string;
        sourceTransactionAmount: string;
        targetTransactionAmount: string;
        sourceTransactionCurrency: string;
        targetTransactionCurrency: string;
        settlementRate: string;
        settlementRateSource: string;
        fxGainLossEntryId: string | null;
      }>(sql`
        select amount::text as "amount", source_amount::text as "sourceAmount",
               source_transaction_amount::text as "sourceTransactionAmount",
               target_transaction_amount::text as "targetTransactionAmount",
               source_transaction_currency as "sourceTransactionCurrency",
               target_transaction_currency as "targetTransactionCurrency",
               settlement_rate::text as "settlementRate",
               settlement_rate_source as "settlementRateSource",
               fx_gain_loss_entry_id as "fxGainLossEntryId"
          from applications
         where org_id = ${org.orgId}
      `);
      assert.equal(applications.rows.length, 1);
      assert.deepEqual(
        { ...applications.rows[0], fxGainLossEntryId: applications.rows[0]!.fxGainLossEntryId ? "set" : null },
        {
          amount: "110.0000",
          sourceAmount: "120.0000",
          sourceTransactionAmount: "100.0000",
          targetTransactionAmount: "100.0000",
          sourceTransactionCurrency: "EUR",
          targetTransactionCurrency: "EUR",
          settlementRate: "1.0000000000",
          settlementRateSource: "same_currency",
          fxGainLossEntryId: "set",
        },
      );

      const fxEntryId = applications.rows[0]!.fxGainLossEntryId;
      const fxLines = await db.execute<{ accountId: string; amount: string }>(sql`
        select account_id as "accountId", amount::text as "amount"
          from journal_lines
         where org_id = ${org.orgId} and entry_id = ${fxEntryId}
         order by line_number
      `);
      assert.deepEqual(fxLines.rows, [
        { accountId: org.accounts.ar, amount: "-10.0000" },
        { accountId: org.accounts.fxGainLoss, amount: "10.0000" },
      ]);

      const second = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-fx", appliedRef: "invoice-fx", amount: "100", currency: "EUR" },
      ]);
      assert.deepEqual(second, {
        pairs: 1,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 1,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation gives each realized-FX group its own entry number",
  { skip: !DB },
  async () => {
    // One foreign-currency payment settles two parties whose carrying rates
    // both drifted, so two FX groups carry nonzero adjustments for the same
    // payment document. Naming every realized-FX entry `${documentId}-FX`
    // posts the second group onto the first group's entry number, violating
    // journal_entries_org_number and rolling back the entire reconciliation.
    const org = await createScratchOrg();
    const paymentDocumentId = randomUUID();
    const invoiceAId = randomUUID();
    const invoiceBId = randomUUID();
    const paymentEntryId = randomUUID();
    const entryAId = randomUUID();
    const entryBId = randomUUID();
    const partyBId = randomUUID();
    try {
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${partyBId}, ${org.orgId}, 'customer', 'FX Party B', true, '{}'::jsonb)
      `);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, status, subtotal, tax_total,
           total, custom)
        values
          (${paymentDocumentId}, ${org.orgId}, 'customer_payment', 'PAY-FX2',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'EUR', 'approved', 200, 0, 200, '{"sourceId":"payment-fx2"}'::jsonb),
          (${invoiceAId}, ${org.orgId}, 'customer_invoice', 'INV-FX2A',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'EUR', 'approved', 100, 0, 100, '{"sourceId":"invoice-fx2a"}'::jsonb),
          (${invoiceBId}, ${org.orgId}, 'customer_invoice', 'INV-FX2B',
           ${partyBId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'EUR', 'approved', 100, 0, 100, '{"sourceId":"invoice-fx2b"}'::jsonb)
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin)
        values
          (${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'PAY-FX2', ${org.date}, ${org.periodId}, 'Two-party foreign payment',
           'draft', ${paymentDocumentId}, 'document'),
          (${entryAId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'INV-FX2A', ${org.date}, ${org.periodId}, 'Foreign invoice A',
           'draft', ${invoiceAId}, 'document'),
          (${entryBId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'INV-FX2B', ${org.date}, ${org.periodId}, 'Foreign invoice B',
           'draft', ${invoiceBId}, 'document')
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, 120, 'EUR', 100, 1.2, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.ar},
           ${org.subsidiaryId}, 125, 'EUR', 100, 1.25, ${partyBId}, true),
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 3, ${org.accounts.bank},
           ${org.subsidiaryId}, -245, 'CAD', -245, 1, null, false),
          (${randomUUID()}, ${org.orgId}, ${entryAId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, -110, 'EUR', -100, 1.1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${entryAId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, 110, 'CAD', 110, 1, null, false),
          (${randomUUID()}, ${org.orgId}, ${entryBId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, -115, 'EUR', -100, 1.15, ${partyBId}, true),
          (${randomUUID()}, ${org.orgId}, ${entryBId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, 115, 'CAD', 115, 1, null, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id in (${paymentEntryId}, ${entryAId}, ${entryBId})
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${paymentEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${paymentDocumentId}
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${entryAId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${invoiceAId}
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${entryBId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${invoiceBId}
      `);

      const result = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-fx2", appliedRef: "invoice-fx2a", amount: "120", currency: "CAD" },
        { paymentRef: "payment-fx2", appliedRef: "invoice-fx2b", amount: "125", currency: "CAD" },
      ]);
      assert.deepEqual(result, {
        pairs: 2,
        inserted: 2,
        insertedAmount: "225.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });

      const fxNumbers = await db.execute<{ entryNumber: string }>(sql`
        select e.entry_number as "entryNumber"
          from journal_entries e
         where e.org_id = ${org.orgId} and e.origin = 'fx_settlement'
         order by e.entry_number
      `);
      assert.equal(fxNumbers.rows.length, 2);
      assert.notEqual(fxNumbers.rows[0]!.entryNumber, fxNumbers.rows[1]!.entryNumber);

      // A re-run settles nothing new and mints no further FX entries, so the
      // stepped numbering cannot drift across runs.
      const rerun = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-fx2", appliedRef: "invoice-fx2a", amount: "120", currency: "CAD" },
        { paymentRef: "payment-fx2", appliedRef: "invoice-fx2b", amount: "125", currency: "CAD" },
      ]);
      assert.deepEqual(rerun, {
        pairs: 2,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 2,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation caps over-application as unallocated instead of forcing it",
  { skip: !DB },
  async () => {
    // A source link for 100 against 50 of open capacity must settle exactly
    // the 50 that exists and report the other 50 as unallocated. Forcing the
    // full 100 would breach the kernel's open-item check (or worse, silently
    // over-settle the subledger past zero).
    const org = await createScratchOrg();
    const paymentDocumentId = randomUUID();
    const appliedDocumentId = randomUUID();
    const paymentEntryId = randomUUID();
    const appliedEntryId = randomUUID();
    const paymentLineId = randomUUID();
    const appliedLineId = randomUUID();
    try {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, status, subtotal, tax_total,
           total, custom)
        values
          (${paymentDocumentId}, ${org.orgId}, 'customer_payment', 'PAY-OVER',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 50, 0, 50, '{"sourceId":"payment-over"}'::jsonb),
          (${appliedDocumentId}, ${org.orgId}, 'invoice', 'INV-OVER',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 50, 0, 50, '{"sourceId":"invoice-over"}'::jsonb)
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin)
        values
          (${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'PAY-OVER', ${org.date}, ${org.periodId}, 'Over-application payment',
           'draft', ${paymentDocumentId}, 'document'),
          (${appliedEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'INV-OVER', ${org.date}, ${org.periodId}, 'Over-application invoice',
           'draft', ${appliedDocumentId}, 'document')
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (${paymentLineId}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, 50, 'CAD', 50, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, -50, 'CAD', -50, 1, null, false),
          (${appliedLineId}, ${org.orgId}, ${appliedEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, -50, 'CAD', -50, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${appliedEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, 50, 'CAD', 50, 1, null, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id in (${paymentEntryId}, ${appliedEntryId})
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${paymentEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${paymentDocumentId}
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${appliedEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${appliedDocumentId}
      `);

      const first = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-over", appliedRef: "invoice-over", amount: "100", currency: "CAD" },
        { paymentRef: "payment-over", appliedRef: "ghost-9", amount: "10", currency: "CAD" },
      ]);
      assert.deepEqual(first, {
        pairs: 2,
        inserted: 1,
        insertedAmount: "50.0000",
        alreadySettled: 0,
        skippedNoLine: 1,
        unallocated: "50.0000",
      });
      const applied = await db.execute<{ total: string }>(sql`
        select sum(amount)::text as total from applications where org_id = ${org.orgId}`);
      assert.equal(applied.rows[0]!.total, "50.0000");

      // A re-run settles nothing further: remaining capacity is zero, so the
      // same over-link stays fully unallocated instead of double-settling.
      const second = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-over", appliedRef: "invoice-over", amount: "100", currency: "CAD" },
      ]);
      assert.deepEqual(second, {
        pairs: 1,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "50.0000",
      });
      const again = await db.execute<{ total: string; count: string }>(sql`
        select sum(amount)::text as total, count(*)::text as count
          from applications where org_id = ${org.orgId}`);
      assert.deepEqual(again.rows[0], { total: "50.0000", count: "1" });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation accumulates partial applications without over-settling",
  { skip: !DB },
  async () => {
    // Two source reports for the same pair (30, then 50 more) settle 30 and
    // then only the 20 still open; a third identical report settles nothing.
    // The pair total never exceeds the 50 of open capacity.
    const org = await createScratchOrg();
    const paymentDocumentId = randomUUID();
    const appliedDocumentId = randomUUID();
    const paymentEntryId = randomUUID();
    const appliedEntryId = randomUUID();
    try {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, status, subtotal, tax_total,
           total, custom)
        values
          (${paymentDocumentId}, ${org.orgId}, 'customer_payment', 'PAY-PART',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 50, 0, 50, '{"sourceId":"payment-part"}'::jsonb),
          (${appliedDocumentId}, ${org.orgId}, 'invoice', 'INV-PART',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 50, 0, 50, '{"sourceId":"invoice-part"}'::jsonb)
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin)
        values
          (${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'PAY-PART', ${org.date}, ${org.periodId}, 'Partial payment',
           'draft', ${paymentDocumentId}, 'document'),
          (${appliedEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'INV-PART', ${org.date}, ${org.periodId}, 'Partial invoice',
           'draft', ${appliedDocumentId}, 'document')
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, 50, 'CAD', 50, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, -50, 'CAD', -50, 1, null, false),
          (${randomUUID()}, ${org.orgId}, ${appliedEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, -50, 'CAD', -50, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${appliedEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, 50, 'CAD', 50, 1, null, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id in (${paymentEntryId}, ${appliedEntryId})
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${paymentEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${paymentDocumentId}
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${appliedEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${appliedDocumentId}
      `);

      const first = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-part", appliedRef: "invoice-part", amount: "30", currency: "CAD" },
      ]);
      assert.deepEqual(first, {
        pairs: 1,
        inserted: 1,
        insertedAmount: "30.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
      const second = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-part", appliedRef: "invoice-part", amount: "50", currency: "CAD" },
      ]);
      assert.deepEqual(second, {
        pairs: 1,
        inserted: 1,
        insertedAmount: "20.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
      const third = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-part", appliedRef: "invoice-part", amount: "50", currency: "CAD" },
      ]);
      assert.deepEqual(third, {
        pairs: 1,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 1,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
      const total = await db.execute<{ total: string }>(sql`
        select sum(amount)::text as total from applications where org_id = ${org.orgId}`);
      assert.equal(total.rows[0]!.total, "50.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a manual application that commits mid-mirror is honored, not double-settled",
  { skip: !DB },
  async () => {
    // Two users at once: the connector mirror hydrates a 100 open payment
    // and a 100 open invoice while a manual application for the same pair
    // commits underneath it. The mirror must converge on the manual win —
    // resolve cleanly with the pair already settled — never die on the
    // open-item guard (losing the whole batch) and never double-settle.
    const org = await createScratchOrg();
    const paymentDocumentId = randomUUID();
    const appliedDocumentId = randomUUID();
    const paymentEntryId = randomUUID();
    const appliedEntryId = randomUUID();
    const paymentLineId = randomUUID();
    const appliedLineId = randomUUID();
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    try {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, status, subtotal, tax_total,
           total, custom)
        values
          (${paymentDocumentId}, ${org.orgId}, 'customer_payment', 'PAY-RACE',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 100, 0, 100, '{"sourceId":"payment-race"}'::jsonb),
          (${appliedDocumentId}, ${org.orgId}, 'invoice', 'INV-RACE',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 100, 0, 100, '{"sourceId":"invoice-race"}'::jsonb)
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin)
        values
          (${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'PAY-RACE', ${org.date}, ${org.periodId}, 'Race payment',
           'draft', ${paymentDocumentId}, 'document'),
          (${appliedEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'INV-RACE', ${org.date}, ${org.periodId}, 'Race invoice',
           'draft', ${appliedDocumentId}, 'document')
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (${paymentLineId}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, 100, 'CAD', 100, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, -100, 'CAD', -100, 1, null, false),
          (${appliedLineId}, ${org.orgId}, ${appliedEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, -100, 'CAD', -100, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${appliedEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, 100, 'CAD', 100, 1, null, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id in (${paymentEntryId}, ${appliedEntryId})
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${paymentEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${paymentDocumentId}
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${appliedEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${appliedDocumentId}
      `);

      // The manual writer: inserts the full application, then holds its
      // transaction open (and its endpoint row locks with it) until the
      // mirror has demonstrably contended with it.
      const inserted = deferred();
      const release = deferred();
      let manualPid = 0;
      let manualError: unknown = null;
      const manual = withOrgTransaction(org.orgId, async () => {
        manualPid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
        await db.execute(sql`
          insert into applications
            (org_id, from_line_id, to_line_id, amount, source_amount,
             source_transaction_amount, source_transaction_currency,
             target_transaction_amount, target_transaction_currency,
             settlement_rate, settlement_rate_source, settlement_rate_reference,
             applied_on)
          values
            (${org.orgId}, ${paymentLineId}, ${appliedLineId}, 100, 100,
             100, 'CAD', 100, 'CAD', 1, 'same_currency', 'manual race edit',
             ${org.date})
        `);
        inserted.resolve();
        await release.promise;
      }).then(
        () => null,
        (error: unknown) => {
          manualError = error;
          inserted.resolve();
          release.resolve();
          return error;
        },
      );

      const mirror = reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-race", appliedRef: "invoice-race", amount: "100", currency: "CAD" },
      ]).then(
        (stats) => ({ ok: true as const, stats }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      try {
        await inserted.promise;
        // The mirror cannot finish while the manual transaction holds the
        // endpoints: it must arrive blocked on this backend, whether at its
        // hydration-time endpoint lock or at its insert. Poll for that
        // contention instead of sleeping a fixed amount.
        let contended = false;
        for (let attempt = 0; attempt < 150 && !contended; attempt++) {
          const waiting = (await db.execute(sql`
            select pid from pg_stat_activity
             where datname = current_database()
               and ${manualPid} = any(pg_blocking_pids(pid))
          `)).rows;
          contended = waiting.length > 0;
          if (!contended) await delay(20);
        }
        assert.ok(contended, "the mirror must contend with the manual application");
      } finally {
        // Commit the manual win underneath the waiting mirror, then settle
        // both sides before any fixture cleanup.
        release.resolve();
        await manual;
      }
      assert.equal(manualError, null);

      const outcome = await mirror;
      assert.equal(outcome.ok, true, outcome.ok ? "" : String(outcome.error));
      assert.deepEqual(outcome.ok ? outcome.stats : null, {
        pairs: 1,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 1,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
      const settled = await db.execute<{ total: string; count: string }>(sql`
        select sum(amount)::text as total, count(*)::text as count
          from applications
         where org_id = ${org.orgId} and unapplied_at is null`);
      assert.deepEqual(settled.rows[0], { total: "100.0000", count: "1" });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the mirror skips a pair whose invoice was voided before it runs",
  { skip: !DB },
  async () => {
    // The other concurrent office: a controlled void lands first, then the
    // mirror runs. Reversed entries are not settlement endpoints, so the
    // pair must resolve as a skipped line with nothing written — never an
    // application onto the voided invoice's dead lines.
    const org = await createScratchOrg();
    const paymentDocumentId = randomUUID();
    const appliedDocumentId = randomUUID();
    const paymentEntryId = randomUUID();
    const appliedEntryId = randomUUID();
    try {
      const actorId = await createScratchUser(org.orgId, "Void Auditor", "admin");
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, status, subtotal, tax_total,
           total, custom)
        values
          (${paymentDocumentId}, ${org.orgId}, 'customer_payment', 'PAY-VOID',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 100, 0, 100, '{"sourceId":"payment-void"}'::jsonb),
          (${appliedDocumentId}, ${org.orgId}, 'customer_invoice', 'INV-VOID',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 100, 0, 100, '{"sourceId":"invoice-void"}'::jsonb)
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin)
        values
          (${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'PAY-VOID', ${org.date}, ${org.periodId}, 'Void-race payment',
           'draft', ${paymentDocumentId}, 'document'),
          (${appliedEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'INV-VOID', ${org.date}, ${org.periodId}, 'Void-race invoice',
           'draft', ${appliedDocumentId}, 'document')
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, 100, 'CAD', 100, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, -100, 'CAD', -100, 1, null, false),
          (${randomUUID()}, ${org.orgId}, ${appliedEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, -100, 'CAD', -100, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${appliedEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, 100, 'CAD', 100, 1, null, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id in (${paymentEntryId}, ${appliedEntryId})
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${paymentEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${paymentDocumentId}
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${appliedEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${appliedDocumentId}
      `);

      const voided = await requestDocumentVoid({
        documentId: appliedDocumentId,
        orgId: org.orgId,
        actorId,
        reason: "voided before the mirror runs",
        reversalDate: org.date,
        source: "api",
      });
      assert.equal(voided.status, "voided");

      const stats = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "payment-void", appliedRef: "invoice-void", amount: "100", currency: "CAD" },
      ]);
      assert.deepEqual(stats, {
        pairs: 1,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 0,
        skippedNoLine: 1,
        unallocated: "0.0000",
      });
      const written = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from applications where org_id = ${org.orgId}`);
      assert.equal(written.rows[0]!.count, "0");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a void racing the mirror converges without double-settling or dead-line writes",
  { skip: !DB },
  async () => {
    // Two users at once with no staging: the mirror and a controlled void of
    // the invoiced side start together. Both take the same id-ordered
    // endpoint locks, so they serialize completely — first committer wins
    // and the loser converges cleanly. Asserted order-agnostically: no live
    // application may reference a reversed line, neither side may fail raw,
    // and a voided invoice is never settled by the mirror.
    const org = await createScratchOrg();
    const paymentDocumentId = randomUUID();
    const appliedDocumentId = randomUUID();
    const paymentEntryId = randomUUID();
    const appliedEntryId = randomUUID();
    try {
      const actorId = await createScratchUser(org.orgId, "Race Auditor", "admin");
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, status, subtotal, tax_total,
           total, custom)
        values
          (${paymentDocumentId}, ${org.orgId}, 'customer_payment', 'PAY-CONVERGE',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 100, 0, 100, '{"sourceId":"payment-converge"}'::jsonb),
          (${appliedDocumentId}, ${org.orgId}, 'customer_invoice', 'INV-CONVERGE',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 100, 0, 100, '{"sourceId":"invoice-converge"}'::jsonb)
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin)
        values
          (${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'PAY-CONVERGE', ${org.date}, ${org.periodId}, 'Converge payment',
           'draft', ${paymentDocumentId}, 'document'),
          (${appliedEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'INV-CONVERGE', ${org.date}, ${org.periodId}, 'Converge invoice',
           'draft', ${appliedDocumentId}, 'document')
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, 100, 'CAD', 100, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, -100, 'CAD', -100, 1, null, false),
          (${randomUUID()}, ${org.orgId}, ${appliedEntryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, -100, 'CAD', -100, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${appliedEntryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, 100, 'CAD', 100, 1, null, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id in (${paymentEntryId}, ${appliedEntryId})
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${paymentEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${paymentDocumentId}
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${appliedEntryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${appliedDocumentId}
      `);

      const [mirrorOutcome, voidOutcome] = await Promise.all([
        reconcileApplications(org.orgId, "sourceId", [
          { paymentRef: "payment-converge", appliedRef: "invoice-converge", amount: "100", currency: "CAD" },
        ]).then(
          (stats) => ({ ok: true as const, stats }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        requestDocumentVoid({
          documentId: appliedDocumentId,
          orgId: org.orgId,
          actorId,
          reason: "void racing the settlement mirror",
          reversalDate: org.date,
          source: "api",
        }).then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);

      // Neither side fails raw: the mirror converges (settles or cleanly
      // skips) and the void either completes or meets its live-application
      // refusal when the mirror settled first.
      if (!mirrorOutcome.ok) {
        assert.match(String(mirrorOutcome.error), /voided or reposted/);
      }
      if (!voidOutcome.ok) {
        assert.ok(voidOutcome.error instanceof DocumentVoidError, String(voidOutcome.error));
      }
      const mirrorInserted = mirrorOutcome.ok ? mirrorOutcome.stats.inserted : 0;
      const voidVoided = voidOutcome.ok && voidOutcome.result.status === "voided";
      assert.ok(
        !(voidVoided && mirrorInserted > 0),
        "a voided invoice is never settled by the mirror",
      );
      const dead = await db.execute<{ count: string }>(sql`
        select count(*)::text as count
          from applications a
         where a.org_id = ${org.orgId}
           and a.unapplied_at is null
           and exists (
             select 1
               from journal_lines l
               join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
              where l.id in (a.from_line_id, a.to_line_id)
                and e.status = 'reversed'
           )`);
      assert.equal(dead.rows[0]!.count, "0");
      const applied = await db.execute<{ total: string }>(sql`
        select coalesce(sum(case when to_line_id in (
          select id from journal_lines where entry_id = ${appliedEntryId}
        ) then amount else 0 end), 0)::text as total
          from applications
         where org_id = ${org.orgId} and unapplied_at is null`);
      assert.ok(Number(applied.rows[0]!.total) <= 100, `over-applied: ${applied.rows[0]!.total}`);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>;

interface FixtureLine {
  readonly accountId: string;
  readonly amount: string;
  readonly txnAmount?: string;
  readonly fxRate?: string;
  readonly currency?: string;
  readonly partyId: string | null;
  readonly open: boolean;
}

/**
 * Post a document with exact lines; returns the ids for assertions. Signs
 * are the caller's: payments carry positive AR lines, invoices negative
 * ones, so opposites settle.
 */
async function postFixtureDoc(
  org: ScratchOrg,
  docNumber: string,
  sourceId: string,
  lines: readonly FixtureLine[],
  docKind = "customer_invoice",
): Promise<{ documentId: string; entryId: string; lineIds: string[] }> {
  const documentId = randomUUID();
  const entryId = randomUUID();
  const lineIds = lines.map(() => randomUUID());
  const total = lines
    .reduce((sum, line) => (line.amount.startsWith("-") ? sum : sum + Number(line.amount)), 0)
    .toFixed(4);
  // The open-item currency guard ties the document currency to its lines —
  // foreign-currency fixtures must carry the line currency, not CAD.
  const docCurrency = lines[0]?.currency ?? "CAD";
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, status, subtotal, tax_total,
       total, custom)
    values
      (${documentId}, ${org.orgId}, ${docKind}, ${docNumber},
       ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
       ${docCurrency}, 'approved', ${total}, '0', ${total}, ${JSON.stringify({ sourceId })})
  `);
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
       period_id, memo, status, source_document_id, origin)
    values
      (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
       ${docNumber}, ${org.date}, ${org.periodId}, ${`Fixture ${docNumber}`},
       'draft', ${documentId}, 'document')
  `);
  // One multi-row statement: the jl_balanced / jl_balanced_by_subsidiary
  // constraint triggers fire at commit, so every line of the entry must land
  // in the same statement — per-line inserts trip the guard mid-entry.
  const lineValues = lines.map((line, i) => sql`(${lineIds[i]}, ${org.orgId}, ${entryId}, ${i + 1}, ${line.accountId},
         ${org.subsidiaryId}, ${line.amount}, ${line.currency ?? "CAD"},
         ${line.txnAmount ?? line.amount}, ${line.fxRate ?? "1"},
         ${line.partyId}, ${line.open})`);
  await db.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, party_id, is_open_item)
      values ${sql.join(lineValues, sql`, `)}
    `);
  await db.execute(sql`
    update journal_entries
       set status = 'posted', posted_at = now()
     where id = ${entryId}
  `);
  await db.execute(sql`
    update documents
       set posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}, status = 'posted'
     where id = ${documentId}
  `);
  return { documentId, entryId, lineIds };
}

test(
  "application reconciliation settles nothing when a link names the same line twice",
  { skip: !DB },
  async () => {
    // A degenerate source link whose payment and applied references resolve
    // to the same open line must not self-apply: no compatible counterpart
    // exists, so the full amount stays unallocated instead of settling the
    // line against itself.
    const org = await createScratchOrg();
    const documentId = randomUUID();
    const entryId = randomUUID();
    const openLineId = randomUUID();
    try {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, status, subtotal, tax_total,
           total, custom)
        values
          (${documentId}, ${org.orgId}, 'customer_payment', 'PAY-SELF',
           ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date},
           'CAD', 'approved', 50, 0, 50, '{"sourceId":"self-1"}'::jsonb)
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin)
        values
          (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
           'PAY-SELF', ${org.date}, ${org.periodId}, 'Self-link payment',
           'draft', ${documentId}, 'document')
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item)
        values
          (${openLineId}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ar},
           ${org.subsidiaryId}, 50, 'CAD', 50, 1, ${org.customerId}, true),
          (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.bank},
           ${org.subsidiaryId}, -50, 'CAD', -50, 1, null, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now()
         where id = ${entryId}
      `);
      await db.execute(sql`
        update documents
           set posted_entry_id = ${entryId}, posting_period_id = ${org.periodId}, status = 'posted'
         where id = ${documentId}
      `);

      const result = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "self-1", appliedRef: "self-1", amount: "50", currency: "CAD" },
      ]);
      assert.deepEqual(result, {
        pairs: 1,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "50.0000",
      });
      const applied = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from applications where org_id = ${org.orgId}`);
      assert.equal(applied.rows[0]!.count, "0");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation caps two pairs sharing one payment line",
  { skip: !DB },
  async () => {
    // One call, one 120 payment line, links of 100 and 60: the second pair
    // must see the room the first pair consumed. Dropped accumulators (or a
    // pair remainder that never decrements) over-settle the line instead.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      await postFixtureDoc(org, "PAY-SHARED", "pay-shared", [
        { accountId: org.accounts.ar, amount: "120", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-120", partyId: null, open: false },
      ], "customer_payment");
      await postFixtureDoc(org, "INV-SHARED-A", "inv-shared-a", [
        { accountId: org.accounts.ar, amount: "-100", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "100", partyId: null, open: false },
      ]);
      await postFixtureDoc(org, "INV-SHARED-B", "inv-shared-b", [
        { accountId: org.accounts.ar, amount: "-60", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "60", partyId: null, open: false },
      ]);
      const result = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-shared", appliedRef: "inv-shared-a", amount: "100", currency: "CAD" },
        { paymentRef: "pay-shared", appliedRef: "inv-shared-b", amount: "60", currency: "CAD" },
      ]);
      assert.deepEqual(result, {
        pairs: 2,
        inserted: 2,
        insertedAmount: "120.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "40.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation caps two pairs sharing one invoice line",
  { skip: !DB },
  async () => {
    // Mirror image: two payments against one 120 invoice line with links of
    // 100 and 60 settle 120 and leave 40 unallocated.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      await postFixtureDoc(org, "PAY-SHARED-A", "pay-shared-a", [
        { accountId: org.accounts.ar, amount: "100", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-100", partyId: null, open: false },
      ], "customer_payment");
      await postFixtureDoc(org, "PAY-SHARED-B", "pay-shared-b", [
        { accountId: org.accounts.ar, amount: "60", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-60", partyId: null, open: false },
      ], "customer_payment");
      await postFixtureDoc(org, "INV-SHARED", "inv-shared", [
        { accountId: org.accounts.ar, amount: "-120", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "120", partyId: null, open: false },
      ]);
      const result = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-shared-a", appliedRef: "inv-shared", amount: "100", currency: "CAD" },
        { paymentRef: "pay-shared-b", appliedRef: "inv-shared", amount: "60", currency: "CAD" },
      ]);
      assert.deepEqual(result, {
        pairs: 2,
        inserted: 2,
        insertedAmount: "120.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "40.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation re-running a foreign pair with a larger link settles nothing new",
  { skip: !DB },
  async () => {
    // After a 120 link fully settles the payment line, a 130 link must find
    // no room: the hydrated usage (not the pair delta alone) binds. Flipped
    // hydration columns or inflated accumulators settle phantom money here.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      await postFixtureDoc(org, "PAY-FX-RERUN", "pay-fx-rerun", [
        { accountId: org.accounts.ar, amount: "120", txnAmount: "100", fxRate: "1.2", currency: "USD", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-120", txnAmount: "-100", fxRate: "1.2", currency: "USD", partyId: null, open: false },
      ], "customer_payment");
      // Same transaction currency on both sides with different carrying
      // rates: cross-currency pairs never match by design (the reconciler
      // joins on line currency), but the FX hydration/capacity paths still
      // apply and the realized-FX entry still mints on the rate gap.
      await postFixtureDoc(org, "INV-FX-RERUN", "inv-fx-rerun", [
        { accountId: org.accounts.ar, amount: "-110", txnAmount: "-100", fxRate: "1.1", currency: "USD", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "110", txnAmount: "100", fxRate: "1.1", currency: "USD", partyId: null, open: false },
      ]);
      const first = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-fx-rerun", appliedRef: "inv-fx-rerun", amount: "120", currency: "CAD" },
      ]);
      assert.deepEqual(first, {
        pairs: 1,
        inserted: 1,
        insertedAmount: "110.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
      const second = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-fx-rerun", appliedRef: "inv-fx-rerun", amount: "130", currency: "CAD" },
      ]);
      assert.deepEqual(second, {
        pairs: 1,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "10.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation caps a huge second link by remaining transaction capacity",
  { skip: !DB },
  async () => {
    // The payment line keeps 30 of transaction room after the first call; a
    // 1000 link must settle exactly that. A negated capacity guard settles
    // the whole link against room that does not exist.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      await postFixtureDoc(org, "PAY-CAP", "pay-cap", [
        { accountId: org.accounts.ar, amount: "120", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-120", partyId: null, open: false },
      ], "customer_payment");
      await postFixtureDoc(org, "INV-CAP-A", "inv-cap-a", [
        { accountId: org.accounts.ar, amount: "-1000", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "1000", partyId: null, open: false },
      ]);
      const first = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-cap", appliedRef: "inv-cap-a", amount: "90", currency: "CAD" },
      ]);
      assert.equal(first.inserted, 1);
      const second = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-cap", appliedRef: "inv-cap-a", amount: "1000", currency: "CAD" },
      ]);
      assert.deepEqual(second, {
        pairs: 1,
        inserted: 1,
        insertedAmount: "30.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "880.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation settles dust usage exactly and never twice",
  { skip: !DB },
  async () => {
    // A 0.0001 settlement is real usage: skipping it overstates room on the
    // next call, and a one-unit remainder must still allocate. The third
    // call re-runs the settled total and reports it settled.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      await postFixtureDoc(org, "PAY-DUST", "pay-dust", [
        { accountId: org.accounts.ar, amount: "100", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-100", partyId: null, open: false },
      ], "customer_payment");
      await postFixtureDoc(org, "INV-DUST", "inv-dust", [
        { accountId: org.accounts.ar, amount: "-100", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "100", partyId: null, open: false },
      ]);
      const first = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-dust", appliedRef: "inv-dust", amount: "0.0001", currency: "CAD" },
      ]);
      assert.deepEqual(first, {
        pairs: 1,
        inserted: 1,
        insertedAmount: "0.0001",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
      const second = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-dust", appliedRef: "inv-dust", amount: "100.0001", currency: "CAD" },
      ]);
      assert.deepEqual(second, {
        pairs: 1,
        inserted: 1,
        insertedAmount: "99.9999",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0001",
      });
      // Re-running exactly the settled total reports the pair settled; the
      // 0.0001 the second call left unallocated stays unallocated, not phantom.
      const third = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-dust", appliedRef: "inv-dust", amount: "100.0000", currency: "CAD" },
      ]);
      assert.deepEqual(third, {
        pairs: 1,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 1,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation allocates a one-unit remainder from one-unit rooms",
  { skip: !DB },
  async () => {
    // After settling 50 of a 50.0001 payment, every room holds exactly one
    // unit: guards widened to one unit skip the 0.0001 settlement and leave
    // it unallocated.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      await postFixtureDoc(org, "PAY-DUSTB", "pay-dustb", [
        { accountId: org.accounts.ar, amount: "50.0001", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-50.0001", partyId: null, open: false },
      ], "customer_payment");
      await postFixtureDoc(org, "INV-DUSTB", "inv-dustb", [
        { accountId: org.accounts.ar, amount: "-100", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "100", partyId: null, open: false },
      ]);
      const first = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-dustb", appliedRef: "inv-dustb", amount: "50", currency: "CAD" },
      ]);
      assert.equal(first.inserted, 1);
      const second = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-dustb", appliedRef: "inv-dustb", amount: "50.0001", currency: "CAD" },
      ]);
      assert.deepEqual(second, {
        pairs: 1,
        inserted: 1,
        insertedAmount: "0.0001",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation settles a dust-sized open line in full",
  { skip: !DB },
  async () => {
    // A 0.0001 invoice line is settleable: room and candidate guards that
    // demand more than one unit skip it and leave it open forever.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      await postFixtureDoc(org, "PAY-DUSTC", "pay-dustc", [
        { accountId: org.accounts.ar, amount: "100", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-100", partyId: null, open: false },
      ], "customer_payment");
      await postFixtureDoc(org, "INV-DUSTC", "inv-dustc", [
        { accountId: org.accounts.ar, amount: "-0.0001", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "0.0001", partyId: null, open: false },
      ]);
      const result = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-dustc", appliedRef: "inv-dustc", amount: "0.0001", currency: "CAD" },
      ]);
      assert.deepEqual(result, {
        pairs: 1,
        inserted: 1,
        insertedAmount: "0.0001",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation walks three payment lines for a dust remainder",
  { skip: !DB },
  async () => {
    // PayLines stay line-number sorted, so one 80.0001 link walks lines 1-3
    // (40, 40, 40.0001) in order and settles everything: a remainder check
    // widened to one unit breaks out after line 2 and strands the dust.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      // Three open AR lines, not one: the helper posts the whole balanced
      // entry (three open lines plus the offsetting bank line) in one go.
      await postFixtureDoc(org, "PAY-DUST3", "pay-dust3", [
        { accountId: org.accounts.ar, amount: "40", partyId: customer, open: true },
        { accountId: org.accounts.ar, amount: "40", partyId: customer, open: true },
        { accountId: org.accounts.ar, amount: "40.0001", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-120.0001", partyId: null, open: false },
      ], "customer_payment");
      await postFixtureDoc(org, "INV-DUST3", "inv-dust3", [
        { accountId: org.accounts.ar, amount: "-120", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "120", partyId: null, open: false },
      ]);
      const result = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-dust3", appliedRef: "inv-dust3", amount: "80.0001", currency: "CAD" },
      ]);
      assert.deepEqual(result, {
        pairs: 1,
        inserted: 3,
        insertedAmount: "80.0001",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation breaks on a zero transaction allocation instead of posting dust",
  { skip: !DB },
  async () => {
    // With a 1000 carrying rate, a one-unit (0.0001) functional remainder
    // rounds to a zero transaction allocation: posting it would write a
    // zero-txn application row, so the drain breaks and leaves the dust
    // unallocated instead.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      await postFixtureDoc(org, "PAY-DUSTFX", "pay-dustfx", [
        { accountId: org.accounts.ar, amount: "101000", txnAmount: "101", fxRate: "1000", currency: "USD", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-101000", txnAmount: "-101", fxRate: "1000", currency: "USD", partyId: null, open: false },
      ], "customer_payment");
      await postFixtureDoc(org, "INV-DUSTFX", "inv-dustfx", [
        { accountId: org.accounts.ar, amount: "-10000", txnAmount: "-10000", fxRate: "1", currency: "USD", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "10000", txnAmount: "10000", fxRate: "1", currency: "USD", partyId: null, open: false },
      ]);
      const first = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-dustfx", appliedRef: "inv-dustfx", amount: "100000", currency: "CAD" },
      ]);
      assert.deepEqual(first, {
        pairs: 1,
        inserted: 1,
        insertedAmount: "100.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0000",
      });
      const second = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-dustfx", appliedRef: "inv-dustfx", amount: "100000.0001", currency: "CAD" },
      ]);
      assert.deepEqual(second, {
        pairs: 1,
        inserted: 0,
        insertedAmount: "0.0000",
        alreadySettled: 0,
        skippedNoLine: 0,
        unallocated: "0.0001",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application reconciliation derives a fresh entry number on collision",
  { skip: !DB },
  async () => {
    // The preferred realized-FX number is taken by an earlier entry, so the
    // allocator must walk to the first free generation. Starting at zero,
    // suffixing unconditionally, or stepping by two all mint the wrong name.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      const payment = await postFixtureDoc(org, "PAY-COLLIDE", "pay-collide", [
        { accountId: org.accounts.ar, amount: "120", txnAmount: "100", fxRate: "1.2", currency: "USD", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-120", txnAmount: "-100", fxRate: "1.2", currency: "USD", partyId: null, open: false },
      ], "customer_payment");
      await postFixtureDoc(org, "INV-COLLIDE", "inv-collide", [
        { accountId: org.accounts.ar, amount: "-110", txnAmount: "-100", fxRate: "1.1", currency: "USD", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "110", txnAmount: "100", fxRate: "1.1", currency: "USD", partyId: null, open: false },
      ]);
      // Squat the preferred realized-FX number with a real posted entry (a
      // bare lineless entry trips the posted-balanced guard; closed lines
      // keep it balanced and invisible to the reconciler).
      await postFixtureDoc(org, `${payment.documentId}-FX`, "blocker-number", [
        { accountId: org.accounts.ar, amount: "10", partyId: customer, open: false },
        { accountId: org.accounts.bank, amount: "-10", partyId: null, open: false },
      ]);
      const result = await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-collide", appliedRef: "inv-collide", amount: "120", currency: "CAD" },
      ]);
      assert.equal(result.inserted, 1);
      const numbers = await db.execute<{ entryNumber: string }>(sql`
        select e.entry_number as "entryNumber"
          from journal_entries e
         where e.org_id = ${org.orgId} and e.origin = 'fx_settlement'
      `);
      assert.deepEqual(numbers.rows.map((row) => row.entryNumber), [`${payment.documentId}-FX-2`]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "open-balance recomputation heals out-of-band drift without touching clean rows",
  { skip: !DB },
  async () => {
    // recomputeOpenBalances has no coverage: direct document edits bypass
    // the application trigger, and only the recompute restores the
    // denormalized balance the aging reports read.
    const org = await createScratchOrg();
    const customer = org.customerId;
    try {
      await postFixtureDoc(org, "PAY-HEAL", "pay-heal", [
        { accountId: org.accounts.ar, amount: "50", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "-50", partyId: null, open: false },
      ], "customer_payment");
      const invoice = await postFixtureDoc(org, "INV-HEAL", "inv-heal", [
        { accountId: org.accounts.ar, amount: "-50", partyId: customer, open: true },
        { accountId: org.accounts.bank, amount: "50", partyId: null, open: false },
      ]);
      await reconcileApplications(org.orgId, "sourceId", [
        { paymentRef: "pay-heal", appliedRef: "inv-heal", amount: "50", currency: "CAD" },
      ]);
      const settled = await db.execute<{ balance: string }>(sql`
        select open_balance::text as balance from documents
         where id = ${invoice.documentId} and org_id = ${org.orgId}`);
      assert.equal(settled.rows[0]!.balance, "0.0000");
      await db.execute(sql`
        update documents set open_balance = '999.0000'
         where id = ${invoice.documentId} and org_id = ${org.orgId}`);
      assert.equal(await recomputeOpenBalances(org.orgId), 1);
      const healed = await db.execute<{ balance: string }>(sql`
        select open_balance::text as balance from documents
         where id = ${invoice.documentId} and org_id = ${org.orgId}`);
      assert.equal(healed.rows[0]!.balance, "0.0000");
      assert.equal(await recomputeOpenBalances(org.orgId), 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
