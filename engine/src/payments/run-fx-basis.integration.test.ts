import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createPaymentRun } from "./run-creation.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "a foreign-currency payment run pays each vendor once and converts at its own payment date",
  { skip: !DB },
  async () => {
    // Two EUR bills from one vendor were booked at 1.40 and 1.45. The run must
    // compose one payment that relieves each bill at its carrying amount and
    // leaves the payment's own rate to its posting date, so realized FX is
    // measured; copying a bill's historical rate onto the payment would book
    // the bank leg at history and split the vendor into one transfer per rate.
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Run FX basis", "admin");
      await db.execute(sql`insert into vendor_roles (org_id, party_id, ap_account_id, is_active)
      values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, true)`);
      const bills: string[] = [];
      for (const [number, rate] of [
        ["BILL-FX-1", "1.40"],
        ["BILL-FX-2", "1.45"],
      ] as const) {
        const billId = randomUUID();
        await db.execute(sql`insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', ${number}, ${org.subsidiaryId}, ${org.vendorId},
                ${org.date}, 'EUR', ${rate}, '100', '0', '100', ${actor})`);
        await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
        values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', '100', '100', '0')`);
        await db.execute(
          sql`update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`,
        );
        await postDocument(billId, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });
        bills.push(billId);
      }
      const formatId = randomUUID();
      await db.execute(sql`insert into payment_formats (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
      values (${formatId}, ${org.orgId}, 'WIRE-FX-EUR', 'EUR wire', 'wire', 'credit', 'CA', 'EUR', ${actor}, ${actor})`);
      const profileId = randomUUID();
      await db.execute(sql`insert into payment_bank_profiles
        (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id, currency, country, settings, created_by, updated_by)
      values (${profileId}, ${org.orgId}, 'EUR profile', ${org.accounts.bank}, ${org.subsidiaryId}, ${formatId}, 'EUR', 'CA',
              '{}'::jsonb, ${actor}, ${actor})`);

      const run = await createPaymentRun({
        allowedSubsidiaryIds: null,
        orgId: org.orgId,
        createdBy: actor,
        paymentBankProfileId: profileId,
        billDocumentIds: bills,
        scheduledFor: org.date,
      });

      const instructions = await db.execute<{ amount: string; payment_document_id: string }>(
        sql`
      select amount::text as amount, payment_document_id from payment_instructions
       where org_id = ${org.orgId} and payment_run_id = ${run.id}`,
        "objects",
      );
      assert.deepEqual(
        instructions.map((row) => row.amount),
        ["200.0000"],
        "one transfer for the vendor's EUR bills",
      );
      const payment = (
        await db.execute<{ fx_rate: string; allocations: Array<{ targetBaseAmount?: string }> }>(
          sql`
      select fx_rate::text as fx_rate, custom->'allocations' as allocations from documents
       where org_id = ${org.orgId} and id = ${instructions[0]!.payment_document_id}`,
          "objects",
        )
      )[0]!;
      assert.equal(
        payment.fx_rate,
        "1.0000000000",
        "the payment rate is left to its posting date, not copied from a bill",
      );
      assert.deepEqual(
        payment.allocations.map((allocation) => allocation.targetBaseAmount).sort(),
        ["140.0000", "145.0000"],
        "each bill is relieved at its own carrying amount",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
