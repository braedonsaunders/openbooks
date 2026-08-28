import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp } from "./money.ts";
import {
  assertContributoryBasesDeclared,
  legacyStatutoryLiabilityAccount,
  packStatutoryComponents,
  PAYROLL_COUNTRY_PACKS,
  PayrollPackError,
  payrollJurisdictionDeclared,
  statutoryRemittanceDeclaration,
  type PayrollCountryPack,
} from "./payroll/packs.ts";
import { undeclaredJurisdictionHolidayConflict } from "./payroll-holidays.ts";
import { payRunReadiness } from "./payroll-readiness.ts";
import {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
  statutoryHolidayLinesForStub,
} from "./payroll-run.ts";
import { createScratchOrg, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The country-agnostic core, proven against a jurisdiction that does not
 * exist. Every generic-layer decision — what to seed, where a liability
 * posts, what is never remitted, what dues mean at tax time — must come from
 * a PACK declaration, so a synthetic third pack ("ZZ", Freedonia) is the
 * honest probe: if any Canadian answer leaks into it, the generic layer still
 * has a homeland.
 */

/** A minimal third country pack no real jurisdiction resembles. */
const FREEDONIA: PayrollCountryPack = {
  country: "ZZ" as PayrollCountryPack["country"],
  installable: false,
  statutoryCurrency: "ZZD",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: {
    label: "canton",
    known: ["Z1", "Z2"],
    supported: ["Z1"],
    unsupportedReason: "canton {region} is not implemented by the ZZ payroll pack",
  },
  jurisdictions: [
    {
      key: "ZZ", name: "Freedonia", scope: "employment",
      citation: "Freedonia Labour Act", holidays: [], holidayPay: null,
    },
  ],
  remittanceVendorSettingsKey: "zzRemittancePartyId",
  // Freedonia spreads a retroactive payment back over the periods it relates
  // to and taxes it as ordinary income of those periods — deliberately the
  // OPPOSITE of the CRA's and the IRS's answer, so a Canadian or American
  // "retro is a bonus" leaking into the generic layer would show up here.
  retroactivePayTreatment: "periodic",
  contributoryBases: {
    pensionable: "Freedonia pension-levy wages",
    insurable: "Freedonia employment-fund wages",
  },
  employeeUnionDuesTaxTreatment: null,
  // The pack's filing declaration is lazy like the built-ins'; Freedonia
  // files nothing, and says so rather than inheriting anyone's forms.
  filings: () => ({
    country: "ZZ",
    programTypes: [{ key: "zz_payg", label: "Freedonia PAYG employer number" }],
    yearEnd: [],
  }),
  // Freedonia publishes every rate it levies, so the employer supplies NONE.
  // An empty slot list is a real declaration, not an omission: it proves the
  // generic rate layer does not assume every pack has an experience-rated or
  // per-region levy the way the CA and US packs do.
  statutoryRates: { country: "ZZ", slots: [] },
  // One transcribed year, no region publishing its own tables. Declaring this
  // is what lets the product say "2027 is not loaded for ZZ" in readiness
  // instead of throwing from inside a calculation in January.
  taxYears: {
    country: "ZZ",
    editions: [{
      year: 2026,
      label: "Freedonia PAYG tables (2026)",
      effectiveFrom: "2026-01-01",
      citation: "Freedonia Revenue Bulletin 2026-1",
      status: "published",
    }],
    regionsWithOwnTables: [],
    ratesModule: "engine/src/payroll/freedonia/rates.ts",
    scaffold: { files: [], barrels: [], steps: [] },
  },
  // Freedonia issues ONE withholding certificate and has no cantonal income
  // tax at all. Both are REQUIRED members, which is the point: a pack that
  // stays silent about its certificates or its jurisdictions is a pack whose
  // answer somebody guessed, and the US pack's declarations sat unregistered
  // and unreachable for two whole slices precisely because nothing forced it
  // to say so out loud.
  certificates: () => ({
    country: "ZZ",
    certificates: [{
      key: "zz_payg_declaration",
      form: "PAYG-1",
      label: "Freedonia PAYG declaration",
      scope: { level: "country" },
      purpose: "withholding",
      citation: "Freedonia Revenue Bulletin 2026-1",
      summary: "Filed on hire; sets the employee's PAYG scale.",
      storage: "certificate_rows",
      fields: [{
        key: "scale", label: "PAYG scale", kind: "choice",
        choices: [{ value: "A", label: "Scale A" }, { value: "B", label: "Scale B" }],
        default: "A",
        help: "Scale A unless the Revenue has written to the employee naming scale B.",
      }],
    }],
  }),
  // No canton levies income tax, and that is a DECLARATION rather than an
  // omission: `residentWithholding: "none"` is what makes the resolver
  // withhold nothing without anybody's engine having to be consulted.
  withholding: () => ({
    country: "ZZ",
    regions: (["Z1", "Z2"] as const).map((region) => ({
      region,
      label: `Canton ${region} (no income tax)`,
      implemented: true,
      taxesNonresidentWages: false,
      residentWithholding: "none" as const,
      residentWithholdingImplemented: true,
      subRegions: [],
      subRegionConflictRule: "both" as const,
      citation: "Freedonia Revenue Bulletin 2026-1: income tax is levied federally",
    })),
  }),
  computeStatutory: async () => {
    throw new PayrollPackError("Freedonia statutory compute is not implemented");
  },
  statutorySlots: [
    {
      key: "payg",
      legacySettingsKey: "zzPayableAccountId",
      components: [
        { code: "ZTAX", name: "Freedonia PAYG", systemKey: "zz_tax", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
      ],
    },
    {
      key: "holiday",
      components: [
        // The pack's own internal accrual: banked, paid out to the employee,
        // NEVER remitted. The remittance module must learn that from this
        // declaration, not from recognising the words 'vacation_accrual'.
        { code: "ZHOL", name: "Holiday accrual", systemKey: "holiday_accrual", kind: "employer_contribution", sequence: 240, assessedOn: "earnings", remittance: "internal_accrual" },
      ],
    },
  ],
};

const withFreedonia = async (run: () => Promise<void> | void): Promise<void> => {
  PAYROLL_COUNTRY_PACKS.ZZ = FREEDONIA;
  try {
    await run();
  } finally {
    delete PAYROLL_COUNTRY_PACKS.ZZ;
  }
};

/* ------------------------------------------------------------------ */
/* Seeding is the pack's declaration                                   */
/* ------------------------------------------------------------------ */

test("a third pack's statutory set is its own declaration — nothing Canadian in it", async () => {
  await withFreedonia(() => {
    const keys = packStatutoryComponents("ZZ").map((c) => `${c.systemKey}/${c.kind}`);
    assert.deepEqual(keys, ["zz_tax/deduction", "holiday_accrual/employer_contribution"]);
    // The Canadian set exists only under the Canadian pack.
    for (const caOnly of ["cpp", "cpp2", "ei", "qpip", "income_tax", "vacation_accrual"]) {
      assert.ok(!keys.some((k) => k.startsWith(`${caOnly}/`)), `${caOnly} leaked into ZZ`);
    }
  });
});

test("an unknown country never falls through to anybody's component set", () => {
  assert.throws(() => packStatutoryComponents("GB"), PayrollPackError);
  assert.throws(() => packStatutoryComponents(""), PayrollPackError);
});

test("contributory bases are a required, asserted declaration", async () => {
  assertContributoryBasesDeclared("CA");
  assertContributoryBasesDeclared("US");
  await withFreedonia(() => assertContributoryBasesDeclared("ZZ"));
  // A pack authored through a cast with the declaration blanked is refused at
  // seed time rather than accumulating an unnamed base.
  PAYROLL_COUNTRY_PACKS.ZZ = {
    ...FREEDONIA,
    contributoryBases: { pensionable: " ", insurable: "" },
  };
  try {
    assert.throws(() => assertContributoryBasesDeclared("ZZ"), /contributory bases/);
  } finally {
    delete PAYROLL_COUNTRY_PACKS.ZZ;
  }
});

test("seeding a third pack provisions exactly its declaration — no Canadian component leaks", { skip: !DB }, async () => {
  // The schema keeps its OWN registry of pack identities
  // (pay_components_system_key / pay_components_country check constraints), so
  // a real third pack extends the baseline in the same change that declares
  // it, and an undeclared key is refused at the table too. The dev database is
  // shared with concurrent sessions, so this test does not touch that registry:
  // the synthetic pack here declares an EMPTY statutory set, which is exactly
  // the shape that used to be impossible — the old
  // `country === "US" ? US_COMPONENTS : CA_COMPONENTS` seeded the CANADIAN set
  // for any third country, and this proves the declaration now drives the rows
  // all the way to the table. (That a NON-empty declaration seeds verbatim is
  // the pure test above: the seeder maps packStatutoryComponents 1:1.)
  PAYROLL_COUNTRY_PACKS.ZZ = { ...FREEDONIA, statutorySlots: [] };
  try {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedPayrollComponents(org.orgId, actorId, "ZZ");
    const rows = (await db.execute<{ code: string; system_key: string | null; country: string | null }>(sql`
      select code, system_key, country from pay_components where org_id = ${org.orgId}
      order by sequence, code
    `));

    // Exactly the jurisdiction-free baseline, all of it country-less; not one
    // statutory component of anybody else's.
    assert.deepEqual(
      rows.rows.map((r) => r.code),
      ["BASE", "OT", "STAT", "STATPREM", "BONUS", "VACPAY"],
    );
    assert.ok(rows.rows.every((r) => r.country === null));
    const systemKeys = new Set(rows.rows.map((r) => r.system_key));
    for (const caOnly of ["cpp", "cpp2", "ei", "qpip", "income_tax", "vacation_accrual", "wcb", "eht", "fit", "ss"]) {
      assert.ok(!systemKeys.has(caOnly), `${caOnly} seeded for a ZZ org`);
    }
    // No vacation entitlement plan either: ZZ declares no vacation accrual.
    const plans = (await db.execute(sql`
      select 1 from entitlement_plans where org_id = ${org.orgId} and system_key = 'vacation'
    `));
    assert.equal(plans.rows.length, 0);
  } finally {
    delete PAYROLL_COUNTRY_PACKS.ZZ;
  }
});

/* ------------------------------------------------------------------ */
/* GL slot resolution and the remittance declaration                   */
/* ------------------------------------------------------------------ */

test("statutory liabilities resolve through the slot's own legacy key — synthetic slot included", async () => {
  const settings = {
    taxPayableAccountId: "acct-tax",
    cppPayableAccountId: "acct-cpp",
    eiPayableAccountId: "acct-ei",
    vacationPayableAccountId: "acct-vac",
    zzPayableAccountId: "acct-zz",
  };
  await withFreedonia(() => {
    // The synthetic slot resolves with no generic-layer knowledge of it.
    assert.equal(legacyStatutoryLiabilityAccount("zz_tax", settings), "acct-zz");
    // Its internal accrual has no legacy key: component account or refusal.
    assert.equal(legacyStatutoryLiabilityAccount("holiday_accrual", settings), null);
  });
  // The CA merges are the PACK's declarations, preserved exactly: CPP2 rides
  // the CPP payable and QPIP the EI payable, because those slots say so.
  assert.equal(legacyStatutoryLiabilityAccount("income_tax", settings), "acct-tax");
  assert.equal(legacyStatutoryLiabilityAccount("cpp", settings), "acct-cpp");
  assert.equal(legacyStatutoryLiabilityAccount("cpp2", settings), "acct-cpp");
  assert.equal(legacyStatutoryLiabilityAccount("ei", settings), "acct-ei");
  assert.equal(legacyStatutoryLiabilityAccount("qpip", settings), "acct-ei");
  assert.equal(legacyStatutoryLiabilityAccount("vacation_accrual", settings), "acct-vac");
  // Slots with no legacy key (WCB, EHT, the whole US pack) resolve null.
  for (const key of ["wcb", "eht", "fit", "ss", "medicare", "futa", "suta", "nonsense"]) {
    assert.equal(legacyStatutoryLiabilityAccount(key, settings), null, key);
  }
});

test("'never remitted' is a component declaration, not the spelling of vacation_accrual", async () => {
  assert.deepEqual(statutoryRemittanceDeclaration().internalAccrualSystemKeys, ["vacation_accrual"]);
  await withFreedonia(() => {
    const declaration = statutoryRemittanceDeclaration();
    assert.deepEqual(
      [...declaration.internalAccrualSystemKeys].sort(),
      ["holiday_accrual", "vacation_accrual"],
    );
    // The statutory vendor fallback is per pack: CA names its CRA vendor key,
    // ZZ names its own, the US declares none, and WCB (external) has no
    // fallback at all.
    assert.equal(declaration.vendorSettingsKeyBySystemKey.get("cpp"), "craRemittancePartyId");
    assert.equal(declaration.vendorSettingsKeyBySystemKey.get("income_tax"), "craRemittancePartyId");
    assert.equal(declaration.vendorSettingsKeyBySystemKey.get("zz_tax"), "zzRemittancePartyId");
    assert.equal(declaration.vendorSettingsKeyBySystemKey.get("fit"), null);
    assert.equal(declaration.vendorSettingsKeyBySystemKey.has("wcb"), false);
    assert.equal(declaration.vendorSettingsKeyBySystemKey.has("vacation_accrual"), false);
  });
});

test("a system key two packs declare differently is a refusal, never a coin toss", () => {
  PAYROLL_COUNTRY_PACKS.ZZ = {
    ...FREEDONIA,
    statutorySlots: [
      {
        key: "vacation",
        components: [
          // CA declares vacation_accrual internal; this pack claims it remits.
          { code: "ZVAC", name: "Vacation levy", systemKey: "vacation_accrual", kind: "employer_contribution", sequence: 240, assessedOn: "earnings", remittance: "tax_authority" },
        ],
      },
    ],
  };
  try {
    assert.throws(() => statutoryRemittanceDeclaration(), /internal_accrual and remittable/);
  } finally {
    delete PAYROLL_COUNTRY_PACKS.ZZ;
  }
});

/* ------------------------------------------------------------------ */
/* The undeclared-jurisdiction statutory holiday gate                  */
/* ------------------------------------------------------------------ */

test("an undeclared jurisdiction blocks exactly when a holiday is in the period", () => {
  // Every Canadian PROVINCE is declared now. 'ZZ' is T4127's region for an
  // employee employed outside any of them: the withholding pack knows it and no
  // employment-standards act governs it, so it is the case this gate is for.
  // Canada Day 2026-07-01 falls inside the period, and the run must stop rather
  // than pay a silent zero for the day.
  const conflict = undeclaredJurisdictionHolidayConflict({
    country: "CA", jurisdiction: "CA-ZZ", from: "2026-06-21", to: "2026-07-04",
  });
  assert.ok(conflict);
  assert.equal(conflict.date, "2026-07-01");
  assert.match(conflict.message, /Canada Day/);
  assert.match(conflict.message, /CA-ZZ/);

  // A holiday only SOME sibling calendars name still trips the probe: the third
  // Monday of February is Family Day in four provinces, Louis Riel Day in
  // Manitoba, Islander Day in Prince Edward Island and Heritage Day in Nova
  // Scotia — one date, four names, and the message picks the commonest.
  const february = undeclaredJurisdictionHolidayConflict({
    country: "CA", jurisdiction: "CA-ZZ", from: "2026-02-15", to: "2026-02-21",
  });
  assert.ok(february);
  assert.equal(february.date, "2026-02-16");

  // …and a day only two of the fourteen keep does NOT. National Indigenous
  // Peoples Day binds the Northwest Territories and Yukon and nobody else, and
  // it must not stop an employment neither of them governs. This is what a
  // constant threshold got wrong once the country was fully transcribed.
  assert.equal(
    undeclaredJurisdictionHolidayConflict({
      country: "CA", jurisdiction: "CA-ZZ", from: "2026-06-15", to: "2026-06-27",
    }),
    null,
  );

  // No statutory holiday in the window: the undeclared jurisdiction
  // calculates exactly as it always has.
  assert.equal(
    undeclaredJurisdictionHolidayConflict({
      country: "CA", jurisdiction: "CA-ZZ", from: "2026-07-06", to: "2026-07-18",
    }),
    null,
  );

  // And the eight that used to be this gate's case are declared now, so they
  // calculate instead of blocking.
  for (const jurisdiction of ["CA-MB", "CA-NB", "CA-NL", "CA-NS", "CA-NT", "CA-NU", "CA-PE", "CA-YT"]) {
    assert.ok(payrollJurisdictionDeclared(jurisdiction));
    assert.equal(
      undeclaredJurisdictionHolidayConflict({
        country: "CA", jurisdiction, from: "2026-06-21", to: "2026-07-04",
      }),
      null,
    );
  }

  // A DECLARED jurisdiction is never this gate's case — including the ones
  // declared as "no mandate" (US states), which pay nothing lawfully.
  assert.ok(payrollJurisdictionDeclared("CA-ON"));
  assert.ok(payrollJurisdictionDeclared("US-TX"));
  assert.equal(
    undeclaredJurisdictionHolidayConflict({
      country: "CA", jurisdiction: "CA-ON", from: "2026-06-21", to: "2026-07-04",
    }),
    null,
  );

  // Massachusetts is deliberately omitted (its Blue Laws mandate premium
  // pay), so July 4 — observed Friday July 3, 2026 — stops it by name.
  assert.ok(!payrollJurisdictionDeclared("US-MA"));
  const massachusetts = undeclaredJurisdictionHolidayConflict({
    country: "US", jurisdiction: "US-MA", from: "2026-06-29", to: "2026-07-12",
  });
  assert.ok(massachusetts);
  assert.equal(massachusetts.date, "2026-07-03");
  assert.match(massachusetts.message, /US-MA/);
});

/* ------------------------------------------------------------------ */
/* The stub-side holiday gate refuses before any database work         */
/* ------------------------------------------------------------------ */

test("the calculated stub's jurisdiction gate refuses before touching the transaction", async () => {
  // The same gate, as the CALCULATION runs it — `statutoryHolidayLinesForStub`
  // inside payroll-run.ts. Every refusal must happen before a single query and
  // before any component lookup: a run that would pay a silent zero or honour
  // a foreign calendar stops at the gate, not partway into the employee's
  // calculation. Both stubs below throw if they are touched at all.
  const untouchedTx = {
    execute() { throw new Error("transaction used before the gate passed"); },
  } as unknown as Parameters<typeof statutoryHolidayLinesForStub>[0];
  const need = () => {
    throw new Error("components looked up before the gate passed");
  };
  const emp = (labourJurisdiction: string | null): Record<string, string | null> => ({
    party_id: "emp-1", display_name: "Ann", labour_jurisdiction: labourJurisdiction,
  });

  // An explicit labour jurisdiction no pack declares is refused outright —
  // ahead of even the holiday probe, because an undeclared EXPLICIT key is a
  // data-entry fault, not a gap in the packs.
  await assert.rejects(
    statutoryHolidayLinesForStub(untouchedTx, {
      orgId: "o", documentId: "d", employeePartyId: "emp-1", employeeName: "Ann",
      emp: emp("CA-ZZ"), country: "CA", province: null,
      periodStart: "2026-07-06", periodEnd: "2026-07-18",
      payRate: null, need,
    }),
    /has a labour jurisdiction this payroll cannot honour/,
  );

  // Derived from the region instead (no explicit attribute): CA-ZZ with Canada
  // Day in the period blocks with the same message readiness raises…
  await assert.rejects(
    statutoryHolidayLinesForStub(untouchedTx, {
      orgId: "o", documentId: "d", employeePartyId: "emp-1", employeeName: "Ann",
      emp: emp(null), country: "CA", province: "ZZ",
      periodStart: "2026-06-21", periodEnd: "2026-07-04",
      payRate: null, need,
    }),
    /Canada Day/,
  );

  // …and with NO holiday in the period it calculates exactly as it always
  // has — no lines, and provably no database work.
  assert.deepEqual(
    await statutoryHolidayLinesForStub(untouchedTx, {
      orgId: "o", documentId: "d", employeePartyId: "emp-1", employeeName: "Ann",
      emp: emp(null), country: "CA", province: "ZZ",
      periodStart: "2026-07-06", periodEnd: "2026-07-18",
      payRate: null, need,
    }),
    [],
  );

  // A DECLARED jurisdiction passes the gate and only then reaches for its
  // components — the lookups stay lazy, so an org without the phase wired up
  // never pays their cost on a refusal path.
  await assert.rejects(
    statutoryHolidayLinesForStub(untouchedTx, {
      orgId: "o", documentId: "d", employeePartyId: "emp-1", employeeName: "Ann",
      emp: emp(null), country: "CA", province: "ON",
      periodStart: "2026-06-21", periodEnd: "2026-07-04",
      payRate: null, need,
    }),
    /components looked up before the gate passed/,
  );
});

/* ------------------------------------------------------------------ */
/* Statutory holiday pay wiring: gated, declared, byte-stable when off */
/* ------------------------------------------------------------------ */

test("stat pay: OFF is byte-identical, ON pays the declared formula, undeclared blocks only with a holiday", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const orgId = org.orgId;
  const actorId = (await seedFlowActors(orgId)).adminId;

  const account = async (number: string, name: string, type: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                            reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false,
              '[]'::jsonb, '{}'::jsonb, true)`);
    return id;
  };
  const wageExpense = await account("6000", "Wages expense", "expense");
  const netPayable = await account("2300", "Wages payable", "liability_current");
  const craPayable = await account("2310", "CRA remittances payable", "liability_current");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        netPayAccountId: netPayable,
        cppPayableAccountId: craPayable,
        eiPayableAccountId: craPayable,
        taxPayableAccountId: craPayable,
        wagesTo: "expense",
      },
    })}::jsonb where id = ${orgId}`);
  await seedPayrollComponents(orgId, actorId, "CA");
  // The production Quebec path emits the pack's separate Revenu Québec
  // income-tax component. Point it at the same fixture payable account so
  // this regression reaches holiday-line persistence rather than failing in
  // unrelated GL setup.
  await db.execute(sql`
    update pay_components set liability_account_id = ${craPayable}
     where org_id = ${orgId} and system_key = 'qc_income_tax' and kind = 'deduction'`);

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${orgId}, 'Biweekly', 'biweekly', 26, '2026-06-20', 3, true,
            ${actorId}, ${actorId})`);

  const employee = async (name: string, province: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${id}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
      values (${orgId}, ${id}, '2020-01-01', true, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                    is_active, created_by, updated_by)
      values (${orgId}, ${id}, 'CAD', '30', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                             pay_basis, federal_claim_code, provincial_claim_code,
                                             vacation_method, is_active, created_by, updated_by)
      values (${orgId}, ${id}, ${scheduleId}, ${province}, 'hourly', 1, 1,
              'accrue', true, ${actorId}, ${actorId})`);
    return id;
  };
  const ontarioId = await employee("Olive Ontario", "ON");
  const quebecId = await employee("Quinn Quebec", "QC");
  const manitobaId = await employee("Morley Manitoba", "MB");
  // Employed outside any province: withholding knows 'ZZ', no employment
  // standards act does, so this is the employee the undeclared gate is for.
  const outsideId = await employee("Zed Offshore", "ZZ");

  const hours = async (employeeId: string, days: string[], perDay = 20) => {
    for (const workedOn of days) {
      await db.execute(sql`
        insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                  billing_status, costing_basis, created_by, updated_by)
        values (${orgId}, ${employeeId}, ${workedOn}, ${perDay}, 'approved', false,
                'unbilled', 'actual', ${actorId}, ${actorId})`);
    }
  };

  // Lookback fodder: one committed run whose period sits wholly inside the
  // four work weeks before Canada Day (2026-06-03 .. 2026-06-30).
  await hours(ontarioId, ["2026-06-08", "2026-06-10", "2026-06-12", "2026-06-16"]);
  await hours(quebecId, ["2026-06-08", "2026-06-10", "2026-06-12", "2026-06-16"]);
  await hours(manitobaId, ["2026-06-09", "2026-06-11"]);
  await hours(outsideId, ["2026-06-09", "2026-06-11"]);
  const run1 = await createPayRun({
    orgId, actorId, payScheduleId: scheduleId,
    periodStart: "2026-06-07", periodEnd: "2026-06-20",
  });
  const calc1 = await calculatePayRun({ orgId, documentId: run1.documentId, actorId });
  assert.deepEqual(calc1.errors, []);
  await commitPayRun({ orgId, documentId: run1.documentId, actorId });

  // The run under test: its period contains Canada Day (Wednesday 2026-07-01).
  await hours(ontarioId, ["2026-06-22", "2026-06-24", "2026-06-26", "2026-06-30"]);
  await hours(quebecId, ["2026-06-22", "2026-06-24", "2026-06-26", "2026-06-30"]);
  await hours(manitobaId, ["2026-06-23", "2026-06-25"]);
  await hours(outsideId, ["2026-06-23", "2026-06-25"]);
  const run2 = await createPayRun({
    orgId, actorId, payScheduleId: scheduleId,
    periodStart: "2026-06-21", periodEnd: "2026-07-04",
  });

  const snapshot = async () => {
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select s.employee_party_id, s.gross, s.net_pay, s.employer_cost, s.factors,
             l.kind, l.description, l.hours, l.rate, l.amount, l.sequence, c.code
        from pay_stubs s
        join pay_stub_lines l on l.stub_id = s.id
        left join pay_components c on c.id = l.component_id
       where s.org_id = ${orgId} and s.pay_run_document_id = ${run2.documentId}
       order by s.employee_party_id, l.sequence, l.amount, l.description
    `));
    return JSON.stringify(rows.rows);
  };

  // --- Feature OFF (the default): calculates exactly as before the feature.
  const offResult = await calculatePayRun({ orgId, documentId: run2.documentId, actorId });
  assert.equal(offResult.employees, 4);
  assert.deepEqual(offResult.errors, []);
  const offStubs = await snapshot();
  assert.ok(!offStubs.includes("stat"), "no stat holiday lines while the feature is off");

  // --- Feature ON.
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{payroll,statutoryHolidayPay}', 'true'::jsonb)
     where id = ${orgId}`);

  // Readiness names the undeclared jurisdiction and the holiday BEFORE the
  // run does, with the same message.
  const readiness = await payRunReadiness(orgId, run2.documentId);
  const blocker = readiness.items.find((item) => item.code === "holiday.undeclaredJurisdiction");
  assert.ok(blocker, "readiness blocker for the undeclared jurisdiction");
  assert.equal(blocker.severity, "blocker");
  assert.match(blocker.detail ?? "", /CA-ZZ/);
  assert.match(blocker.detail ?? "", /Canada Day/);
  assert.deepEqual(blocker.employees.map((e) => e.partyId), [outsideId]);

  // The production path must refuse Ontario/Quebec holiday pay when the
  // employer has not supplied the two legal eligibility facts. A missing
  // value is not permission to use the ordinary formula or to assume consent.
  const missingFacts = await calculatePayRun({ orgId, documentId: run2.documentId, actorId });
  assert.equal(missingFacts.employees, 0);
  assert.equal(missingFacts.errors.length, 4);
  const missingByName = new Map(missingFacts.errors.map((e) => [e.employee, e.message]));
  assert.match(missingByName.get("Olive Ontario") ?? "", /absence assertion/);
  assert.match(missingByName.get("Quinn Quebec") ?? "", /commission-pay status/);

  // Supplying the authoritative facts reaches the same resolver used by a
  // real run. Quebec's commission employee must take the 12-week ÷60 arm,
  // while Ontario's explicit consent assertion allows its ordinary ÷20 rule.
  const holidayEligibility = {
    [ontarioId]: { paidOnCommission: false, absentWithoutConsent: false },
    [quebecId]: { paidOnCommission: true, absentWithoutConsent: false },
    [manitobaId]: { paidOnCommission: false, absentWithoutConsent: false },
  };
  const onResult = await calculatePayRun({
    orgId, documentId: run2.documentId, actorId, holidayEligibility,
  });
  // Ontario calculates with the declared ESA formula. Manitoba is DECLARED now
  // and its measure is a normal working day, so it refuses for a different and
  // better reason: nobody has said what hours this employee normally works, and
  // the run will not invent them. Zed is refused by the undeclared gate with
  // the readiness blocker's own message.
  assert.equal(onResult.employees, 2);
  assert.equal(onResult.errors.length, 2);
  const byName = new Map(onResult.errors.map((e) => [e.employee, e.message]));
  assert.match(byName.get("Morley Manitoba") ?? "", /no work schedule is in force/);
  assert.match(byName.get("Morley Manitoba") ?? "", /Canada Day/);
  assert.equal(byName.get("Zed Offshore"), blocker.detail);

  // Record what Morley normally works — 8 hours a day, Monday to Friday,
  // effective before the period — and Manitoba calculates.
  const mbSchedule = randomUUID();
  await db.execute(sql`
    insert into work_schedules (id, org_id, name, employee_party_id, pattern, cycle_days,
                                cycle_anchor, effective_from, is_active, created_by, updated_by)
    values (${mbSchedule}, ${orgId}, 'Full time', ${manitobaId}, 'cycle', 7, '2026-01-04',
            '2026-01-01', true, ${actorId}, ${actorId})`);
  for (const dayIndex of [1, 2, 3, 4, 5]) {
    await db.execute(sql`
      insert into work_schedule_days (org_id, schedule_id, day_index, hours, created_by, updated_by)
      values (${orgId}, ${mbSchedule}, ${dayIndex}, '8', ${actorId}, ${actorId})`);
  }
  const withSchedule = await calculatePayRun({
    orgId, documentId: run2.documentId, actorId, holidayEligibility,
  });
  assert.equal(withSchedule.employees, 3);
  assert.equal(withSchedule.errors.length, 1, "only the undeclared jurisdiction is left");
  assert.equal(withSchedule.errors[0]!.employee, "Zed Offshore");

  // Hand-worked ESA s. 24(1)(a): regular wages in the four work weeks before
  // the holiday's week = the committed June 7–20 stub, 80h × $30 = 2,400.00
  // (vacation pay: none). 2,400 ÷ 20 = 120.00 for the day; no hours worked on
  // July 1, so no premium line.
  const statLines = (await db.execute<{ system_key: string; amount: string; gross: string; employee_party_id: string; description: string }>(sql`
    select c.system_key, l.amount, s.gross, s.employee_party_id, l.description
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id
      join pay_components c on c.id = l.component_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${run2.documentId}
       and c.system_key in ('stat_holiday', 'stat_holiday_premium')
  `));
  assert.equal(statLines.rows.length, 4);
  const ontarioStat = statLines.rows.find((r) => r.employee_party_id === ontarioId);
  assert.ok(ontarioStat);
  assert.equal(ontarioStat.system_key, "stat_holiday");
  assert.equal(cmp(ontarioStat.amount, "120.00"), 0);
  // The day's pay is IN gross, ahead of the statutory pass (phase 2).
  assert.equal(cmp(ontarioStat.gross, add("2400.00", "120.00")), 0);

  const quebecStat = statLines.rows.find((r) =>
    r.employee_party_id === quebecId && /Canada Day/.test(r.description));
  assert.ok(quebecStat);
  assert.equal(quebecStat.system_key, "stat_holiday");
  // The production caller supplied paidOnCommission=true, so Quebec uses the
  // twelve-week commission window and divides by 60: $2,400 ÷ 60 = $40,
  // rather than silently applying the ordinary $2,400 ÷ 20 = $120 formula.
  assert.equal(cmp(quebecStat.amount, "40.00"), 0);

  // The same production entry point honours an asserted unconsented absence:
  // Ontario's last-and-first scheduled-shift test disqualifies the holiday,
  // while the other employees retain their supplied facts.
  const denied = await calculatePayRun({
    orgId,
    documentId: run2.documentId,
    actorId,
    holidayEligibility: {
      ...holidayEligibility,
      [ontarioId]: { paidOnCommission: false, absentWithoutConsent: true },
    },
  });
  assert.equal(denied.employees, 3);
  assert.equal(denied.errors.length, 1);
  const deniedByName = new Map(denied.errors.map((e) => [e.employee, e.message]));
  assert.equal(deniedByName.get("Zed Offshore"), blocker.detail);
  const deniedHoliday = await db.execute<{ count: number }>(sql`
    select count(*)::int as count
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and l.org_id = s.org_id
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${run2.documentId}
       and s.employee_party_id = ${ontarioId} and c.system_key = 'stat_holiday'
  `);
  assert.equal(Number(deniedHoliday.rows[0]?.count ?? 0), 0);

  // Hand-worked Manitoba s. 23(1): the wages for regular hours on a NORMAL
  // WORKDAY — 8 scheduled hours × $30.00 = $240.00. Note what it is not: the
  // Ontario answer for the same employee would have been the four weeks'
  // wages ÷ 20, and the four weeks here are 40 hours (two 20-hour days) ×
  // $30 = $1,200, which ÷ 20 is $60. The province genuinely changes the
  // number by four times, which is why neither may stand in for the other.
  const manitobaStat = statLines.rows.find((r) => r.employee_party_id === manitobaId);
  assert.ok(manitobaStat);
  assert.equal(manitobaStat.system_key, "stat_holiday");
  assert.equal(cmp(manitobaStat.amount, "240.00"), 0);

  // --- Feature ON with no holiday in the period: the undeclared jurisdiction
  // calculates exactly as it always has, and readiness raises nothing.
  await hours(ontarioId, ["2026-07-06", "2026-07-08"]);
  await hours(manitobaId, ["2026-07-07"]);
  await hours(outsideId, ["2026-07-07"]);
  const run3 = await createPayRun({
    orgId, actorId, payScheduleId: scheduleId,
    periodStart: "2026-07-05", periodEnd: "2026-07-18",
  });
  const clearReadiness = await payRunReadiness(orgId, run3.documentId);
  assert.ok(!clearReadiness.items.some((item) => item.code === "holiday.undeclaredJurisdiction"));
  const run3Result = await calculatePayRun({ orgId, documentId: run3.documentId, actorId });
  assert.equal(run3Result.employees, 4);
  assert.deepEqual(run3Result.errors, []);

  // --- Feature back OFF: run 2 recalculates byte-identical to the first pass.
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{payroll,statutoryHolidayPay}', 'false'::jsonb)
     where id = ${orgId}`);
  const offAgain = await calculatePayRun({ orgId, documentId: run2.documentId, actorId });
  assert.equal(offAgain.employees, 4);
  assert.deepEqual(offAgain.errors, []);
  assert.equal(await snapshot(), offStubs);
});
