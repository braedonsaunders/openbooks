import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { buildNecPreparationRows, computeFiling } from "./information-returns.ts";
import { db, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The reported shape: a vendor flagged reportable through the only flag the
 * operator UI exposes (no information-return assignment), paid by posted
 * vendor payments against bills booked to an unmapped expense account. The
 * spend must land in the filing's default box (NEC Box 1) instead of the
 * vendor vanishing from the worksheet.
 */
async function seedFlaggedVendorPaidOnUnmappedAccount(
  org: ScratchOrg,
  actorId: string,
): Promise<{ vendorId: string }> {
  const vendorId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${vendorId}, ${org.orgId}, 'vendor', 'Unmapped Account Vendor',
            ${org.subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into vendor_roles
      (org_id, party_id, is_t4a, information_return_form, tin_last4, tin_type,
       created_by, updated_by)
    values (${org.orgId}, ${vendorId}, true, null, '4321', 'ein', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
    values (${randomUUID()}, ${org.orgId}, ${vendorId}, ${org.subsidiaryId})`);

  const calendarId = (
    await db.execute<{ id: string }>(
      sql`
    select id from fiscal_calendars where org_id = ${org.orgId} limit 1`,
      "objects",
    )
  )[0]!.id;
  const period2025 = randomUUID();
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
       is_adjustment, fiscal_calendar_id)
    values (${period2025}, ${org.orgId}, 2025, 7, '2025-07', '2025-07-01', '2025-07-31',
            false, ${calendarId})`);

  const billId = randomUUID();
  const billEntryId = randomUUID();
  const billApLineId = randomUUID();
  const paymentId = randomUUID();
  const paymentEntryId = randomUUID();
  const paymentApLineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, subtotal, tax_total, total, created_by, updated_by)
    values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', 'BILL-1099-1', ${org.subsidiaryId},
            ${vendorId}, '2025-07-10', 'CAD', '8620.00', '0', '8620.00', ${actorId}, ${actorId}),
           (${paymentId}, ${org.orgId}, 'vendor_payment', 'draft', 'PAY-1099-1', ${org.subsidiaryId},
            ${vendorId}, '2025-07-15', 'CAD', '8620.00', '0', '8620.00', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
       memo, status, source_document_id, origin, created_by, updated_by)
    values (${billEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'BILL-1099-1',
            '2025-07-10', ${period2025}, 'Unmapped-expense bill', 'draft',
            ${billId}, 'document', ${actorId}, ${actorId}),
           (${paymentEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'PAY-1099-1',
            '2025-07-15', ${period2025}, 'Reportable-vendor payment', 'draft',
            ${paymentId}, 'document', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into journal_lines
      (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount,
       currency, txn_amount, fx_rate, party_id, is_open_item)
    values (${billApLineId}, ${org.orgId}, ${billEntryId}, 1, ${org.accounts.ap},
            ${org.subsidiaryId}, '-8620.00', 'CAD', '-8620.00', 1, ${vendorId}, true),
           (${randomUUID()}, ${org.orgId}, ${billEntryId}, 2, ${org.accounts.cogs},
            ${org.subsidiaryId}, '8620.00', 'CAD', '8620.00', 1, null, false),
           (${paymentApLineId}, ${org.orgId}, ${paymentEntryId}, 1, ${org.accounts.ap},
            ${org.subsidiaryId}, '8620.00', 'CAD', '8620.00', 1, ${vendorId}, true),
           (${randomUUID()}, ${org.orgId}, ${paymentEntryId}, 2, ${org.accounts.bank},
            ${org.subsidiaryId}, '-8620.00', 'CAD', '-8620.00', 1, null, false)`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, description, quantity, unit,
       unit_price, amount, created_by)
    values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, 'Contract labor',
            '1', 'ea', '8620.00', '8620.00', ${actorId})`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId}
     where org_id = ${org.orgId} and id in (${billEntryId}, ${paymentEntryId})`);
  await db.execute(sql`
    update documents
       set status = 'posted', posted_entry_id = ${billEntryId}, posting_period_id = ${period2025}
     where org_id = ${org.orgId} and id = ${billId}`);
  await db.execute(sql`
    update documents
       set status = 'posted', posted_entry_id = ${paymentEntryId}, posting_period_id = ${period2025}
     where org_id = ${org.orgId} and id = ${paymentId}`);
  await db.execute(sql`
    update documents
       set custom = ${JSON.stringify({ bankAccountId: org.accounts.bank, allocations: [] })}::jsonb
     where org_id = ${org.orgId} and id = ${paymentId}`);
  await db.execute(sql`
    insert into applications
      (org_id, from_line_id, to_line_id, amount, applied_on, source_amount,
       source_transaction_amount, source_transaction_currency,
       target_transaction_amount, target_transaction_currency,
       settlement_rate, settlement_rate_source, settlement_rate_reference,
       created_by, updated_by)
    values (${org.orgId}, ${paymentApLineId}, ${billApLineId}, '8620.00', '2025-07-15', '8620.00',
            '8620.00', 'CAD', '8620.00', 'CAD',
            '1', 'same_currency', 'same transaction currency', ${actorId}, ${actorId})`);
  return { vendorId };
}

test(
  "a flagged vendor with no form assignment lands in NEC Box 1 from unmapped bills",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await withBypassContext(async () =>
        createScratchUser(org.orgId, "Accountant", "admin"),
      );
      const { vendorId } = await withBypassContext(async () =>
        seedFlaggedVendorPaidOnUnmappedAccount(org, actorId),
      );
      const filing = await withBypassContext(async () =>
        computeFiling({ orgId: org.orgId, taxYear: 2025, formType: "1099-NEC", currency: "CAD" }),
      );
      assert.equal(filing.recipients.length, 1);
      const recipient = filing.recipients[0]!;
      assert.equal(recipient.profile.partyId, vendorId);
      assert.equal(recipient.amounts.boxAmounts["nec1"], "8620.0000");
      assert.equal(recipient.amounts.reportableTotal, "8620.0000");
      assert.equal(recipient.amounts.paymentCount, 1);
      assert.equal(filing.tracedCash, "8620.0000");
      // The unmapped spend is named, and the missing form assignment still
      // surfaces — the vendor is included, not silently dropped.
      const kinds = filing.exceptions.map((exception) => exception.kind);
      assert.ok(
        kinds.includes("missing_form_assignment"),
        `expected a form-assignment note, got ${kinds}`,
      );
      const rows = buildNecPreparationRows(filing, new Map());
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.box1, "8620.0000");
      assert.ok(
        rows[0]!.exclusionDetails.length > 0,
        "the worksheet row must carry the assignment note",
      );
    } finally {
      await withBypassContext(async () => dropScratchOrg(org.orgId));
    }
  },
);
