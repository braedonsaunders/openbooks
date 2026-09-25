import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, seedFlowActors, seedWorkerEmployment } from "../testing/fixtures.ts";
import { upsertPayrollEmployerFact } from "./employer-fact-store.ts";
import { setPackSlotAccount } from "./packs.ts";

export interface AdoptionFixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
  employeeId: string;
  employeeName: string;
  employmentId: string;
}

/** Seed an explicit ON EHT rate for shared, low-payroll Canadian fixtures. */
export async function seedOntarioEhtFixture(orgId: string, actorId: string, annualExemption = "1000000"): Promise<void> {
  await db.execute(sql`
    insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                         rate_values, created_by, updated_by)
    values (${orgId}, 'CA', 'ca_eht', 'ON', 2026,
            ${JSON.stringify({ rate: "1.95", annualExemption })}::jsonb,
            ${actorId}, ${actorId})
  `);
}

/** Standalone GB legal employer holding the whole £15,000 Apprenticeship Levy allowance. */
export async function seedGbLevyAllowanceFixture(
  orgId: string, actorId: string, subsidiaryId: string,
): Promise<void> {
  await upsertPayrollEmployerFact({ orgId, actorId, subsidiaryId, country: "GB",
    factKey: "gb_apprenticeship_levy_allowance", effectiveFrom: "2026-04-06",
    value: "15000.00", changeReason: "test employer holds the whole allowance" });
}

/** Ten-strong ordinary-sector FR employer under the mainland TA regime, plus an explicit zero AT/MP rate. */
export async function seedFrRecapEmployerFixture(
  orgId: string, actorId: string, subsidiaryId: string,
): Promise<void> {
  const fact = (factKey: string, value: string) => upsertPayrollEmployerFact({ orgId, actorId,
    subsidiaryId, country: "FR", factKey, effectiveFrom: "2026-01-01", value,
    changeReason: "recap fixture classifies the test employer" });
  await fact("effectif_moyen_annuel", "10.00");
  await fact("fr_ags_employer_type", "ordinary");
  await fact("fr_apprentissage_regime", "droit_commun");
  await db.execute(sql`
    insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                         rate_values, created_by, updated_by)
    values (${orgId}, 'FR', 'fr_atmp', 'FR', 2026, '{"taux": "0.0000"}',
            ${actorId}, ${actorId})`);
}

/** 35-hour week per employee: RGDU adjusts the SMIC to contractual hours. */
export async function seedFullTimeWorkScheduleFixture(
  orgId: string, actorId: string, employeeId: string,
): Promise<void> {
  const workScheduleId = randomUUID();
  await db.execute(sql`
    insert into work_schedules (id, org_id, name, employee_party_id, pattern, cycle_days,
                                cycle_anchor, effective_from, is_active, created_by, updated_by)
    values (${workScheduleId}, ${orgId}, 'Temps plein', ${employeeId}, 'cycle', 7, '2026-01-05',
            '2026-01-01', true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into work_schedule_days (org_id, schedule_id, day_index, hours, created_by, updated_by)
    values (${orgId}, ${workScheduleId}, 1, '7', ${actorId}, ${actorId}),
           (${orgId}, ${workScheduleId}, 2, '7', ${actorId}, ${actorId}),
           (${orgId}, ${workScheduleId}, 3, '7', ${actorId}, ${actorId}),
           (${orgId}, ${workScheduleId}, 4, '7', ${actorId}, ${actorId}),
           (${orgId}, ${workScheduleId}, 5, '7', ${actorId}, ${actorId})`);
}

/**
 * Canonical test hire: parties row, minimal role, HRM employment, labor
 * rate, payroll profile, and optional approved time entries. Replaces the
 * per-file hire closures that each hand-rolled the same five inserts and
 * drifted apart (most quietly dropped the employment link 0374 requires).
 * Every field is explicit — no country or rate defaults to inherit.
 */
