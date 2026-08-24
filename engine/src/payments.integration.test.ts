import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "./db.ts";
import {
  cancelPaymentRun,
  createPaymentDocument,
  createPaymentRun,
  PaymentError,
  postPaymentWithApplications,
  reversePaymentForReturn,
  updateDraftPayment,
} from "./payments.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** The storage-enforced duplicate-live-reservation violation, anywhere in a cause chain. */
function isLiveSourceConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === "payment_run_items_live_source") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

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
    const invoiceControl = (await db.execute<{ id: string }>(sql`
      select id from journal_lines where entry_id = ${invoiceEntryId} and account_id = ${org.accounts.ar}
    `));
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
    }, userId, org.orgId);
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
    const afterFailure = (await db.execute<{ status: string; posted_entry_id: string | null; entries: number }>(sql`
      select status, posted_entry_id,
             (select count(*) from journal_entries where source_document_id = ${payment.id})::int as entries
        from documents where id = ${payment.id}
    `));
    assert.deepEqual(afterFailure.rows[0], { status: "approved", posted_entry_id: null, entries: 0 });

    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,fxRealizedGainLoss}', to_jsonb(${org.accounts.fxGainLoss}::text), true)
       where id = ${org.orgId}`);
    const { entryId: paymentEntryId } = await postPaymentWithApplications(payment.id, undefined, userId);
    const evidence = (await db.execute<{
      amount: string; source_amount: string;
      source_transaction_amount: string; source_transaction_currency: string;
      target_transaction_amount: string; target_transaction_currency: string;
      settlement_rate: string; settlement_rate_source: string; settlement_rate_reference: string;
      fx_gain_loss_entry_id: string; fx_status: string; fx_balance: string;
      control_adjustment: string; gain_loss: string;
    }>(sql`
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
    `));
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
    const reversed = (await db.execute<{ payment_status: string; fx_status: string; reversals: number; unapplied: number; document_status: string }>(sql`
      select
        (select status from journal_entries where id = ${paymentEntryId}) as payment_status,
        (select status from journal_entries where id = ${fxEntryId}) as fx_status,
        (select count(*) from journal_entries where reverses_entry_id in (${paymentEntryId}, ${fxEntryId}) and status = 'posted')::int as reversals,
        (select count(*) from applications where from_line_id in (select id from journal_lines where entry_id = ${paymentEntryId}) and unapplied_at is not null)::int as unapplied,
        (select status from documents where id = ${payment.id}) as document_status
    `));
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

test("an open item can be reserved by only one live payment run at a time", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const options = await withBypass(async () => {
      const actorId = await createScratchUser(org.orgId, "Run Operator", "accountant");
      const formatId = randomUUID();
      const profileId = randomUUID();
      const billId = randomUUID();

      await db.execute(sql`
        insert into payment_formats
          (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
        values
          (${formatId}, ${org.orgId}, 'CPA005-RESERVE', 'CPA-005 credit reservation test',
           'cpa005_credit', 'credit', 'CA', 'CAD', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into payment_bank_profiles
          (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id,
           currency, country, created_by, updated_by)
        values
          (${profileId}, ${org.orgId}, 'Reservation run profile', ${org.accounts.bank},
           ${org.subsidiaryId}, ${formatId}, 'CAD', 'CA', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${billId}, ${org.orgId}, 'vendor_bill', 'approved', 'BILL-RESERVE-1',
                ${org.subsidiaryId}, ${org.vendorId}, ${org.date}, 'CAD', '1',
                '125', '0', '125', ${actorId})`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount)
        values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', '125',
                '125', '0')`);
      await postDocument(billId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });

      return { actorId, profileId, billId };
    });

    await withOrgContext(org.orgId, async () => {
      const openLineId = (await db.execute<{ id: string }>(sql`
        select jl.id as id
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
         where je.source_document_id = ${options.billId}
           and je.status = 'posted' and jl.is_open_item and jl.amount < 0
      `)).rows[0]!.id;

      const createRun = () =>
        createPaymentRun({
          orgId: org.orgId,
          createdBy: options.actorId,
          paymentBankProfileId: options.profileId,
          billDocumentIds: [options.billId],
          scheduledFor: org.date,
        });
      const itemStatuses = (runId: string) =>
        db.execute<{ status: string; n: number }>(sql`
          select status, count(*)::int as n
            from payment_run_items
           where org_id = ${org.orgId} and payment_run_id = ${runId}
             and source_open_line_id = ${openLineId}
           group by status`);

      // The first live run reserves the bill's payable line.
      const firstRun = await createRun();
      assert.deepEqual((await itemStatuses(firstRun.id)).rows, [{ status: "selected", n: 1 }]);

      // An overlapping selection of the reserved bill is refused while that
      // run is live.
      await assert.rejects(createRun, (error: unknown) => {
        assert.ok(error instanceof PaymentError);
        assert.match(error.message, /already selected in another live payment run/);
        return true;
      });

      // PostgreSQL — not the service-level selection filter — is the final
      // authority: a writer that skips the filter still cannot double-reserve.
      const ghostRunId = randomUUID();
      await db.execute(sql`
        insert into payment_runs
          (id, org_id, run_number, bank_account_id, payment_bank_profile_id,
           method, direction, purpose, currency, status, created_by)
        values (${ghostRunId}, ${org.orgId}, 'RUN-RESERVE-GHOST', ${org.accounts.bank},
                ${options.profileId}, 'eft', 'outbound', 'vendor_payments',
                'CAD', 'draft', ${options.actorId})`);
      await assert.rejects(
        db.execute(sql`
          insert into payment_run_items
            (org_id, payment_run_id, source_document_id, source_open_line_id, kind,
             gross_amount, payment_amount, currency, status, created_by)
          values (${org.orgId}, ${ghostRunId}, ${options.billId}, ${openLineId}, 'bill',
                  '125', '125', 'CAD', 'selected', ${options.actorId})`),
        isLiveSourceConflict,
      );

      // Cancelling the live run releases the reservation through the
      // lifecycle triggers...
      await cancelPaymentRun(firstRun.id, org.orgId);
      assert.deepEqual((await itemStatuses(firstRun.id)).rows, [{ status: "excluded", n: 1 }]);

      // ...and only a live (`selected`) item reserves its source line, so a
      // new run can reserve the released bill immediately while the excluded
      // history coexists.
      const secondRun = await createRun();
      assert.notEqual(secondRun.id, firstRun.id);
      assert.deepEqual((await itemStatuses(secondRun.id)).rows, [{ status: "selected", n: 1 }]);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
