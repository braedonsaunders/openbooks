import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { resolveProjectFinancials } from "./financials.ts";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** The T&M built-in profile: GL cost headline, bill-rate billable value. */
const tmProfile = BUILTIN_PROJECT_TYPES.find((t) => t.key === "time_and_materials")!
  .financialProfile;
/** Same shape with labour split out at time rates. */
const laborProfile = { ...tmProfile, laborCost: { source: "time_rate" as const } };

async function seedTwoCurrencyProject() {
  const org = await createScratchOrg();
  const usSub = randomUUID();
  const projectId = randomUUID();
  const cadEmp = randomUUID();
  const usEmp = randomUUID();
  await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`);
  await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${cadEmp}, ${org.orgId}, 'employee', 'CAD Worker', ${org.subsidiaryId}, true, '{}'::jsonb),
           (${usEmp}, ${org.orgId}, 'employee', 'US Worker', ${usSub}, true, '{}'::jsonb)`);
  await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`);
  await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${org.orgId},'USD','CAD',${org.date}::date,'spot',1.35,'manual')`);
  await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-FX', 'FX job', ${org.customerId}, 'active', true, '{}'::jsonb)`);
  // Billable time: 10h each at bill 100 / cost 50 in the worker's own
  // functional, stamped like the rate engines stamp them.
  await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, status, is_billable, billing_status, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, bill_rate, bill_rate_currency, custom)
    values (${randomUUID()}, ${org.orgId}, ${cadEmp}, ${org.date}, '10.0000', ${projectId}, 'approved', true, 'unbilled', '50.0000', 'CAD', ${org.subsidiaryId}, '100.0000', 'CAD', '{}'::jsonb),
           (${randomUUID()}, ${org.orgId}, ${usEmp}, ${org.date}, '10.0000', ${projectId}, 'approved', true, 'unbilled', '50.0000', 'USD', ${usSub}, '100.0000', 'USD', '{}'::jsonb)`);
  // Posted GL cost on the project: CAD 100 + USD 100.
  for (const [num, sub, cur, amt] of [["PF-CAD", org.subsidiaryId, "CAD", "100"], ["PF-USD", usSub, "USD", "100"]] as const) {
    const entry = randomUUID();
    await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entry}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${org.date}, ${org.periodId}, 'draft', 'manual')`);
    await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${sub}, ${projectId}, ${amt}, ${cur}, ${amt}, '1'),
             (${org.orgId}, ${entry}, 2, ${org.accounts.ap}, ${sub}, null, ${"-" + amt}, ${cur}, ${"-" + amt}, '1')`);
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
  }
  // A direct USD 100 subcontract commitment (no linked PO): an open
  // balance that translates at the closing spot.
  await db.execute(sql`insert into subcontracts (id, org_id, project_id, vendor_id, number, title, currency, original_commitment, status)
    values (${randomUUID()}, ${org.orgId}, ${projectId}, ${org.vendorId}, 'SC-FX', 'FX sub', 'USD', '100', 'active')`);
  // A posted USD invoice, an approved USD purchase order and a posted USD
  // vendor bill, all carrying project-tagged lines.
  const docs = [
    ["INV-USD", "customer_invoice", "posted", org.customerId, org.accounts.revenue, "200"],
    ["PO-USD", "purchase_order", "approved", org.vendorId, org.accounts.cogs, "200"],
    ["BILL-USD", "vendor_bill", "posted", org.vendorId, org.accounts.cogs, "150"],
  ] as const;
  for (const [num, kind, status, party, account, total] of docs) {
    const docId = randomUUID();
    await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total, open_balance)
      values (${docId}, ${org.orgId}, ${kind}, ${num}, ${party}, ${usSub}, ${org.date}, ${org.date}, 'USD', '1', 'draft', ${total}, 0, ${total}, ${total})`);
    await db.execute(sql`insert into document_lines (id, org_id, document_id, line_number, project_id, account_id, amount, is_billable)
      values (${randomUUID()}, ${org.orgId}, ${docId}, 1, ${projectId}, ${account}, ${total}, true)`);
    if (status === "posted") {
      // Posted documents require a posted entry link (evidence only; the
      // project's own GL cost comes from the tagged legs above).
      const entry = randomUUID();
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${usSub}, ${"EV-" + num}, ${org.date}, ${org.periodId}, 'draft', 'manual')`);
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${usSub}, ${total}, 'USD', ${total}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${usSub}, ${"-" + total}, 'USD', ${"-" + total}, '1')`);
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
      await db.execute(sql`update documents set status='posted', posted_entry_id=${entry}, posting_period_id=${org.periodId} where id=${docId}`);
    } else {
      await db.execute(sql`update documents set status=${status} where id=${docId}`);
    }
  }
  return { org, projectId };
}

/**
 * Project financials state presentation currency: USD legs translate at
 * 1.35 everywhere — GL cost, labour, billable time and lines, invoiced,
 * committed and the transactions tab — never fused as base units.
 */
test("project financials translate every measure to presentation", { skip: !DB }, async () => {
  const { org, projectId } = await seedTwoCurrencyProject();
  try {
    const report = await resolveProjectFinancials(org.orgId, projectId, tmProfile);
    // GL cost: 100 CAD + 135 CAD.
    assert.equal(report.measures.actual_cost, "235.0000");
    // Billable time at bill rates: 1000 CAD + 1350 CAD.
    assert.equal(report.measures.billable_time_value, "2350.0000");
    // Billable lines: the USD 150 vendor bill → 202.5 CAD.
    assert.equal(report.measures.billable_cost_value, "202.5000");
    // Invoiced: the USD 200 invoice → 270 CAD.
    assert.equal(report.measures.invoiced_to_date, "270.0000");
    // Committed: the USD 200 purchase order → 270 CAD, plus the USD 100
    // direct subcontract → 135 CAD.
    assert.equal(report.measures.committed_cost, "405.0000");
    // Cost detail and the transactions tab translate too.
    const cogs = report.costByAccount.find((r) => r.accountId === org.accounts.cogs)!;
    assert.equal(cogs.amount, "235.0000");
    const invoice = report.documents.find((r) => r.documentNumber === "INV-USD")!;
    assert.equal(invoice.amount, "270.0000");

    const labor = await resolveProjectFinancials(org.orgId, projectId, laborProfile);
    // Labour at cost rates: 500 CAD + 675 CAD.
    assert.equal(labor.measures.labor_cost, "1175.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project financials fail closed when a measure functional has no spot coverage", { skip: !DB }, async () => {
  const { org, projectId } = await seedTwoCurrencyProject();
  try {
    await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`);
    await assert.rejects(resolveProjectFinancials(org.orgId, projectId, tmProfile), /no spot rate for USD/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("approved hours with no cost rate price nothing and surface as unrated", { skip: !DB }, async () => {
  const { org, projectId } = await seedTwoCurrencyProject();
  try {
    // Six approved hours with no wage evidence (legacy or an explicit
    // unrated opt-in): priced labour must not move, and the hours must
    // appear as unrated instead of a silent $0.
    const unratedEmp = randomUUID();
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${unratedEmp}, ${org.orgId}, 'employee', 'Unrated Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`);
    await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, status, is_billable, custom)
      values (${randomUUID()}, ${org.orgId}, ${unratedEmp}, ${org.date}, '6.0000', ${projectId}, 'approved', false, '{}'::jsonb)`);
    const labor = await resolveProjectFinancials(org.orgId, projectId, laborProfile);
    assert.equal(labor.measures.labor_cost, "1175.0000");
    assert.equal(labor.measures.labor_unrated_hours, "6.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
