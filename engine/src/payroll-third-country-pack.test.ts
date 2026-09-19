import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPayrollRegionSupported,
  packStatutoryComponents,
  PAYROLL_COUNTRY_PACKS,
  packRates,
  payrollCountry,
  payrollPack,
  payrollTaxYearSupport,
  resolveEmployeePayrollContext,
  resolvePayrollRunContext,
  statutoryAssessment,
  type PayrollCountryPack,
  type PayrollRunContext,
} from "./payroll/packs.ts";
import { declaredPayrollFilings } from "./payroll-filing-registry.ts";

/**
 * A third country pack is expressible: declaring it in the registry is the
 * whole channel, and every refusal names the country instead of answering
 * with a neighbour's numbers.
 *
 * The GB fixture below is NOT a pack — its engine is a stub, its regions are
 * illustrative, and it is removed from the registry by every test that adds
 * it. What it proves is structural: under the old `PayrollCountry =
 * "CA" | "US"` union this file does not compile (`country: "GB"` is not
 * assignable), and under the open registry every generic surface either
 * serves the pack from its own declaration or refuses it by name.
 */

function fixturePack(): PayrollCountryPack {
  return {
    country: "GB",
    name: "United Kingdom",
    // A new pack cannot forget the identifier: it is REQUIRED on
    // PayrollCountryPack, so this fixture states its (illustrative) answer.
    employeeIdentifier: {
      label: "Fixture identifier",
      pattern: "\\d{6}",
      formatHelp: "6 digits",
      example: "123456",
      requiredForPayroll: true,
      neededFor: null,
      citation: "test fixture — no authority",
      numericEntry: true,
    },
    installable: true,
    statutorySlots: [],
    remittanceVendorSettingsKey: null,
    // Placeholder, not a transcription: the fixture has no engine, so no
    // retro treatment is implemented or asserted anywhere.
    retroactivePayTreatment: "periodic",
    contributoryBases: {
      pensionable: "fixture qualifying earnings",
      insurable: "fixture insurable earnings",
    },
    employeeUnionDuesTaxTreatment: null,
    statutoryCurrency: "GBP",
    // HMRC-shaped year (opens 6 April, named for the opening year) so the
    // run-context assertions exercise a non-calendar definition.
    taxYear: { basis: "fiscal", startMonth: 4, startDay: 6, namedBy: "opening_year" },
    regions: {
      label: "nation",
      known: ["ENG", "SCT", "WLS", "NIR"],
      supported: ["ENG"],
      unsupportedReason: "income tax withholding for {region} is not implemented by the GB fixture pack",
    },
    jurisdictions: [],
    filings: () => ({ country: "GB", programTypes: [], yearEnd: [] }),
    statutoryRates: { country: "GB", slots: [] },
    taxYears: {
      country: "GB",
      editions: [],
      regionsWithOwnTables: [],
      ratesModule: "fixture",
      scaffold: { files: [], barrels: [], steps: [] },
    },
    certificates: () => ({ country: "GB", certificates: [] }),
    withholding: () => ({ country: "GB", regions: [] }),
    computeStatutory: async (): Promise<Record<string, string>> => ({}),
    statutoryEngineLabel: "Fixture",
  };
}

/** Insert the fixture, run the body, and always remove it again. */
async function withFixture(body: (pack: PayrollCountryPack) => void | Promise<void>): Promise<void> {
  const pack = fixturePack();
  PAYROLL_COUNTRY_PACKS["GB"] = pack;
  try {
    await body(pack);
  } finally {
    delete PAYROLL_COUNTRY_PACKS["GB"];
  }
}

test("a declared third pack resolves through the registry, not a union", async () => {
  await withFixture((pack) => {
    assert.equal(payrollPack("GB"), pack);
    assert.equal(payrollCountry("GB"), "GB");
  });
});

test("installability is the pack's own declaration", async () => {
  const { installablePayrollCountries } = await import("./payroll/packs.ts");
  await withFixture(() => {
    assert.ok(installablePayrollCountries().includes("GB"));
  });
  assert.ok(!installablePayrollCountries().includes("GB"));
});

test("the pack's own declarations arrive with it — rates, tax years, filings", async () => {
  await withFixture((pack) => {
    assert.equal(packRates("GB"), pack.statutoryRates);
    assert.equal(payrollTaxYearSupport("GB"), pack.taxYears);
    assert.ok(declaredPayrollFilings().some((declared) => declared.country === "GB"));
  });
});

test("an empty pack is an honest empty state, not somebody's home country", async () => {
  await withFixture(() => {
    assert.deepEqual(packStatutoryComponents("GB"), []);
    assert.throws(
      () => statutoryAssessment("GB", "income_tax", "deduction"),
      /the GB payroll pack does not declare/,
    );
  });
});

test("the run context resolves for the third country, on its own tax year", async () => {
  await withFixture(() => {
    const subsidiary = { id: "sub-gb", name: "GB Ltd", country: "GB", baseCurrency: "GBP" };
    const before = resolvePayrollRunContext({ payDate: "2026-04-05", subsidiary });
    assert.equal(before.country, "GB");
    assert.equal(before.taxYear, 2025);
    const opening = resolvePayrollRunContext({ payDate: "2026-04-06", subsidiary });
    assert.equal(opening.taxYear, 2026);
  });
});

test("a currency the pack's engine does not compute in refuses, naming both", async () => {
  await withFixture(() => {
    assert.throws(
      () => resolvePayrollRunContext({
        payDate: "2026-04-06",
        subsidiary: { id: "sub-gb", name: "GB Ltd", country: "GB", baseCurrency: "USD" },
      }),
      /GBP.*USD|USD.*GBP/,
    );
  });
});

test("regions refuse by name — never a neighbour's withholding", async () => {
  await withFixture(() => {
    assertPayrollRegionSupported("GB", "ENG");
    assert.throws(() => assertPayrollRegionSupported("GB", "SCT"), /SCT/);
    assert.throws(() => assertPayrollRegionSupported("GB", "ON"), /unknown GB nation/);
  });
});

test("the employee half of the chain agrees per country, or refuses both sides", async () => {
  await withFixture(() => {
    const run: PayrollRunContext = {
      country: "GB",
      subsidiaryId: "sub-gb",
      subsidiaryName: "GB Ltd",
      currency: "GBP",
      taxYear: 2026,
      payDate: "2026-04-06",
    };
    const employee = {
      partyId: "emp-gb",
      name: "Gb Employee",
      country: "GB",
      region: "ENG",
    };
    assert.equal(resolveEmployeePayrollContext({ run, employee }).country, "GB");
    assert.throws(
      () => resolveEmployeePayrollContext({
        run,
        employee: { ...employee, partyId: "emp-ca", name: "Ca Employee", country: "CA" },
      }),
      /CA.*GB|GB.*CA/,
    );
  });
});

test("countries with no pack still refuse, naming what exists", async () => {
  assert.throws(() => payrollPack("XX"), /no payroll country pack for XX/);
  assert.throws(() => payrollCountry(null), /no payroll country pack/);
  assert.throws(() => packRates("XX"), /declares no statutory rate slots/);
  assert.throws(() => payrollTaxYearSupport("XX"), /declares no statutory tax years/);
});

test("the fixture leaves no pack behind for other tests", () => {
  assert.throws(() => payrollPack("GB"), /no payroll country pack for GB/);
});
