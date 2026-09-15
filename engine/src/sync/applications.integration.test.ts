import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { reconcileApplications } from "./applications.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";

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
        { paymentRef: "payment-1", appliedRef: "invoice-1", amount: "50" },
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
        { paymentRef: "payment-1", appliedRef: "invoice-1", amount: "50" },
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
        { paymentRef: "payment-fx", appliedRef: "invoice-fx", amount: "120" },
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
        { paymentRef: "payment-fx", appliedRef: "invoice-fx", amount: "120" },
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
        { paymentRef: "payment-fx2", appliedRef: "invoice-fx2a", amount: "120" },
        { paymentRef: "payment-fx2", appliedRef: "invoice-fx2b", amount: "125" },
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
        { paymentRef: "payment-fx2", appliedRef: "invoice-fx2a", amount: "120" },
        { paymentRef: "payment-fx2", appliedRef: "invoice-fx2b", amount: "125" },
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
        { paymentRef: "payment-over", appliedRef: "invoice-over", amount: "100" },
        { paymentRef: "payment-over", appliedRef: "ghost-9", amount: "10" },
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
        { paymentRef: "payment-over", appliedRef: "invoice-over", amount: "100" },
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
        { paymentRef: "payment-part", appliedRef: "invoice-part", amount: "30" },
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
        { paymentRef: "payment-part", appliedRef: "invoice-part", amount: "50" },
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
        { paymentRef: "payment-part", appliedRef: "invoice-part", amount: "50" },
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
