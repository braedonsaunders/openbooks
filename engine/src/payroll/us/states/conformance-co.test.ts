/**
 * Colorado DR 1098 goldens.
 *
 * Source: Colorado Department of Revenue, DR 1098 (rev. 10/21/25),
 * https://tax.colorado.gov/sites/tax/files/documents/DR_1098_Colorado_Withholding_Worksheet_for_Employees.pdf
 * It prescribes the 2026 allowance amounts and 4.40% rate but gives no worked
 * dollar example, so expected values below are independent worksheet arithmetic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedCertificate } from "../../certificates.ts";
import { CO_CERTIFICATE, CO_RATES_2026, CO_WITHHOLDING } from "./co.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(CO_CERTIFICATE, answers);

test("CO DR 1098 — 2026 weekly $1,000, otherwise status, no DR 0004 allowance: $39.35", () => {
  // Official 2026 DR 1098: $52,000 − $5,500 = $46,500 × 4.40% = $2,046 ÷ 52 = $39.346… → $39.35.
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert({ filing_status: "other" }),
  });
  assert.equal(result.tax, money("39.35"));
  assert.equal(result.factors.CO_ANNUAL_ALLOWANCE, money("5500"));
  assert.equal(result.year, CO_RATES_2026.year);
});

test("CO DR 1098 — 2026 weekly $1,000, married filing jointly default: $34.69", () => {
  // Official 2026 DR 1098: $52,000 − $11,000 = $41,000 × 4.40% = $1,804 ÷ 52 = $34.692… → $34.69.
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert({ filing_status: "married_joint" }),
  });
  assert.equal(result.tax, money("34.69"));
  assert.equal(result.factors.CO_ANNUAL_ALLOWANCE, money("11000"));
});

test("CO DR 1098 — DR 0004 line 2 overrides the W-4 default", () => {
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert({ filing_status: "married_joint", annual_allowance: "0" }),
  });
  // $52,000 × 4.40% = $2,288.00 ÷ 52 = $44.00
  assert.equal(result.tax, money("44.00"));
  assert.equal(result.factors.CO_ANNUAL_ALLOWANCE, money("0"));
});

test("CO DR 1098 — extra withholding is added after the rate", () => {
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert({ filing_status: "other", additional_per_period: "25" }),
  });
  assert.equal(result.tax, money("64.35"));
});

test("CO refuses a year the posted worksheet has not been loaded for", () => {
  assert.throws(
    () => CO_WITHHOLDING.compute({
      payDate: "2027-01-08",
      periodsPerYear: 52,
      wages: "1000.00",
      basis: "resident",
      certificate: cert(),
    }),
    /2027 Colorado income tax withholding tables are not available in this pack version.*update the pack/,
  );
});
