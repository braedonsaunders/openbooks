import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  importSettlementBatch,
  postSettlementBatch,
  PspSettlementError,
  type ParsedSettlement,
} from "./psp-settlement.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { openItemsForParty } from "./payment-queries.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { sameCurrencyAllocation } from "./settlement-policy.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function ensureOpenPeriod(orgId: string, periodId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const [year, month] = today.split("-").map(Number) as [number, number, number];
  await db.execute(sql`
    insert into accounting_periods
      (org_id, fiscal_calendar_id, fiscal_year, period_number, name,
       starts_on, ends_on, is_adjustment)
    select ${orgId}, fiscal_calendar_id, ${year}, ${month}, ${today.slice(0, 7)},
           ${`${year}-${String(month).padStart(2, "0")}-01`},
           ${new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)}, false
      from accounting_periods
     where id = ${periodId}
    on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do nothing
  `);
}

/** A posted USD receipt for a USD invoice, booked at fxRate into CAD books. */
async function usdReceipt(org: Awaited<ReturnType<typeof createScratchOrg>>, userId: string, fxRate: string): Promise<{ invoiceId: string; receiptId: string }> {
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${org.orgId}, 'USD', 'CAD', ${org.date}, 'spot', ${fxRate}, 'test')`);
  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`INV-${randomUUID().slice(0, 8)}`},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'USD', '1',
            '100', '0', '100', ${userId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
  await db.execute(sql`update documents set status = 'approved', updated_at = now() where id = ${invoiceId} and org_id = ${org.orgId}`);
  await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });

  const payment = await createPaymentDocument({
    orgId: org.orgId,
    kind: "customer_payment",
    createdBy: userId,
    allowedSubsidiaryIds: null,
    partyId: org.customerId,
    bankAccountId: org.accounts.bank,
    documentDate: org.date,
    subsidiaryId: org.subsidiaryId,
    currency: "USD",
    fxRate,
  });
  const openItems = await openItemsForParty(org.customerId, "ar", org.orgId);
  const item = openItems.find((i) => i.documentId === invoiceId);
  assert.ok(item, "invoice open item exists");
  const allocations = [sameCurrencyAllocation(item.lineId, "100")];
  await updateDraftPayment(payment.id, { allocations, referenceNumber: "fx-receipt" }, userId, org.orgId);
  const submission = await submitAndReleaseIfUngated("customer_payment", payment.id, userId);
  assert.equal(submission.gated, false);
  await postPaymentWithApplications(payment.id, allocations, userId, "api");
  return { invoiceId, receiptId: payment.id };
}

function eurBatch(receiptId: string, fx: ParsedSettlement["fx"]): ParsedSettlement {
  return {
    provider: "stripe",
    externalRef: `po_fx_${randomUUID().slice(0, 8)}`,
    settlementDate: "2026-07-10",
    currency: "EUR",
    lines: [{ kind: "charge", amount: "100", currency: "USD", documentId: receiptId, externalRef: "txn_fx_1" }],
    fx,
    memo: "EUR payout of USD charges",
  };
}

test("a EUR payout of USD charges posts balanced with realized FX", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "FX Tester", "admin");
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":true}}'::jsonb where id = ${org.orgId}`);
    await ensureOpenPeriod(org.orgId, org.periodId);
    // The receipt booked 100 USD at 1.35; the payout converts at 0.92 and the
    // payout books at 1.47, so the run realizes a 0.24 gain.
    const { receiptId } = await usdReceipt(org, userId, "1.3500000000");
    const accounts = {
      bankAccountId: org.accounts.bank,
      feeAccountId: org.accounts.adjustment,
      disputeAccountId: org.accounts.adjustment,
      fxAccountId: org.accounts.fxGainLoss,
      clearingAccountId: org.accounts.clearing,
    };
    const { batchId } = await importSettlementBatch(
      org.orgId,
      userId,
      eurBatch(receiptId, {
        sourceCurrency: "USD",
        rate: "0.9200000000",
        rateSource: "stripe:balance_transaction",
        payoutRate: "1.4700000000",
        payoutRateSource: "test:evidenced",
      }),
      accounts,
      null,
    );
    const posted = await postSettlementBatch(org.orgId, batchId, userId, null);
    assert.ok(posted.entryId);

    const lines = (await db.execute<{ name: string; amount: string }>(sql`
      select a.name, jl.amount::text as amount
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${org.orgId} and je.id = ${posted.entryId}
       order by a.name`)).rows;
    const total = lines.reduce((sum, l) => sum + BigInt(Math.round(Number(l.amount) * 10_000)), 0n);
    assert.equal(total, 0n);
    const byName = new Map(lines.map((l) => [l.name, l.amount]));
    // Bank: 92 EUR × 1.47 = 135.24 CAD. Booked: 100 × 1.35 = 135 CAD.
    assert.equal(byName.get("Cash"), "135.2400");
    assert.equal(byName.get("Realized FX Gain or Loss"), "-0.2400");
    assert.equal(byName.get("Received Not Billed"), "-135.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a foreign-currency batch without rate evidence refuses naming the field", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "FX Tester", "admin");
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":true}}'::jsonb where id = ${org.orgId}`);
    const { receiptId } = await usdReceipt(org, userId, "1.3500000000");
    const accounts = {
      bankAccountId: org.accounts.bank,
      feeAccountId: org.accounts.adjustment,
      disputeAccountId: org.accounts.adjustment,
      fxAccountId: org.accounts.fxGainLoss,
      clearingAccountId: org.accounts.clearing,
    };
    await assert.rejects(
      () => importSettlementBatch(org.orgId, userId, eurBatch(receiptId, null), accounts, null),
      (error) => error instanceof PspSettlementError && /conversion_rate|exchange_rate/.test(error.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
