import assert from "node:assert/strict";
import test from "node:test";
import { capAnnualEarnings, type T4Slip } from "./payroll-yearend.ts";
import { renderT4Xml } from "./payroll-t4xml.ts";
import {
  assertPayrollRegionSupported,
  payrollCountry,
  payrollRegionSupported,
  payrollTaxYear,
  PAYROLL_COUNTRY_PACKS,
  PayrollJurisdictionError,
  resolveEmployeePayrollContext,
  resolvePayrollRunContext,
  taxYearFor,
  type PayrollRunContext,
  type PayrollTaxYearDefinition,
} from "./payroll/packs.ts";

/**
 * Multi-country correctness.
 *
 * The product claims to run a mixed CA/US tenant. It did — silently and
 * wrongly: the country pack boundary was real for statutory ACCOUNT SLOTS and
 * for almost nothing else, and Canada was the `else` arm, the default and the
 * fallthrough everywhere else. Every test here names the specific wrong money
 * or wrong filing it prevents, and every one was written to FAIL against the
 * code as it stood.
 *
 * These are pure: the whole point of the change is that the jurisdiction chain
 * is decided by declarations, so it can be proven without a database.
 */

/* ------------------------------------------------------------------ */
/* The chain: employee ⟹ subsidiary ⟹ currency ⟹ filing account        */
/* ------------------------------------------------------------------ */

const CA_ENTITY = {
  id: "sub-ca", name: "Acme Canada Ltd", country: "CA", baseCurrency: "CAD",
};
const US_ENTITY = {
  id: "sub-us", name: "Acme US Inc", country: "US", baseCurrency: "USD",
};

const caRun = (): PayrollRunContext =>
  resolvePayrollRunContext({ payDate: "2026-07-21", subsidiary: CA_ENTITY });
const usRun = (): PayrollRunContext =>
  resolvePayrollRunContext({ payDate: "2026-07-21", subsidiary: US_ENTITY });

test("the run's country comes from the paying legal entity, not from an employee", () => {
  // subsidiaries.country has existed all along and no payroll module read it.
  assert.equal(caRun().country, "CA");
  assert.equal(caRun().currency, "CAD");
  assert.equal(usRun().country, "US");
  assert.equal(usRun().currency, "USD");
  assert.equal(usRun().subsidiaryName, "Acme US Inc");
});

test("an entity whose functional currency is not its pack's statutory currency is refused", () => {
  // T4127 returns CAD and Pub 15-T returns USD — neither takes a currency
  // argument. A USD-denominated Canadian run files USD numbers on a CRA
  // return, and every GL leg balances perfectly while doing it.
  assert.throws(
    () => resolvePayrollRunContext({
      payDate: "2026-07-21",
      subsidiary: { ...CA_ENTITY, baseCurrency: "USD" },
    }),
    (error: unknown) =>
      error instanceof PayrollJurisdictionError
      && /statutory engine computes in CAD.*functional currency is USD/s.test(error.message),
  );
});

test("a run document denominated differently from its own entity is refused", () => {
  assert.throws(
    () => resolvePayrollRunContext({
      payDate: "2026-07-21", subsidiary: CA_ENTITY, runCurrency: "USD",
    }),
    /denominated in USD but its Acme Canada Ltd entity's functional currency is CAD/,
  );
});

test("an entity in a country with no payroll pack is refused, not defaulted to Canada", () => {
  assert.throws(
    () => resolvePayrollRunContext({
      payDate: "2026-07-21",
      subsidiary: { id: "sub-gb", name: "Acme UK Ltd", country: "GB", baseCurrency: "GBP" },
    }),
    (error: unknown) =>
      error instanceof PayrollJurisdictionError
      && /Acme UK Ltd.*registered in GB.*no payroll country pack for GB/s.test(error.message),
  );
});

/* ------------------------------------------------------------------ */
/* Defect 2 — the employee's country was never reconciled with the      */
/*            subsidiary's                                              */
/* ------------------------------------------------------------------ */

