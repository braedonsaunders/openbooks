import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createPaymentDocument, updateDraftPayment } from "./payments.ts";
import { postDocument } from "../ledger/posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Blessed representation contract (coordinator adjudication): documents.total
 * on a payment is the CASH frame. A vendor payment settling a 100 bill with a
 * 10 early-payment discount moves 90 cash (total = 90) while its AP leg
 * relieves the gross 100 — the relieved amount lives in the journal legs and
 * the settlement evidence, never the header. The payment's open balance stays
 * in the settlement frame (100 while unapplied) so applications consume 1:1
 * against bill open amounts.
 */
test("discount vendor payment pins total-as-cash with gross AP relief", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Discount clerk", "admin");

    const billId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', ${`BILL-DISC-${billId.slice(0, 6)}`},
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

    const payment = await createPaymentDocument({
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
    const entryId = await postDocument(payment.id, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });

    const doc = (await db.execute<{ total: string; open_balance: string }>(sql`
      select total::text, open_balance::text from documents where id = ${payment.id}
    `)).rows[0]!;
    // Cash frame on the header…
    assert.equal(doc.total, "90.0000");
    // …settlement frame in the legs…
    const legs = (await db.execute<{ account_id: string; amount: string; is_open_item: boolean }>(sql`
      select account_id, amount::text, is_open_item from journal_lines
       where entry_id = ${entryId} and org_id = ${org.orgId} order by line_number
    `)).rows;
    assert.deepEqual(
      legs.map((l) => [l.account_id, l.amount, l.is_open_item]),
      [
        [org.accounts.ap, "100.0000", true],
        [org.accounts.bank, "-90.0000", false],
        [org.accounts.cogs, "-10.0000", false],
      ],
    );
    // …and the payment's open balance offers the gross 100 for application,
    // consuming 1:1 against the bill's open 100.
    assert.equal(doc.open_balance, "100.0000");
    const bill = (await db.execute<{ open_balance: string }>(sql`
      select open_balance::text from documents where id = ${billId}
    `)).rows[0]!;
    assert.equal(bill.open_balance, "100.0000");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
