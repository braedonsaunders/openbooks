import { seedEmployment } from "../testing/hrm-harness.ts";
import { seedCanadianPostingAccounts } from "../testing/payroll-posting-fixture.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import {
  assertFixtureDatabase,
  createScratchOrg,
  seedFlowActors,
  seedWorkerEmployment,
  seedVacationTerms,
} from "../testing/fixtures.ts";
import { type VacationMethod } from "./vacation-terms.ts";
import { upsertPayrollEmployerFact } from "./employer-fact-store.ts";
import { setPackSlotAccount } from "./packs.ts";
import { validateUsFilingAccountLineage } from "./us/filing-account-lineage.ts";

export { seedVacationTerms } from "../testing/fixtures.ts";

export interface AdoptionFixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
  employeeId: string;
  employeeName: string;
  employmentId: string;
}

/** Seed explicit ON EHT pricing and its declared single-employer exemption allocation for fixtures. */
export async function seedOntarioEhtFixture(
  orgId: string,
  actorId: string,
  annualExemption = "1000000",
  declareExemptionAllocation = true,
  initialExemptionAllocation = annualExemption,
): Promise<void> {
  await db.execute(sql`
    insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                         rate_values, created_by, updated_by)
    values (${orgId}, 'CA', 'ca_eht', 'ON', 2026,
            ${JSON.stringify({ rate: "1.95", annualExemption })}::jsonb,
            ${actorId}, ${actorId})
  `);
  if (declareExemptionAllocation) {
    const employer = (
      await db.execute<{ id: string }>(
        sql`
      select id from subsidiaries where org_id=${orgId} and country='CA' and parent_id is null order by id limit 1
    `,
        "objects",
      )
    )[0];
    if (!employer)
      throw new Error("The Ontario EHT fixture requires a native Canadian legal employer");
    await upsertPayrollEmployerFact({
      orgId,
      actorId,
      subsidiaryId: employer.id,
      country: "CA",
      factKey: "eht_exemption_share_on",
      effectiveFrom: "2026-01-01",
      value: initialExemptionAllocation,
      changeReason: "Declare the test legal employer share of the Ontario annual exemption",
    });
  }
}

/**
 * ROE issuance prerequisites for ROE record tests: the employee's complete
 * Block 9 default mailing address, a confirmed separation event, and a
 * 'none' Block 17 classification for every component so calculated earning
 * lines resolve. The event's last insurable date (2026-08-01) sits after the
 * 2026 summer stubs the ROE window tests commit, so no late-earnings refusal
 * fires; tests with later stubs declare their own event instead.
 */
export async function seedRoeIssuanceFixture(orgId: string, employeeId: string): Promise<void> {
  await db.execute(sql`
    insert into addresses (org_id, party_id, line1, city, region, postal_code, country)
    values (${orgId}, ${employeeId}, '10 Main Street', 'Toronto', 'ON', 'M5V 2T6', 'CA')`);
  const event = await db.execute(
    sql`
    insert into payroll_roe_separation_events
      (org_id, employee_party_id,employment_id,subsidiary_id,first_day_worked,source_reference,
       interruption_on, last_insurable_earnings_on, status, change_reason)
    select ${orgId}::uuid, ${employeeId}::uuid,prof.employment_id,p.subsidiary_id,'2000-01-01',
      'Original fixture employment-spell declaration','2026-08-10','2026-08-01','confirmed','ROE fixture separation'
    from employee_payroll_profiles prof join parties p on p.org_id=prof.org_id and p.id=prof.employee_party_id
    where prof.org_id=${orgId} and prof.employee_party_id=${employeeId} returning id`,
    "objects",
  );
  assert.equal(
    event.length,
    1,
    "the ROE fixture resolves one native employee employment and employer",
  );
  await db.execute(sql`
    insert into payroll_roe_component_classifications
      (org_id, pay_component_id, effective_from, block, change_reason)
    select ${orgId}, id, '2020-01-01', 'none', 'ROE fixture' from pay_components where org_id = ${orgId}`);
}