export interface HiredEmployeeSeed {
  scheduleId: string;
  subsidiaryId: string;
  name: string;
  country: string;
  province: string;
  payBasis: string;
  currency: string;
  rate: string;
  rateBasis: string;
  rateEffectiveFrom?: string;
  annualHours?: string | null;
  federalClaimCode?: number | null;
  provincialClaimCode?: number | null;
  vacationPercent?: string | null;
  vacationMethod?: string | null;
  filingStatus?: string | null;
  partySubsidiaryId?: string | null;
  employeeNumber?: string | null;
  hiredOn?: string | null;
  timeEntries?: { workedOn: string; hours?: string; projectId?: string }[];
}

export async function seedHiredEmployee(
  orgId: string, actorId: string, seed: HiredEmployeeSeed,
): Promise<{ employeeId: string; employmentId: string }> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${employeeId}, ${orgId}, 'person', ${seed.name}, ${seed.partySubsidiaryId ?? null},
            true, '{}'::jsonb)`);
  // hired_on is omitted when the hire states none: like annual_hours above,
  // the column rejects a guessed value, so there is one insert per shape.
  if (seed.hiredOn != null) {
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, employee_number, hired_on, is_active)
      values (${randomUUID()}, ${orgId}, ${employeeId}, ${seed.employeeNumber ?? null},
              ${seed.hiredOn}, true)`);
  } else {
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, employee_number)
      values (${randomUUID()}, ${orgId}, ${employeeId}, ${seed.employeeNumber ?? null})`);
  }
  const employmentId = await seedWorkerEmployment(orgId, employeeId, seed.subsidiaryId);
  // annual_hours is omitted when the hire states none: the column rejects an
  // explicit null, so there is one insert per shape, never a guessed default.
  if (seed.annualHours != null) {
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                    effective_from, is_active, created_by, updated_by)
      values (${orgId}, ${employeeId}, ${seed.currency}, ${seed.rate}, ${seed.rateBasis},
              ${seed.annualHours}, ${seed.rateEffectiveFrom ?? "2026-01-01"}, true,
              ${actorId}, ${actorId})`);
  } else {
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                    effective_from, is_active, created_by, updated_by)
      values (${orgId}, ${employeeId}, ${seed.currency}, ${seed.rate}, ${seed.rateBasis},
              ${seed.rateEffectiveFrom ?? "2026-01-01"}, true, ${actorId}, ${actorId})`);
  }
  // Optional profile columns are appended only when the hire states them:
  // several reject an explicit null, so omission (not null) is the absent
  // shape — the same reason annual_hours above has two inserts.
  const profileCols = [
    "org_id", "employee_party_id", "employment_id", "pay_schedule_id", "country",
    "province", "pay_basis", "is_active", "created_by", "updated_by",
  ];
  const profileVals: unknown[] = [
    orgId, employeeId, employmentId, seed.scheduleId, seed.country,
    seed.province, seed.payBasis, true, actorId, actorId,
  ];
  const profileExtra: [string, unknown][] = [
    ["federal_claim_code", seed.federalClaimCode ?? undefined],
    ["provincial_claim_code", seed.provincialClaimCode ?? undefined],
    ["vacation_percent", seed.vacationPercent ?? undefined],
    ["vacation_method", seed.vacationMethod ?? undefined],
    ["filing_status", seed.filingStatus ?? undefined],
  ];
  for (const [col, val] of profileExtra) {
    if (val !== undefined) {
      profileCols.push(col);
      profileVals.push(val);
    }
  }
  await db.execute(sql`
    insert into employee_payroll_profiles (${sql.join(profileCols.map((c) => sql.raw(c)), sql`, `)})
    values (${sql.join(profileVals.map((v) => sql`${v}`), sql`, `)})`);
  for (const entry of seed.timeEntries ?? []) {
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id,
                                status, is_billable, billing_status, costing_basis,
                                created_by, updated_by)
      values (${orgId}, ${employeeId}, ${entry.workedOn}, ${entry.hours ?? "20"},
              ${entry.projectId ?? null}, 'approved', false, 'unbilled', 'actual',
              ${actorId}, ${actorId})`);
  }
  return { employeeId, employmentId };
}

/** Québec CNT-subject employer: classify for CNT and point the slot at the given payable. */
export async function seedCntSubjectEmployerFixture(
  orgId: string, actorId: string, subsidiaryId: string, payableAccountId: string,
): Promise<void> {
  await upsertPayrollEmployerFact({ orgId, actorId, subsidiaryId, country: "CA",
    factKey: "cnt_exemption", effectiveFrom: "2026-01-01", value: "none",
    changeReason: "test employer subject to CNT" });
  await setPackSlotAccount(orgId, actorId, "CA", "cnt", payableAccountId);
}

