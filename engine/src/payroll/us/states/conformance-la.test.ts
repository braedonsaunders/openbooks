/**
 * Louisiana withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from R-1306 (1/26) Examples 1–2 or is
 * that publication's own arithmetic on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, divIntCents, mulRateCents, U } from "../../canada/decimal.ts";
import {
  LA_CERTIFICATE, LA_REGION, LA_RATES_2026, LA_WITHHOLDING, laDeductionPerPeriod, laPeriodTax,
} from "./la.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: LA_CERTIFICATE,
    stored: [{ certificateKey: LA_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("LA certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(LA_CERTIFICATE), null);
  assert.equal(LA_REGION.implemented, true);
  assert.equal(LA_REGION.certificateKey, "us_la_l4");
});

test("LA printed 3.09% and R-1306's own 12,875/52 and 25,750/26", () => {
  assert.equal(pctToRate("3.09"), "0.0309");
  // Example 1: 12,875/52 = 247.60. Example 2: 25,750/26 = 990.38.
  assert.equal(D(divIntCents(U("12875"), 52)), money("247.60"));
  assert.equal(D(divIntCents(U("25750"), 26)), money("990.38"));
  assert.equal(laDeductionPerPeriod("1", 52, LA_RATES_2026), U("247.60"));
  assert.equal(laDeductionPerPeriod("2", 26, LA_RATES_2026), U("990.38"));
  assert.equal(D(mulRateCents(U("452.40"), pctToRate("3.09"))), money("13.98"));
  assert.equal(D(mulRateCents(U("3609.62"), pctToRate("3.09"))), money("111.54"));
  assert.equal(laPeriodTax(U("700"), "1", 52, LA_RATES_2026), U("13.98"));
  assert.equal(laPeriodTax(U("4600"), "2", 26, LA_RATES_2026), U("111.54"));
});

test("LA R-1306 Example 1 — $700 weekly, Block A = 1: $13.98", () => {
  // W = (700 − (12,875/52)) × 0.0309 = (700 − 247.60) × 0.0309 = 13.98.
  const result = LA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00",
    basis: "resident", certificate: cert({ standard_deduction: "1" }),
  });
  assert.equal(result.factors.LA_WAGES, money("700"));
  assert.equal(result.factors.LA_DEDUCTION, money("247.60"));
  assert.equal(result.factors.LA_TAXABLE, money("452.40"));
  assert.equal(result.tax, money("13.98"));
});

test("LA R-1306 Example 2 — $4,600 biweekly, Block A = 2: $111.54", () => {
  // W = (4,600 − (25,750/26)) × 0.0309 = (4,600 − 990.38) × 0.0309 = 111.54.
  const result = LA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 26, wages: "4600.00",
    basis: "resident", certificate: cert({ standard_deduction: "2" }),
  });
  assert.equal(result.factors.LA_WAGES, money("4600"));
  assert.equal(result.factors.LA_DEDUCTION, money("990.38"));
  assert.equal(result.factors.LA_TAXABLE, money("3609.62"));
  assert.equal(result.tax, money("111.54"));
});

test("LA no L-4 withholds with no standard deduction", () => {
  const empty = LA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00",
    basis: "resident", certificate: resolveCertificate({ certificate: LA_CERTIFICATE }),
  });
  const none = LA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00",
    basis: "resident", certificate: cert({ standard_deduction: "0" }),
  });
  assert.equal(empty.tax, none.tax);
  assert.equal(empty.factors.LA_DEDUCTION, money("0"));
  // Formula 1: W = 700 × 0.0309 = 21.63.
  assert.equal(empty.tax, money("21.63"));
});

test("LA extra withholding is added", () => {
  assert.equal(LA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00",
    basis: "resident",
    certificate: cert({ standard_deduction: "1", additional_per_period: "5.00" }),
  }).tax, money("18.98"));
});

test("LA refuses a year it has not transcribed", () => {
  assert.throws(
    () => LA_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "700",
      basis: "resident", certificate: cert({ standard_deduction: "1" }),
    }),
    /2027 Louisiana income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
