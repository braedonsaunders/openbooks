/**
 * Idaho withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the July 23 2026 percentage table
 * or from Computing Withholding's own worked example on that edition.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { certificateDeclarationProblem, type ResolvedCertificate } from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  ID_CERTIFICATE, ID_REGION, ID_RATES_2026_07_23, ID_THRESHOLDS_2026_07_23, ID_WITHHOLDING,
  idPeriodTax, idRoundToDollar,
} from "./id.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(ID_CERTIFICATE, answers);

test("ID certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(ID_CERTIFICATE), null);
  assert.equal(ID_REGION.implemented, true);
  assert.equal(ID_REGION.certificateKey, "us_id_idw4");
});

test("ID printed 5.3% and the Computing Withholding $593 remainder", () => {
  assert.equal(pctToRate("5.3"), "0.053");
  // $1,212 − $619 = $593. $593 × 5.3% = $31.429, nearest dollar $31.
  assert.equal(D(mulRateCents(U("593"), pctToRate("5.3"))), money("31.43"));
  assert.equal(idRoundToDollar(mulRateCents(U("593"), pctToRate("5.3"))), U("31"));
  assert.equal(
    idPeriodTax(U("1212"), "biweekly", false, ID_RATES_2026_07_23),
    U("31"),
  );
  assert.equal(ID_THRESHOLDS_2026_07_23.biweekly.single, "619");
});

test("ID Computing Withholding example — $1,212 biweekly, unmarried, 4 allowances: $31", () => {
  // Official example after the child-tax-credit sunset: ICTCAT $0 × 4 = $0.
  // Subject wages $1,212. 5.3% of the amount over $619. Tax to withhold $31.
  const result = ID_WITHHOLDING.compute({
    payDate: "2026-08-15", periodsPerYear: 26, wages: "1212.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "4" }),
  });
  assert.equal(result.factors.ID_WAGES, money("1212"));
  assert.equal(result.factors.ID_ALLOWANCES, money("0"));
  assert.equal(result.factors.ID_TAXABLE, money("1212"));
  assert.equal(result.factors.ID_THRESHOLD, money("619"));
  assert.equal(result.tax, money("31"));
});

test("ID four allowances still subtract zero after the sunset", () => {
  const four = ID_WITHHOLDING.compute({
    payDate: "2026-08-15", periodsPerYear: 26, wages: "1212.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "4" }),
  });
  const zero = ID_WITHHOLDING.compute({
    payDate: "2026-08-15", periodsPerYear: 26, wages: "1212.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "0" }),
  });
  assert.equal(four.tax, zero.tax);
  assert.equal(four.factors.ID_ALLOWANCES, money("0"));
});

test("ID extra withholding is added and exempt is zero", () => {
  assert.equal(ID_WITHHOLDING.compute({
    payDate: "2026-08-15", periodsPerYear: 26, wages: "1212.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "4", additional_per_period: "5.00" }),
  }).tax, money("36"));
  assert.equal(ID_WITHHOLDING.compute({
    payDate: "2026-08-15", periodsPerYear: 26, wages: "1212.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
});

test("ID refuses a pre-sunset 2026 pay date and an untranscribed year", () => {
  assert.throws(
    () => ID_WITHHOLDING.compute({
      payDate: "2026-04-15", periodsPerYear: 26, wages: "1212",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /pay dates before 2026-07-23 is not loaded.*Never apply the July 23 2026/s,
  );
  assert.throws(
    () => ID_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 26, wages: "1212",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /2027 Idaho income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
