import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Consumer-frame pin for the total-as-cash contract (see
 * payment-discount-total.integration.test.ts): a vendor payment settling a
 * 100 bill with a 10 early-payment discount moves 90 cash. Every reader that
 * displays a payment total must report the CASH frame (90), never the
 * AP-relieved gross (100):
 *   - module-home paid tiles and cash-forecast vendor history sum
 *     abs(documents.total);
 *   - 1099 filing and the compliance paid-this-year queue read the bank-side
 *     journal legs, explicitly excluding the non-cash discount leg.
 * If a future change "fixes" header.total to the gross, or a consumer starts
 * reading AP legs, these aggregates report 100 and fail here.
 */
test("discount payment consumers report cash, not AP-relieved gross", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Consumer-frame clerk", "admin");

    const billId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', ${`BILL-CONS-${billId.slice(0, 6)}`},
              ${org.subsidiaryId}, ${org.vendorId}, ${org.date}, 'CAD', '1',
              '100', '0', '100', ${actor})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, party_id)
      values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', '100', '100', '0', ${org.vendorId})`);
    await db.execute(sql`update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
    const billEntryId = await postDocument(billId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
    const billLineId = (await db.execute<{ id: string }>(sql`
      select id from journal_lines where entry_id = ${billEntryId} and account_id = ${org.accounts.ap}
    `)).rows[0]!.id;

    const payment = await createPaymentDocument({ allowedSubsidiaryIds: null,
      orgId: org.orgId,
      kind: "vendor_payment",
      createdBy: actor,
      partyId: org.vendorId,
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      documentDate: org.date,
      currency: "CAD",
      fxRate: "1",
    });
    await updateDraftPayment(
      payment.id,
      {
        partyId: org.vendorId,
        bankAccountId: org.accounts.bank,
        allocations: [{
          openLineId: billLineId,
          sourceTransactionAmount: "100",
          targetTransactionAmount: "100",
          settlementRate: "1",
          settlementRateSource: "same_currency" as const,
          settlementRateReference: "same transaction currency",
        }],
        discountAmount: "10.0000",
        discountAccountId: org.accounts.cogs,
      },
      actor,
      org.orgId,
    );
    await db.execute(sql`update documents set status = 'approved' where id = ${payment.id} and org_id = ${org.orgId}`);
    await postDocument(payment.id, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });

    // Module-home paid tile shape (web/lib/module-home/purchasing.ts) and
    // cash-forecast vendor history shape (web/lib/cash/core.ts): header
    // totals are the cash frame, so the aggregate is the 90 that moved.
    const tile = (await db.execute<{ paid: string }>(sql`
      select coalesce(sum(round(abs(d.total * d.fx_rate), 4)), 0)::text as paid
        from documents d
       where d.org_id = ${org.orgId} and d.kind in ('vendor_payment', 'check')
         and d.status = 'posted' and d.voided_at is null
    `)).rows[0]!;
    assert.equal(tile.paid, "90.0000");

    // 1099 / compliance paid-this-year shape (engine/src/compliance/information-returns.ts,
    // web/lib/compliance.ts): bank-side legs only — the discount leg never
    // leaves the bank and must not inflate reportable cash.
    const cash = (await db.execute<{ cash: string }>(sql`
      select coalesce(-sum(jl.amount) filter (
        where jl.amount < 0 and not jl.is_open_item and funding.type = 'asset_bank'
      ), 0)::text as cash
        from documents d
        join journal_entries je on je.id = d.posted_entry_id and je.org_id = d.org_id and je.status = 'posted'
        join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id
        join accounts funding on funding.id = jl.account_id and funding.org_id = jl.org_id
       where d.org_id = ${org.orgId} and d.id = ${payment.id}
    `)).rows[0]!;
    assert.equal(cash.cash, "90.0000");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
