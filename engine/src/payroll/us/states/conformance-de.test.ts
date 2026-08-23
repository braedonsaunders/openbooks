/**
 * Delaware withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the Division of Revenue
 * Employer's Guide Section 17 examples and Tax Computation Table, or is
 * those figures' own arithmetic. Nothing here was produced by running the
 * engine and pasting the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, divIntCents, mulRateCents, U } from "../../canada/decimal.ts";
import {
  DE_CERTIFICATE, DE_REGION, DE_RATES_2026, DE_WITHHOLDING, deAnnualPeriods, deAnnualTax,
  deStandardDeduction,
} from "./de.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: DE_CERTIFICATE,
    stored: [{ certificateKey: DE_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("DE certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(DE_CERTIFICATE), null);
  assert.equal(DE_REGION.implemented, true);
  assert.equal(DE_REGION.certificateKey, "us_de_sdw4a");
  assert.equal(DE_REGION.subRegions.length, 0);
});

test("DE printed percents and addends are the table's own figures", () => {
  assert.equal(pctToRate("5.20"), "0.0520");
  assert.equal(pctToRate("6.60"), "0.0660");
  assert.notEqual(pctToRate("6.60"), pctToRate("6.75"));
  assert.equal(D(U("741") + mulRateCents(U("1750"), pctToRate("5.20"))), money("832"));
  assert.equal(D(U("261") + mulRateCents(U("8500"), pctToRate("4.80"))), money("669"));
  assert.equal(deAnnualTax(U("21750")), U("832"));
  assert.equal(deAnnualTax(U("18500")), U("669"));
  assert.equal(deAnnualTax(U("60000")), U("2943.50"));
  assert.equal(deStandardDeduction("single", DE_RATES_2026), U("3250"));
  assert.equal(deStandardDeduction("married_joint", DE_RATES_2026), U("6500"));
  assert.equal(deStandardDeduction("married_separate", DE_RATES_2026), U("3250"));
  assert.equal(deAnnualPeriods(365, DE_RATES_2026.dailyPeriods), 300);
  assert.equal(deAnnualPeriods(52, DE_RATES_2026.dailyPeriods), 52);
});

test("DE Section 17 single taxpayer — 1 allowance, $25,000", () => {
  // "Tax on $21,750.00 ($741.00 + $91.00 [$1,750.00 x 5.20%])" = $832
  // minus $110 = $722. Weekly $13.88, bi-weekly $27.77, semi-monthly $30.08,
  // monthly $60.17. $25,000 does not divide evenly by 52, so the example is
  // pinned on the annual $25,000 path plus the publication's own ÷ P lines.
  const annual = DE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 1, wages: "25000.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "1" }),
  });
  assert.equal(annual.factors.DE_ANNUAL_WAGES, money("25000"));
  assert.equal(annual.factors.DE_STANDARD_DEDUCTION, money("3250"));
  assert.equal(annual.factors.DE_TAXABLE, money("21750"));
  assert.equal(annual.factors.DE_ANNUAL_TAX, money("832"));
  assert.equal(annual.factors.DE_EXEMPTION_CREDIT, money("110"));
  assert.equal(annual.factors.DE_AFTER_CREDIT, money("722"));
  assert.equal(annual.tax, money("722"));
  assert.equal(D(divIntCents(U("722"), 52)), money("13.88"));
  assert.equal(D(divIntCents(U("722"), 26)), money("27.77"));
  assert.equal(D(divIntCents(U("722"), 24)), money("30.08"));
  assert.equal(D(divIntCents(U("722"), 12)), money("60.17"));
});

test("DE Section 17 married filing jointly — 3 allowances, $25,000", () => {
  const annual = DE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 1, wages: "25000.00",
    basis: "resident",
    certificate: cert({ filing_status: "married_joint", allowances: "3" }),
  });
  assert.equal(annual.factors.DE_STANDARD_DEDUCTION, money("6500"));
  assert.equal(annual.factors.DE_TAXABLE, money("18500"));
  assert.equal(annual.factors.DE_ANNUAL_TAX, money("669"));
  assert.equal(annual.factors.DE_EXEMPTION_CREDIT, money("330"));
  assert.equal(annual.factors.DE_AFTER_CREDIT, money("339"));
  assert.equal(annual.tax, money("339"));
  assert.equal(D(divIntCents(U("339"), 52)), money("6.52"));
  assert.equal(D(divIntCents(U("339"), 26)), money("13.04"));
  assert.equal(D(divIntCents(U("339"), 24)), money("14.13"));
  assert.equal(D(divIntCents(U("339"), 12)), money("28.25"));
});

test("DE Section 17 married filing separately — 2 allowances, $25,000", () => {
  const annual = DE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 1, wages: "25000.00",
    basis: "resident",
    certificate: cert({ filing_status: "married_separate", allowances: "2" }),
  });
  assert.equal(annual.factors.DE_STANDARD_DEDUCTION, money("3250"));
  assert.equal(annual.factors.DE_TAXABLE, money("21750"));
  assert.equal(annual.factors.DE_ANNUAL_TAX, money("832"));
  assert.equal(annual.factors.DE_EXEMPTION_CREDIT, money("220"));
  assert.equal(annual.factors.DE_AFTER_CREDIT, money("612"));
  assert.equal(annual.tax, money("612"));
  assert.equal(D(divIntCents(U("612"), 52)), money("11.77"));
  assert.equal(D(divIntCents(U("612"), 26)), money("23.54"));
  assert.equal(D(divIntCents(U("612"), 24)), money("25.50"));
  assert.equal(D(divIntCents(U("612"), 12)), money("51.00"));
});

test("DE no certificate withholds as single with zero allowances", () => {
  const empty = DE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 1, wages: "25000.00",
    basis: "resident",
    certificate: resolveCertificate({ certificate: DE_CERTIFICATE }),
  });
  const singleZero = DE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 1, wages: "25000.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "0" }),
  });
  assert.equal(empty.tax, singleZero.tax);
  assert.equal(empty.factors.DE_EXEMPTION_CREDIT, money("0"));
  assert.equal(empty.tax, money("832"));
});

test("DE extra withholding is added and exempt is zero", () => {
  const extra = DE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 1, wages: "25000.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "1", additional_per_period: "10.00" }),
  });
  assert.equal(extra.tax, money("732"));
  assert.equal(DE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
});

test("DE supplemental paid with regular wages is aggregated", () => {
  const aggregated = DE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2000.00", supplemental: "500.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "1" }),
  });
  const together = DE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2500.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "1" }),
  });
  assert.equal(aggregated.tax, together.tax);
  assert.equal(aggregated.taxSupplemental, money("0"));
});

test("DE refuses a year it has not transcribed", () => {
  assert.throws(
    () => DE_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /2027 Delaware income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