test("a CA-profile employee paid by a US entity is REFUSED, never silently withheld CPP/EI", () => {
  // This is the exact shape a green integration test used to bless: an
  // employee in a country='US'/USD subsidiary, with the profile country left
  // to its 'CA' default, calculated with no errors — i.e. Canadian CPP, EI and
  // Ontario income tax withheld from an employee of a US legal entity, filed
  // under a CRA program account, in the wrong currency.
  assert.throws(
    () => resolveEmployeePayrollContext({
      run: usRun(),
      employee: { partyId: "e1", name: "Scoped Sam", country: "CA", region: "ON" },
    }),
    (error: unknown) =>
      error instanceof PayrollJurisdictionError
      && /Scoped Sam:/.test(error.message)
      && /on the CA country pack, but this run pays from Acme US Inc, a US legal entity/
        .test(error.message),
  );
});

test("a correctly configured US employee of a US entity resolves cleanly", () => {
  const resolved = resolveEmployeePayrollContext({
    run: usRun(),
    employee: {
      partyId: "e1", name: "Scoped Sam", country: "US", region: "TX",
      subsidiaryId: "sub-us", subsidiaryCountry: "US",
      filingAccountId: "fa-1", filingAccountCountry: "US", filingAccountNumber: "12-3456789",
    },
  });
  assert.equal(resolved.country, "US");
  assert.equal(resolved.region, "TX");
  assert.equal(resolved.currency, "USD");
  assert.equal(resolved.taxYear, 2026);
  assert.equal(resolved.filingAccountId, "fa-1");
});

test("an employee of a different legal entity than the run pays from is refused", () => {
  // An ORG-WIDE pay schedule pays across subsidiaries. That is how a US-entity
  // employee ended up on a Canadian run with nothing complaining.
  assert.throws(
    () => resolveEmployeePayrollContext({
      run: caRun(),
      employee: {
        partyId: "e2", name: "Cross Chris", country: "CA", region: "ON",
        subsidiaryId: "sub-us", subsidiaryCountry: "US",
      },
    }),
    /belong to a US legal entity but this run pays from Acme Canada Ltd \(CA\)/,
  );
});

test("a CRA program account on a US employee is refused — a filing account is a tax authority", () => {
  assert.throws(
    () => resolveEmployeePayrollContext({
      run: usRun(),
      employee: {
        partyId: "e3", name: "Misfiled Morgan", country: "US", region: "TX",
        filingAccountId: "fa-ca", filingAccountCountry: "CA",
        filingAccountNumber: "999999999RP0001",
      },
    }),
    /999999999RP0001 is a CA account, which cannot file a US return/,
  );
});

test("every broken link in the chain is reported at once, not one refusal per attempt", () => {
  try {
    resolveEmployeePayrollContext({
      run: usRun(),
      employee: {
        // The region is checked against the employee's OWN declared country —
        // 'TX' is not a province, so all four links break at once.
        partyId: "e4", name: "Tangled Terry", country: "CA", region: "TX",
        subsidiaryId: "sub-ca", subsidiaryCountry: "CA",
        filingAccountId: "fa-ca", filingAccountCountry: "CA", filingAccountNumber: "RP0001",
      },
    });
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof PayrollJurisdictionError);
    const message = error.message;
    assert.match(message, /^Tangled Terry: /);
    assert.match(message, /on the CA country pack/);
    assert.match(message, /belong to a CA legal entity/);
    assert.match(message, /cannot file a US return/);
    assert.match(message, /unknown CA province "TX"/);
  }
});

/* ------------------------------------------------------------------ */
/* Refuse rather than approximate: the regions a pack cannot withhold   */
/* ------------------------------------------------------------------ */

test("Quebec is refused by the CA pack, naming the provincial tax AND the RL-1", () => {
  // T4127 covers only the FEDERAL side of Quebec employment. A QC employee
  // calculated by this pack was under-withheld by an entire provincial income
  // tax (TP-1015.3, Revenu Québec) and issued no RL-1 — and nothing said so,
  // because the CA arm was never asked the question the US arm has always
  // been asked about an unsupported state.
  assert.equal(payrollRegionSupported("CA", "QC"), false);
  assert.throws(
    () => assertPayrollRegionSupported("CA", "QC"),
    (error: unknown) =>
      error instanceof PayrollJurisdictionError
      && /TP-1015\.3.*RL-1.*Revenu Québec/s.test(error.message),
  );
});

test("the provinces T4127 does implement are supported, including ZZ", () => {
  for (const province of ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "SK", "YT", "ZZ"]) {
    assert.doesNotThrow(() => assertPayrollRegionSupported("CA", province), province);
  }
});

