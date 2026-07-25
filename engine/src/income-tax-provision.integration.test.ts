import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  computeProvisionRun,
  getProvisionRun,
  postProvisionRun,
} from "./income-tax-provision.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * End-to-end ASC 740: enacted rate + pretax income from the ledger → compute →
 * post through the kernel (origin tax_provision) → repost reverses and
 * supersedes cleanly.
 */
test("income tax provision computes, posts, and reposts with reversal", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = randomUUID();
    await db.execute(sql`
      insert into users (id, org_id, email, name, password_hash, role, is_active)
      values (${userId}, ${org.orgId}, ${`tax-${userId}@scratch.test`}, 'Tax Tester', 'x', 'admin', true)`);

    // Income-tax accounts + control mapping.
    const mk = async (number: string, name: string, type: string) => {
      const id = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      return id;
    };
    const [expense, payable, dta, dtl, va] = await Promise.all([
      mk("6100", "Income Tax Expense", "expense"),
      mk("2110", "Income Tax Payable", "liability_current_other"),
      mk("1410", "Deferred Tax Assets", "asset_current_other"),
      mk("2410", "Deferred Tax Liabilities", "liability_long_term"),
      mk("1415", "Valuation Allowance", "asset_current_other"),
    ]);
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts}',
        coalesce(settings->'controlAccounts', '{}'::jsonb) ||
        ${JSON.stringify({
          incomeTaxExpense: expense,
          incomeTaxPayable: payable,
          deferredTaxAsset: dta,
          deferredTaxLiability: dtl,
          valuationAllowance: va,
        })}::jsonb)
      where id = ${org.orgId}`);

    // Enacted rate: 26.5% federal, org-wide.
    await db.execute(sql`
      insert into income_tax_rates (org_id, jurisdiction, rate_percent, effective_from, created_by, updated_by)
      values (${org.orgId}, 'Federal', '26.5', '2020-01-01', ${userId}, ${userId})`);

    // $1,000,000 of pretax income in FY2026: one posted invoice.
    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-TAX-1',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '1000000', '0', '1000000', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '1000000', '1000000', '0', '0')`);
    await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });

    // Compute: DTL 200,000 taxable diff, DTA −80,000 deductible diff, VA 10,000.
    const runId = await computeProvisionRun(org.orgId, 2026, {
      permanentDifferences: [],
      valuationAllowance: "10000",
      additionalDifferences: [
        { category: "fixed_assets", description: "P&E book vs tax", difference: "200000", source: "manual" },
        { category: "provisions", description: "Accrued warranty", difference: "-80000", source: "manual" },
      ],
    }, userId);
    const run = await getProvisionRun(org.orgId, runId);
    assert.ok(run);
    const payload = run.payload as { pretaxBookIncome: string; currentTax: string; totalExpense: string; effectiveRatePercent: string };
    assert.equal(payload.pretaxBookIncome, "1000000.0000");
    assert.equal(payload.currentTax, "265000.0000");
    // Expense = 265,000 + 53,000 DTL − 21,200 DTA + 10,000 VA = 306,800.
    assert.equal(payload.totalExpense, "306800.0000");
    assert.equal(payload.effectiveRatePercent, "30.68");
    assert.equal(run.differences.length, 2);

    // Post through the kernel.
    const { entryId } = await postProvisionRun(org.orgId, runId, userId);
    const entry = (await db.execute(sql`
      select status, origin from journal_entries where id = ${entryId}
    `)) as unknown as { rows: { status: string; origin: string }[] };
    assert.equal(entry.rows[0]!.status, "posted");
    assert.equal(entry.rows[0]!.origin, "tax_provision");
    const lines = (await db.execute(sql`
      select account_id, amount from journal_lines where entry_id = ${entryId} order by line_number
    `)) as unknown as { rows: { account_id: string; amount: string }[] };
    const byAccount = new Map(lines.rows.map((l) => [l.account_id, l.amount]));
    assert.equal(byAccount.get(payable), "-265000.0000");
    assert.equal(byAccount.get(dta), "21200.0000");
    assert.equal(byAccount.get(dtl), "-53000.0000");
    assert.equal(byAccount.get(va), "-10000.0000");
    assert.equal(byAccount.get(expense), "306800.0000");
    assert.equal(
      lines.rows.reduce((a, l) => a + Number(l.amount), 0),
      0,
      "provision journal balances",
    );
    const posted = await getProvisionRun(org.orgId, runId);
    assert.equal(posted?.status, "posted");

    // Repost the FY: reverse + supersede, exactly one live posted run remains.
    const runId2 = await computeProvisionRun(org.orgId, 2026, {
      permanentDifferences: [],
      valuationAllowance: "10000",
      additionalDifferences: [
        { category: "fixed_assets", description: "P&E book vs tax", difference: "300000", source: "manual" },
        { category: "provisions", description: "Accrued warranty", difference: "-80000", source: "manual" },
      ],
    }, userId);
    const { entryId: entryId2 } = await postProvisionRun(org.orgId, runId2, userId);
    const states = (await db.execute(sql`
      select status, count(*)::int as n from tax_provision_runs
       where org_id = ${org.orgId} and fiscal_year = 2026 group by status
    `)) as unknown as { rows: { status: string; n: number }[] };
    const byStatus = new Map(states.rows.map((r) => [r.status, r.n]));
    assert.equal(byStatus.get("posted"), 1);
    assert.equal(byStatus.get("superseded"), 1);
    const reversal = (await db.execute(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${org.orgId} and origin = 'tax_provision' and reverses_entry_id = ${entryId}
    `)) as unknown as { rows: { n: number }[] };
    assert.equal(reversal.rows[0]!.n, 1, "repost reversed the superseded entry");

    // The DTL movement between the two runs (53,000 → 79,500) shows in entry 2.
    const dtlLine = (await db.execute(sql`
      select amount from journal_lines where entry_id = ${entryId2} and account_id = ${dtl}
    `)) as unknown as { rows: { amount: string }[] };
    assert.equal(dtlLine.rows[0]!.amount, "-79500.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