/** Create the explicitly declared native federal payer for a US fixture. */
export async function seedUsEinAccount(
  orgId: string,
  actorId: string,
  subsidiaryId: string,
  accountNumber: string,
): Promise<string> {
  const id = randomUUID();
  const employer = await db.execute(
    sql`select id from subsidiaries where org_id=${orgId}
    and id=${subsidiaryId} and country='US' and not is_elimination`,
    "objects",
  );
  assert.equal(employer.length, 1, "the declared EIN requires a native US legal employer");
  const inserted = await db.execute(
    sql`insert into payroll_filing_accounts
    (id,org_id,country,program_type,account_number,name,subsidiary_id,is_active,created_by,updated_by)
    values(${id},${orgId},'US','us_ein',${accountNumber},'Federal EIN',${subsidiaryId},true,${actorId},${actorId}) returning id`,
    "objects",
  );
  assert.equal(inserted.length, 1, "the declared federal EIN must be created");
  return id;
}

export interface UsSuiFixtureSource {
  federalAccountId: string;
  subsidiaryId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceReference: string;
  /** Select a declared account when the fixture contains multiple state registrations. */
  filingAccountId?: string;
  /** Null records payer lineage only, retaining an intentional missing financing method. */
  financingMethod?: string | null;
}

/** Retain the original state registration's payer before any native payroll uses it. */
export async function seedUsSuiAccount(
  orgId: string,
  actorId: string,
  state: string,
  source: UsSuiFixtureSource,
): Promise<string> {
  const candidates = await db.execute<{ id: string }>(
    sql`
    select id from payroll_filing_accounts
     where org_id=${orgId} and country='US' and program_type='us_state_sui'
       and state_code=${state} and is_active
       and (subsidiary_id is null or subsidiary_id=${source.subsidiaryId})
       ${source.filingAccountId ? sql`and id=${source.filingAccountId}` : sql``}
     order by id`,
    "objects",
  );
  assert.ok(
    candidates.length <= 1,
    "declare the exact state registration when candidate accounts are ambiguous",
  );
  if (source.filingAccountId)
    assert.equal(candidates.length, 1, "the declared state registration must exist");
  const filingAccountId = candidates[0]?.id ?? randomUUID();
  if (!candidates.length) {
    const inserted = await db.execute(
      sql`
      insert into payroll_filing_accounts (id,org_id,country,program_type,account_number,name,
        subsidiary_id,state_code,is_active,created_by,updated_by)
      values (${filingAccountId},${orgId},'US','us_state_sui',${`${state}-TEST`},${`${state} SUI`},
        ${source.subsidiaryId},${state},true,${actorId},${actorId}) returning id`,
      "objects",
    );
    assert.equal(inserted.length, 1, "the declared state registration must be created");
  }
  await db.transaction(async (tx) => {
    const input = {
      filingAccountId,
      federalAccountId: source.federalAccountId,
      subsidiaryId: source.subsidiaryId,
      effectiveFrom: source.effectiveFrom,
      effectiveTo: source.effectiveTo,
      sourceReference: source.sourceReference,
      changeReason: "Retain the original state registration employer",
    };
    await validateUsFilingAccountLineage(tx, orgId, input);
    const retained = await tx.execute<{
      federalAccountId: string;
      subsidiaryId: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      sourceReference: string;
    }>(
      sql`
      select federal_account_id as "federalAccountId",subsidiary_id as "subsidiaryId",
        effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",source_reference as "sourceReference"
      from payroll_us_filing_account_employer_lineage where org_id=${orgId} and filing_account_id=${filingAccountId}`,
      "objects",
    );
    if (retained.length) {
      assert.deepEqual(
        retained,
        [
          {
            federalAccountId: source.federalAccountId,
            subsidiaryId: source.subsidiaryId,
            effectiveFrom: source.effectiveFrom,
            effectiveTo: source.effectiveTo,
            sourceReference: source.sourceReference,
          },
        ],
        "the declared state registration must retain exactly its original payer evidence",
      );
    } else {
      const inserted = await tx.execute(
        sql`insert into payroll_us_filing_account_employer_lineage
        (org_id,filing_account_id,federal_account_id,subsidiary_id,effective_from,effective_to,
          source_reference,change_reason,created_by,updated_by)
        values(${orgId},${filingAccountId},${source.federalAccountId},${source.subsidiaryId},
          ${source.effectiveFrom},${source.effectiveTo},${source.sourceReference},${input.changeReason},${actorId},${actorId}) returning id`,
        "objects",
      );
      assert.equal(inserted.length, 1, "the original state registration payer must be retained");
    }
  });
  if (source.financingMethod !== null) {
    await upsertPayrollEmployerFact({
      orgId,
      actorId,
      filingAccountId,
      country: "US",
      factKey: "sui_financing_method",
      effectiveFrom: source.effectiveFrom,
      value: source.financingMethod ?? "contributory",
      changeReason: "state account determination",
    });
  }
  return filingAccountId;
}

