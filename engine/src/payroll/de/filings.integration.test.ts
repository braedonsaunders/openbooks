/**
 * DE Lohnsteuerbescheinigung (Ausdruck) — DB-owned population tests.
 *
 * DB-OWNED: runs on the gate, not on the producing Mac. Fixture: one EUR org
 * on the DE pack with two salaried employees in different Länder (BY 8%
 * KiSt, NW 9% KiSt). The pack refuses every run until U1/U2/U3 and the
 * Berufsgenossenschaft resolve, so no stubs commit: proves both employees
 * refuse by name on a calculated run and on the draft, and nothing lands in
 * pay_stubs for the year. Pure PAP/SV math stays pinned in
 * compute-statutory.test.ts; empty-year filing refusals in the test below.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PAYROLL_COUNTRY_PACKS, setPackSlotAccount } from "../packs.ts";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../platform/db.ts";
import { sealSecret } from "../../platform/secrets.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { seedPayrollComponents } from "../run-setup.ts";
import {
  lohnsteuerbescheinigungSlips,
} from "./filings.ts";
import { DE_PAYROLL_PACK } from "./pack.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedWorkerEmployment,
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
  idNr: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${orgId}, 'person', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${id})`);
  const employmentId = await seedWorkerEmployment(orgId, id, subsidiaryId);
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, employment_id, pay_schedule_id, country, province, pay_basis, is_active,
       sin_encrypted, sin_last3, created_by, updated_by)
    values (${orgId}, ${id}, ${employmentId}, ${scheduleId}, 'DE', ${land}, 'salary', true,
            ${sealSecret(idNr)}, ${idNr.slice(-3)}, ${actorId}, ${actorId})`);
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

test(
  "German runs refuse at calculate until employer levies resolve; nothing commits and the draft stays out",
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
      // Statutory slots declare no liabilityAccountRole, so seeding alone leaves
      // every deduction unmapped and run-commit refuses the run. Map them all to
      // the payroll-deductions control account, as the IT settlement fixture does.
      for (const slot of PAYROLL_COUNTRY_PACKS.DE!.statutorySlots) {
        await setPackSlotAccount(org.orgId, actorId, "DE", slot.key, deductionsId);
      }
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

      const maria = await makeEmployee(
        org.orgId, org.subsidiaryId, actorId, scheduleId, "Maria Muster", "BY", "74400", "12345678901",
      );
      await fileCertificate(org.orgId, maria, actorId, "de_elstam", {
        steuerklasse: "I", kinderfreibetrag_anzahl: "0", konfession: "rk",
      });
      await fileCertificate(org.orgId, maria, actorId, "de_pv_nachweis", {
        kinderlosenzuschlag: "true", abschlag_kinder: "0",
      });
      const jan = await makeEmployee(
        org.orgId, org.subsidiaryId, actorId, scheduleId, "Jan Beispiel", "NW", "60000", "23456789012",
      );
      await fileCertificate(org.orgId, jan, actorId, "de_elstam", {
        steuerklasse: "III", kinderfreibetrag_anzahl: "2", konfession: "ev",
      });
      await fileCertificate(org.orgId, jan, actorId, "de_pv_nachweis", {
        kinderlosenzuschlag: "false", abschlag_kinder: "2",
      });

      // January calculates: both employees refuse by name. U1/U2/U3 and the
      // Berufsgenossenschaft price nothing until employer-specific rates and
      // bases resolve, so the run must never commit as complete — even this
      // fully configured org (slots mapped, Zusatzbeitragssatz filed,
      // Finanzamt registered) cannot escape the refusal.
      const janRun = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-01-01", periodEnd: "2026-01-31", payDate: "2026-01-31",
      });
      const janErrors = (await calculatePayRun({ orgId: org.orgId, actorId, documentId: janRun.documentId })).errors;
      assert.equal(janErrors.length, 2);
      for (const error of janErrors) {
        assert.equal(error.kind, "refusal");
        assert.match(error.message, /employer levies are not priced: U1.*U2.*U3.*Berufsgenossenschaft/);
      }
      // March is calculated but left DRAFT — with nothing committable, no
      // stubs exist anywhere for the year, so the draft stays out too.
      const draft = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-03-01", periodEnd: "2026-03-31", payDate: "2026-03-31",
      });
      const draftErrors = (await calculatePayRun({ orgId: org.orgId, actorId, documentId: draft.documentId })).errors;
      assert.equal(draftErrors.length, 2);
      const stubs = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from pay_stubs s
         where s.org_id = ${org.orgId} and s.tax_year = 2026 and s.country = 'DE'`)).rows[0]!.n;
      assert.equal(stubs, "0");
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
    const _actorId = (await seedFlowActors(org.orgId)).adminId;
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
