/**
 * Connecticut withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from TPG-211 (Rev. 12/25) Tables A–E
 * or is the calculation rules' own arithmetic on those printed numbers.
 * Nothing here was produced by running the engine and pasting the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { CT_CERTIFICATE, CT_REGION } from "./ct-declaration.ts";
import {
  CT_RATES_2026, CT_WITHHOLDING,
  ctInitialTax, ctPersonalCredit, ctPersonalExemption, ctPhaseOutAddBack, ctTaxRecapture,
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
});

test("CT Table A printed exemptions — first band and the $1,000 step", () => {
  assert.equal(ctPersonalExemption("A", U("24000")), U("12000"));
  assert.equal(ctPersonalExemption("A", U("24000.01")), U("11000"));
  assert.equal(ctPersonalExemption("A", U("35000")), U("1000"));
  assert.equal(ctPersonalExemption("A", U("35000.01")), U("0"));
  assert.equal(ctPersonalExemption("B", U("38000")), U("19000"));
  assert.equal(ctPersonalExemption("B", U("56000")), U("1000"));
  assert.equal(ctPersonalExemption("C", U("48000")), U("24000"));
  assert.equal(ctPersonalExemption("C", U("71000")), U("1000"));
  assert.equal(ctPersonalExemption("F", U("30000")), U("15000"));
  assert.equal(ctPersonalExemption("F", U("44000")), U("1000"));
  assert.equal(ctPersonalExemption("D", U("10000")), U("0"));
  assert.equal(ctPersonalExemption("D", U("999999")), U("0"));
});

test("CT Table B addends are the publication's own figures", () => {
  assert.equal(ctInitialTax("A", U("10000")), U("200"));
  assert.equal(ctInitialTax("A", U("50000")), U("2000"));
  assert.equal(ctInitialTax("A", U("100000")), U("4750"));
  assert.equal(D(U("200") + mulRateCents(U("40000"), pctToRate("4.5"))), money("2000"));
  assert.equal(ctInitialTax("B", U("16000")), U("320"));
  assert.equal(ctInitialTax("C", U("20000")), U("400"));
  assert.equal(CT_RATES_2026.noCertificateRate, pctToRate("6.99"));
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

test("CT Table E printed personal tax credits", () => {
  assert.equal(ctPersonalCredit("A", U("12000")), "0.00");
  assert.equal(ctPersonalCredit("A", U("12000.01")), "0.75");
  assert.equal(ctPersonalCredit("A", U("52000")), "0.02");
  assert.equal(ctPersonalCredit("A", U("52000.01")), "0.01");
  assert.equal(ctPersonalCredit("A", U("52500.01")), "0.00");
  assert.equal(ctPersonalCredit("D", U("20000")), "0.00");
  assert.equal(ctPersonalCredit("F", U("15000.01")), "0.75");
  assert.equal(ctPersonalCredit("B", U("19000.01")), "0.75");
});

test("CT no completed CT-W4 withholds 6.99% with no exemption", () => {
  const result = CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: resolveCertificate({ certificate: CT_CERTIFICATE }),
  });
  assert.equal(result.tax, money("69.90"));
  assert.equal(result.factors.CT_NO_CERTIFICATE, "1");
});

test("CT-W4 Code E stops withholding", () => {
  assert.equal(CT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({ withholding_code: "E" }),
  }).tax, money("0"));
});

test("CT TPG-211 weekly $1,000 Code A — calculation rules, not the table", () => {
  // Annualized salary $52,000. Table A Code A: $35,000 and up → exemption $0.
  // Table B: $2,000 + 5.5% of $2,000 = $2,110.
  // Table C: more than $50,250 ≤ $52,750 → $25.
  // Table D: ≤ $105,000 → $0.
  // Table E: more than $51,500 ≤ $52,000 → 0.02.
  // ($2,110 + $25) × 0.98 ÷ 52.
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
  // Circular CT Example 9 prints the wage-bracket table's $39.97 on these
  // facts. TPG-211 says to use either the tables or these rules — they are
  // not the same method and must not be collapsed.
  assert.notEqual(result.tax, money("39.97"));
});

test("CT extra withholding is added and reduced withholding is subtracted", () => {
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

test("CT refuses a year it has not transcribed", () => {
  assert.throws(
    () => CT_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000",
      basis: "resident", certificate: cert({ withholding_code: "A" }),
    }),
    /2027/,
  );
});
