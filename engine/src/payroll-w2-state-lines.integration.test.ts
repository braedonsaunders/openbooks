import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { setPackSlotAccount } from "./payroll/packs.ts";
import { yearEndFiling } from "./payroll-filing-registry.ts";
import {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
} from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * W-2 boxes 15–20 from the committed-stub subledger.
 *
 * The US pack withholds state income tax (`state_income_tax`) and local
 * income tax (`local_income_tax`) on committed stubs; the W-2 slip reports
 * them back per work state the way boxes 1–6 report the federal figures —
 * one repeating 15–20 group per state on the single copy, per the IRS General
 * Instructions for Forms W-2 and W-3 (two-letter state abbreviation and the
 * state-assigned ID in 15; state wages in 16; state income tax in 17; local
 * wages, local tax and locality name in 18–20). No SSA EFW2 file is produced;
 * that refusal stays.
 */

interface Fixture {
  orgId: string;
  actorId: string;
  scheduleId: string;
}

async function usPayrollOrg(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const account = async (number: string, name: string, type: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                            reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
              '[]'::jsonb, '{}'::jsonb, true)`);
    return id;
  };
  const wageExpense = await account("6000", "Wages expense", "expense");
  const burdenExpense = await account("6010", "Payroll burden", "expense");
  const netPayable = await account("2300", "Wages payable", "liability_current");
  const irsPayable = await account("2330", "Federal payroll taxes payable", "liability_current");
  const statePayable = await account("2360", "State income tax payable", "liability_current");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        countries: ["US"],
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "US");
  for (const slot of ["fit", "fica", "futa", "suta"]) {
    await setPackSlotAccount(org.orgId, actorId, "US", slot, irsPayable);
  }
  await setPackSlotAccount(org.orgId, actorId, "US", "state_income_tax", statePayable);
  await setPackSlotAccount(org.orgId, actorId, "US", "local_income_tax", statePayable);

  const subsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
            '{}'::jsonb, false, true, '{}'::jsonb)`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active,
                               created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly US', 'biweekly', 26, '2026-07-18', 3,
            ${subsidiaryId}, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, scheduleId };
}

/** The employer's SUI account for a state — the box-15 ID number's source. */
async function suiAccount(fx: Fixture, state: string, accountNumber: string): Promise<void> {
  await db.execute(sql`
    insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                         state_code, is_default)
    values (${randomUUID()}, ${fx.orgId}, 'US', 'us_state_sui', ${accountNumber}, ${`${state} SUI`},
            ${state}, false)`);
}

interface EmployeeOptions {
  state: string;
  certificates?: { key: string; region?: string | null; answers?: Record<string, string> }[];
}

