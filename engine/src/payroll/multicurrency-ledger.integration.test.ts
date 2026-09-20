import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { deriveConsolidatedRates } from "../consolidation/consolidation.ts";
import { db } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { payrollRemittanceSummary } from "./remittance.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A mixed-currency payroll ledger must never add raw units from different
 * currencies and present the total under one symbol. Two committed runs —
 * GBP 11,083.33 and EUR 12,250.00 — share one remittance group; the summary
 * must refuse (or translate through a derived rate), never report 23,333.33.
 * A foreign-subsidiary pay run likewise must not post with no derived
 * consolidated rate for its period. Single-currency scopes post and aggregate
 * exactly as before.
 */
type MixedFixture = {
  orgId: string;
  actorId: string;
  rootSub: string;
  eurSub: string;
  liability: string;
  component: string;
  septPeriod: string;
  control: { ar: string; ap: string; bank: string };
};

async function seedMixedOrg(): Promise<MixedFixture> {
  const org = await createScratchOrg();
  const orgId = org.orgId;
  const actorId = (await seedFlowActors(orgId)).adminId;
  const control = { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank };
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('GBP', 'Pound Sterling', 2), ('EUR', 'Euro', 2)
    on conflict (code) do nothing`);
  await db.execute(sql`
    update subsidiaries set base_currency = 'GBP', country = 'GB', name = 'London HQ'
     where org_id = ${orgId} and parent_id is null`);
  await db.execute(sql`update orgs set base_currency = 'GBP', country = 'GB' where id = ${orgId}`);
  const rootSub = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null`)).rows[0]!.id;
  const eurSub = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${eurSub}, ${orgId}, ${rootSub}, 'Dublin Branch', 'EUR', 'IE', '{}'::jsonb,
            false, true, '{}'::jsonb)`);
  const calendar = (await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where org_id = ${orgId} limit 1`)).rows[0]!.id;
  const septPeriod = randomUUID();
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
                                    is_adjustment, fiscal_calendar_id)
    values (${septPeriod}, ${orgId}, 2026, 9, '2026-09', '2026-09-01', '2026-09-30', false, ${calendar})
    on conflict (id) do nothing`);
  const liability = randomUUID();
  const number = `2${String(Math.floor(Math.random() * 9000) + 1000)}`;
  await db.execute(sql`
    insert into accounts
      (id, org_id, number, name, type, is_summary, is_active, eliminate,
       reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${liability}, ${orgId}, ${number}, 'Payroll liabilities', 'liability_current', false, true,
            false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  const component = randomUUID();
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
    values (${orgId}, ${org.vendorId}, true, ${actorId}, ${actorId})
    on conflict do nothing`);
  await db.execute(sql`
    insert into pay_components
      (id, org_id, code, name, kind, system_key, liability_account_id,
       remittance_party_id, sequence, country, created_by, updated_by)
    values (${component}, ${orgId}, ${`MIX-${component.slice(0, 6)}`}, 'Test withholding', 'deduction',
            'income_tax', ${liability}, ${org.vendorId}, 10, 'GB', ${actorId}, ${actorId})`);
  return { orgId, actorId, rootSub, eurSub, liability, component, septPeriod, control };
}

async function addCommittedRun(
  fx: MixedFixture,
  input: { subsidiary: string; currency: string; gross: string; number: string; schedule: string },
): Promise<string> {
  const documentId = randomUUID();
  const stubId = randomUUID();
  const lineId = randomUUID();
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom, created_by, updated_by)
    values (${employeeId}, ${fx.orgId}, 'person', ${`Emp ${input.number}`}, ${input.subsidiary},
            true, '{}'::jsonb, ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date, posting_date, posting_period_id,
       currency, status, memo, created_by, updated_by)
    values (${documentId}, ${fx.orgId}, 'pay_run', ${input.number}, ${input.subsidiary}, '2026-09-30',
            '2026-09-30', ${fx.septPeriod}, ${input.currency}, 'draft', 'mixed-currency proof',
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end, pay_date_offset_days,
       is_active, created_by, updated_by)
    values (${input.schedule}, ${fx.orgId}, ${`Schedule ${input.number}`}, 'monthly', 12, '2026-09-30', 0,
            true, ${fx.actorId}, ${fx.actorId})
    on conflict (id) do nothing`);
  await db.execute(sql`
    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year,
       run_status, run_type, created_by, updated_by)
    values (${documentId}, ${fx.orgId}, ${input.schedule}, '2026-09-01', '2026-09-30', '2026-09-30', 2026,
            'committed', 'regular', ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province, periods_per_year, pay_date, tax_year,
       currency_code, gross, pensionable_earnings, insurable_earnings, net_pay, employer_cost,
       vacation_accrued, factors, created_by, updated_by)
    values (${stubId}, ${fx.orgId}, ${documentId}, ${employeeId}, 'LON', 12, '2026-09-30', 2026,
            ${input.currency}, ${input.gross}, ${input.gross}, ${input.gross}, ${input.gross},
            ${input.gross}, '0', '{}'::jsonb, ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, amount, sequence,
       liability_account_id, liability_account_source, created_by, updated_by)
    values (${lineId}, ${fx.orgId}, ${stubId}, ${fx.component}, 'deduction', 'Test withholding',
            ${input.gross}, 10, ${fx.liability}, 'commit', ${fx.actorId}, ${fx.actorId})`);
  return documentId;
}

