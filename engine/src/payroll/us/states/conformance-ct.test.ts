/**
 * Connecticut withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from Informational Publication 2026(1),
 * Circular CT (Issued 12/12/2025), or TPG-211 (Rev. 12/25) Tables A–E, or is
 * those publications' own arithmetic on their own printed numbers. Nothing
 * here was produced by running the engine and pasting the answer.
 *
 * Circular CT Examples 8–10 are wage-bracket TABLE cells. TPG-211 says to use
 * either the tables or the calculation rules; they do not agree to the cent.
 * The engine is the calculation rules. The table cells are pinned as
 * `notEqual` so nobody "fixes" the engine against the other official method.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  CT_CERTIFICATE, CT_REGION, CT_RATES_2026, CT_WITHHOLDING, ctInitialTax, ctPersonalCredit,
  ctPersonalExemption, ctPhaseOutAddBack, ctTaxRecapture,
} from "./ct.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: CT_CERTIFICATE,
    stored: [{ certificateKey: CT_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("CT certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(CT_CERTIFICATE), null);
  assert.equal(CT_REGION.implemented, true);
  assert.equal(CT_REGION.certificateKey, "us_ct_ctw4");
  assert.equal(CT_REGION.residentWithholding, "required_net_of_credit");
  assert.equal(CT_REGION.residentWithholdingImplemented, false);
  assert.equal(CT_CERTIFICATE.storage, "certificate_rows");
  for (const field of CT_CERTIFICATE.fields) {
    assert.ok(field.help.length > 20, `${field.key} help is too thin`);
  }
});

test("CT Table A printed exemptions — first band and the $1,000 step", () => {
  // TPG-211 Table A, first ceiling and last $1,000 band before "and up".
  assert.equal(ctPersonalExemption("A", U("24000")), U("12000"));
  assert.equal(ctPersonalExemption("A", U("24000.01")), U("11000"));
  assert.equal(ctPersonalExemption("A", U("35000")), U("1000"));
  assert.equal(ctPersonalExemption("A", U("35000.01")), U("0"));
  assert.equal(ctPersonalExemption("B", U("38000")), U("19000"));
  assert.equal(ctPersonalExemption("B", U("56000")), U("1000"));
  assert.equal(ctPersonalExemption("B", U("56000.01")), U("0"));
  assert.equal(ctPersonalExemption("C", U("48000")), U("24000"));
  assert.equal(ctPersonalExemption("C", U("71000")), U("1000"));
  assert.equal(ctPersonalExemption("F", U("30000")), U("15000"));
  assert.equal(ctPersonalExemption("F", U("44000")), U("1000"));
  assert.equal(ctPersonalExemption("D", U("10000")), U("0"));
  assert.equal(ctPersonalExemption("D", U("999999")), U("0"));
});

test("CT Table B addends and printed percents are the publication's own figures", () => {
  // TPG-211 Table B, Code A/D/F: $200 + 4.5% of excess over $10,000 at $50,000.
  assert.equal(ctInitialTax("A", U("10000")), U("200"));
  assert.equal(ctInitialTax("A", U("50000")), U("2000"));
  assert.equal(ctInitialTax("A", U("100000")), U("4750"));
  assert.equal(D(U("200") + mulRateCents(U("40000"), pctToRate("4.5"))), money("2000"));
  assert.equal(D(U("2000") + mulRateCents(U("50000"), pctToRate("5.5"))), money("4750"));
  assert.equal(ctInitialTax("B", U("16000")), U("320"));
  assert.equal(ctInitialTax("C", U("20000")), U("400"));
  assert.equal(CT_RATES_2026.noCertificateRate, pctToRate("6.99"));
  assert.equal(pctToRate("6.99"), "0.0699");
  assert.notEqual(pctToRate("6.99"), pctToRate("7"));
});

test("CT Table C printed phase-out add-backs", () => {
  assert.equal(ctPhaseOutAddBack("A", U("50250")), U("0"));
  assert.equal(ctPhaseOutAddBack("A", U("50250.01")), U("25"));
  assert.equal(ctPhaseOutAddBack("A", U("72750")), U("225"));
  assert.equal(ctPhaseOutAddBack("A", U("72750.01")), U("250"));
  assert.equal(ctPhaseOutAddBack("B", U("78500")), U("0"));
  assert.equal(ctPhaseOutAddBack("B", U("114500.01")), U("400"));
  assert.equal(ctPhaseOutAddBack("C", U("145500.01")), U("500"));
  assert.equal(ctPhaseOutAddBack("F", U("56500.01")), U("25"));
});

test("CT Table D printed recapture amounts", () => {
  assert.equal(ctTaxRecapture("A", U("105000")), U("0"));
  assert.equal(ctTaxRecapture("A", U("105000.01")), U("25"));
  assert.equal(ctTaxRecapture("A", U("150000")), U("225"));
  assert.equal(ctTaxRecapture("A", U("150000.01")), U("250"));
  assert.equal(ctTaxRecapture("A", U("200000.01")), U("340"));
  assert.equal(ctTaxRecapture("A", U("345000")), U("2860"));
  assert.equal(ctTaxRecapture("A", U("345000.01")), U("2950"));
  assert.equal(ctTaxRecapture("A", U("540000.01")), U("3400"));
  assert.equal(ctTaxRecapture("B", U("168000.01")), U("40"));
  assert.equal(ctTaxRecapture("B", U("320000.01")), U("540"));
  assert.equal(ctTaxRecapture("C", U("210000.01")), U("50"));
  assert.equal(ctTaxRecapture("C", U("400000.01")), U("680"));
});

test("CT Table E printed personal tax credits — Step 12 is 1.00 minus the decimal", () => {
  assert.equal(ctPersonalCredit("A", U("12000")), "0.00");
  assert.equal(ctPersonalCredit("A", U("12000.01")), "0.75");
  assert.equal(ctPersonalCredit("A", U("52000")), "0.02");
  assert.equal(ctPersonalCredit("A", U("52000.01")), "0.01");
  assert.equal(ctPersonalCredit("A", U("52500.01")), "0.00");
  assert.equal(ctPersonalCredit("D", U("20000")), "0.00");
  assert.equal(ctPersonalCredit("F", U("15000.01")), "0.75");
  assert.equal(ctPersonalCredit("B", U("19000.01")), "0.75");
  // TPG-211 Step 12: "Example: 1.00 - .15 = .85."
  assert.equal(D(U("1") - U("0.15")), money("0.85"));
});

test("CT no completed CT-W4 withholds 6.99% with no exemption", () => {
  // Circular CT p. 11: "If an employee fails to give you a completed Form
  // CT-W4, you must withhold at a flat rate of 6.99%, without allowance for
  // exemption." 6.99% of $1,000.00 = $69.90.
  const result = CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: resolveCertificate({ certificate: CT_CERTIFICATE }),
  });
  assert.equal(result.tax, money("69.90"));
  assert.equal(result.factors.CT_NO_CERTIFICATE, "1");
  assert.equal(D(mulRateCents(U("1000"), pctToRate("6.99"))), money("69.90"));
});

test("CT-W4 Code E stops withholding", () => {
  assert.equal(CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({ withholding_code: "E" }),
  }).tax, money("0"));
});

test("CT Circular CT Example 8 — weekly $700 Code F is the calculation rules, not $17.65", () => {
  // Example 8 (wage-bracket tables): "$700 per week … Withholding Code F …
  //  $17.65 × .60 = $10.59" after a CT-W4NA 60% allocation.
  // Calculation rules on the same $700 / Code F (no CT-W4NA):
  //   Annualized $36,400. Table A Code F $36,000–$37,000 → exemption $8,000.
  //   Taxable $28,400. Table B: $200 + 4.5% of $18,400 = $1,028.
  //   Tables C and D: $0. Table E: $33,300–$60,000 → 0.10.
  //   $1,028 × 0.90 = $925.20 ÷ 52 = $17.79.
  const result = CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "700.00", basis: "nonresident",
    certificate: cert({ withholding_code: "F" }),
  });
  assert.equal(result.factors.CT_ANNUAL_WAGES, money("36400"));
  assert.equal(result.factors.CT_EXEMPTION, money("8000"));
  assert.equal(result.factors.CT_TAXABLE, money("28400"));
  assert.equal(result.factors.CT_INITIAL_TAX, money("1028"));
  assert.equal(result.factors.CT_CREDIT, "0.10");
  assert.equal(result.factors.CT_AFTER_CREDIT, money("925.20"));
  assert.equal(result.tax, money("17.79"));
  assert.notEqual(result.tax, money("17.65"));
  // The 60% CT-W4NA step is refused — no silent 60% of either figure.
  assert.notEqual(result.tax, money("10.59"));
});

test("CT Circular CT Example 9 — weekly $1,000 Code A is the calculation rules, not $39.97", () => {
  // Example 9 (wage-bracket tables): "$1,000 per week … Code A …
  //  the employer would withhold $39.97 per week".
  // Calculation rules:
  //   Annualized $52,000. Table A Code A $35,000 and up → exemption $0.
  //   Table B: $2,000 + 5.5% of $2,000 = $2,110.
  //   Table C: more than $50,250 ≤ $52,750 → $25.
  //   Table D: ≤ $105,000 → $0.
  //   Table E: more than $51,500 ≤ $52,000 → 0.02.
  //   ($2,110 + $25) × 0.98 = $2,092.30 ÷ 52 = $40.24.
  const result = CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({ withholding_code: "A" }),
  });
  assert.equal(result.factors.CT_ANNUAL_WAGES, money("52000"));
  assert.equal(result.factors.CT_EXEMPTION, money("0"));
  assert.equal(result.factors.CT_INITIAL_TAX, money("2110"));
  assert.equal(result.factors.CT_PHASE_OUT, money("25"));
  assert.equal(result.factors.CT_RECAPTURE, money("0"));
  assert.equal(result.factors.CT_CREDIT, "0.02");
  assert.equal(result.factors.CT_AFTER_CREDIT, money("2092.30"));
  assert.equal(result.tax, money("40.24"));
  assert.notEqual(result.tax, money("39.97"));
});

test("CT Circular CT Example 10 — biweekly $2,300 Code B is the calculation rules, not $78.82", () => {
  // Example 10 (wage-bracket tables): "$2,300 biweekly … Code B …
  //  The employer withholds $78.82".
  // Calculation rules:
  //   Annualized $59,800. Table A Code B $56,000 and up → exemption $0.
  //   Table B: $320 + 4.5% of $43,800 = $2,291.
  //   Tables C and D: $0. Table E: $46,000–$74,000 → 0.10.
  //   $2,291 × 0.90 = $2,061.90 ÷ 26 = $79.30.
  const result = CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 26, wages: "2300.00", basis: "nonresident",
    certificate: cert({ withholding_code: "B" }),
  });
  assert.equal(result.factors.CT_ANNUAL_WAGES, money("59800"));
  assert.equal(result.factors.CT_EXEMPTION, money("0"));
  assert.equal(result.factors.CT_INITIAL_TAX, money("2291"));
  assert.equal(result.factors.CT_CREDIT, "0.10");
  assert.equal(result.factors.CT_AFTER_CREDIT, money("2061.90"));
  assert.equal(result.tax, money("79.30"));
  assert.notEqual(result.tax, money("78.82"));
});

test("CT extra withholding is added and reduced withholding is subtracted", () => {
  // TPG-211 Steps 14–16 on Example 9's $40.24 calculation-rules result.
  const extra = CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({ withholding_code: "A", additional_per_period: "10.00" }),
  });
  assert.equal(extra.tax, money("50.24"));
  const reduced = CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({ withholding_code: "A", reduced_per_period: "100.00" }),
  });
  assert.equal(reduced.tax, money("0"));
});

test("CT supplemental paid with regular wages is aggregated, not a flat 6.99%", () => {
  // Circular CT Example 11: paid in the same check, "the total of the
  // regular pay plus the overtime" is one payment. Example 12's separately-
  // paid recompute is not applied — the engine is not given last-period tax.
  const aggregated = CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00", supplemental: "200.00",
    basis: "resident", certificate: cert({ withholding_code: "A" }),
  });
  const together = CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1200.00",
    basis: "resident", certificate: cert({ withholding_code: "A" }),
  });
  assert.equal(aggregated.tax, together.tax);
  assert.equal(aggregated.taxSupplemental, money("0"));
  assert.notEqual(aggregated.tax, D(mulRateCents(U("200"), pctToRate("6.99"))));
});

test("CT refuses a year it has not transcribed", () => {
  assert.throws(
    () => CT_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000",
      basis: "resident", certificate: cert({ withholding_code: "A" }),
    }),
    /2027 Connecticut income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
