/**
 * Colorado DR 1098 goldens.
 *
 * Every expected figure is the worksheet's own arithmetic on the digits the
 * 11/14/23 PDF prints (4.40%, $10,000 / $5,000). DR 1098 publishes no worked
 * dollar example, so these are labelled substitutes — the same honesty
 * conformance-tranche2.test.ts uses for Ohio and Michigan.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedCertificate } from "../../certificates.ts";
import { CO_CERTIFICATE, CO_RATES_2026, CO_WITHHOLDING } from "./co.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(CO_CERTIFICATE, answers);

test("CO DR 1098 — weekly $1,000, otherwise status, no DR 0004 allowance: $39.77", () => {
  // 1c $52,000 − 2a $5,000 = $47,000 × 4.40% = $2,068.00 ÷ 52 = $39.7692… → $39.77
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert({ filing_status: "other" }),
  });
  assert.equal(result.tax, money("39.77"));
  assert.equal(result.factors.CO_ANNUAL_ALLOWANCE, money("5000"));
  assert.equal(result.year, CO_RATES_2026.year);
});

test("CO DR 1098 — weekly $1,000, married filing jointly default: $35.54", () => {
  // 1c $52,000 − 2a $10,000 = $42,000 × 4.40% = $1,848.00 ÷ 52 = $35.5384… → $35.54
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert({ filing_status: "married_joint" }),
  });
  assert.equal(result.tax, money("35.54"));
  assert.equal(result.factors.CO_ANNUAL_ALLOWANCE, money("10000"));
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
  assert.equal(result.tax, money("64.77"));
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
    /2027 Colorado income tax withholding tables are not loaded/,
  );
});
