/**
 * Indiana withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from Departmental Notice #1
 * (R46 / 01-26) or is the notice's own arithmetic on its own printed
 * numbers. Nothing here was produced by running the engine and pasting
 * the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { IN_CERTIFICATE, IN_REGION } from "./in-declaration.ts";
import {
  IN_COUNTIES_2026, IN_RATES_2026, IN_WITHHOLDING,
  inApplicableCounty, inCounty, inCountyWithholding, inPeriodTaxable,
} from "./in.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: IN_CERTIFICATE,
    stored: [{ certificateKey: IN_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

const EXAMPLE_EXEMPTIONS = {
  personal: 5,
  additionalDependent: 3,
  firstTimeDependent: 1,
  adoptedDependent: 2,
};

test("IN certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(IN_CERTIFICATE), null);
  assert.equal(IN_REGION.implemented, true);
  assert.equal(IN_REGION.certificateKey, "us_in_wh4");
  assert.equal(IN_REGION.subRegions.length, 92);
});

test("IN Departmental Notice #1 weekly example — $800, five/three/one/two exemptions: $13.96", () => {
  // p. 3: "An employee is paid a weekly salary of $800; he/she claims five
  // personal exemptions and is subject to county tax at the rate of 0.01.
  // He/she claims three additional dependent exemptions, one first-time
  // additional dependent exemption, and two adopted child dependent
  // exemptions. The taxable income of $473.08 …
  //   Deduction Constant from Table A                         $96.15
  //   Deduction Constant from Table B (additional dependent)  +86.54
  //   Deduction Constant from Table B (first-time)            +28.85
  //   Deduction Constant from Table C (adopted dependent)    +115.38
  //   Total Deduction Constant                               $326.92
  //   Gross Income                                           $800.00
  //   Taxable Income                                         $473.08
  //   State Tax to Withhold   $473.08 × .0295 = $13.96
  //   County Tax to Withhold  $473.08 × .01   =  $4.73"
  const result = IN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: cert({
      personal_exemptions: "5",
      additional_dependent_exemptions: "3",
      first_time_dependent_exemptions: "1",
      adopted_dependent_exemptions: "2",
    }),
  });
  assert.equal(result.factors.IN_PERIOD_EXEMPTION, money("326.92"));
  assert.equal(result.factors.IN_TAXABLE, money("473.08"));
  assert.equal(result.tax, money("13.96"));

  const harrison = inCounty(2026, "31");
  assert.equal(harrison.rate, "0.01");
  const county = inCountyWithholding({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00",
    exemptions: EXAMPLE_EXEMPTIONS, county: harrison,
  });
  assert.equal(county.tax, money("4.73"));
});

test("IN 2.95% is the notice's own percent — a 3.00% guess fails the example", () => {
  assert.equal(IN_RATES_2026.rate, pctToRate("2.95"));
  assert.notEqual(IN_RATES_2026.rate, pctToRate("3"));
  assert.equal(D(mulRateCents(U("473.08"), "0.0295")), money("13.96"));
  assert.notEqual(D(mulRateCents(U("473.08"), "0.03")), money("13.96"));
});

test("IN Table A/B/C weekly constants are $1,000 / $1,500 / $3,000 ÷ 52", () => {
  const personal = inPeriodTaxable({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00",
    exemptions: { personal: 5, additionalDependent: 0, firstTimeDependent: 0, adoptedDependent: 0 },
  });
  assert.equal(personal.factors.IN_PERIOD_EXEMPTION, money("96.15"));

  const additional = inPeriodTaxable({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00",
    exemptions: { personal: 0, additionalDependent: 3, firstTimeDependent: 0, adoptedDependent: 0 },
  });
  assert.equal(additional.factors.IN_PERIOD_EXEMPTION, money("86.54"));

  const firstTime = inPeriodTaxable({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00",
    exemptions: { personal: 0, additionalDependent: 0, firstTimeDependent: 1, adoptedDependent: 0 },
  });
  assert.equal(firstTime.factors.IN_PERIOD_EXEMPTION, money("28.85"));

  const adopted = inPeriodTaxable({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00",
    exemptions: { personal: 0, additionalDependent: 0, firstTimeDependent: 0, adoptedDependent: 2 },
  });
  assert.equal(adopted.factors.IN_PERIOD_EXEMPTION, money("115.38"));
});

test("IN publishes all 92 counties, and six of them changed after 1 Oct 2025", () => {
  assert.equal(IN_COUNTIES_2026.length, 92);
  assert.equal(new Set(IN_COUNTIES_2026.map((c) => c.code)).size, 92);
  assert.equal(IN_COUNTIES_2026.filter((c) => c.changedSinceOct2025).length, 6);
  // High-precision rates that a rounded guess would miss.
  assert.equal(inCounty(2026, "07").rate, "0.025234"); // Brown
  assert.equal(inCounty(2026, "08").rate, "0.024733"); // Carroll *
  assert.equal(inCounty(2026, "37").rate, "0.02864"); // Jasper
  assert.equal(inCounty(2026, "92").rate, "0.016829"); // Whitley
  assert.equal(inCounty(2026, "64").rate, "0.005"); // Porter — the lowest
  assert.equal(inCounty(2026, "68").rate, "0.03"); // Randolph — the highest
});

test("an unknown Indiana county code is refused, and a blank county withholds nothing", () => {
  assert.throws(() => inCounty(2026, "99"), /not an Indiana county code/);
  assert.equal(inApplicableCounty("2026-03-06", "NA", null), null);
  assert.equal(inApplicableCounty("2026-03-06", "not applicable", ""), null);
  assert.equal(inApplicableCounty("2026-03-06", null, null), null);
  // Out-of-state January-1 resident working in Marion County.
  assert.equal(inApplicableCounty("2026-03-06", "NA", "49")?.code, "49");
  // In-state resident: residence county wins even when a work county is set.
  assert.equal(inApplicableCounty("2026-03-06", "31", "49")?.code, "31");
});

test("IN extra state withholding is added AFTER the 2.95% rate", () => {
  const result = IN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: cert({
      personal_exemptions: "5",
      additional_dependent_exemptions: "3",
      first_time_dependent_exemptions: "1",
      adopted_dependent_exemptions: "2",
      additional_state_per_period: "10.00",
    }),
  });
  assert.equal(result.tax, money("23.96"));
});

test("IN with no WH-4 withholds on the entire wage at 2.95% — zero exemptions", () => {
  const result = IN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: resolveCertificate({ certificate: IN_CERTIFICATE }),
  });
  assert.equal(result.factors.IN_PERIOD_EXEMPTION, money("0"));
  assert.equal(result.tax, money("23.60"));
});

test("IN bonus / supplemental is taxed at 2.95% with no exemptions", () => {
  const result = IN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", supplemental: "200.00",
    basis: "resident",
    certificate: cert({ personal_exemptions: "5" }),
  });
  // Periodic: ($800 − $96.15) × 2.95% = $20.76; bonus $200 × 2.95% = $5.90.
  assert.equal(result.taxSupplemental, money("5.90"));
  assert.equal(result.tax, money("26.66"));
});

test("IN refuses a year it has not transcribed", () => {
  assert.throws(
    () => IN_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "800",
      basis: "resident", certificate: cert(),
    }),
    /2027 Indiana income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