test("the US pack still refuses a withholding state, and an unknown one differently", () => {
  // Preserved behaviour — this was the good precedent the CA pack now follows.
  assert.throws(
    () => assertPayrollRegionSupported("US", "CA"),
    /state income tax withholding for CA is not yet supported/,
  );
  assert.throws(
    () => assertPayrollRegionSupported("US", "ON"),
    /unknown US state "ON" on the payroll profile/,
  );
  assert.equal(
    PAYROLL_COUNTRY_PACKS.US!.regions.supported.length, 9,
    "wave-1 coverage is the nine no-withholding states",
  );
});

test("a missing region is refused, never defaulted to Ontario", () => {
  // `province ?? "ON"` withheld Ontario provincial tax from an employee whose
  // jurisdiction nobody had recorded.
  assert.throws(
    () => assertPayrollRegionSupported("CA", ""),
    /unknown CA province "\(unset\)" on the payroll profile/,
  );
});

test("an unknown country string is a refusal, not a cast to Canada", () => {
  // `emp.country === "US" ? "US" : "CA"` turned every unrecognised value into
  // Canada — including a country whose pack was never written.
  assert.equal(payrollCountry("US"), "US");
  assert.equal(payrollCountry("CA"), "CA");
  for (const value of ["GB", "", null, undefined, "ca", "USA"]) {
    assert.throws(() => payrollCountry(value), PayrollJurisdictionError, String(value));
  }
});

/* ------------------------------------------------------------------ */
/* Defect 7 — the tax year is the PACK's answer                        */
/* ------------------------------------------------------------------ */

test("both current packs declare a calendar tax year — as a declaration, not a hardcode", () => {
  for (const country of ["CA", "US"] as const) {
    assert.equal(PAYROLL_COUNTRY_PACKS[country]!.taxYear.basis, "calendar");
    assert.equal(payrollTaxYear(country, "2026-01-01"), 2026);
    assert.equal(payrollTaxYear(country, "2026-12-31"), 2026);
    assert.equal(payrollTaxYear(country, "2027-01-01"), 2027);
  }
});

test("the tax-year mechanism handles a non-calendar year, so the declaration is real", () => {
  // Neither current pack exercises this, which is exactly why it is tested
  // directly: a "declaration" that only ever answers `payDate.slice(0, 4)` is
  // indistinguishable from the hardcode it replaced.
  const hmrc: PayrollTaxYearDefinition = {
    basis: "fiscal", startMonth: 4, startDay: 6, namedBy: "opening_year",
  };
  assert.equal(taxYearFor(hmrc, "2026-04-05"), 2025); // last day of 2025/26
  assert.equal(taxYearFor(hmrc, "2026-04-06"), 2026); // first day of 2026/27
  assert.equal(taxYearFor(hmrc, "2026-12-31"), 2026);
  assert.equal(taxYearFor(hmrc, "2027-01-01"), 2026); // still 2026/27

  const ato: PayrollTaxYearDefinition = {
    basis: "fiscal", startMonth: 7, startDay: 1, namedBy: "closing_year",
  };
  assert.equal(taxYearFor(ato, "2026-06-30"), 2026); // last day of 2025/26
  assert.equal(taxYearFor(ato, "2026-07-01"), 2027); // first day of 2026/27
});

/* ------------------------------------------------------------------ */
/* Defect 3 — a mid-year province move is two slips, capped once       */
/* ------------------------------------------------------------------ */

test("annual T4 maxima are consumed across an employee's slips, not applied to each", () => {
  // `max(province)` collapsed the year to one lexically-largest province, so
  // BC→ON and ON→BC both filed as 'ON'. The CRA wants a slip per province of
  // employment — but boxes 24 and 26 are capped PER EMPLOYEE per year, so
  // capping each slip independently would report up to N × the maximum.
  const caps = { mie: "68900", yampe: "85000" };
  const capped = capAnnualEarnings(
    [
      { employeePartyId: "mover", insurable: "50000", pensionable: "60000" },
      { employeePartyId: "mover", insurable: "40000", pensionable: "50000" },
      { employeePartyId: "stayer", insurable: "90000", pensionable: "90000" },
    ],
    caps,
  );
  // First slip fills first; the second gets only the room that is left.
  assert.equal(capped[0]!.box24EiInsurable, "50000");
  assert.equal(capped[1]!.box24EiInsurable, "18900.0000"); // 68,900 − 50,000
  assert.equal(capped[0]!.box26CppPensionable, "60000");
  assert.equal(capped[1]!.box26CppPensionable, "25000.0000"); // 85,000 − 60,000
  // …and an unrelated employee's room is their own.
  assert.equal(capped[2]!.box24EiInsurable, "68900");
  assert.equal(capped[2]!.box26CppPensionable, "85000");
});