test("a GBP run and a EUR run never sum to one symbol-labelled figure", { skip: !DB }, async () => {
  const fx = await seedMixedOrg();
  try {
    await addCommittedRun(fx, { subsidiary: fx.rootSub, currency: "GBP", gross: "11083.33", number: "PAY-00002", schedule: randomUUID() });
    await addCommittedRun(fx, { subsidiary: fx.eurSub, currency: "EUR", gross: "12250.00", number: "PAY-00003", schedule: randomUUID() });
    await assert.rejects(
      payrollRemittanceSummary(fx.orgId, { from: "2026-09-01", to: "2026-09-30" }),
      /No consolidated exchange rates for EUR → GBP in the period ending 2026-09-30\. Derive rates from period close first\./,
      "the mixed scope refuses with the trial balance's own message",
    );
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("a mixed scope translates through derived rates — never at a silent 1.0", { skip: !DB }, async () => {
  const fx = await seedMixedOrg();
  try {
    await addCommittedRun(fx, { subsidiary: fx.rootSub, currency: "GBP", gross: "11083.33", number: "PAY-00002", schedule: randomUUID() });
    await addCommittedRun(fx, { subsidiary: fx.eurSub, currency: "EUR", gross: "12250.00", number: "PAY-00003", schedule: randomUUID() });
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${fx.orgId}, 'EUR', 'GBP', '2026-09-15', 'spot', '0.85')`);
    const written = await deriveConsolidatedRates(fx.orgId, fx.septPeriod, fx.actorId);
    assert.ok(written > 0, "the September EUR→GBP rate derives");
    const groups = await payrollRemittanceSummary(fx.orgId, { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(groups.length, 1);
    // 11,083.33 GBP + 12,250.00 EUR × 0.85 = 21,495.83 GBP. The raw-unit sum
    // 23,333.33 (a silent 1.0) must never appear.
    assert.equal(cmp(groups[0]!.grossPayroll, "21495.83"), 0);
    assert.equal(cmp(groups[0]!.total, "21495.83"), 0);
    assert.ok(cmp(groups[0]!.grossPayroll, "23333.33") !== 0);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("a single-currency scope aggregates exactly as before", { skip: !DB }, async () => {
  const fx = await seedMixedOrg();
  try {
    await addCommittedRun(fx, { subsidiary: fx.rootSub, currency: "GBP", gross: "11083.33", number: "PAY-00002", schedule: randomUUID() });
    const groups = await payrollRemittanceSummary(fx.orgId, { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(groups.length, 1);
    assert.equal(cmp(groups[0]!.grossPayroll, "11083.33"), 0);
    assert.equal(cmp(groups[0]!.total, "11083.33"), 0);
    assert.equal(groups[0]!.employeeCount, 1);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("a homogeneous foreign-currency scope passes through untranslated", { skip: !DB }, async () => {
  const fx = await seedMixedOrg();
  try {
    await addCommittedRun(fx, { subsidiary: fx.eurSub, currency: "EUR", gross: "12250.00", number: "PAY-00003", schedule: randomUUID() });
    const groups = await payrollRemittanceSummary(fx.orgId, { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(groups.length, 1);
    assert.equal(cmp(groups[0]!.grossPayroll, "12250.00"), 0);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

async function seedPostableRun(fx: MixedFixture, subsidiary: string, currency: string, number: string): Promise<string> {
  const wages = randomUUID();
  const expenseNumber = `5${String(Math.floor(Math.random() * 9000) + 1000)}`;
  await db.execute(sql`
    insert into accounts
      (id, org_id, number, name, type, is_summary, is_active, eliminate,
       reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${wages}, ${fx.orgId}, ${expenseNumber}, 'Wages expense', 'expense', false, true,
            false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date, posting_date, posting_period_id,
       currency, status, memo, created_by, updated_by)
    values (${documentId}, ${fx.orgId}, 'pay_run', ${number}, ${subsidiary}, '2026-09-30',
            '2026-09-30', ${fx.septPeriod}, ${currency}, 'draft', 'posting proof',
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into document_lines (org_id, document_id, line_number, account_id, description, amount,
                                created_by, updated_by)
    values (${fx.orgId}, ${documentId}, 1, ${wages}, 'Wages', '100.00', ${fx.actorId}, ${fx.actorId}),
           (${fx.orgId}, ${documentId}, 2, ${fx.liability}, 'Withholding', '-100.00', ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`update documents set status = 'approved' where id = ${documentId}`);
  return documentId;
}

test("a foreign-subsidiary pay run refuses to post with no derived rate", { skip: !DB }, async () => {
  const fx = await seedMixedOrg();
  try {
    const documentId = await seedPostableRun(fx, fx.eurSub, "EUR", "PAY-00003");
    await assert.rejects(
      postDocument(documentId, { control: fx.control }),
      /No consolidated exchange rates for EUR → GBP in the period ending 2026-09-30\. Derive rates from period close first\./,
    );
    const status = (await db.execute<{ status: string }>(sql`
      select status from documents where id = ${documentId}`)).rows[0]!.status;
    assert.equal(status, "approved", "the refused run stays unposted");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("a foreign-subsidiary pay run posts once rates derive, tagged with its currency", { skip: !DB }, async () => {
  const fx = await seedMixedOrg();
  try {
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${fx.orgId}, 'EUR', 'GBP', '2026-09-15', 'spot', '0.85')`);
    await deriveConsolidatedRates(fx.orgId, fx.septPeriod, fx.actorId);
    const documentId = await seedPostableRun(fx, fx.eurSub, "EUR", "PAY-00003");
    const entryId = await postDocument(documentId, { control: fx.control });
    const lines = (await db.execute<{
      subsidiary_id: string; amount: string; currency: string; txn_amount: string; fx_rate: string;
    }>(sql`
      select subsidiary_id, amount::text as amount, currency, txn_amount::text as txn_amount,
             fx_rate::text as fx_rate
        from journal_lines where entry_id = ${entryId} order by line_number`)).rows;
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.subsidiary_id, fx.eurSub);
      assert.equal(line.currency, "EUR");
      assert.equal(line.txn_amount, line.amount);
    }
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("a root-currency pay run posts with no rates anywhere", { skip: !DB }, async () => {
  const fx = await seedMixedOrg();
  try {
    const documentId = await seedPostableRun(fx, fx.rootSub, "GBP", "PAY-00002");
    const entryId = await postDocument(documentId, { control: fx.control });
    assert.ok(entryId);
    const count = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from consolidated_fx_rates where org_id = ${fx.orgId}`)).rows[0]!.n;
    assert.equal(count, 0, "no rate was needed or read");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("translated totals never equal the raw-unit sum", { skip: !DB }, async () => {
  const fx = await seedMixedOrg();
  try {
    await addCommittedRun(fx, { subsidiary: fx.rootSub, currency: "GBP", gross: "11083.33", number: "PAY-00002", schedule: randomUUID() });
    await addCommittedRun(fx, { subsidiary: fx.eurSub, currency: "EUR", gross: "12250.00", number: "PAY-00003", schedule: randomUUID() });
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${fx.orgId}, 'EUR', 'GBP', '2026-09-15', 'spot', '1.17')`);
    await deriveConsolidatedRates(fx.orgId, fx.septPeriod, fx.actorId);
    const groups = await payrollRemittanceSummary(fx.orgId, { from: "2026-09-01", to: "2026-09-30" });
    // A silent 1.0 would report 23,333.33; the translated figure differs.
    assert.ok(cmp(groups[0]!.grossPayroll, "23333.33") !== 0);
    assert.equal(cmp(groups[0]!.grossPayroll, "25415.83"), 0);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