/** Standalone GB legal employer holding the whole £15,000 Apprenticeship Levy allowance. */
export async function seedGbLevyAllowanceFixture(
  orgId: string,
  actorId: string,
  subsidiaryId: string,
): Promise<void> {
  await upsertPayrollEmployerFact({
    orgId,
    actorId,
    subsidiaryId,
    country: "GB",
    factKey: "gb_apprenticeship_levy_allowance",
    effectiveFrom: "2026-04-06",
    value: "15000.00",
    changeReason: "test employer holds the whole allowance",
  });
}

/** Ten-strong ordinary-sector FR employer under the mainland TA regime, plus an explicit zero AT/MP rate. */
export async function seedFrRecapEmployerFixture(
  orgId: string,
  actorId: string,
  subsidiaryId: string,
): Promise<void> {
  const fact = (factKey: string, value: string) =>
    upsertPayrollEmployerFact({
      orgId,
      actorId,
      subsidiaryId,
      country: "FR",
      factKey,
      effectiveFrom: "2026-01-01",
      value,
      changeReason: "recap fixture classifies the test employer",
    });
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
  orgId: string,
  actorId: string,
  employeeId: string,
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
  vacationMethod?: VacationMethod | null;
  filingStatus?: string | null;
  /** Workers-compensation exclusion, opt-in like every other extra: absent means undecided. */
  wcbExempt?: boolean | null;
  wcbExemptReason?: string | null;
  partySubsidiaryId?: string | null;
  employeeNumber?: string | null;
  hiredOn?: string | null;
  timeEntries?: { workedOn: string; hours?: string; projectId?: string }[];
}

export async function seedHiredEmployee(
  orgId: string,
  actorId: string,
  seed: HiredEmployeeSeed,
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
    "org_id",
    "employee_party_id",
    "employment_id",
    "pay_schedule_id",
    "country",
    "province",
    "pay_basis",
    "is_active",
    "created_by",
    "updated_by",
  ];
  const profileVals: unknown[] = [
    orgId,
    employeeId,
    employmentId,
    seed.scheduleId,
    seed.country,
    seed.province,
    seed.payBasis,
    true,
    actorId,
    actorId,
  ];
  const profileExtra: [string, unknown][] = [
    ["federal_claim_code", seed.federalClaimCode ?? undefined],
    ["provincial_claim_code", seed.provincialClaimCode ?? undefined],
    ["filing_status", seed.filingStatus ?? undefined],
    ["wcb_exempt", seed.wcbExempt ?? undefined],
    ["wcb_exempt_reason", seed.wcbExemptReason ?? undefined],
  ];
  for (const [col, val] of profileExtra) {
    if (val !== undefined) {
      profileCols.push(col);
      profileVals.push(val);
    }
  }
  await db.execute(sql`
    insert into employee_payroll_profiles (${sql.join(
      profileCols.map((c) => sql.raw(c)),
      sql`, `,
    )})
    values (${sql.join(
      profileVals.map((v) => sql`${v}`),
      sql`, `,
    )})`);
  // A hire participates in the declared vacation offering. A scenario without
  // one creates no phantom election; an explicitly requested election still
  // refuses through the native fixture writer when its program is missing.
  const vacationProgram = (
    await db.execute(
      sql`select id from entitlement_plans where org_id=${orgId} and system_key='vacation'`,
      "objects",
    )
  )[0];
  if (vacationProgram || seed.vacationPercent !== undefined || seed.vacationMethod !== undefined)
    await seedVacationTerms(
      orgId,
      employmentId,
      actorId,
      seed.vacationPercent ?? "4",
      seed.vacationMethod ?? "accrue",
    );
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
  orgId: string,
  actorId: string,
  subsidiaryId: string,
  payableAccountId: string,
): Promise<void> {
  await upsertPayrollEmployerFact({
    orgId,
    actorId,
    subsidiaryId,
    country: "CA",
    factKey: "cnt_exemption",
    effectiveFrom: "2026-01-01",
    value: "none",
    changeReason: "test employer subject to CNT",
  });
  await setPackSlotAccount(orgId, actorId, "CA", "cnt", payableAccountId);
}

