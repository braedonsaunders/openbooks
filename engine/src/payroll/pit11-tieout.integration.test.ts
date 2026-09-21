import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../platform/db.ts";
import { add } from "../money/money.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { PAYROLL_COUNTRY_PACKS, setPackSlotAccount } from "./packs.ts";
import { parsePit11RowId, pit11Population, pit11Slips, pit11Slip } from "./pl/pit11.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} from "../testing/fixtures.ts";
import "../testing/database-bypass.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * PIT-11 tie-out: two employees across two committed monthly runs, plus a
 * third run left uncommitted to prove it never reaches the statutory form.
 *
 * Anna (8 000 zł/mo): poz. 29 = 16 000, poz. 30 = 500, poz. 31 = 15 500,
 * poz. 33 = 996, poz. 95 = 2 193.60, poz. 122 = 1 242.58.
 * Marek (6 000 zł/mo): poz. 29 = 12 000, poz. 30 = 500, poz. 31 = 11 500,
 * poz. 33 = 582, poz. 95 = 1 645.20, poz. 122 = 931.94.
 * Every figure is the pack's own arithmetic for the month (Jan and Feb
 * 2026 both price wholly at 12 % — the 120 000 zł year-to-date test never
 * comes close), summed over the two committed months.
 */

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
  birthYear: number,
  annualRate: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${orgId}, 'person', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${id})`);
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis, is_active,
       pl_rok_urodzenia, created_by, updated_by)
    values (${orgId}, ${id}, ${scheduleId}, 'PL', 'PL', 'salary', true,
            ${birthYear}, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates
      (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from, is_active,
       created_by, updated_by)
    values (${orgId}, ${id}, 'PLN', ${annualRate}, 'year', '2080', '2026-01-01', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_tax_certificates
      (org_id, employee_party_id, country, certificate_key, region, sub_region,
       answers, effective_from, created_by, updated_by)
    values (${orgId}, ${id}, 'PL', 'pl_pit2', null, null,
            ${JSON.stringify({ kup: "miejscowy", pomniejszenie: "1/12" })}::jsonb,
            '2026-01-01'::date, ${actorId}, ${actorId})`);
  return id;
}

