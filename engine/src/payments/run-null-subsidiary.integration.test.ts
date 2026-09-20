import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createPaymentRun } from "./run-creation.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A vendor bill converted from a purchase order carries no subsidiary:
 * single-entity orders never set one (the order drawer sends no subsidiary
 * for single-entity orgs, and convertOrder inherits it as null). The pay run
 * must still be able to select and allocate that bill's AP open line — the
 * posting kernel books the bill's lines on the org root, so the run's payment
 * belongs on the root too, not on a null subsidiary whose empty scope matches
 * nothing.
 */
test("a pay run selects a posted bill whose document has no subsidiary", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Payables clerk", "admin");

    const formatId = randomUUID();
    const profileId = randomUUID();
    await db.execute(sql`
      insert into payment_formats
        (id, org_id, code, name, rail, direction, file_extension, content_type, created_by, updated_by)
      values (${formatId}, ${org.orgId}, ${`WIRE-NS-${formatId.slice(0, 8)}`},
              'Null-subsidiary wire', 'wire', 'credit', 'csv', 'text/csv', ${actor}, ${actor})
    `);
    await db.execute(sql`
      insert into payment_bank_profiles
        (id, org_id, name, bank_account_id, payment_format_id, currency,
         require_run_approval, require_file_approval, created_by, updated_by)
      values (${profileId}, ${org.orgId}, 'Null-subsidiary profile', ${org.accounts.bank},
              ${formatId}, 'CAD', false, false, ${actor}, ${actor})
    `);

    // The order-converted shape: approved, posted, but subsidiary_id null.
    // (Mirroring the draft→lines→approve seed order other bill tests use.)
    const billId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', ${`BILL-NS-${billId.slice(0, 6)}`},
              null, ${org.vendorId}, ${org.date}, 'CAD', '1', '100', '0', '100', ${actor})
    `);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, party_id)
      values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', '100', '100', '0', ${org.vendorId})
    `);
    await db.execute(sql`update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
    await postDocument(billId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });

    const run = await createPaymentRun({
      orgId: org.orgId,
      createdBy: actor,
      paymentBankProfileId: profileId,
      billDocumentIds: [billId],
    });

    const payment = (await db.execute<{ subsidiary_id: string | null; total: string }>(sql`
      select d.subsidiary_id, d.total::text as total
        from documents d
        join payment_instructions i on i.payment_document_id = d.id and i.org_id = d.org_id
       where i.payment_run_id = ${run.id} and i.org_id = ${org.orgId}
       limit 1
    `)).rows[0]!;
    assert.equal(payment.subsidiary_id, org.subsidiaryId, "run payment inherits the org root, not null");
    assert.equal(payment.total, "100.0000");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
