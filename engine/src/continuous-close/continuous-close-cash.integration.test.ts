import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { defaultContinuousCloseDetectors } from "../agents/continuous-close-config.ts";
import { businessToday } from "../platform/business-date.ts";
import { db, withBypassContext } from "../platform/db.ts";
import { cashFindings } from "../agents/cash.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Live-PostgreSQL proofs for the cash-alerts pack (background agent pack B):
 * low bank balances, bills due inside the window outrunning cash, and the
 * open-item forecast's lowest week. The pack function is exercised directly
 * (the same way the registry dispatches it); control-plane persistence is
 * covered by continuous-close.integration.test.ts.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const MS_DAY = 86_400_000;

async function scan(orgId: string, threshold = "100.0000") {
  return cashFindings(orgId, threshold, defaultContinuousCloseDetectors("cash"));
}

function fingerprints(findings: Awaited<ReturnType<typeof scan>>): string[] {
  return findings.map((finding) => finding.fingerprint);
}

/** ISO date n days after today (businessToday, the detector's own clock). */
async function daysFromToday(orgId: string, n: number): Promise<string> {
  const today = await businessToday(orgId);
  return new Date(new Date(`${today}T00:00:00Z`).getTime() + n * MS_DAY).toISOString().slice(0, 10);
}

/** Post a balanced bank receipt so starting cash is exactly `amount`. */
async function seedBankCash(org: ScratchOrg, entryNumber: string, amount: string): Promise<void> {
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values
      (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryNumber},
       ${org.date}, ${org.periodId}, ${entryNumber}, 'draft', 'manual')`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
    values
      (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, null, ${amount}, 'CAD', ${amount}, '1'),
      (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, null, ${`-${amount}`}, 'CAD', ${`-${amount}`}, '1')`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
}

/** An approved, posted vendor bill open for `amount`, due on `dueDate` (null = undated). */
async function seedVendorBill(
  org: ScratchOrg,
  number: string,
  amount: string,
  dueDate: string | null,
): Promise<void> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, due_date, currency, fx_rate, subtotal, tax_total, total)
      values (${documentId}, ${org.orgId}, 'vendor_bill', 'draft', ${number}, ${org.subsidiaryId},
              ${org.vendorId}, ${org.date}, ${org.date}, ${dueDate},
              'CAD', '1', ${amount}, '0.0000', ${amount})`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         quantity, unit_price, custom, extra_dims)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, ${amount}, 0,
              1, ${amount}, '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now() where id = ${documentId}`);
  });
  await withBypassContext(() =>
    postDocument(documentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }),
  );
}

test(
  "cash under the floor surfaces a low-balance finding with the shortfall",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await seedBankCash(org, "CASH-SEED", "5000.0000");

      const findings = await scan(org.orgId, "5100.0000");
      const low = findings.filter((finding) => finding.findingType === "cash_low_balance");
      assert.equal(low.length, 1, `one low-balance finding, got ${fingerprints(findings)}`);
      const only = low[0]!;
      assert.equal(only.fingerprint, "cash-low-balance");
      assert.equal(only.agentKey, "cash");
      assert.equal(only.materiality, "100.0000");
      assert.equal(only.summary.total, "5000.0000");
      assert.equal(only.summary.href, "/banking/cash");
      assert.ok(
        (only.summary.accounts as { balance: string }[]).some((a) => a.balance === "5000.0000"),
        "the funded bank account carries its balance",
      );

      // Cash above the floor scans clean.
      const calm = await scan(org.orgId, "100.0000");
      assert.ok(
        !fingerprints(calm).some((fingerprint) => fingerprint.startsWith("cash-low-balance")),
        "funded cash raises no low-balance finding",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "bills due inside the window outrunning cash surface a crunch, fingerprint-stable",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await seedBankCash(org, "CRUNCH-CASH", "1000.0000");
      await seedVendorBill(org, "BILL-CRUNCH-1", "5000.0000", await daysFromToday(org.orgId, 5));

      // 5000 due against 1000 cash: excess 4000.
      const findings = await scan(org.orgId);
      const crunch = findings.filter((finding) => finding.findingType === "cash_bill_crunch");
      assert.equal(crunch.length, 1, `one crunch finding, got ${fingerprints(findings)}`);
      const only = crunch[0]!;
      assert.equal(only.fingerprint, "cash-bill-crunch");
      assert.equal(only.materiality, "4000.0000");
      assert.equal(only.summary.billCount, 1);
      const bills = only.evidence[0]!.data.bills as { docNumber: string; amount: string }[];
      assert.equal(bills[0]!.docNumber, "BILL-CRUNCH-1");
      assert.equal(bills[0]!.amount, "5000.0000");
      const again = await scan(org.orgId);
      assert.deepEqual(
        fingerprints(again).sort(),
        fingerprints(findings).sort(),
        "repeat scans are fingerprint-stable",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the forecast fires on the statistical prediction week, not the far due date",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await seedBankCash(org, "FORECAST-CASH", "1000.0000");
      // This vendor pays 90 days after the transaction on average — past the
      // bill's own due date, so the statistical prediction wins over the
      // due-date floor and lands well before the due week.
      await db.execute(sql`
        insert into party_payment_stats (org_id, party_id, account_type, settled_on, n, sum_days, sum_days_sq)
        values (${org.orgId}, ${org.vendorId}, 'liability_payable', ${org.date}, 5, 450, 40500)`);
      await seedVendorBill(org, "BILL-FORECAST-1", "9000.0000", await daysFromToday(org.orgId, 9));

      const findings = await scan(org.orgId);
      const short = findings.filter((finding) => finding.findingType === "cash_forecast_shortfall");
      assert.equal(short.length, 1, `one shortfall finding, got ${fingerprints(findings)}`);
      const only = short[0]!;
      assert.equal(only.fingerprint, "cash-forecast-shortfall");
      assert.equal(only.materiality, "8000.0000");
      // Transaction date (the scratch fixture date) + 90 days lands well
      // past the +9-day due date, so the due-date floor cannot bind: the
      // statistical prediction week, pushed to Monday on a weekend.
      const predicted = new Date(`${org.date}T00:00:00Z`).getTime() + 90 * MS_DAY;
      const pushed = new Date(predicted);
      const day = pushed.getUTCDay();
      if (day === 6) pushed.setTime(pushed.getTime() + 2 * MS_DAY);
      if (day === 0) pushed.setTime(pushed.getTime() + MS_DAY);
      const sunday = new Date(pushed.getTime() - pushed.getUTCDay() * MS_DAY);
      assert.equal(only.summary.lowestWeek, sunday.toISOString().slice(0, 10));
      assert.equal(only.summary.lowestCash, "-8000.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "cash scans stay inside the requesting org",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      await seedBankCash(org, "ISOLATION-CASH", "10.0000");
      const findings = await scan(org.orgId, "5100.0000");
      const low = findings.filter((finding) => finding.findingType === "cash_low_balance");
      assert.equal(low.length, 1, "the thin org flags its own low cash");
      assert.equal(low[0]!.summary.total, "10.0000");
      // The untouched org reports its own (zero) balance, never the seeded 10.
      const otherFindings = await scan(other.orgId, "5100.0000");
      const otherLow = otherFindings.filter((finding) => finding.findingType === "cash_low_balance");
      assert.equal(otherLow.length, 1, "the other org scans its own cash");
      assert.notEqual(otherLow[0]!.summary.total, "10.0000");
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);
