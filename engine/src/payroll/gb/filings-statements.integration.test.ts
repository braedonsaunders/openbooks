/**
 * GB P60/P45 statement tests — DB-owned, run on the gate machine.
 *
 * "Written to the standard, not executed" on the Mac: this file needs a
 * database (populations are SQL over committed pay runs) and the Mac no
 * longer creates one. The gate runs exactly what is written here.
 *
 * What these prove, with two stayers (rUK + Scotland) across two committed
 * monthly runs, one leaver, and one calculated-but-uncommitted run:
 * - the P60 population aggregates the year's committed stubs per employee
 *   (not one row per run), and the uncommitted run is excluded;
 * - every figure ties to the committed subledger to the cent through
 *   INDEPENDENT queries (gross columns for pay, component lines for tax and
 *   NIC — not the factors the builder sums);
 * - the leaver is excluded from the P60 and appears on the P45 with the
 *   termination date;
 * - parseRowId round-trips every emitted row id and refuses foreign ones;
 * - the slip boxes carry the population figures, the S-code reports Scottish
 *   tax, and a missing coding notice refuses by name;
 * - a year with no committed runs, and a year the pack's tables do not
 *   cover, refuse by name instead of printing an empty statement.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { cmp } from "../../money/money.ts";
import { db } from "../../platform/db.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { seedPayrollComponents } from "../run-setup.ts";
import { gbP45Leavers, gbP60Slips, gbTaxYearBounds } from "../yearend.ts";
import { gbPackFilings } from "./filings.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} from "../../testing/fixtures.ts";
import "../../testing/database-bypass.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const YEAR = 2026;

async function makeAccount(
  orgId: string,
  actorId: string,
  number: string,
  name: string,
  type: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_active, is_summary, created_by, updated_by)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, true, false, ${actorId}, ${actorId})`);
  return id;
}

async function makeEmployee(
  orgId: string,
  subsidiaryId: string,
  actorId: string,
  scheduleId: string,
  name: string,
  nation: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${orgId}, 'person', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, employee_number)
    values (${randomUUID()}, ${orgId}, ${id}, ${`GB-${name}`})`);
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis, is_active,
       created_by, updated_by)
    values (${orgId}, ${id}, ${scheduleId}, 'GB', ${nation}, 'salary', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates
      (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from, is_active,
       created_by, updated_by)
    values (${orgId}, ${id}, 'GBP', '36000', 'year', '2080', '2026-01-01', true,
            ${actorId}, ${actorId})`);
  return id;
}

async function fileCertificate(
  orgId: string,
  employeeId: string,
  actorId: string,
  key: string,
  answers: Record<string, string>,
): Promise<void> {
  await db.execute(sql`
    insert into employee_tax_certificates
      (org_id, employee_party_id, country, certificate_key, region, sub_region,
       answers, effective_from, created_by, updated_by)
    values (${orgId}, ${employeeId}, 'GB', ${key}, null, null,
            ${JSON.stringify(answers)}::jsonb, '2026-04-06'::date, ${actorId}, ${actorId})`);
}

async function payMonth(
  orgId: string,
  actorId: string,
  scheduleId: string,
  periodStart: string,
  periodEnd: string,
  commit: boolean,
): Promise<string> {
  const run = await createPayRun({ orgId, actorId, payScheduleId: scheduleId, periodStart, periodEnd });
  const calc = await calculatePayRun({ orgId, actorId, documentId: run.documentId });
  assert.deepEqual(calc.errors, []);
  if (commit) await commitPayRun({ orgId, documentId: run.documentId, actorId });
  return run.documentId;
}

/** Independent tie-out legs: gross columns for pay, component lines for tax/NIC. */
async function independentTotals(orgId: string, employeeId: string): Promise<{
  pay: string; tax: string; nic: string;
}> {
  const rows = (await db.execute<{ pay: string; tax: string; nic: string }>(sql`
    select sum(s.gross)::text as pay,
           (select coalesce(sum(l.amount), 0)::text from pay_stub_lines l
             join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
             join pay_stubs s2 on s2.id = l.stub_id and s2.org_id = l.org_id
             join pay_runs r2 on r2.document_id = s2.pay_run_document_id and r2.org_id = s2.org_id
                and r2.run_status = 'committed'
            where l.org_id = ${orgId} and s2.employee_party_id = ${employeeId}
              and s2.tax_year = ${YEAR} and s2.country = 'GB'
              and l.kind = 'deduction' and pc.system_key = 'paye') as tax,
           (select coalesce(sum(l.amount), 0)::text from pay_stub_lines l
             join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
             join pay_stubs s2 on s2.id = l.stub_id and s2.org_id = l.org_id
             join pay_runs r2 on r2.document_id = s2.pay_run_document_id and r2.org_id = s2.org_id
                and r2.run_status = 'committed'
            where l.org_id = ${orgId} and s2.employee_party_id = ${employeeId}
              and s2.tax_year = ${YEAR} and s2.country = 'GB'
              and l.kind = 'deduction' and pc.system_key = 'nic') as nic
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.employee_party_id = ${employeeId}
       and s.tax_year = ${YEAR} and s.country = 'GB'
  `)).rows[0]!;
  return { pay: rows.pay, tax: rows.tax, nic: rows.nic };
}

