import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

const { vendorData } = await import("./vendor-data.ts");

const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("vendor payment analytics counts an installment bill once and uses final settlement", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    // A 100 bill settled by two installments (40 on July 19, 60 on July 25)
    // against a July 20 due date: one paid bill, ten days to pay, late.
    const billEntry = randomUUID();
    const billLine = randomUUID();
    const firstPay = randomUUID();
    const secondPay = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into vendor_roles (id, org_id, party_id)
        values (${randomUUID()}, ${org.orgId}, ${org.vendorId})`);
      await db.execute(sql`
        insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${billEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'BILL-INST', '2026-07-15', ${org.periodId}, 'draft', 'manual')`);
      await db.execute(sql`
        insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, due_date, is_open_item, amount, currency, txn_amount, fx_rate)
        values (${billLine}, ${org.orgId}, ${billEntry}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${org.vendorId}, '2026-07-20', true, '-100', 'CAD', '-100', 1),
               (${randomUUID()}, ${org.orgId}, ${billEntry}, 2, ${org.accounts.cogs}, ${org.subsidiaryId}, ${org.vendorId}, null, false, '100', 'CAD', '100', 1)`);
      await db.execute(sql`
        update journal_entries set status = 'posted', posted_at = now() where id = ${billEntry}`);
      for (const [num, date, amount, line] of [['PAY-1', '2026-07-19', '40', firstPay], ['PAY-2', '2026-07-25', '60', secondPay]] as const) {
        const payEntry = randomUUID();
        await db.execute(sql`
          insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
          values (${payEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${num}, ${date}, ${org.periodId}, 'draft', 'manual')`);
        await db.execute(sql`
          insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate)
          values (${line}, ${org.orgId}, ${payEntry}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${org.vendorId}, true, ${amount}, 'CAD', ${amount}, 1),
                 (${randomUUID()}, ${org.orgId}, ${payEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, ${org.vendorId}, false, -${amount}::numeric, 'CAD', -${amount}::numeric, 1)`);
        await db.execute(sql`
          update journal_entries set status = 'posted', posted_at = now() where id = ${payEntry}`);
      }
      await db.execute(sql`
        insert into applications (id, org_id, from_line_id, to_line_id, amount, source_amount,
          source_transaction_amount, source_transaction_currency, target_transaction_amount, target_transaction_currency,
          settlement_rate, settlement_rate_source, settlement_rate_reference, applied_on, created_by)
        values (${randomUUID()}, ${org.orgId}, ${firstPay}, ${billLine}, 40, 40, 40, 'CAD', 40, 'CAD',
          1, 'same_currency', 'same transaction currency', '2026-07-19', ${org.orgId}),
               (${randomUUID()}, ${org.orgId}, ${secondPay}, ${billLine}, 60, 60, 60, 'CAD', 60, 'CAD',
          1, 'same_currency', 'same transaction currency', '2026-07-25', ${org.orgId})`);
    });

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
    const fenceVendor = randomUUID();
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
               (${refundVendor}, ${org.orgId}, 'vendor', 'Refund Vendor', ${org.subsidiaryId}, true, '{}'::jsonb),
               (${fenceVendor}, ${org.orgId}, 'vendor', 'Fence Vendor', ${org.subsidiaryId}, true, '{}'::jsonb)`);
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
      await db.execute(sql`
        insert into vendor_roles (id, org_id, party_id, payment_terms_id)
        values (${randomUUID()}, ${org.orgId}, ${fenceVendor}, ${termsId})`);
      // Terms Vendor: no document due date, Net 30 from July 1 → due July 31, paid July 15: on time.
      await seedBill("BILL-TERMS", termsVendor, "2026-07-01", "2026-07-15", null);
      // Bare Vendor: no document due date and no payment terms → excluded from on-time, counted.
      await seedBill("BILL-BARE", bareVendor, "2026-07-02", "2026-07-16", null);
      // Fence Vendor: a June bill and a July bill — only the July one falls
      // inside the report window, so the bill count fences the period.
      await seedBill("BILL-FENCE-JUN", fenceVendor, "2026-06-10", "2026-07-05", null);
      await seedBill("BILL-FENCE-JUL", fenceVendor, "2026-07-05", "2026-07-20", null);
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
    const fenceRow = data.rows.find((candidate) => candidate.id === fenceVendor);
    assert.ok(fenceRow, "the fencing vendor must be present");
    assert.equal(fenceRow.bills, 1, "only the in-window bill counts");
    assert.equal(fenceRow.lastBill, "2026-07-05");
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
    // Shares are 4dp-rounded quotients, so a handful of shown vendors lands
    // within a few 1e-4 of one; a total that still carried filtered vendors
    // would overshoot by whole tenths instead.
    const shareSum = data.rows.reduce((sum, row) => sum + row.sharePct, 0);
    assert.ok(
      Math.abs(shareSum - 1) < 1e-3,
      `spend shares must add up over the vendors shown, got ${shareSum}`,
    );
    assert.equal(data.totals.undatedBills, 1, "undated bills count only vendors actually shown");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
