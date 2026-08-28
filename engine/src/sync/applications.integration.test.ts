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
