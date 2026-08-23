/**
 * Alabama withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the August 2024 ALDOR booklet
 * formula and its official M-2 / $850 weekly example, or is that example's
 * own arithmetic. Nothing here was produced by running the engine and
 * pasting the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  AL_CERTIFICATE, AL_REGION, AL_RATES_2026, AL_WITHHOLDING, alAnnualTax, alDependentAllowance,
  alPersonalExemption, alStandardDeduction, alSupplementalFlat,
} from "./al.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: AL_CERTIFICATE,
    stored: [{ certificateKey: AL_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("AL certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(AL_CERTIFICATE), null);
  assert.equal(AL_REGION.implemented, true);
  assert.equal(AL_REGION.certificateKey, "us_al_a4");
});

test("AL printed standard-deduction phase-out and personal exemptions", () => {
  assert.equal(alStandardDeduction("S", U("25999")), U("3000"));
  assert.equal(alStandardDeduction("S", U("26000")), U("2975"));
  assert.equal(alStandardDeduction("S", U("35500")), U("2500"));
  assert.equal(alStandardDeduction("M", U("25999")), U("8500"));
  assert.equal(alStandardDeduction("M", U("44200")), U("5000"));
  assert.equal(alStandardDeduction("H", U("25999")), U("5200"));
  assert.equal(alStandardDeduction("MS", U("12999")), U("4250"));
  assert.equal(alStandardDeduction("MS", U("17750")), U("2500"));
  assert.equal(alPersonalExemption("0"), U("0"));
  assert.equal(alPersonalExemption("S"), U("1500"));
  assert.equal(alPersonalExemption("M"), U("3000"));
  assert.equal(alDependentAllowance(U("44200"), 2), U("2000"));
  assert.equal(alDependentAllowance(U("50000"), 1), U("1000"));
  assert.equal(alDependentAllowance(U("50000.01"), 1), U("500"));
  assert.equal(alDependentAllowance(U("100000.01"), 1), U("300"));
});

test("AL printed percents and M-bracket addends", () => {
  assert.equal(pctToRate("5"), "0.05");
  assert.equal(D(mulRateCents(U("26370"), pctToRate("5"))), money("1318.50"));
  assert.equal(alAnnualTax("M", U("32370")), U("1538.50"));
  assert.equal(alAnnualTax("S", U("3000")), U("110"));
  assert.equal(AL_RATES_2026.supplementalRate, pctToRate("5"));
  assert.equal(alSupplementalFlat("200.00"), money("10"));
});

test("AL official example — M-2, $850 weekly, FIT $35.19: $29.59", () => {
  // Booklet: $850 × 52 = $44,200. SD $5,000. "M" $3,000. 2 × $1,000.
  // FIT printed as $35.19 × 52 = $1,830.00; 35.19 × 52 is $1,829.88.
  // Period tax is $29.59 either way. The engine annualizes FIT exactly.
  const result = AL_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "850.00",
    basis: "resident",
    certificate: cert({
      exemption: "M", dependents: "2", federal_income_tax_withheld: "35.19",
    }),
  });
  assert.equal(result.factors.AL_GI, money("44200"));
  assert.equal(result.factors.AL_STANDARD_DEDUCTION, money("5000"));
  assert.equal(result.factors.AL_FEDERAL_ANNUAL, money("1829.88"));
  assert.equal(result.factors.AL_PERSONAL_EXEMPTION, money("3000"));
  assert.equal(result.factors.AL_DEPENDENTS, money("2000"));
  assert.equal(result.tax, money("29.59"));
  assert.notEqual(result.factors.AL_FEDERAL_ANNUAL, money("1830"));
});

test("AL no A-4 withholds as zero exemptions", () => {
  const empty = AL_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "850.00",
    basis: "resident",
    certificate: resolveCertificate({
      certificate: AL_CERTIFICATE,
      stored: [{
        certificateKey: AL_CERTIFICATE.key,
        answers: { federal_income_tax_withheld: "35.19" },
        effectiveFrom: null,
      }],
    }),
  });
  const zero = AL_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "850.00",
    basis: "resident",
    certificate: cert({ exemption: "0", dependents: "0", federal_income_tax_withheld: "35.19" }),
  });
  assert.equal(empty.tax, zero.tax);
  assert.equal(empty.factors.AL_PERSONAL_EXEMPTION, money("0"));
});

test("AL refuses without this period's federal income tax withheld", () => {
  assert.throws(
    () => AL_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 52, wages: "850.00",
      basis: "resident", certificate: cert({ exemption: "M" }),
    }),
    /federal income tax withheld/,
  );
});

test("AL supplemental paid with regular wages is aggregated, not a silent 5%", () => {
  const aggregated = AL_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "850.00", supplemental: "200.00",
    basis: "resident",
    certificate: cert({ exemption: "M", dependents: "2", federal_income_tax_withheld: "35.19" }),
  });
  const together = AL_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1050.00",
    basis: "resident",
    certificate: cert({ exemption: "M", dependents: "2", federal_income_tax_withheld: "35.19" }),
  });
  assert.equal(aggregated.tax, together.tax);
  assert.equal(aggregated.taxSupplemental, money("0"));
  assert.notEqual(aggregated.tax, alSupplementalFlat("200.00"));
});

test("AL refuses a year it has not transcribed", () => {
  assert.throws(
    () => AL_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "850",
      basis: "resident",
      certificate: cert({ exemption: "M", federal_income_tax_withheld: "0" }),
    }),
    /2027 Alabama income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
