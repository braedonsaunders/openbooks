/**
 * Kentucky withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from 42A003 (TCF)(10-2025),
 * "2026 KENTUCKY WITHHOLDING TAX FORMULA", or is the formula's own
 * arithmetic on its own printed numbers. Nothing here was produced by
 * running the engine and pasting the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { KY_CERTIFICATE, KY_REGION } from "./ky-declaration.ts";
import { KY_RATES_2026, KY_WITHHOLDING } from "./ky.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: KY_CERTIFICATE,
    stored: [{ certificateKey: KY_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("KY certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(KY_CERTIFICATE), null);
  assert.equal(KY_REGION.implemented, true);
  assert.equal(KY_REGION.certificateKey, "us_ky_k4");
});

test("KY 42A003 monthly example — $3,270: $104.65", () => {
  // "Payroll Frequency: monthly  Wages: $3,270
  //  1. Compute annual wages: $3,270 × 12 = $39,240
  //  2. Compute Kentucky taxable wages: $39,240 − $3,360 = $35,880
  //  3. Compute gross annual Kentucky tax: $35,880 × 3.5% = $1,255.80
  //  4. Compute Kentucky withholding tax for tax period: $1,255.80 ÷ 12 = 104.65"
  const result = KY_WITHHOLDING.compute({
    payDate: "2026-03-31", periodsPerYear: 12, wages: "3270.00", basis: "resident",
    certificate: cert(),
  });
  assert.equal(result.factors.KY_ANNUAL_WAGES, money("39240"));
  assert.equal(result.factors.KY_TAXABLE, money("35880"));
  assert.equal(result.factors.KY_ANNUAL_TAX, money("1255.80"));
  assert.equal(result.tax, money("104.65"));
});

test("KY 3.5% and $3,360 are the publication's own figures — a 4% / $3,000 guess fails", () => {
  assert.equal(KY_RATES_2026.rate, pctToRate("3.5"));
  assert.equal(KY_RATES_2026.standardDeduction, "3360");
  assert.notEqual(KY_RATES_2026.rate, pctToRate("4"));
  assert.notEqual(KY_RATES_2026.standardDeduction, "3000");
  assert.equal(D(mulRateCents(U("35880"), "0.035")), money("1255.80"));
  assert.notEqual(D(mulRateCents(U("35880"), "0.04")), money("1255.80"));
});

test("KY 42A003 bi-weekly example's own arithmetic is $47.98, not the printed $47", () => {
  // A defect in the publication, quantified rather than matched.
  //
  // Step 2 prints $39,000 − $3,360 = $35,640. Step 3 then says
  // "$35,730 × 3.5% = $1,247.40". $35,640 × 3.5% is $1,247.40; $35,730 × 3.5%
  // is $1,250.55. The tax figure is the step-2 wage, the $35,730 is a typo.
  // $1,247.40 ÷ 26 = $47.9769…, which the formula to the cent prints as $47.98.
  // The publication prints "$47".
  const result = KY_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 26, wages: "1500.00", basis: "resident",
    certificate: cert(),
  });
  assert.equal(result.factors.KY_ANNUAL_WAGES, money("39000"));
  assert.equal(result.factors.KY_TAXABLE, money("35640"));
  assert.equal(result.factors.KY_ANNUAL_TAX, money("1247.40"));
  assert.equal(result.tax, money("47.98"));
  assert.notEqual(result.tax, money("47"));
});

test("KY extra withholding is added AFTER the 3.5% rate", () => {
  const result = KY_WITHHOLDING.compute({
    payDate: "2026-03-31", periodsPerYear: 12, wages: "3270.00", basis: "resident",
    certificate: cert({ additional_per_period: "10.00" }),
  });
  assert.equal(result.tax, money("114.65"));
});

test("KY K-4 exemption stops withholding", () => {
  const result = KY_WITHHOLDING.compute({
    payDate: "2026-03-31", periodsPerYear: 12, wages: "3270.00", basis: "resident",
    certificate: cert({ exempt: "true" }),
  });
  assert.equal(result.tax, money("0"));
});

test("KY refuses a year it has not transcribed", () => {
  assert.throws(
    () => KY_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 12, wages: "3270",
      basis: "resident", certificate: cert(),
    }),
    /2027 Kentucky income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
