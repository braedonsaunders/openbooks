/**
 * Rhode Island withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the 2026 Employer's Income Tax
 * Withholding Tables or is that publication's own arithmetic on its own
 * printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { RI_CERTIFICATE, RI_REGION } from "./ri-declaration.ts";
import { RI_WITHHOLDING, riPeriodTax } from "./ri.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: RI_CERTIFICATE,
    stored: [{ certificateKey: RI_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("RI certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(RI_CERTIFICATE), null);
  assert.equal(RI_REGION.implemented, true);
  assert.equal(RI_REGION.certificateKey, "us_ri_riw4");
});

test("RI printed percents and the booklet's $597.77 remainder", () => {
  assert.equal(pctToRate("3.75"), "0.0375");
  assert.equal(pctToRate("4.75"), "0.0475");
  assert.equal(pctToRate("5.99"), "0.0599");
  // Official example remainder: $597.77 × 4.75% = $28.39; + $59.18 = $87.57.
  assert.equal(D(mulRateCents(U("597.77"), pctToRate("4.75"))), money("28.39"));
  assert.equal(riPeriodTax(U("2175.77"), "weekly"), U("87.57"));
});

test("RI booklet example — $2,195 weekly, 1 exemption: $87.57", () => {
  // $2,195.00 − $19.23 = $2,175.77.
  // Second weekly bracket: $59.18 + 4.75% of $597.77 = $87.57.
  const result = RI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00",
    basis: "resident", certificate: cert({ allowances: "1" }),
  });
  assert.equal(result.factors.RI_WAGES, money("2195"));
  assert.equal(result.factors.RI_EXEMPTION, money("19.23"));
  assert.equal(result.factors.RI_TAXABLE, money("2175.77"));
  assert.equal(result.tax, money("87.57"));
});

test("RI no RI W-4 withholds at zero allowances", () => {
  const empty = RI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00",
    basis: "resident", certificate: resolveCertificate({ certificate: RI_CERTIFICATE }),
  });
  const zero = RI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00",
    basis: "resident", certificate: cert({ allowances: "0" }),
  });
  assert.equal(empty.tax, zero.tax);
  assert.equal(empty.factors.RI_EXEMPTION, money("0"));
});

test("RI exemption phases out above the printed weekly wage", () => {
  const phased = RI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "5592.32",
    basis: "resident", certificate: cert({ allowances: "1" }),
  });
  assert.equal(phased.factors.RI_EXEMPTION, money("0"));
});

test("RI extra withholding is added, exempt is zero, and an unpublished period is refused", () => {
  assert.equal(RI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00",
    basis: "resident", certificate: cert({ allowances: "1", additional_per_period: "5.00" }),
  }).tax, money("92.57"));
  assert.equal(RI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "2195.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.throws(
    () => RI_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 13, wages: "2195",
      basis: "resident", certificate: cert({ allowances: "1" }),
    }),
    /publishes withholding tables/,
  );
});

test("RI refuses a year it has not transcribed", () => {
  assert.throws(
    () => RI_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "2195",
      basis: "resident", certificate: cert({ allowances: "1" }),
    }),
    /2027 Rhode Island income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
