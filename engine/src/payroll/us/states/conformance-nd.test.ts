/**
 * North Dakota withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the 2026 Rates and Instructions
 * booklet or is that publication's own arithmetic on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  ND_CERTIFICATE, ND_NDWM_CERTIFICATE, ND_REGION, ND_RATES_2026, ND_TRIBAL_CERTIFICATE, ND_WITHHOLDING, ndAnnualTax,
} from "./nd.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(ND_CERTIFICATE, answers);

test("ND certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(ND_CERTIFICATE), null);
  assert.equal(certificateDeclarationProblem(ND_NDWM_CERTIFICATE), null);
  assert.equal(ND_REGION.implemented, true);
  assert.equal(ND_REGION.certificateKey, "us_nd_w4");
});

test("ND Form NDW-M requires the spouse's eligibility facts and attached dependent ID", () => {
  const input = {
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1800.00", basis: "resident" as const,
    certificate: cert(),
  };
  const incomplete = resolvedCertificate(ND_NDWM_CERTIFICATE, {
    employee_is_civilian_spouse: "true",
    both_domiciled_outside_nd: "true",
  });
  assert.throws(() => ND_WITHHOLDING.compute({
    ...input, supportingCertificates: { us_nd_ndwm: incomplete },
  }), /North Dakota military-spouse withholding exemption requires proof that .*permanent duty station.*solely.*military ID/);

  const complete = resolvedCertificate(ND_NDWM_CERTIFICATE, Object.fromEntries([
    "employee_is_civilian_spouse", "both_domiciled_outside_nd", "servicemember_stationed_in_nd",
    "employee_present_solely_to_accompany", "dependent_military_id_attached",
  ].map((key) => [key, "true"])));
  const result = ND_WITHHOLDING.compute({
    ...input, supportingCertificates: { us_nd_ndwm: complete },
  });
  assert.equal(result.tax, money("0"));
  assert.equal(result.factors.ND_MILITARY_SPOUSE_EXEMPT, money("0.0001"));
});

test("ND printed percents and the Single table's $35,975 remainder", () => {
  assert.equal(pctToRate("1.95"), "0.0195");
  assert.equal(pctToRate("2.50"), "0.0250");
  assert.equal(D(mulRateCents(U("35975"), pctToRate("1.95"))), money("701.51"));
  assert.equal(ndAnnualTax(U("93600"), "single", ND_RATES_2026), U("701.51"));
});

test("ND Section 2 worksheet — $1,800 weekly Single, table arithmetic", () => {
  // Booklet lines 1–3: $1,800 × 52 = $93,600.
  // Single table: $0 + 1.95% of ($93,600 − $57,625) = $701.51.
  // $701.51 ÷ 52 = $13.49, nearest dollar $13.
  // The booklet prints line 4 as $734.00 / line 5 as $14.00 — those figures
  // match the wage-bracket cell for $1,800–$1,825 weekly Single, not this
  // table. The engine follows the Annual Percentage Method Table.
  const result = ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: cert({ filing_status: "single" }),
  });
  assert.equal(result.factors.ND_ANNUAL_WAGES, money("93600"));
  assert.equal(result.factors.ND_ANNUAL_TAX, money("701.51"));
  assert.equal(result.tax, money("13"));
});

test("ND pre-2020 W-4 Section 1 uses the $97 weekly allowance and printed $10 example", () => {
  // 2026 booklet Section 1, Percentage Method: $1,800 − (2 × $97) = $1,606;
  // Table 1 Single: 1.95% × ($1,606 − $1,108) = $9.71 → nearest dollar $10.
  // https://www.tax.nd.gov/sites/www/files/documents/forms/individual/2026-iit/2026-income-tax-withholding-rates-booklet.pdf
  const result = ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: cert({ filing_status: "single" }),
    federalLegacyW4: { status: "single", allowances: 2 },
  });
  assert.equal(result.factors.ND_W4_METHOD, "pre_2020_section_1");
  assert.equal(result.factors.ND_W4_ALLOWANCE, money("194"));
  assert.equal(result.factors.ND_W4_TAXABLE, money("1606"));
  assert.equal(result.tax, money("10"));
});

test("ND no W-4 withholds as single", () => {
  const empty = ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: resolveCertificate({ certificate: ND_CERTIFICATE }),
  });
  const single = ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: cert({ filing_status: "single" }),
  });
  assert.equal(empty.tax, single.tax);
});

test("ND extra withholding is added, exempt is zero, and an unpublished period is refused", () => {
  assert.equal(ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", additional_per_period: "5.00" }),
  }).tax, money("18"));
  assert.equal(ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.throws(
    () => ND_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 1, wages: "93600",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /publishes withholding tables/,
  );
});

test("ND reservation exemption prices only the off-reservation wages", () => {
  // Guideline p. 2: $2,000 weekly single is $17 on full wages; with $600 of
  // reservation-source wages attested, the $1,400 remainder withholds $6.
  const result = ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "2000.00",
    basis: "nonresident", certificate: cert({ filing_status: "single" }),
    supportingCertificates: {
      [ND_TRIBAL_CERTIFICATE.key]: resolvedCertificate(ND_TRIBAL_CERTIFICATE, {
        enrolled_member: "true",
        lives_on_reservation: "true",
        reservation_source_wages: "600.00",
      }),
    },
  });
  assert.equal(result.tax, money("6"));
});

test("ND refuses a year it has not transcribed", () => {
  assert.throws(
    () => ND_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1800",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /2027 North Dakota income tax withholding tables are not available in this pack version.*update the pack.*Never extrapolate the prior year/s,
  );
});