export async function seedCanadianPayrollComponentsForTest(
  orgId: string, actorId: string,
): Promise<void> {
  await seedPayrollComponents(orgId, actorId, "CA");
  await seedOntarioEhtFixture(orgId, actorId);
}

async function seedEmployee(
  fx: { orgId: string; actorId: string; scheduleId: string; subsidiaryId: string },
  options: { name: string; hiredOn?: string } = { name: "Terry Worker" },
): Promise<{ employeeId: string; employmentId: string }> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${fx.orgId}, 'person', ${options.name}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${options.hiredOn ?? "2020-01-06"}, true,
            ${fx.actorId}, ${fx.actorId})`);
  // Stub calculation refuses employees without an HRM employment, so the hire
  // carries one and the profile points at it.
  const employmentId = await seedWorkerEmployment(fx.orgId, employeeId, fx.subsidiaryId);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2020-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                           province, pay_basis, country, federal_claim_code,
                                           provincial_claim_code, vacation_percent, vacation_method,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${employmentId}, ${fx.scheduleId}, 'ON', 'hourly', 'CA', 1, 1,
            '4', 'accrue', true, ${fx.actorId}, ${fx.actorId})`);
  return { employeeId, employmentId };
}

/** A Canadian org with payroll accounts, components, a schedule and one hire. */
export async function seedAdoption(
  options: { hiredOn?: string } = {},
): Promise<AdoptionFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
    values(${org.orgId},${actorId},'payroll.manage','grant')`);

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
  const netPayable = await account(
    "2300",
    "Wages payable",
    "liability_current_other",
  );
  const craPayable = await account(
    "2310",
    "CRA remittances payable",
    "liability_current_other",
  );
  const vacationPayable = await account(
    "2320",
    "Vacation payable",
    "liability_current_other",
  );
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        cppPayableAccountId: craPayable,
        eiPayableAccountId: craPayable,
        taxPayableAccountId: craPayable,
        vacationPayableAccountId: vacationPayable,
        wagesTo: "expense",
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");
  // Shared Ontario fixtures configure EHT so unrelated tests reach their own behavior.
  await seedOntarioEhtFixture(org.orgId, actorId);

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);

  const employeeName = "Terry Worker";
  const { employeeId, employmentId } = await seedEmployee(
    { orgId: org.orgId, actorId, scheduleId, subsidiaryId: org.subsidiaryId },
    { name: employeeName, hiredOn: options.hiredOn },
  );

  return {
    orgId: org.orgId,
    actorId,
    subsidiaryId: org.subsidiaryId,
    scheduleId,
    employeeId,
    employeeName,
    employmentId,
  };
}

export async function calculatedRun(fx: AdoptionFixture) {
  const entry = (
    await db.execute<{ id: string }>(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
      is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${fx.employeeId}, '2026-07-14', 8, 'approved', false,
      'unbilled', 'actual', ${fx.actorId}, ${fx.actorId}) returning id
  `)
  ).rows[0]!;
  const run = await createPayRun({
    orgId: fx.orgId,
    actorId: fx.actorId,
    payScheduleId: fx.scheduleId,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
  });
  const input = {
    orgId: fx.orgId,
    actorId: fx.actorId,
    documentId: run.documentId,
  };
  assert.deepEqual((await calculatePayRun(input)).errors, []);
  return { input, entryId: entry.id };
}

/** Model rows that predate 0093. DDL and row changes are one transaction;
 * the guard is restored before commit. Production reconciliation never disables it. */
export async function markLegacy(orgId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`alter table pay_stubs disable trigger pay_stub_filing_account_guard`,
    );
    const rows = await tx.execute<{
      id: string;
    }>(sql`update pay_stubs set filing_account_id=null,
      filing_account_source='unknown',filing_account_evidence=null where org_id=${orgId} returning id`);
    await tx.execute(
      sql`alter table pay_stubs enable trigger pay_stub_filing_account_guard`,
    );
    return rows.rows[0]!.id;
  });
}
