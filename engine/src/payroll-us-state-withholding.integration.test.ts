import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  packCertificates, payrollCertificate, resolveCertificate,
} from "./payroll/certificates.ts";
import { reciprocityAgreement } from "./payroll/reciprocity.ts";
import { regionWithholding } from "./payroll/withholding-jurisdictions.ts";
import { PAYROLL_COUNTRY_PACKS, setPackSlotAccount } from "./payroll/packs.ts";
import {
  CA_WITHHOLDING, NY_WITHHOLDING, NYC_WITHHOLDING, PA_WITHHOLDING,
} from "./payroll/us/states/index.ts";
import { calculatePayRun, createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

/**
 * The US state withholding engine, ON A REAL PAY RUN.
 *
 * Two previous slices built this: ten state engines with 119 conformance
 * goldens, a pure resolution order with 25 tests, certificates, reciprocity and
 * sub-region levies. Every one of those tests passed. NONE OF IT RAN. Nothing
 * imported `us/jurisdictions.ts`, so its declarations were never registered;
 * nothing in `payroll-run.ts` mentioned the resolution or the engines, so
 * `calculateStub` never withheld a cent of state tax. A Californian's stub
 * carried federal tax, FICA, FUTA and SUI and no California income tax at all,
 * and 658 unit tests were green while it did.
 *
 * That gap existed *because* every test was a unit test. So these are not:
 * each one runs a pay run against the database and reads the stub back, and the
 * amounts are compared against the state engines called DIRECTLY with the same
 * inputs — the assertion the presence of a line cannot make.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

/* --------------------------------------------------------------------- */
/* The registrations actually happen now                                  */
/* --------------------------------------------------------------------- */

/**
 * Deliberately imports NO `us/jurisdictions.ts`. That side-effect import is the
 * crutch that hid the defect: the tests registered the declarations themselves,
 * so they could not tell that the product never did. This file reaches them the
 * way the pay run does — through the pack.
 */
test("the US pack PUBLISHES its withholding declarations — they used to be dead code", () => {
  const pack = PAYROLL_COUNTRY_PACKS.US!;
  const declared = pack.withholding();
  // The registry the pure resolver reads answers with the pack's OWN objects.
  // Before this, `regionWithholding("US", "CA")` threw "the US payroll pack
  // declares no withholding jurisdictions" anywhere the tests had not imported
  // the module for its side effect — which is to say, in the product.
  assert.equal(
    regionWithholding("US", "CA"),
    declared.regions.find((region) => region.region === "CA"),
  );
  assert.equal(regionWithholding("US", "CA").label, "California PIT");
  assert.equal(regionWithholding("US", "OH").subRegions.length > 200, true);

  // Certificates and reciprocity, through the same publication.
  assert.equal(
    packCertificates("US").certificates.some((certificate) => certificate.key === "us_ca_de4"),
    true,
  );
  assert.equal(payrollCertificate("US", "us_ny_it2104").form, "IT-2104");
  assert.equal(reciprocityAgreement("US", "NJ", "PA")?.certificateKey, "us_nj_nj165");
  // New York has none, and that is the canonical case: a New Jersey resident
  // working in New York is withheld New York in full.
  assert.equal(reciprocityAgreement("US", "NY", "NJ"), null);

  // Canada answers the same interface, which is what keeps it an interface.
  const ca = PAYROLL_COUNTRY_PACKS.CA!;
  assert.equal(ca.withholding().regions.length, 14);
  assert.equal(ca.certificates().certificates.some((entry) => entry.key === "ca_td1"), true);
  assert.equal(ca.reciprocity, undefined);
});

/* --------------------------------------------------------------------- */
/* Fixture                                                                */
/* --------------------------------------------------------------------- */

interface Fixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
  statePayable: string;
}

const PAY_DATE = "2026-07-21";
const PERIOD_START = "2026-07-05";
const PERIOD_END = "2026-07-18";
/** 26 periods of $2,000 — $52,000 a year, comfortably into every bracket. */
const PERIOD_WAGES = "2000.0000";

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
    values (${scheduleId}, ${org.orgId}, 'Biweekly US', 'biweekly', 26, ${PERIOD_END}, 3,
            ${subsidiaryId}, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, subsidiaryId, scheduleId, statePayable };
}

interface EmployeeOptions {
  /** Work region (`employee_payroll_profiles.province`). */
  state: string;
  /** Residence region, when it differs from the work region. */
  residence?: string;
  certificates?: {
    key: string;
    region?: string | null;
    subRegion?: string | null;
    answers?: Record<string, string>;
  }[];
}

