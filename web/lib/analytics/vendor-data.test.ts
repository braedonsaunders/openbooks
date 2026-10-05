import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

const { vendorData } = await import("./vendor-data.ts");

const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { createPaymentDocument, updateDraftPayment } = await import("@openbooks/engine/src/payments/payment-documents.ts"), { postPaymentWithApplications } = await import("@openbooks/engine/src/payments/payment-posting.ts"), { sameCurrencyAllocation } = await import("@openbooks/engine/src/payments/settlement-policy.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("vendor payment analytics counts an installment bill once and uses final settlement", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const billId = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into vendor_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${org.vendorId})`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, party_id, subsidiary_id,
           document_date, posting_date, due_date, currency, fx_rate, subtotal,
           tax_total, total, custom)
        values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', 'ANALYTICS-INSTALLMENT-1',
                ${org.vendorId}, ${org.subsidiaryId}, '2026-07-15', '2026-07-15',
                '2026-07-20', 'CAD', '1', '100', '0', '100', '{}'::jsonb)`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount)
        values (${randomUUID()}, ${org.orgId}, ${billId}, 1, ${org.accounts.cogs},
                '1', '100', '100', '0')`);
      await db.execute(sql`
        update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
    });

    const billEntryId = await withBypass(() => postDocument(billId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }, { deferEffects: true, suppressAutomation: true }));
    const targetLineId = (await withBypass(() => db.execute<{ id: string }>(sql`
      select id from journal_lines
       where org_id = ${org.orgId} and entry_id = ${billEntryId}
         and account_id = ${org.accounts.ap} and is_open_item
    `))).rows[0]?.id;
    assert.ok(targetLineId, "posted bill must have an AP open-item line");
    const payableLineId: string = targetLineId;

    const postInstallment = async (documentDate: string, amount: string): Promise<void> => {
      const payment = await withBypass(() => createPaymentDocument({ allowedSubsidiaryIds: null,
        orgId: org.orgId,
        kind: "vendor_payment",
        createdBy: null,
        partyId: org.vendorId,
        bankAccountId: org.accounts.bank,
        subsidiaryId: org.subsidiaryId,
        documentDate,
        currency: "CAD",
      }));
      await withBypass(() => updateDraftPayment(
        payment.id,
        {
          allocations: [sameCurrencyAllocation(payableLineId, amount)],
          bankAccountId: org.accounts.bank,
        },
        null,
        org.orgId,
      ));
      await withBypass(() => db.execute(sql`
        update documents set status = 'approved' where id = ${payment.id} and org_id = ${org.orgId}`));
      await withBypass(() => postPaymentWithApplications(payment.id, undefined, undefined));
    };

    await postInstallment("2026-07-19", "40");
    await postInstallment("2026-07-25", "60");

    const data = await withOrgContext(org.orgId, () => vendorData(
      { from: "2026-07-01", to: "2026-07-31", label: "July 2026" },
      org.orgId,
      null,
    ));
    const row = data.rows.find((candidate) => candidate.id === org.vendorId);
    assert.ok(row, "vendor payment row should be present in the spend window");
    assert.equal(row.paidBills, 1, "two installments must count as one paid bill");
    assert.equal(row.avgDaysToPay, 10, "average days must run from the bill date to final payment (July 25 − July 15)");
    assert.equal(row.onTimePct, 0, "a bill whose final installment is late is not on time");
    assert.equal(row.lateSpend, "60.0000", "late spend must retain the late installment amount");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("vendor spend excludes parties without a vendor role", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      await db.execute(sql`
        insert into vendor_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${org.vendorId})`);
      const entryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'NON-VENDOR-SPEND', '2026-07-10', ${org.periodId}, 'draft', 'manual')`);
      await db.execute(sql`
        insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${org.customerId}, '500', 'CAD', '500', '1'),
               (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${org.customerId}, '-500', 'CAD', '-500', '1')`);
      await db.execute(sql`
        update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
    });
    const data = await withOrgContext(org.orgId, () => vendorData(
      { from: "2026-07-01", to: "2026-07-31", label: "July 2026" },
      org.orgId,
      null,
    ));
    assert.equal(
      data.rows.find((candidate) => candidate.id === org.customerId),
      undefined,
      "expense lines against a customer must not read as vendor spend",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("terms-based due dates judge on-time and undated bills are counted, not scored", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const termsId = randomUUID();
    const termsVendor = randomUUID();
    const bareVendor = randomUUID();
    const quietVendor = randomUUID();
    const refundVendor = randomUUID();
    const seedBill = async (
      docNum: string, party: string, billDate: string, payDate: string, docDue: string | null,
    ): Promise<void> => {
      const docId = randomUUID();
      const billEntry = randomUUID();
      const billLine = randomUUID();
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, due_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
        values (${docId}, ${org.orgId}, 'vendor_bill', ${docNum}, ${party}, ${org.subsidiaryId}, ${billDate}, ${billDate}, ${docDue}, 'CAD', '1', 'draft', '100', 0, '100', '100')`);
      await db.execute(sql`
        insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, source_document_id)
        values (${billEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${docNum}, ${billDate}, ${org.periodId}, 'draft', 'manual', ${docId})`);
      await db.execute(sql`
        insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${billLine}, ${org.orgId}, ${billEntry}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${party}, true, '-100', 'CAD', '-100', 1),
               (${randomUUID()}, ${org.orgId}, ${billEntry}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, ${party}, false, '100', 'CAD', '100', 1)`);
      await db.execute(sql`
        update journal_entries set status = 'posted', posted_at = now() where id = ${billEntry}`);
      await db.execute(sql`
        update documents set status = 'posted', posted_entry_id = ${billEntry}, posting_period_id = ${org.periodId} where id = ${docId}`);
      const payEntry = randomUUID();
      const payLine = randomUUID();
      await db.execute(sql`
        insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${payEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${'PAY-' + docNum}, ${payDate}, ${org.periodId}, 'draft', 'manual')`);
      await db.execute(sql`
        insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${payLine}, ${org.orgId}, ${payEntry}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${party}, true, '100', 'CAD', '100', 1),
               (${randomUUID()}, ${org.orgId}, ${payEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${party}, false, '-100', 'CAD', '-100', 1)`);
      await db.execute(sql`
        update journal_entries set status = 'posted', posted_at = now() where id = ${payEntry}`);
      await db.execute(sql`
        insert into applications (id, org_id, from_line_id, to_line_id, amount, source_amount,
          source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency,
          settlement_rate, settlement_rate_source, settlement_rate_reference, applied_on, created_by)
        values (${randomUUID()}, ${org.orgId}, ${payLine}, ${billLine}, 100, 100, 100, 'CAD', 100, 'CAD',
          1, 'same_currency', 'same transaction currency', ${payDate}, ${org.orgId})`);
    };
    await withBypass(async () => {
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${termsVendor}, ${org.orgId}, 'vendor', 'Terms Vendor', ${org.subsidiaryId}, true, '{}'::jsonb),
               (${bareVendor}, ${org.orgId}, 'vendor', 'Bare Vendor', ${org.subsidiaryId}, true, '{}'::jsonb),
               (${quietVendor}, ${org.orgId}, 'vendor', 'Quiet Vendor', ${org.subsidiaryId}, true, '{}'::jsonb),
               (${refundVendor}, ${org.orgId}, 'vendor', 'Refund Vendor', ${org.subsidiaryId}, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into payment_terms (id, org_id, name, net_days) values (${termsId}, ${org.orgId}, 'Net 30', 30)`);
      await db.execute(sql`
        insert into vendor_roles (id, org_id, party_id, payment_terms_id)
        values (${randomUUID()}, ${org.orgId}, ${termsVendor}, ${termsId})`);
      await db.execute(sql`
        insert into vendor_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${bareVendor})`);
      await db.execute(sql`
        insert into vendor_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${quietVendor})`);
      await db.execute(sql`
        insert into vendor_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${refundVendor})`);
      // Terms Vendor: no document due date, Net 30 from July 1 → due July 31, paid July 15: on time.
      await seedBill("BILL-TERMS", termsVendor, "2026-07-01", "2026-07-15", null);
      // Bare Vendor: no document due date and no payment terms → excluded from on-time, counted.
      await seedBill("BILL-BARE", bareVendor, "2026-07-02", "2026-07-16", null);
      // Quiet Vendor: spend with no settled bills at all → unrated for lack
      // of payments, not for lack of dates.
      const spendEntry = randomUUID();
      await db.execute(sql`
        insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${spendEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'SPEND-QUIET', '2026-07-10', ${org.periodId}, 'draft', 'manual')`);
      await db.execute(sql`
        insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${spendEntry}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${quietVendor}, false, '250', 'CAD', '250', 1),
               (${randomUUID()}, ${org.orgId}, ${spendEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${quietVendor}, false, '-250', 'CAD', '-250', 1)`);
      await db.execute(sql`
        update journal_entries set status = 'posted', posted_at = now() where id = ${spendEntry}`);
      // Refund Vendor: a settled but undated bill (+100 spend) outweighed by
      // a credit (-250) → net spend below zero, so the vendor is filtered out
      // of the rows while its undated bill still sits in the payment map.
      await seedBill("BILL-REFUND", refundVendor, "2026-07-03", "2026-07-17", null);
      const creditEntry = randomUUID();
      await db.execute(sql`
        insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${creditEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'CREDIT-REFUND', '2026-07-11', ${org.periodId}, 'draft', 'manual')`);
      await db.execute(sql`
        insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${randomUUID()}, ${org.orgId}, ${creditEntry}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${refundVendor}, false, '-250', 'CAD', '-250', 1),
               (${randomUUID()}, ${org.orgId}, ${creditEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${refundVendor}, false, '250', 'CAD', '250', 1)`);
      await db.execute(sql`
        update journal_entries set status = 'posted', posted_at = now() where id = ${creditEntry}`);
    });
    const data = await withOrgContext(org.orgId, () => vendorData(
      { from: "2026-07-01", to: "2026-07-31", label: "July 2026" },
      org.orgId,
      null,
    ));
    const termsRow = data.rows.find((candidate) => candidate.id === termsVendor);
    assert.ok(termsRow, "the terms vendor must be present");
    assert.equal(termsRow.paidBills, 1);
    assert.equal(termsRow.undatedBills, 0);
    assert.equal(termsRow.onTimePct, 1, "payment before the terms-derived due date is on time");
    assert.equal(termsRow.unratedReason, null, "a rated vendor carries no unrated reason");
    const bareRow = data.rows.find((candidate) => candidate.id === bareVendor);
    assert.ok(bareRow, "the vendor without terms must be present");
    assert.equal(bareRow.paidBills, 1);
    assert.equal(bareRow.undatedBills, 1);
    assert.equal(bareRow.onTimePct, null, "a settled bill with no due source is excluded from the on-time figure");
    assert.equal(bareRow.performance, null, "a vendor with no usable payment history is unrated, not neutral");
    assert.equal(bareRow.quadrant, "unrated");
    assert.equal(bareRow.unratedReason, "undated", "settled-but-undated bills name the dating remedy, not settling");
    const quietRow = data.rows.find((candidate) => candidate.id === quietVendor);
    assert.ok(quietRow, "the vendor with spend but no payments must be present");
    assert.equal(quietRow.paidBills, 0);
    assert.equal(quietRow.quadrant, "unrated");
    assert.equal(quietRow.unratedReason, "no-payments", "no settled bills names the settling remedy, not dating");
    assert.equal(
      data.rows.find((candidate) => candidate.id === refundVendor),
      undefined,
      "a vendor with net spend at or below zero is filtered out of the rows",
    );
    const shareSum = data.rows.reduce((sum, row) => sum + row.sharePct, 0);
    assert.ok(
      Math.abs(shareSum - 1) < 1e-9,
      `spend shares must add up over the vendors shown, got ${shareSum}`,
    );
    assert.equal(data.totals.undatedBills, 1, "undated bills count only vendors actually shown");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