export async function seedCanadianPayrollComponentsForTest(
  orgId: string,
  actorId: string,
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
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${employeeId}, ${fx.orgId}, 'person', ${options.name}, ${fx.subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${options.hiredOn ?? "2020-01-06"}, true,
            ${fx.actorId}, ${fx.actorId})`);
  // Stub calculation refuses employees without an HRM employment, so the hire
  // carries one and the profile points at it.
  const { employmentId } = await seedEmployment(fx.orgId, fx.subsidiaryId, {
    workerPartyId: employeeId,
    from: options.hiredOn ?? "2020-01-06",
  });
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2020-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  // The shared hire stands outside workers-compensation scope: the adoption,
  // scope and filing tests built on it assert their own behavior with clean
  // calculations, so the fixture records the exemption explicitly (with the
  // reason the run requires) instead of leaving coverage undecided. Tests of
  // the coverage refusal itself seed their own employees.
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                           province, pay_basis, country, federal_claim_code,
                                           provincial_claim_code, wcb_exempt, wcb_exempt_reason,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${employmentId}, ${fx.scheduleId}, 'ON', 'hourly', 'CA', 1, 1,
            true, 'shared adoption fixture: workers-compensation coverage out of scope',
            true, ${fx.actorId}, ${fx.actorId})`);
  await seedVacationTerms(fx.orgId, employmentId, fx.actorId);
  return { employeeId, employmentId };
}

/** A Canadian org with payroll accounts, components, a schedule and one hire. */
export async function seedAdoption(
  options: { hiredOn?: string; initialOntarioEhtExemption?: string } = {},
): Promise<AdoptionFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
    values(${org.orgId},${actorId},'payroll.manage','grant'),
      (${org.orgId},${actorId},'payroll.run','grant'),
      (${org.orgId},${actorId},'payroll.read','grant')`);

  await seedCanadianPostingAccounts(org.orgId, {
    liabilityType: "liability_current_other",
    enablePayroll: false,
  });
  await seedPayrollComponents(org.orgId, actorId, "CA");
  // Shared Ontario fixtures configure EHT so unrelated tests reach their own behavior.
  await seedOntarioEhtFixture(
    org.orgId,
    actorId,
    "1000000",
    true,
    options.initialOntarioEhtExemption,
  );

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
    await db.execute<{ id: string }>(
      sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
      is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${fx.employeeId}, '2026-07-14', 8, 'approved', false,
      'unbilled', 'actual', ${fx.actorId}, ${fx.actorId}) returning id
  `,
      "objects",
    )
  )[0]!;
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
    await tx.execute(sql`alter table pay_stubs disable trigger pay_stub_filing_account_guard`);
    const rows = await tx.execute<{
      id: string;
    }>(
      sql`update pay_stubs set filing_account_id=null,
      filing_account_source='unknown',filing_account_evidence=null where org_id=${orgId} returning id`,
      "objects",
    );
    await tx.execute(sql`alter table pay_stubs enable trigger pay_stub_filing_account_guard`);
    return rows[0]!.id;
  });
}

