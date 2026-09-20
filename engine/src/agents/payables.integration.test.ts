import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { defaultContinuousCloseDetectors } from "./continuous-close-config.ts";
import { db, withBypass, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { payablesFindings } from "./payables.ts";

/**
 * Live-PostgreSQL proof for the payables pack with its production loaders:
 * Sentinel-shaped duplicate pairs (open/open deduped, open/paid kept),
 * the pay-run horizon card, discount windows, stale approvals, and org
 * isolation.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function shiftDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function seedPostedEntry(org: { orgId: string; bookId: string; subsidiaryId: string; periodId: string; date: string; accounts: Record<string, string> }): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${id}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${id}, ${org.date}, ${org.periodId}, 'draft', 'manual')`);
      await tx.execute(sql`insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${id}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, '1', 'CAD', '1', 1),
               (${org.orgId}, ${id}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, '-1', 'CAD', '-1', 1)`);
      await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${id}`);
    }),
  );
  return id;
}

async function seedBill(
  org: { orgId: string; periodId: string },
  entryId: string,
  partyId: string,
  number: string,
  docDate: string,
  dueDate: string,
  total: string,
  opts: { status?: string; open?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const open = opts.open ?? total;
  await withBypassContext(
    () => db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, document_date, due_date,
         currency, subtotal, tax_total, total, open_balance, party_id,
         posted_entry_id, posting_period_id)
      values (${id}, ${org.orgId}, 'vendor_bill', ${opts.status ?? "posted"}, ${number}, ${docDate}, ${dueDate},
              'CAD', ${total}, '0', ${total}, ${open}, ${partyId},
              ${entryId}, ${org.periodId})`),
  );
  return id;
}

test(
  "payables pack pairs duplicates, cards the pay run, and isolates tenants",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const other = await withBypass(() => createScratchOrg());
    try {
      const today = await withBypassContext(() => businessToday(org.orgId));
      const entry = await seedPostedEntry(org);
      const vendor = await withBypassContext(() =>
        db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${randomUUID()}, ${org.orgId}, 'vendor', 'Vendor One') returning id`),
      ).then((result) => (result.rows[0] as { id: string }).id);

      // Open/open duplicate: same vendor, kind, amount, 4 days apart.
      await seedBill(org, entry, vendor, "BILL-D1", shiftDays(today, -30), shiftDays(today, 60), "1200.00");
      await seedBill(org, entry, vendor, "BILL-D1B", shiftDays(today, -26), shiftDays(today, 60), "1200.00");
      // Open/paid duplicate: the paid leg stays as evidence of double payment.
      await seedBill(org, entry, vendor, "BILL-D2", shiftDays(today, -20), shiftDays(today, 60), "1500.00");
      await seedBill(org, entry, vendor, "BILL-D2B", shiftDays(today, -18), shiftDays(today, -5), "1500.00", { open: "0" });
      // Same amount but a credit memo: never a duplicate.
      await withBypassContext(() => db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, document_date, due_date,
          currency, subtotal, tax_total, total, open_balance, party_id, posted_entry_id, posting_period_id)
        values (${randomUUID()}, ${org.orgId}, 'vendor_credit', 'posted', 'BILL-C1', ${shiftDays(today, -28)}, ${shiftDays(today, 60)},
          'CAD', '1200.00', '0', '1200.00', '1200.00', ${vendor}, ${entry}, ${org.periodId})`));

      // Pay-run horizon (7 days): two due, one far out.
      await seedBill(org, entry, vendor, "BILL-P1", shiftDays(today, -2), shiftDays(today, 3), "700.00");
      await seedBill(org, entry, vendor, "BILL-P2", shiftDays(today, -1), shiftDays(today, 1), "300.00");
      await seedBill(org, entry, vendor, "BILL-P3", shiftDays(today, -1), shiftDays(today, 60), "400.00");

      // Discount window open: 2/10 terms, invoiced 2 days ago.
      await withBypassContext(() => db.execute(sql`
        insert into payment_terms (id, org_id, name, net_days, discount_days, discount_percent, is_active)
        values (${randomUUID()}, ${org.orgId}, '2/10 net 30', 30, 10, '2.0000', true)`));
      await seedBill(org, entry, vendor, "BILL-T1", shiftDays(today, -2), shiftDays(today, 40), "50000.00");

      // Stalled approval: draft from 10 days ago.
      await seedBill(org, entry, vendor, "BILL-S1", shiftDays(today, -10), shiftDays(today, 20), "4000.00", { status: "draft", open: "0" });

      // Another tenant with its own duplicate pair: must not leak in.
      const otherEntry = await seedPostedEntry(other);
      const otherVendor = await withBypassContext(() =>
        db.execute(sql`insert into parties (id, org_id, kind, display_name) values (${randomUUID()}, ${other.orgId}, 'vendor', 'Foreign Vendor') returning id`),
      ).then((result) => (result.rows[0] as { id: string }).id);
      await seedBill(other, otherEntry, otherVendor, "BILL-F1", shiftDays(today, -9), shiftDays(today, 60), "80000.00");
      await seedBill(other, otherEntry, otherVendor, "BILL-F1B", shiftDays(today, -8), shiftDays(today, 60), "80000.00");

      const findings = await withBypassContext(() =>
        payablesFindings(org.orgId, "1000.0000", defaultContinuousCloseDetectors("payables")),
      );
      const byType = (type: string) => findings.filter((finding) => finding.findingType === type);

      const dups = byType("duplicate_bills");
      assert.equal(dups.length, 1);
      assert.equal(dups[0]!.summary.pairCount, 2, "open/open once, open/paid once, credit excluded, foreign excluded");
      assert.equal(dups[0]!.materiality, "3900.0000", "open legs only: 1200 + 1200 + 1500");
      assert.equal(dups[0]!.severity, "warning");

      const runs = byType("bills_due_before_payrun");
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.materiality, "1000.0000");
      assert.equal(runs[0]!.summary.dueCount, 2);
      assert.equal(runs[0]!.summary.beyondHorizonCount, 5, "D1, D1B, D2, T1, P3 defer past the horizon");
      const recommended = runs[0]!.summary.recommended as { documentNumber: string }[];
      assert.deepEqual(
        recommended.map((bill) => bill.documentNumber),
        ["BILL-P2", "BILL-P1"],
        "oldest-due first per the AP cockpit planner order",
      );

      const discounts = byType("early_pay_discount_opportunity");
      assert.equal(discounts.length, 1);
      // No bill-to-term linkage exists, so the term prices every open bill in
      // its window: 2% of (50000 + 700 + 300 + 400).
      assert.equal(discounts[0]!.materiality, "1028.0000");
      assert.match(String(discounts[0]!.fingerprint), /^payables-discount:/);

      const approvals = byType("bills_missing_approval");
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0]!.materiality, "4000.0000");
      assert.equal(approvals[0]!.severity, "warning");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
      await withBypass(() => dropScratchOrg(other.orgId));
    }
  },
);