test(
  "GB P60 aggregates committed runs, ties to the subledger, and excludes the leaver",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const deductionsId = await makeAccount(org.orgId, actorId, "2110", "Payroll Deductions", "liability_current_other");
      const wageId = await makeAccount(org.orgId, actorId, "6000", "Wages & Salaries", "expense");
      const netId = await makeAccount(org.orgId, actorId, "2300", "Employee Payable", "liability_current_other");
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(
             jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"payroll": true}'::jsonb),
             '{payroll}',
             ${JSON.stringify({ wageExpenseAccountId: wageId, netPayAccountId: netId, countries: ["GB"] })}::jsonb
           )
         where id = ${org.orgId}`);
      await db.execute(sql`
        update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts}',
          '{"payrollDeductions": "${deductionsId}"}'::jsonb) where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "GB");
      // The employer PAYE reference the statements head with.
      await db.execute(sql`
        insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,is_default)
        values(${randomUUID()},${org.orgId},'GB','gb_paye','123/AB45678','Main PAYE reference',true)`);

      await db.execute(sql`
        update subsidiaries set base_currency = 'GBP', country = 'GB', name = 'London HQ'
         where org_id = ${org.orgId} and id = ${org.subsidiaryId}`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules
          (id, org_id, name, frequency, periods_per_year, anchor_period_end, pay_date_offset_days,
           subsidiary_id, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'GB monthly', 'monthly', 12, '2026-04-01', 0,
                ${org.subsidiaryId}, true, ${actorId}, ${actorId})`);
      const amy = await makeEmployee(org.orgId, org.subsidiaryId, actorId, scheduleId, "Amy Stayer", "ENG");
      const hamish = await makeEmployee(org.orgId, org.subsidiaryId, actorId, scheduleId, "Hamish Stayer", "SCT");
      const larry = await makeEmployee(org.orgId, org.subsidiaryId, actorId, scheduleId, "Larry Leaver", "ENG");
      await fileCertificate(org.orgId, amy, actorId, "gb_tax_code_notice", { tax_code: "1257L" });
      await fileCertificate(org.orgId, amy, actorId, "gb_starter_checklist", { starter_declaration: "A" });
      await fileCertificate(org.orgId, hamish, actorId, "gb_tax_code_notice", { tax_code: "S1257L" });
      await fileCertificate(org.orgId, hamish, actorId, "gb_starter_checklist", { starter_declaration: "A" });
      await fileCertificate(org.orgId, larry, actorId, "gb_tax_code_notice", { tax_code: "1257L" });
      await fileCertificate(org.orgId, larry, actorId, "gb_starter_checklist", { starter_declaration: "A" });

      await payMonth(org.orgId, actorId, scheduleId, "2026-05-01", "2026-05-31", true);
      await payMonth(org.orgId, actorId, scheduleId, "2026-06-01", "2026-06-30", true);
      await db.execute(sql`
        update employee_roles set terminated_on = '2026-06-20'::date
         where org_id = ${org.orgId} and party_id = ${larry}`);
      // Calculated but never committed: a draft must not appear on a
      // statutory statement.
      await payMonth(org.orgId, actorId, scheduleId, "2026-07-01", "2026-07-31", false);

      // The P60 names the two stayers, not the leaver — one row per
      // employment, not one row per run.
      const slips = await gbP60Slips(org.orgId, YEAR);
      assert.deepEqual(slips.map((slip) => slip.employeeName), ["Amy Stayer", "Hamish Stayer"]);
      for (const slip of slips) {
        // Two committed £3,000 months; the July draft is excluded.
        const expected = await independentTotals(org.orgId, slip.employeePartyId);
        assert.equal(cmp(slip.payInEmployment, expected.pay), 0, `${slip.employeeName} pay ties to gross`);
        assert.equal(cmp(slip.taxDeducted, expected.tax), 0, `${slip.employeeName} tax ties to PAYE lines`);
        assert.equal(cmp(slip.nicEmployee, expected.nic), 0, `${slip.employeeName} NIC ties to NIC lines`);
        assert.equal(slip.stubCount, 2);
        assert.ok(cmp(slip.taxDeducted, "0") > 0, "PAYE priced above zero through the product");
      }
      const hamishSlip = slips.find((slip) => slip.employeeName === "Hamish Stayer")!;
      assert.equal(hamishSlip.nation, "SCT");
      assert.equal(hamishSlip.scottishCode, true);
      assert.equal(hamishSlip.finalTaxCode, "S1257L");

      // The declaration's population carries the same figures under stable
      // row ids, and every row id round-trips through the declared grammar.
      const p60 = gbPackFilings().yearEnd.find((filing) => filing.key === "p60")!;
      const population = await p60.population(org.orgId, YEAR);
      assert.equal(population.rows.length, 2);
      for (const row of population.rows) {
        const parsed = p60.parseRowId(String(row[population.rowKey]));
        assert.ok(parsed, "every emitted row id parses");
        assert.equal(parsed!.employees.length, 1);
      }
      assert.equal(p60.parseRowId("not-a-gb-row"), null);
      assert.equal(
        p60.parseRowId("11111111-1111-4111-8111-111111111111:ON:22222222-2222-4222-8222-222222222222"),
        null,
      );

      // The population totals tie to org-wide independent sums — the
      // employer-side reconciliation (total PAYE, both NIC shares).
      const orgWide = (await db.execute<{ pay: string; tax: string; nicEe: string; nicEr: string }>(sql`
        select sum(s.gross)::text as pay,
               (select coalesce(sum(l.amount), 0)::text from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                 join pay_stubs s2 on s2.id = l.stub_id and s2.org_id = l.org_id
                 join pay_runs r2 on r2.document_id = s2.pay_run_document_id and r2.org_id = s2.org_id
                    and r2.run_status = 'committed'
                where l.org_id = ${org.orgId} and s2.tax_year = ${YEAR} and s2.country = 'GB'
                  and l.kind = 'deduction' and pc.system_key = 'paye') as tax,
               (select coalesce(sum(l.amount), 0)::text from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                 join pay_stubs s2 on s2.id = l.stub_id and s2.org_id = l.org_id
                 join pay_runs r2 on r2.document_id = s2.pay_run_document_id and r2.org_id = s2.org_id
                    and r2.run_status = 'committed'
                where l.org_id = ${org.orgId} and s2.tax_year = ${YEAR} and s2.country = 'GB'
                  and l.kind = 'deduction' and pc.system_key = 'nic') as "nicEe",
               (select coalesce(sum(l.amount), 0)::text from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                 join pay_stubs s2 on s2.id = l.stub_id and s2.org_id = l.org_id
                 join pay_runs r2 on r2.document_id = s2.pay_run_document_id and r2.org_id = s2.org_id
                    and r2.run_status = 'committed'
                where l.org_id = ${org.orgId} and s2.tax_year = ${YEAR} and s2.country = 'GB'
                  and l.kind = 'employer_contribution' and pc.system_key = 'nic') as "nicEr"
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
             and r.run_status = 'committed'
          join employee_roles er on er.party_id = s.employee_party_id and er.org_id = s.org_id
         where s.org_id = ${org.orgId} and s.tax_year = ${YEAR} and s.country = 'GB'
           and (er.terminated_on is null or er.terminated_on::date > ${gbTaxYearBounds(YEAR).end})
      `)).rows[0]!;
      const totalOf = (label: string) => String(population.totals!.find((t) => t.label === label)!.value);
      // The leaver's stubs are excluded from the P60 totals by the same
      // eligibility rule as the rows — the org-wide query above applies it.
      assert.equal(cmp(totalOf("Total pay in employments"), orgWide.pay), 0);
      assert.equal(cmp(totalOf("Total PAYE deducted"), orgWide.tax), 0);
      assert.equal(cmp(totalOf("Employee NIC (primary)"), orgWide.nicEe), 0);
      assert.equal(cmp(totalOf("Employer NIC (secondary)"), orgWide.nicEr), 0);

      // The slip ties to the population, heads the PAYE reference, and
      // reports the Scottish code as Scottish tax.
      const amyRow = String(population.rows.find((row) => row.employee === "Amy Stayer")![population.rowKey]);
      const amySlip = await p60.slip!.build(org.orgId, YEAR, amyRow);
      assert.equal(amySlip.formNumber, "P60");
      const box = (code: string) => amySlip.boxes.find((candidate) => candidate.code === code)!.value;
      const amyStatement = slips.find((slip) => slip.employeeName === "Amy Stayer")!;
      assert.equal(cmp(box("this-pay"), amyStatement.payInEmployment), 0);
      assert.equal(cmp(box("this-tax"), amyStatement.taxDeducted), 0);
      assert.equal(box("final-tax-code"), "1257L");
      assert.ok(amySlip.headerFields.some((field) => field.value === "123/AB45678"));
      const hamishRow = String(population.rows.find((row) => row.employee === "Hamish Stayer")![population.rowKey]);
      const hamishFacsimile = await p60.slip!.build(org.orgId, YEAR, hamishRow);
      assert.match(
        hamishFacsimile.boxes.find((candidate) => candidate.code === "final-tax-code")!.value,
        /S1257L.*Scottish/,
      );
      // The RTI file is refused by name, never implied.
      assert.match(p60.downloadRefusal!, /Full Payment Submission/);

      // The leaver is excluded from the P60 and owns the P45 population.
      const p45 = gbPackFilings().yearEnd.find((filing) => filing.key === "p45")!;
      assert.equal(p45.cadence, "separation");
      const leavers = await gbP45Leavers(org.orgId, YEAR);
      assert.equal(leavers.length, 1);
      assert.equal(leavers[0]!.employeeName, "Larry Leaver");
      assert.equal(leavers[0]!.leavingDate, "2026-06-20");
      const larryExpected = await independentTotals(org.orgId, larry);
      assert.equal(cmp(leavers[0]!.payInEmployment, larryExpected.pay), 0);
      assert.equal(cmp(leavers[0]!.taxDeducted, larryExpected.tax), 0);
      const p45population = await p45.population(org.orgId, YEAR);
      assert.equal(p45population.rows.length, 1);
      const larryRow = String(p45population.rows[0]![p45population.rowKey]);
      assert.deepEqual(p45.parseRowId(larryRow), {
        employees: [larry],
        accounts: p45.parseRowId(larryRow)!.accounts,
      });
      const larrySlip = await p45.slip!.build(org.orgId, YEAR, larryRow);
      assert.equal(larrySlip.formNumber, "P45 (Parts 1A/2/3)");
      assert.equal(
        larrySlip.boxes.find((candidate) => candidate.code === "leaving-date")!.value,
        "2026-06-20",
      );
      assert.equal(
        cmp(larrySlip.boxes.find((candidate) => candidate.code === "pay-to-date")!.value, larryExpected.pay),
        0,
      );
      assert.match(p45.downloadRefusal!, /Part 1.*Full Payment Submission/);

      // A statement without its coding notice refuses by name.
      await db.execute(sql`
        update employee_tax_certificates set superseded_on = '2026-06-01'::date
         where org_id = ${org.orgId} and employee_party_id = ${amy}
           and certificate_key = 'gb_tax_code_notice'`);
      await assert.rejects(p60.slip!.build(org.orgId, YEAR, amyRow), /coding notice/);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "GB statements refuse an empty year and an untranscribed year by name",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await assert.rejects(gbP60Slips(org.orgId, YEAR), /no committed GB pay runs for 2026\/27/);
      await assert.rejects(gbP45Leavers(org.orgId, YEAR), /no committed GB pay runs for 2026\/27/);
      await assert.rejects(gbP60Slips(org.orgId, 2025), /2025 statutory tables are not loaded for GB/);
      await assert.rejects(gbP45Leavers(org.orgId, 2025), /2025 statutory tables are not loaded for GB/);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