async function usEmployee(fx: Fixture, name: string, opts: EmployeeOptions): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${fx.orgId}, 'person', ${name}, ${fx.subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${fx.orgId}, ${id})`);
  // Salaried: $52,000 a year is $2,000 a period at 26 periods, so the stub's
  // taxable wage is exactly PERIOD_WAGES and every expectation below is the
  // engine called with that number.
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, 'USD', '52000', 'year', 2080, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                           province, residence_region, pay_basis, filing_status,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, ${fx.scheduleId}, 'US', ${opts.state},
            ${opts.residence ?? null}, 'salary', 'single', true, ${fx.actorId}, ${fx.actorId})`);
  for (const certificate of opts.certificates ?? []) {
    await db.execute(sql`
      insert into employee_tax_certificates (org_id, employee_party_id, country, certificate_key,
                                             region, sub_region, answers, effective_from,
                                             created_by, updated_by)
      values (${fx.orgId}, ${id}, 'US', ${certificate.key}, ${certificate.region ?? null},
              ${certificate.subRegion ?? null},
              ${JSON.stringify(certificate.answers ?? {})}::jsonb, '2026-01-01',
              ${fx.actorId}, ${fx.actorId})`);
  }
  return id;
}

async function runPayroll(fx: Fixture) {
  const run = await createPayRun({
    orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
    periodStart: PERIOD_START, periodEnd: PERIOD_END,
  });
  const result = await calculatePayRun({
    orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
  });
  return { run, result };
}

const stubOf = async (fx: Fixture, documentId: string, employeePartyId: string) => {
  const r = (await db.execute<{ id: string; gross: string; factors: Record<string, string> }>(sql`
    select id, gross::text as gross, factors from pay_stubs
     where org_id = ${fx.orgId} and pay_run_document_id = ${documentId}
       and employee_party_id = ${employeePartyId}
  `));
  return r.rows[0] ?? null;
};

/** Every deduction line on a stub, by the system key its component carries. */
const deductionsOf = async (fx: Fixture, stubId: string) => {
  const r = (await db.execute<{ system_key: string; description: string; amount: string }>(sql`
    select c.system_key, l.description, l.amount::text as amount
      from pay_stub_lines l join pay_components c on c.id = l.component_id
     where l.org_id = ${fx.orgId} and l.stub_id = ${stubId} and l.kind = 'deduction'
     order by l.sequence
  `));
  return r.rows;
};

/* --------------------------------------------------------------------- */
/* 1. California — the state that was withheld nothing at all             */
/* --------------------------------------------------------------------- */