test("a single-province employee is capped exactly as before", () => {
  const capped = capAnnualEarnings(
    [{ employeePartyId: "solo", insurable: "90000", pensionable: "90000" }],
    { mie: "68900", yampe: "85000" },
  );
  assert.equal(capped[0]!.box24EiInsurable, "68900");
  assert.equal(capped[0]!.box26CppPensionable, "85000");
});

/* ------------------------------------------------------------------ */
/* Defect 4 — Quebec was computed and then discarded                   */
/* ------------------------------------------------------------------ */

const TRANSMITTER = {
  bn: "999999999RP0001", transmitterNumber: "MM555555", name: "Acme Ltd",
  contactName: "Pat Payroll", contactEmail: "pat@acme.test", contactPhone: "5555550100",
};

const slip = (over: Partial<T4Slip> = {}): T4Slip & { sin: string } => ({
  employeePartyId: "e1", employeeName: "Jean Tremblay", province: "ON", isQuebec: false,
  filingAccountId: null,
  box14EmploymentIncome: "50000", box16Cpp: "3500", box16aCpp2: "200", box18Ei: "900",
  box22IncomeTax: "8000", box24EiInsurable: "50000", box26CppPensionable: "50000",
  box44UnionDues: "0", box55Qpip: "0", box56QpipInsurable: "0", stubCount: 26,
  sin: "046454286",
  ...over,
});

const t4 = (slips: (T4Slip & { sin: string })[]): string => renderT4Xml({
  orgId: "11111111-2222-3333-4444-555555555555",
  taxYear: 2026,
  transmitter: TRANSMITTER,
  returns: [{
    filingAccount: { id: null, accountNumber: null, name: null, remitterType: null },
    slips,
    summary: {
      slips: slips.length, employmentIncome: "50000", employeeCpp: "3500", employeeCpp2: "200",
      employerCpp: "3500", employeeEi: "900", employerEi: "1260", incomeTax: "8000",
      remitted: "0",
    },
  }],
});

test("a Quebec slip files QPP in the QPP box, not the CPP box", () => {
  // Box 16 (CPP) and box 17 (QPP) are mutually exclusive. Reporting a QC
  // employee's contribution as CPP tells the CRA they paid into a plan they
  // are not in, and leaves a hole in the QPP record Retraite Québec keeps.
  const xml = t4([slip({
    province: "QC", isQuebec: true, box55Qpip: "442.90", box56QpipInsurable: "103000",
  })]);
  assert.match(xml, /<QPP_CNTRB_AMT>3500\.00<\/QPP_CNTRB_AMT>/);
  assert.doesNotMatch(xml, /<CPP_CNTRB_AMT>/);
  assert.match(xml, /<EMPT_PROV_CD>QC<\/EMPT_PROV_CD>/);
});

test("a Quebec slip carries QPIP premiums and insurable earnings (boxes 55 and 56)", () => {
  // `box55Qpip` was computed by the year-end builder and appeared ZERO times
  // in the XML builder: the premium simply vanished between the two.
  const xml = t4([slip({
    province: "QC", isQuebec: true, box55Qpip: "442.90", box56QpipInsurable: "103000",
  })]);
  assert.match(xml, /<PPIP_AMT>442\.90<\/PPIP_AMT>/);
  assert.match(xml, /<PPIP_ERN_AMT>103000\.00<\/PPIP_ERN_AMT>/);
});

test("a non-Quebec slip is unchanged: CPP box, and no QPIP elements at all", () => {
  const xml = t4([slip()]);
  assert.match(xml, /<CPP_CNTRB_AMT>3500\.00<\/CPP_CNTRB_AMT>/);
  assert.doesNotMatch(xml, /<QPP_CNTRB_AMT>/);
  // Absent, not a zero the CRA would have to interpret.
  assert.doesNotMatch(xml, /PPIP/);
});
