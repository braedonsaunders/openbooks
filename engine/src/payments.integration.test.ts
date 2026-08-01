import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  createPaymentDocument,
  postPaymentWithApplications,
  reversePaymentForReturn,
  updateDraftPayment,
} from "./payments.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("cross-currency payment, dual-amount application, realized FX, evidence, and reversal are atomic", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "FX Tester", "admin");

    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved', 'INV-FX-1',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'EUR', '1.2',
              '100', '0', '100', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '100')`);
    const invoiceEntryId = await postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
    const invoiceControl = (await db.execute(sql`
      select id from journal_lines where entry_id = ${invoiceEntryId} and account_id = ${org.accounts.ar}
    `)) as unknown as { rows: { id: string }[] };
    const targetLineId = invoiceControl.rows[0]!.id;

    const payment = await createPaymentDocument({
      orgId: org.orgId,
      kind: "customer_payment",
      createdBy: userId,
      partyId: org.customerId,
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      documentDate: org.date,
      currency: "USD",
      fxRate: "1.625",
    });
    await updateDraftPayment(payment.id, {
      allocations: [{
        openLineId: targetLineId,
        sourceTransactionAmount: "80",
        targetTransactionAmount: "100",
        settlementRate: "1.25",
        settlementRateSource: "manual",
        settlementRateReference: "BANK-SETTLEMENT-42",
      }],
      bankAccountId: org.accounts.bank,
    }, userId);
    await db.execute(sql`
      update documents
         set status = 'approved', submitted_by = ${userId}, submitted_at = now()
       where id = ${payment.id}
    `);

    // A missing realized-FX account must roll back the payment itself, not
    // leave a posted-but-unapplied transaction behind.
    await db.execute(sql`
      update orgs set settings = settings #- '{controlAccounts,fxRealizedGainLoss}' where id = ${org.orgId}`);
    await assert.rejects(postPaymentWithApplications(payment.id, undefined, userId), /realized FX gain\/loss account is not configured/);
    const afterFailure = (await db.execute(sql`
      select status, posted_entry_id,
             (select count(*) from journal_entries where source_document_id = ${payment.id})::int as entries
        from documents where id = ${payment.id}
    `)) as unknown as { rows: { status: string; posted_entry_id: string | null; entries: number }[] };
    assert.deepEqual(afterFailure.rows[0], { status: "approved", posted_entry_id: null, entries: 0 });

    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,fxRealizedGainLoss}', to_jsonb(${org.accounts.fxGainLoss}::text), true)
       where id = ${org.orgId}`);
    const { entryId: paymentEntryId } = await postPaymentWithApplications(payment.id, undefined, userId);
    const evidence = (await db.execute(sql`
      select a.amount, a.source_amount,
             a.source_transaction_amount, a.source_transaction_currency,
             a.target_transaction_amount, a.target_transaction_currency,
             a.settlement_rate, a.settlement_rate_source, a.settlement_rate_reference,
             a.fx_gain_loss_entry_id, fx.status as fx_status,
             (select coalesce(sum(amount), 0) from journal_lines where entry_id = a.fx_gain_loss_entry_id) as fx_balance,
             (select amount from journal_lines where entry_id = a.fx_gain_loss_entry_id and account_id = ${org.accounts.ar}) as control_adjustment,
             (select amount from journal_lines where entry_id = a.fx_gain_loss_entry_id and account_id = ${org.accounts.fxGainLoss}) as gain_loss
        from applications a join journal_entries fx on fx.id = a.fx_gain_loss_entry_id
       where a.from_line_id in (select id from journal_lines where entry_id = ${paymentEntryId})
    `)) as unknown as { rows: {
      amount: string; source_amount: string;
      source_transaction_amount: string; source_transaction_currency: string;
      target_transaction_amount: string; target_transaction_currency: string;
      settlement_rate: string; settlement_rate_source: string; settlement_rate_reference: string;
      fx_gain_loss_entry_id: string; fx_status: string; fx_balance: string;
      control_adjustment: string; gain_loss: string;
    }[] };
    assert.deepEqual(evidence.rows[0], {
      amount: "120.0000",
      source_amount: "130.0000",
      source_transaction_amount: "80.0000",
      source_transaction_currency: "USD",
      target_transaction_amount: "100.0000",
      target_transaction_currency: "EUR",
      settlement_rate: "1.2500000000",
      settlement_rate_source: "manual",
      settlement_rate_reference: "BANK-SETTLEMENT-42",
      fx_gain_loss_entry_id: evidence.rows[0]!.fx_gain_loss_entry_id,
      fx_status: "posted",
      fx_balance: "0.0000",
      control_adjustment: "10.0000",
      gain_loss: "-10.0000",
    });

    const fxEntryId = evidence.rows[0]!.fx_gain_loss_entry_id;
    const reversalId = await reversePaymentForReturn(payment.id, org.orgId, "NSF", userId, org.date);
    assert.ok(reversalId);
    const reversed = (await db.execute(sql`
      select
        (select status from journal_entries where id = ${paymentEntryId}) as payment_status,
        (select status from journal_entries where id = ${fxEntryId}) as fx_status,
        (select count(*) from journal_entries where reverses_entry_id in (${paymentEntryId}, ${fxEntryId}) and status = 'posted')::int as reversals,
        (select count(*) from applications where from_line_id in (select id from journal_lines where entry_id = ${paymentEntryId}) and unapplied_at is not null)::int as unapplied,
        (select status from documents where id = ${payment.id}) as document_status
    `)) as unknown as { rows: { payment_status: string; fx_status: string; reversals: number; unapplied: number; document_status: string }[] };
    assert.deepEqual(reversed.rows[0], {
      payment_status: "reversed",
      fx_status: "reversed",
      reversals: 2,
      unapplied: 1,
      document_status: "voided",
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