test(
  "a California employee's stub carries California PIT, at the amount the CA engine computes",
  { skip: !DB },
  async () => {
    const fx = await usPayrollOrg();
    try {
      const employee = await usEmployee(fx, "Cali Coder", { state: "CA" });
      const { run, result } = await runPayroll(fx);
      assert.deepEqual(result.errors, []);

      const stub = await stubOf(fx, run.documentId, employee);
      assert.ok(stub, "the Californian was paid");
      assert.equal(stub!.gross, "2000.0000");

      // The engine, called directly with the same facts. No DE 4 on file, so
      // the certificate resolves to the pack's declared defaults — which is a
      // statutory fact ("single, zero allowances"), not this test's choice.
      const expected = CA_WITHHOLDING.compute({
        payDate: PAY_DATE,
        periodEnd: PERIOD_END,
        periodsPerYear: 26,
        wages: "2000.0000",
        certificate: resolveCertificate({
          certificate: payrollCertificate("US", "us_ca_de4"), asOf: PAY_DATE,
        }),
        basis: "resident",
      });
      assert.notEqual(expected.tax, "0.0000", "the fixture must actually be taxable");

      // The AMOUNT, not merely the presence of a line. A line whose number
      // nobody checked is how "withholds state tax" and "withholds the RIGHT
      // state tax" get confused.
      assert.equal(stub!.factors.SIT_CA, expected.tax);
      const deductions = await deductionsOf(fx, stub!.id);
      const stateLine = deductions.find((line) => line.system_key === "state_income_tax");
      assert.ok(stateLine, "a state income tax line is on the stub");
      assert.equal(stateLine!.amount, expected.tax);
      assert.equal(stateLine!.description, "California PIT");
      // Federal withholding is untouched by any of this.
      assert.ok(deductions.some((line) => line.system_key === "fit"));
      // The residence assumption is recorded rather than silent.
      assert.equal(stub!.factors.WITHHOLDING_RESIDENCE, "CA");
      assert.equal(stub!.factors.WITHHOLDING_RESIDENCE_SOURCE, "assumed");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* --------------------------------------------------------------------- */
/* 2. Cross-border — the resolution order decides, and the stub shows it   */
/* --------------------------------------------------------------------- */

test(
  "a Pennsylvania resident working in New Jersey is withheld PENNSYLVANIA, on the NJ-165",
  { skip: !DB },
  async () => {
    const fx = await usPayrollOrg();
    try {
      // The reciprocal pair, in the direction the certificate exists for:
      // New Jersey relieves a Pennsylvania resident who files NJ-165, and the
      // Pennsylvania tax is withheld instead. Get the order wrong and nothing
      // crashes — the wrong state simply receives the money.
      const claimed = await usEmployee(fx, "Reciprocal Rita", {
        state: "NJ", residence: "PA",
        certificates: [{ key: "us_nj_nj165", region: "NJ" }],
      });
      // The same employee WITHOUT the form: New Jersey withholds in full. That
      // is the state most new cross-border hires are actually in, and it is
      // invisible in every system that models reciprocity as a boolean.
      const unclaimed = await usEmployee(fx, "Unfiled Ulric", { state: "NJ", residence: "PA" });

      const { run, result } = await runPayroll(fx);

      const claimedStub = await stubOf(fx, run.documentId, claimed);
      assert.ok(claimedStub);
      const expectedPa = PA_WITHHOLDING.compute({
        payDate: PAY_DATE, periodEnd: PERIOD_END, periodsPerYear: 26,
        wages: "2000.0000",
        certificate: resolveCertificate({
          certificate: payrollCertificate("US", "us_ca_de4"), asOf: PAY_DATE,
        }),
        basis: "resident",
      });
      assert.equal(claimedStub!.factors.SIT_PA, expectedPa.tax);
      assert.equal(claimedStub!.factors.SIT_NJ, undefined, "New Jersey is relieved, not reduced");
      assert.equal(claimedStub!.factors.WITHHOLDING_RESIDENCE, "PA");
      assert.equal(claimedStub!.factors.WITHHOLDING_RESIDENCE_SOURCE, "recorded");
      const claimedLines = await deductionsOf(fx, claimedStub!.id);
      assert.equal(
        claimedLines.find((line) => line.system_key === "state_income_tax")!.description,
        "Pennsylvania personal income tax",
      );

      // Without the certificate the run REFUSES this employee by name: New
      // Jersey withholds (the agreement is unclaimed), and Pennsylvania's own
      // claim on its resident's out-of-state wages is a rule the engine does
      // not compute — so it stops rather than under-withholding by the whole
      // Pennsylvania liability.
      assert.equal(await stubOf(fx, run.documentId, unclaimed), null);
      const refusal = result.errors.find((error) => error.employee === "Unfiled Ulric");
      assert.ok(refusal, "the unfiled employee is refused by name");
      assert.match(refusal!.message, /resides in PA and works in NJ/);
      assert.match(refusal!.message, /Pennsylvania personal income tax requires the employer/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* --------------------------------------------------------------------- */
/* 3. Sub-region — New York City rides beside the state, not instead of it */
/* --------------------------------------------------------------------- */

test(
  "a New York City resident is withheld the CITY tax as well as the state tax",
  { skip: !DB },
  async () => {
    const fx = await usPayrollOrg();
    try {
      const resident = await usEmployee(fx, "Gotham Gil", {
        state: "NY",
        certificates: [{
          key: "us_ny_it2104", region: "NY",
          // The IT-2104's own question. New York City reaches RESIDENTS ONLY,
          // so without this answer the city tax is silently zero.
          answers: { nyc_resident: "true" },
        }],
      });
      // A commuter INTO the city owes it nothing — there has been no city
      // nonresident earnings tax since 1999.
      const commuter = await usEmployee(fx, "Commuter Cass", {
        state: "NY",
        certificates: [{ key: "us_ny_it2104", region: "NY", answers: { nyc_resident: "false" } }],
      });

      const { run, result } = await runPayroll(fx);
      assert.deepEqual(result.errors, []);

      const it2104 = (answers: Record<string, string>) => resolveCertificate({
        certificate: payrollCertificate("US", "us_ny_it2104"),
        stored: [{ certificateKey: "us_ny_it2104", answers, effectiveFrom: "2026-01-01" }],
        asOf: PAY_DATE,
      });
      const expectedState = NY_WITHHOLDING.compute({
        payDate: PAY_DATE, periodEnd: PERIOD_END, periodsPerYear: 26,
        wages: "2000.0000", certificate: it2104({ nyc_resident: "true" }), basis: "resident",
      });
      const expectedCity = NYC_WITHHOLDING.compute({
        payDate: PAY_DATE, periodEnd: PERIOD_END, periodsPerYear: 26,
        wages: "2000.0000", certificate: it2104({ nyc_resident: "true" }), basis: "resident",
      });
      assert.notEqual(expectedCity.tax, "0.0000");

      const stub = await stubOf(fx, run.documentId, resident);
      assert.equal(stub!.factors.SIT_NY, expectedState.tax);
      assert.equal(stub!.factors["LIT_NY-NYC"], expectedCity.tax);
      const lines = await deductionsOf(fx, stub!.id);
      assert.equal(
        lines.find((line) => line.system_key === "local_income_tax")!.amount, expectedCity.tax,
      );
      assert.equal(
        lines.find((line) => line.system_key === "local_income_tax")!.description,
        "New York City resident income tax",
      );

      const commuterStub = await stubOf(fx, run.documentId, commuter);
      assert.equal(commuterStub!.factors.SIT_NY, expectedState.tax);
      assert.equal(commuterStub!.factors["LIT_NY-NYC"], undefined);
      assert.equal(
        (await deductionsOf(fx, commuterStub!.id))
          .some((line) => line.system_key === "local_income_tax"),
        false,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* --------------------------------------------------------------------- */
/* 4 + 5. The refusals — never a silent zero                              */
/* --------------------------------------------------------------------- */

test(
  "an unimplemented state and an unrated Ohio municipality both REFUSE by name",
  { skip: !DB },
  async () => {
    const fx = await usPayrollOrg();
    try {
      // Alabama levies a wage income tax that this pack has not transcribed.
      // Withholding the federal amount, a neighbour's amount, or nothing at all
      // would each be silently wrong money on every stub.
      const connecticut = await usEmployee(fx, "Hartford Hank", { state: "AL" });
      // An Ohio municipality the employer has entered no rate for. Ohio
      // publishes no municipal withholding rate table, so the rate is
      // employer-entered — and an unentered one must stop the run, not withhold
      // zero for a levy the municipality will assess later with interest.
      const ohio = await usEmployee(fx, "Westerville Wes", {
        state: "OH",
        certificates: [{
          key: "us_oh_municipal_record", region: "OH",
          answers: { work_municipality: "WESTERVILLE" },
        }],
      });
      // The control: an Ohio employee in no taxing municipality is paid
      // normally, so the refusal above is about the missing RATE and not about
      // Ohio.
      const plainOhio = await usEmployee(fx, "Plain Ohio Pat", { state: "OH" });

      const { run, result } = await runPayroll(fx);

      assert.equal(await stubOf(fx, run.documentId, connecticut), null);
      const ctRefusal = result.errors.find((error) => error.employee === "Hartford Hank");
      assert.ok(ctRefusal);
      assert.match(ctRefusal!.message, /AL income tax withholding is not implemented/);
      assert.match(ctRefusal!.message, /Implemented: AZ, CA, CO, CT, DE, GA, IL, IN, IA, KY, MD, MA, MI, MN, NJ, NY, NC, OH, OR, PA, UT, VA, WV, WI/);

      assert.equal(await stubOf(fx, run.documentId, ohio), null);
      const ohRefusal = result.errors.find((error) => error.employee === "Westerville Wes");
      assert.ok(ohRefusal, "the municipality refuses rather than withholding zero");
      assert.match(ohRefusal!.message, /no income tax rate has been entered for WESTERVILLE/);
      assert.match(ohRefusal!.message, /us_oh_municipal/);

      const ohioStub = await stubOf(fx, run.documentId, plainOhio);
      assert.ok(ohioStub, "an Ohio employee outside every municipality is paid");
      assert.ok(ohioStub!.factors.SIT_OH);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* --------------------------------------------------------------------- */
/* Canada must not move                                                   */
/* --------------------------------------------------------------------- */

test(
  "the CA pack's new declarations change no Canadian withholding",
  { skip: !DB },
  async () => {
    // The state work adds `certificates` and `withholding` to the CA pack. Both
    // are DECLARATIONS: the Canadian arm of `runStatutoryPass` does not consult
    // the resolution at all, and the TD1 family still reads from the profile
    // columns it always did. This asserts the mapping resolves to the same
    // answers the T4127 engine is given, which is the property that keeps the
    // 18 T4127 and 19 TP-1015 goldens where they are.
    const td1 = payrollCertificate("CA", "ca_td1");
    assert.equal(td1.storage, "profile_columns");
    const resolved = resolveCertificate({
      certificate: td1,
      profile: { federal_claim_code: 1, additional_tax_per_period: "25.0000", cpp_exempt: true },
    });
    assert.equal(resolved.answers.federal_claim_code, "1");
    assert.equal(resolved.answers.additional_tax_per_period, "25.0000");
    assert.equal(resolved.answers.cpp_exempt, "true");
    // An untouched profile does not look like a signed TD1.
    assert.equal(resolveCertificate({ certificate: td1, profile: {} }).onFile, false);
    // Québec's provincial form is TP-1015.3-V, not "TD1QC" — a product that
    // calls it the wrong thing cannot help anybody fill it in.
    assert.equal(payrollCertificate("CA", "ca_td1_QC").form, "TP-1015.3-V");
    assert.equal(payrollCertificate("CA", "ca_td1_ON").form, "TD1ON");
  },
);