async function usEmployee(fx: Fixture, subsidiaryId: string, name: string, opts: EmployeeOptions): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${fx.orgId}, 'person', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id)
    values (${randomUUID()}, ${fx.orgId}, ${id})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, 'USD', '52000', 'year', 2080, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                           province, pay_basis, filing_status,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, ${fx.scheduleId}, 'US', ${opts.state},
            'salary', 'single', true, ${fx.actorId}, ${fx.actorId})`);
  for (const certificate of opts.certificates ?? []) {
    await db.execute(sql`
      insert into employee_tax_certificates (org_id, employee_party_id, country, certificate_key,
                                             region, sub_region, answers, effective_from,
                                             created_by, updated_by)
      values (${fx.orgId}, ${id}, 'US', ${certificate.key}, ${certificate.region ?? null},
              null, ${JSON.stringify(certificate.answers ?? {})}::jsonb, '2026-01-01',
              ${fx.actorId}, ${fx.actorId})`);
  }
  return id;
}

async function runAndCommit(fx: Fixture, periodStart: string, periodEnd: string): Promise<string> {
  const run = await createPayRun({
    orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
    periodStart, periodEnd,
  });
  assert.deepEqual((await calculatePayRun({
    orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
  })).errors, []);
  await commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
  return run.documentId;
}

/** Every deduction line on committed stubs, by component system key. */
async function committedDeductions(fx: Fixture, systemKey: string, province?: string) {
  return (await db.execute<{ amount: string; description: string; province: string }>(sql`
    select l.amount::text as amount, l.description, s.province
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where l.org_id = ${fx.orgId} and r.run_status = 'committed'
       and c.system_key = ${systemKey}
       and (${province ?? null}::text is null or s.province = ${province ?? null})`)).rows;
}

async function w2SlipFor(fx: Fixture, employeeName: string) {
  const filing = yearEndFiling("US", "w2");
  const population = await filing.population(fx.orgId, 2026);
  const row = population.rows.find((candidate) => candidate.employee === employeeName);
  assert.ok(row, `${employeeName} has a W-2 population row`);
  return filing.slip!.build(fx.orgId, 2026, row!.rowId as string);
}

test(
  "a New York City resident's W-2 carries state boxes 15-17 and locality boxes 18-20",
  { skip: !DB },
  async () => {
    const fx = await usPayrollOrg();
    try {
      await suiAccount(fx, "NY", "NY-0099887");
      const subsidiary = (await db.execute<{ subsidiary_id: string }>(sql`
        select subsidiary_id from pay_schedules where org_id = ${fx.orgId} and id = ${fx.scheduleId}`)).rows[0]!
        .subsidiary_id;
      // New York City reaches residents only: without the IT-2104 answer the
      // city tax is silently zero and boxes 18-20 would prove nothing.
      await usEmployee(fx, subsidiary, "Gotham Gil", {
        state: "NY",
        certificates: [{ key: "us_ny_it2104", region: "NY", answers: { nyc_resident: "true" } }],
      });
      await runAndCommit(fx, "2026-07-05", "2026-07-18");

      // The stub really withholds both levels: without these lines the rest
      // of the test would pass vacuously.
      const stateLines = await committedDeductions(fx, "state_income_tax");
      assert.equal(stateLines.length, 1);
      assert.ok(Number(stateLines[0]!.amount) > 0, "New York tax is withheld on the stub");
      const localLines = await committedDeductions(fx, "local_income_tax");
      assert.equal(localLines.length, 1);
      assert.ok(Number(localLines[0]!.amount) > 0, "New York City tax is withheld on the stub");

      const slip = await w2SlipFor(fx, "Gotham Gil");
      const federal = slip.boxes.filter((box) => ["1", "2", "3", "4", "5", "6"].includes(box.code));
      assert.equal(federal.length, 6, "federal boxes 1-6 are unchanged");
      const byCode = (code: string) => slip.boxes.filter((box) => box.code === code);

      assert.deepEqual(byCode("15").map((box) => box.value), ["NY-0099887"]);
      assert.match(byCode("15")[0]!.label, /NY/);
      // Single-state wages reconcile to box 1; the tax reconciles to the stub.
      assert.equal(byCode("16").length, 1);
      assert.equal(
        byCode("16")[0]!.value,
        federal.find((box) => box.code === "1")!.value,
        "single-state box 16 equals box 1",
      );
      assert.deepEqual(byCode("17").map((box) => box.value), [stateLines[0]!.amount]);
      assert.deepEqual(byCode("19").map((box) => box.value), [localLines[0]!.amount]);
      assert.deepEqual(byCode("20").map((box) => box.value), ["New York City resident income tax"]);
      assert.equal(byCode("18").length, 1, "local wages ride the locality that withheld");
      assert.ok(Number(byCode("18")[0]!.value) > 0);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a mid-year mover's two states appear as two groups, never one smashed row",
  { skip: !DB },
  async () => {
    const fx = await usPayrollOrg();
    try {
      await suiAccount(fx, "AZ", "AZ-0011223");
      // No SUI account for California: its box 15 names the state with no ID.
      const subsidiary = (await db.execute<{ subsidiary_id: string }>(sql`
        select subsidiary_id from pay_schedules where org_id = ${fx.orgId} and id = ${fx.scheduleId}`)).rows[0]!
        .subsidiary_id;
      const employee = await usEmployee(fx, subsidiary, "Mover Max", { state: "AZ" });
      await runAndCommit(fx, "2026-07-05", "2026-07-18");
      await db.execute(sql`
        update employee_payroll_profiles set province = 'CA', updated_by = ${fx.actorId}
         where org_id = ${fx.orgId} and employee_party_id = ${employee}`);
      await runAndCommit(fx, "2026-07-19", "2026-08-01");

      const azTax = await committedDeductions(fx, "state_income_tax", "AZ");
      const caTax = await committedDeductions(fx, "state_income_tax", "CA");
      assert.equal(azTax.length, 1, "Arizona withheld on the first stub");
      assert.equal(caTax.length, 1, "California withheld on the second stub");

      const slip = await w2SlipFor(fx, "Mover Max");
      assert.match(String(slip.headerFields.find((field) => field.label === "State(s) of employment")!.value), /AZ \/ CA/);
      const byCode = (code: string) => slip.boxes.filter((box) => box.code === code);
      assert.deepEqual(byCode("15").map((box) => box.value), ["AZ-0011223", "Unassigned"]);
      assert.deepEqual(byCode("17").map((box) => box.value), [azTax[0]!.amount, caTax[0]!.amount]);
      // The two states' wages add up to the one federal wage set — split, not smashed.
      const box1 = slip.boxes.find((box) => box.code === "1")!.value;
      const box16s = byCode("16");
      assert.equal(box16s.length, 2);
      assert.ok(
        Number(box16s[0]!.value) + Number(box16s[1]!.value) === Number(box1),
        "state wages partition box 1",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a no-state-tax employee's W-2 has empty boxes 15-17, not zeros",
  { skip: !DB },
  async () => {
    const fx = await usPayrollOrg();
    try {
      // Texas levies no wage income tax: the stub withholds nothing at either
      // level, so there is nothing to file in boxes 15-20.
      const subsidiary = (await db.execute<{ subsidiary_id: string }>(sql`
        select subsidiary_id from pay_schedules where org_id = ${fx.orgId} and id = ${fx.scheduleId}`)).rows[0]!
        .subsidiary_id;
      await usEmployee(fx, subsidiary, "Lone Star Lou", { state: "TX" });
      await runAndCommit(fx, "2026-07-05", "2026-07-18");
      assert.equal((await committedDeductions(fx, "state_income_tax")).length, 0);
      assert.equal((await committedDeductions(fx, "local_income_tax")).length, 0);

      const slip = await w2SlipFor(fx, "Lone Star Lou");
      assert.deepEqual(slip.boxes.map((box) => box.code), ["1", "2", "3", "4", "5", "6"]);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "the W-2 gap names only the state-ID residual, and the EFW2 refusal stays",
  { skip: !DB },
  async () => {
    const { W2_GAPS } = await import("./payroll/us/filings.ts");
    assert.ok(
      W2_GAPS.some((gap) => /state ID/i.test(gap)),
      "the residual employer state-ID gap is still declared",
    );
    assert.ok(
      !W2_GAPS.some((gap) => /not reported per state/i.test(gap)),
      "boxes 15-20 are reported now, so the old gap is gone",
    );
    const filing = yearEndFiling("US", "w2");
    assert.match(filing.downloadRefusal!, /EFW2/, "no SSA EFW2 file is produced");
  },
);