test(
  "PIT-11 population aggregates two employees over two committed runs and ties to the ledger",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const wageId = await makeAccount(org.orgId, actorId, "6000", "Wages & Salaries", "expense");
      const netId = await makeAccount(org.orgId, actorId, "2300", "Employee Payable", "liability_current_other");
      const deductionsId = await makeAccount(org.orgId, actorId, "2110", "Payroll Deductions", "liability_current_other");
      await db.execute(sql`
        update subsidiaries set base_currency = 'PLN', country = 'PL'
         where org_id = ${org.orgId} and id = ${org.subsidiaryId}`);
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(
             jsonb_set(
               jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"payroll": true}'::jsonb),
               '{payroll}',
               ${JSON.stringify({ wageExpenseAccountId: wageId, netPayAccountId: netId, countries: ["PL"] })}::jsonb
             ),
             '{controlAccounts}',
             ${JSON.stringify({ payrollDeductions: deductionsId })}::jsonb
           )
         where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "PL");
      // Statutory slots carry no liabilityAccountRole, so seeding alone leaves
      // every PL deduction unmapped and run-commit refuses the run. Map them
      // the way the IT settlement fixture does.
      for (const slot of PAYROLL_COUNTRY_PACKS.PL!.statutorySlots) {
        await setPackSlotAccount(org.orgId, actorId, "PL", slot.key, deductionsId);
      }

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules
          (id, org_id, name, frequency, periods_per_year, anchor_period_end, pay_date_offset_days,
           subsidiary_id, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'PL monthly', 'monthly', 12, '2026-01-31', 0,
                ${org.subsidiaryId}, true, ${actorId}, ${actorId})`);
      const anna = await makeEmployee(
        org.orgId, org.subsidiaryId, actorId, scheduleId, "Anna Kowalska", 1990, "96000",
      );
      const marek = await makeEmployee(
        org.orgId, org.subsidiaryId, actorId, scheduleId, "Marek Nowak", 1985, "72000",
      );

      const committed: string[] = [];
      for (const [start, end, payDate] of [
        ["2026-01-01", "2026-01-31", "2026-01-31"],
        ["2026-02-01", "2026-02-28", "2026-02-28"],
      ] as const) {
        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: start, periodEnd: end, payDate,
        });
        assert.deepEqual((await calculatePayRun({
          orgId: org.orgId, actorId, documentId: run.documentId,
        })).errors, []);
        await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        committed.push(run.documentId);
      }
      // March prices but is never committed: a draft run must not appear on
      // a statutory filing.
      const march = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-03-01", periodEnd: "2026-03-31", payDate: "2026-03-31",
      });
      assert.deepEqual((await calculatePayRun({
        orgId: org.orgId, actorId, documentId: march.documentId,
      })).errors, []);
      const marchStubs = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${org.orgId} and s.pay_run_document_id = ${march.documentId}
           and r.run_status <> 'committed'`));
      assert.equal(marchStubs.rows[0]!.n, "2", "March priced two stubs and stayed uncommitted");

      const slips = await pit11Slips(org.orgId, 2026);
      assert.equal(slips.length, 2, "two employees aggregate — never one row");
      const byId = new Map(slips.map((slip) => [slip.employeePartyId, slip]));
      assert.deepEqual(byId.get(anna), {
        employeePartyId: anna,
        employeeName: "Anna Kowalska",
        przychod: "16000.0000",
        kup: "500.0000",
        dochod: "15500.0000",
        zaliczka: "996.0000",
        skladkiSpoleczne: "2193.6000",
        skladkiZdrowotne: "1242.5800",
        stubCount: 2,
      });
      assert.deepEqual(byId.get(marek), {
        employeePartyId: marek,
        employeeName: "Marek Nowak",
        przychod: "12000.0000",
        kup: "500.0000",
        dochod: "11500.0000",
        zaliczka: "582.0000",
        skladkiSpoleczne: "1645.2000",
        skladkiZdrowotne: "931.9400",
        stubCount: 2,
      });

      // Independent tie-out: re-aggregate the committed ledger per employee
      // with a differently-shaped query and prove every box matches it to
      // the grosz. The March run's stubs would add 8 000 / 6 000 to poz. 29
      // here if the population ever read them.
      const ledger = (await db.execute<{
        employee_party_id: string;
        przychod: string; kup: string; zaliczka: string; spoleczne: string; zdrowotna: string;
      }>(sql`
        select s.employee_party_id,
               (select sum(l.amount)::text from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${org.orgId} and l.stub_id = s.id and l.kind = 'earning') as przychod,
               (s.factors->>'KUP')::text as kup,
               (select sum(l.amount)::text from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${org.orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key = 'pit') as zaliczka,
               (select sum(l.amount)::text from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${org.orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key in ('zus_emeryt', 'zus_rent', 'zus_chor')) as spoleczne,
               (select sum(l.amount)::text from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${org.orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key = 'zus_zdr') as zdrowotna
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${org.orgId} and s.tax_year = 2026 and s.country = 'PL'
           and r.run_status = 'committed'`));
      const sumBy = (id: string, pick: (row: (typeof ledger.rows)[number]) => string | null) =>
        ledger.rows
          .filter((row) => row.employee_party_id === id)
          .reduce((acc, row) => add(acc, pick(row) ?? "0"), "0");
      for (const [id, slip] of byId) {
        assert.equal(slip.przychod, sumBy(id, (row) => row.przychod), "poz. 29 ties to committed earning lines");
        assert.equal(slip.kup, sumBy(id, (row) => row.kup), "poz. 30 ties to committed KUP factors");
        assert.equal(slip.zaliczka, sumBy(id, (row) => row.zaliczka), "poz. 33 ties to committed PIT lines");
        assert.equal(slip.skladkiSpoleczne, sumBy(id, (row) => row.spoleczne), "poz. 95 ties to committed ZUS lines");
        assert.equal(slip.skladkiZdrowotne, sumBy(id, (row) => row.zdrowotna), "poz. 122 ties to committed NFZ lines");
      }

      // The population the surface reads: every emitted row id round-trips
      // through the declared grammar, and the PIT-4R tie total holds.
      const population = await pit11Population(org.orgId, 2026);
      assert.equal(population.rowKey, "rowId");
      assert.equal(population.rows.length, 2);
      for (const row of population.rows) {
        const parsed = parsePit11RowId(String(row.rowId));
        assert.deepEqual(parsed, { employees: [String(row.rowId)], accounts: [] });
      }
      assert.equal(parsePit11RowId("not-a-row"), null);
      assert.equal(parsePit11RowId(`${anna}:${randomUUID()}`), null);
      const tie = population.totals?.find((total) => total.label.startsWith("Zaliczki pobrane"));
      assert.equal(tie?.value, "1578.0000", "PIT-4R advances total = sum of poz. 33");

      // The slip the employee is owed: the Ministry's own box numbers.
      const annaSlip = await pit11Slip(org.orgId, 2026, anna);
      assert.equal(annaSlip.formNumber, "PIT-11");
      assert.deepEqual(
        annaSlip.boxes.map((box) => [box.code, box.value]),
        [
          ["29", "16000.0000"],
          ["30", "500.0000"],
          ["31", "15500.0000"],
          ["33", "996.0000"],
          ["95", "2193.6000"],
          ["122", "1242.5800"],
        ],
      );
      await assert.rejects(
        () => pit11Slip(org.orgId, 2026, randomUUID()),
        /no 2026 PIT-11 matches the requested employee/,
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "PIT-11 refuses a year with no committed runs and a year the pack does not cover",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await assert.rejects(
        () => pit11Population(org.orgId, 2026),
        /no committed PL pay stubs for tax year 2026/,
      );
      await assert.rejects(
        () => pit11Slips(org.orgId, 2025),
        /2025 statutory tables are not loaded for PL/,
      );
      await assert.rejects(
        () => pit11Slips(org.orgId, 2024),
        /2024 statutory tables are not loaded for PL/,
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