/** Retain an explicitly declared Canadian opening packet through native qualification commands. */
export async function qualifyCanadianOpeningForTest(input: {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  employeePartyId: string;
  taxYear: number;
  filingAccountId: string;
  province: string;
  coverageStart: string;
  coverageEnd: string;
  amounts: Record<string, string>;
  reportableBases: { cpp: string; ei: string; qpip: string };
  levyAllocations: readonly import("./opening-levy-source-authority.ts").OpeningLevySourceAllocationInput[];
}): Promise<void> {
  const { readOpeningEmployerContext, qualifyOpeningEmployerAuthority } =
    await import("./opening-employer-authority.ts");
  const { readOpeningLevySourceContext, qualifyOpeningLevySourceAuthority } =
    await import("./opening-levy-source-authority.ts");
  const { readCanadianOpeningReportingSourceContext, qualifyCanadianOpeningReportingSource } =
    await import("./canada/opening-reporting-authority.ts");
  const retainFile = async (evidence: unknown) => {
    const sourceFileId = randomUUID(),
      sourceVersionId = randomUUID(),
      folderId = randomUUID();
    const bytes = Buffer.from(JSON.stringify(evidence));
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      (
        await db.execute(
          sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
      values(${folderId},${input.orgId},'Original payroll evidence',true,${input.actorId},${input.actorId},${input.actorId}) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
      values(${sourceFileId},${input.orgId},${folderId},'original-payroll.json','application/json',${bytes.length},${input.actorId},${input.actorId}) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
      values(${sourceVersionId},${sourceFileId},1,${bytes.length},'application/json',${sourceSha256},${input.actorId}) returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`insert into file_blobs(version_id,bytes) values(${sourceVersionId},${bytes}) returning version_id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`update files set current_version_id=${sourceVersionId}
      where org_id=${input.orgId} and id=${sourceFileId} returning id`,
          "objects",
        )
      ).length,
      1,
    );
    return { sourceFileId, sourceVersionId, sourceSha256 };
  };
  const facts = {
    originalCountry: "CA",
    originalCurrency: "CAD",
    coverageStart: input.coverageStart,
    coverageEnd: input.coverageEnd,
    coverageComplete: true,
  } as const;
  const contextInput = {
    orgId: input.orgId,
    actorId: input.actorId,
    employeePartyId: input.employeePartyId,
    taxYear: input.taxYear,
    allowedSubsidiaryIds: null,
  };
  const file = await retainFile({ ...input, ...facts });
  const employer = await readOpeningEmployerContext({
    ...contextInput,
    sourceFileId: file.sourceFileId,
  });
  const source = await readOpeningLevySourceContext(contextInput);
  assert.ok(employer.record);
  assert.ok(source.record);
  const packet = {
    ...contextInput,
    openingBalanceId: employer.record.id,
    expectedOpeningSha256: employer.record.openingSha256,
    expectedOpeningChildrenSha256: source.record.openingChildrenSha256,
    ...file,
    ...facts,
    allocations: input.levyAllocations,
    sourceReference: "Complete original payroll year-to-date report",
    reason: "Retain the declared original employer, statutory coverage and reporting amounts",
  };
  await qualifyOpeningEmployerAuthority({ ...packet, subsidiaryId: input.subsidiaryId });
  const levy = await qualifyOpeningLevySourceAuthority(packet);
  const reporting = await readCanadianOpeningReportingSourceContext(contextInput);
  assert.ok(reporting.original.children);
  const allocations = [
    {
      sourceOrdinal: 1,
      firstCoveredPayDate: input.coverageStart,
      filingAccountId: input.filingAccountId,
      province: input.province,
      annualAmounts: reporting.original.annualAmounts,
      reportableBases: input.reportableBases,
      children: reporting.original.children,
    },
  ];
  const reportingFile = await retainFile({ ...input, ...facts, allocations });
  await qualifyCanadianOpeningReportingSource({
    ...packet,
    ...reportingFile,
    requestId: randomUUID(),
    expectedLevyAuthorityId: levy.id,
    expectedLevyAllocationSha256: levy.allocationSha256,
    allocations,
  });
}

/** A declared CRA registration and dated EI multiple, without inferring employee ownership. */
export async function seedCanadianFilingAccountForTest(
  orgId: string,
  actorId: string,
  input: {
    subsidiaryId: string;
    accountNumber: string;
    name: string;
    effectiveFrom: string;
    eiEmployerMultiplier: string;
  },
): Promise<string> {
  await assertFixtureDatabase();
  const filingAccountId = randomUUID();
  assert.equal(
    (
      await db.execute(
        sql`insert into payroll_filing_accounts
    (id,org_id,country,program_type,account_number,name,subsidiary_id,is_default,created_by,updated_by)
    values(${filingAccountId},${orgId},'CA','ca_rp',${input.accountNumber},${input.name},${input.subsidiaryId},true,${actorId},${actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  await upsertPayrollEmployerFact({
    orgId,
    actorId,
    filingAccountId,
    country: "CA",
    factKey: "ei_employer_multiplier",
    effectiveFrom: input.effectiveFrom,
    value: input.eiEmployerMultiplier,
    changeReason: "Declared employer EI multiple for the retained CRA registration",
  });
  return filingAccountId;
}
