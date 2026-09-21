/**
 * DE Lohnsteuerbescheinigung (Ausdruck) — DB-owned population tests.
 *
 * DB-OWNED: runs on the gate, not on the producing Mac. Fixture: one EUR org
 * on the DE pack with two salaried employees in different Länder (BY 8%
 * KiSt, NW 9% KiSt), two committed monthly runs (Jan+Feb 2026) plus one
 * calculated-but-draft March run. Proves the population aggregates (not one
 * row), excludes the draft, ties to committed stubs to the cent, round-trips
 * parseRowId, and refuses by name where it must.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../platform/db.ts";
import { add, cmp } from "../../money/money.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { seedPayrollComponents } from "../run-setup.ts";
import {
  lohnsteuerbescheinigungSlips,
  parseLohnsteuerbescheinigungRowId,
} from "./filings.ts";
import { DE_PAYROLL_PACK } from "./pack.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} from "../../testing/fixtures.ts";
import "../../testing/database-bypass.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

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
  land: string,
  annualSalary: string,
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
       created_by, updated_by)
    values (${orgId}, ${id}, ${scheduleId}, 'DE', ${land}, 'salary', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates
      (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from, is_active,
       created_by, updated_by)
    values (${orgId}, ${id}, 'EUR', ${annualSalary}, 'year', '2080', '2026-01-01', true,
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
    values (${orgId}, ${employeeId}, 'DE', ${key}, null, null,
            ${JSON.stringify(answers)}::jsonb, '2026-01-01'::date, ${actorId}, ${actorId})`);
}

async function committedRun(
  orgId: string,
  actorId: string,
  scheduleId: string,
  periodStart: string,
  periodEnd: string,
): Promise<string> {
  const run = await createPayRun({
    orgId, actorId, payScheduleId: scheduleId, periodStart, periodEnd, payDate: periodEnd,
  });
  assert.deepEqual(
    (await calculatePayRun({ orgId, actorId, documentId: run.documentId })).errors,
    [],
  );
  await commitPayRun({ orgId, documentId: run.documentId, actorId });
  return run.documentId;
}

test(
  "two employees across two committed runs tie to the cent; the draft run is excluded",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const wageId = await makeAccount(org.orgId, actorId, "6000", "Wages & Salaries", "expense");
      const netId = await makeAccount(org.orgId, actorId, "2300", "Employee Payable", "liability_current_other");
      const deductionsId = await makeAccount(org.orgId, actorId, "2110", "Payroll Deductions", "liability_current_other");
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(
             jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"payroll": true}'::jsonb),
             '{payroll}',
             ${JSON.stringify({ wageExpenseAccountId: wageId, netPayAccountId: netId, countries: ["DE"] })}::jsonb
           )
         where id = ${org.orgId}`);
      await db.execute(sql`
        update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts}',
          ${JSON.stringify({ payrollDeductions: deductionsId })}::jsonb)
         where id = ${org.orgId}`);
      await db.execute(sql`
        update subsidiaries set base_currency = 'EUR', country = 'DE', name = 'München HQ'
         where org_id = ${org.orgId} and id = ${org.subsidiaryId}`);

      await seedPayrollComponents(org.orgId, actorId, "DE");
      // The fund's own Zusatzbeitragssatz (tenant-declared: no national
      // average is transcribed, and the engine refuses without it).
      await db.execute(sql`
        insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                             rate_values, created_by, updated_by)
        values (${org.orgId}, 'DE', 'de_kvz', null, 2026, '{"rate": "2.50"}',
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into payroll_filing_accounts
          (org_id, country, program_type, account_number, name, remitter_type,
           is_default, is_active, created_by, updated_by)
        values (${org.orgId}, 'DE', 'de_finanzamt', '9143', 'Betriebsstättenfinanzamt München',
                'regular', true, true, ${actorId}, ${actorId})`);

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules
          (id, org_id, name, frequency, periods_per_year, anchor_period_end, pay_date_offset_days,
           subsidiary_id, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'DE monthly', 'monthly', 12, '2026-01-31', 0,
                ${org.subsidiaryId}, true, ${actorId}, ${actorId})`);

      // BY (8% KiSt) Steuerklasse I, no children; NW (9% KiSt)
      // Steuerklasse III with two Kinderfreibeträge — per-Land, per-employee
      // facts the certificate must carry, never a national default.
      const maria = await makeEmployee(
        org.orgId, org.subsidiaryId, actorId, scheduleId, "Maria Muster", "BY", "74400",
      );
      await fileCertificate(org.orgId, maria, actorId, "de_elstam", {
        steuerklasse: "I", kinderfreibetrag_anzahl: "0", konfession: "rk",
      });
      await fileCertificate(org.orgId, maria, actorId, "de_pv_nachweis", {
        kinderlosenzuschlag: "true", abschlag_kinder: "0",
      });
      const jan = await makeEmployee(
        org.orgId, org.subsidiaryId, actorId, scheduleId, "Jan Beispiel", "NW", "60000",
      );
      await fileCertificate(org.orgId, jan, actorId, "de_elstam", {
        steuerklasse: "III", kinderfreibetrag_anzahl: "2", konfession: "ev",
      });
      await fileCertificate(org.orgId, jan, actorId, "de_pv_nachweis", {
        kinderlosenzuschlag: "false", abschlag_kinder: "2",
      });

      await committedRun(org.orgId, actorId, scheduleId, "2026-01-01", "2026-01-31");
      await committedRun(org.orgId, actorId, scheduleId, "2026-02-01", "2026-02-28");
      // March is calculated but left DRAFT — it must not appear anywhere.
      const draft = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-03-01", periodEnd: "2026-03-31", payDate: "2026-03-31",
      });
      assert.deepEqual(
        (await calculatePayRun({ orgId: org.orgId, actorId, documentId: draft.documentId })).errors,
        [],
      );
      const draftStubs = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${org.orgId} and s.pay_run_document_id = ${draft.documentId}
           and r.run_status <> 'committed'`)).rows[0]!.n;
      assert.ok(Number(draftStubs) >= 2, "the draft run holds stubs, so the exclusion is load-bearing");

      const slips = await lohnsteuerbescheinigungSlips(org.orgId, 2026);
      assert.equal(slips.length, 2);
      const byEmployee = new Map(slips.map((slip) => [slip.employeePartyId, slip]));
      const mariaSlip = byEmployee.get(maria)!;
      const janSlip = byEmployee.get(jan)!;
      assert.ok(mariaSlip && janSlip, "one slip per employee");

      // The engine priced both cases: exact monthly grosses, real withholding.
      assert.equal(mariaSlip.gross, "12400.0000");
      assert.equal(janSlip.gross, "10000.0000");
      assert.ok(cmp(mariaSlip.lst, "0") > 0, "BY StKl I Lohnsteuer priced");
      assert.ok(cmp(janSlip.lst, "0") > 0, "NW StKl III Lohnsteuer priced");
      assert.ok(cmp(mariaSlip.kist, "0") > 0, "BY 8% Kirchensteuer priced");
      assert.ok(cmp(janSlip.kist, "0") > 0, "NW 9% Kirchensteuer priced");
      // Certified Merkmale, not derivations.
      assert.equal(mariaSlip.steuerklasse, "I");
      assert.equal(mariaSlip.land, "BY");
      assert.equal(mariaSlip.kinderfreibetraege, "0");
      assert.equal(janSlip.steuerklasse, "III");
      assert.equal(janSlip.land, "NW");
      assert.equal(janSlip.kinderfreibetraege, "2");
      assert.equal(mariaSlip.zeitraumBis, "2026-02-28");
      assert.ok((mariaSlip.finanzamt ?? "").includes("9143"), "Finanzamt footer resolves the account");

      // Tie-out, straight from committed stub lines — to the cent.
      const lines = (await db.execute<{
        employee_party_id: string; kind: string; system_key: string | null;
        taxable: boolean | null; amount: string;
      }>(sql`
        select s.employee_party_id, l.kind, pc.system_key, pc.taxable, l.amount::text as amount
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
          join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
         where s.org_id = ${org.orgId} and s.tax_year = 2026 and s.country = 'DE'
           and r.run_status = 'committed'`)).rows;
      const sumFor = (employee: string, pick: (line: (typeof lines)[number]) => boolean): string =>
        lines.filter((line) => String(line.employee_party_id) === employee && pick(line))
          .reduce((total, line) => add(total, line.amount), "0");
      for (const [employee, slip] of [[maria, mariaSlip], [jan, janSlip]] as const) {
        const gross = sumFor(employee, (line) => line.kind === "earning" && (line.taxable ?? true));
        assert.equal(cmp(gross, slip.gross), 0, `Zeile 3 ties for ${slip.employeeName}`);
        for (const [key, field] of [
          ["lohnsteuer", slip.lst], ["solidaritaetszuschlag", slip.soli],
          ["kirchenlohnsteuer", slip.kist], ["rv", slip.rvW], ["kv", slip.kvW],
          ["pv", slip.pvW], ["av", slip.avW],
        ] as const) {
          const withheld = sumFor(
            employee,
            (line) => line.kind === "deduction" && line.system_key === key,
          );
          assert.equal(cmp(withheld, field), 0, `${key} ties for ${slip.employeeName}`);
        }
        for (const [key, field] of [["rv", slip.rvEr], ["kv", slip.kvEr], ["pv", slip.pvEr]] as const) {
          const share = sumFor(
            employee,
            (line) => line.kind === "employer_contribution" && line.system_key === key,
          );
          assert.equal(cmp(share, field), 0, `${key} AG share ties for ${slip.employeeName}`);
        }
      }

      // The declaration's population aggregates the same slips, and every row
      // id round-trips the grammar while foreign ones refuse.
      const filing = DE_PAYROLL_PACK.filings().yearEnd.find((candidate) => candidate.key === "lohnsteuerbescheinigung")!;
      const population = await filing.population(org.orgId, 2026);
      assert.equal(population.rows.length, 2);
      const totals = new Map((population.totals ?? []).map((total) => [total.label, total.value]));
      assert.equal(cmp(String(totals.get("Brutto (Zeile 3)")), add(mariaSlip.gross, janSlip.gross)), 0);
      assert.equal(cmp(String(totals.get("Lohnsteuer (Zeile 4)")), add(mariaSlip.lst, janSlip.lst)), 0);
      for (const row of population.rows) {
        const rowId = String(row[population.rowKey]);
        const scope = filing.parseRowId(rowId);
        assert.deepEqual(scope, { employees: [rowId], accounts: [] });
        assert.ok(parseLohnsteuerbescheinigungRowId(rowId), "grammar round-trips");
      }
      assert.equal(filing.parseRowId("not-a-row"), null);
      assert.equal(filing.parseRowId(`${maria}:${jan}`), null);

      // The slip renders the BMF Zeilen for a real row and refuses an unknown one.
      const slipData = await filing.slip!.build(org.orgId, 2026, maria);
      const codes = slipData.boxes.map((box) => box.code);
      for (const code of ["3", "4", "5", "6", "23a", "25", "26", "27", "22a", "24a", "24c"]) {
        assert.ok(codes.includes(code), `Zeile ${code} renders`);
      }
      await assert.rejects(
        () => filing.slip!.build(org.orgId, 2026, randomUUID()),
        /no 2026 Lohnsteuerbescheinigung matches/,
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "an empty year and an unpublished year refuse by name — never an empty slip",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const filing = DE_PAYROLL_PACK.filings().yearEnd.find((candidate) => candidate.key === "lohnsteuerbescheinigung")!;
      await assert.rejects(
        () => filing.population(org.orgId, 2026),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes("2026"), error.message);
          assert.ok(/no committed German/.test(error.message), error.message);
          return true;
        },
      );
      await assert.rejects(
        () => filing.population(org.orgId, 2025),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes("2025"), error.message);
          assert.ok(error.message.includes("2026"), error.message);
          return true;
        },
      );
      await assert.rejects(
        () => lohnsteuerbescheinigungSlips(org.orgId, 2025),
        /2025/,
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
