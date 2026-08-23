/**
 * Oregon withholding CONFORMANCE goldens — 150-206-436 (Rev. 12-31-25).
 *
 * Every expected figure is transcribed from the publication's own Example 1
 * line-by-line, Example 2 period splits, Examples 3–4 phase-out rules, or
 * the publication's own arithmetic on its printed table digits. Nothing here
 * was produced by running the engine and pasting the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, divIntCents, mulRateCents, U } from "../../canada/decimal.ts";
import {
  OR_CERTIFICATE, OR_REGION, OR_RATES_2026, OR_WITHHOLDING, orAllowancesUsed, orAnnualWithholding,
  orBracketTableFor, orFederalCap, orMulRateDollars, orPhaseTableFor, orRatesForPayDate,
  orRoundToDollar, orSupplementalFlat, orTransitWithholding,
} from "./or.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(OR_CERTIFICATE, answers);

test("OR certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(OR_CERTIFICATE), null);
  assert.equal(OR_REGION.implemented, true);
  assert.equal(OR_REGION.certificateKey, "us_or_orw4");
  assert.equal(OR_REGION.residentWithholdingImplemented, false);
  assert.equal(OR_REGION.residentWithholding, "unknown");
  assert.equal(OR_CERTIFICATE.storage, "certificate_rows");
  for (const field of OR_CERTIFICATE.fields) {
    assert.ok(field.help.length > 20, `${field.key} help is too thin`);
  }
});

test("OR printed percents convert by shifting the point, not dividing", () => {
  assert.equal(OR_RATES_2026.low.single[0]!.rate, pctToRate("4.75"));
  assert.equal(OR_RATES_2026.low.single[1]!.rate, pctToRate("6.75"));
  assert.equal(OR_RATES_2026.low.single[2]!.rate, pctToRate("8.75"));
  assert.equal(OR_RATES_2026.high.single[1]!.rate, pctToRate("9.9"));
  assert.equal(OR_RATES_2026.noFormRate, pctToRate("8"));
  assert.equal(pctToRate("4.75"), "0.0475");
  assert.equal(pctToRate("8.75"), "0.0875");
  assert.equal(pctToRate("9.9"), "0.099");
  assert.equal(OR_RATES_2026.exemptionCredit, "263");
  assert.equal(OR_RATES_2026.standardDeductionSingle, "2910");
  assert.equal(OR_RATES_2026.standardDeductionMarried, "5820");
  assert.equal(OR_RATES_2026.federalCap, "8750");
});

test("OR printed addends ARE the tax on everything below each low-wage band", () => {
  // 150-206-436 (Rev. 12-31-25) low-wage Single table. Each next addend is
  // the prior addend plus (width × rate) rounded to the dollar — the same
  // unit Example 1 line 7 uses.
  const [s0, s1, s2] = OR_RATES_2026.low.single;
  assert.equal(
    D(U(s0!.add) + orMulRateDollars(U(s1!.atLeast) - U(s0!.subtract), s0!.rate)),
    money(s1!.add),
  );
  assert.equal(
    D(U(s1!.add) + orMulRateDollars(U(s2!.atLeast) - U(s1!.subtract), s1!.rate)),
    money(s2!.add),
  );

  const [m0, m1, m2] = OR_RATES_2026.low.married_or_3plus;
  assert.equal(
    D(U(m0!.add) + orMulRateDollars(U(m1!.atLeast) - U(m0!.subtract), m0!.rate)),
    money(m1!.add),
  );
  assert.equal(
    D(U(m1!.add) + orMulRateDollars(U(m2!.atLeast) - U(m1!.subtract), m1!.rate)),
    money(m2!.add),
  );

  // High-wage addends drop one $263 credit from the low-wage top addend,
  // then the 9.9% addend is the tax at the 8.75% ceiling.
  assert.equal(
    D(U(s2!.add) - U(OR_RATES_2026.exemptionCredit)),
    money(OR_RATES_2026.high.single[0]!.add),
  );
  assert.equal(
    D(
      U(OR_RATES_2026.high.single[0]!.add)
      + orMulRateDollars(
        U("125000") - U(OR_RATES_2026.high.single[0]!.subtract),
        OR_RATES_2026.high.single[0]!.rate,
      ),
    ),
    money(OR_RATES_2026.high.single[1]!.add),
  );
  assert.equal(
    D(U(m2!.add) - U(OR_RATES_2026.exemptionCredit)),
    money(OR_RATES_2026.high.married_or_3plus[0]!.add),
  );
  assert.equal(
    D(
      U(OR_RATES_2026.high.married_or_3plus[0]!.add)
      + orMulRateDollars(
        U("250000") - U(OR_RATES_2026.high.married_or_3plus[0]!.subtract),
        OR_RATES_2026.high.married_or_3plus[0]!.rate,
      ),
    ),
    money(OR_RATES_2026.high.married_or_3plus[1]!.add),
  );
});

/* ===================================================================== */
/* Example 1 — annual, single, 0 allowances, $25,000 / $1,000 FIT        */
/* ===================================================================== */

test("OR Example 1 — annual $25,000 single 0 allowances: $1,789 (Rev. 12-31-25)", () => {
  // Publication line-by-line:
  //   1. Wage                              $25,000
  //   2. Less federal withholding          − $1,000
  //   3. Less standard deduction           − $2,910
  //   4. BASE                              $21,090
  //   5. Amount of BASE over $11,400       $9,690
  //   6. Tax on first $11,400 of BASE      $941
  //   7. Tax on excess (0.0875 × $9,690)   $848
  //   8. Total tax from rates              $1,789
  //   9. Less personal exemption credit    − $0
  //  10. Net tax to be withheld annually   $1,789
  //
  // 9,690 × 0.0875 = 848.375, printed as $848 — the dollar-rounding pin.
  const result = OR_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 1, wages: "25000.00", basis: "resident",
    certificate: cert({
      marital_status: "single",
      allowances: "0",
      federal_income_tax_withheld: "1000.00",
    }),
  });
  assert.equal(result.factors.OR_ANNUAL_WAGES, money("25000"));
  assert.equal(result.factors.OR_FEDERAL_USED, money("1000"));
  assert.equal(result.factors.OR_STANDARD_DEDUCTION, money("2910"));
  assert.equal(result.factors.OR_BASE, money("21090"));
  assert.equal(result.factors.OR_BAND_ADD, "941");
  assert.equal(result.factors.OR_FROM_RATES, money("1789"));
  assert.equal(result.factors.OR_CREDIT, money("0"));
  assert.equal(result.tax, money("1789"));
  assert.equal(result.year, OR_RATES_2026.year);
});

/* ===================================================================== */
/* Example 2 — divide the printed $1,789 by the printed period counts    */
/* ===================================================================== */

test("OR Example 2 — $1,789 de-annualized is $149 / $75 / $69 / $34 / $7", () => {
  // "To figure monthly withholding … take the annual net tax to be withheld
  // ($1,789) and divide by 12 = $149.
  //  twice a month … divide by 24 = $75
  //  every two weeks … divide by 26 = $69
  //  weekly … divide by 52 = $34
  //  daily … divide by 260 = $7"
  const annual = U("1789");
  assert.equal(D(orRoundToDollar(divIntCents(annual, 12))), money("149"));
  assert.equal(D(orRoundToDollar(divIntCents(annual, 24))), money("75"));
  assert.equal(D(orRoundToDollar(divIntCents(annual, 26))), money("69"));
  assert.equal(D(orRoundToDollar(divIntCents(annual, 52))), money("34"));
  assert.equal(D(orRoundToDollar(divIntCents(annual, 260))), money("7"));

  // Period wages that annualize back to Example 1's BASE ($21,090):
  // 2,083.3333 × 12 = 24,999.9996; 83.3333 × 12 = 999.9996;
  // 24,999.9996 − 999.9996 − 2,910 = 21,090. Compute then applies
  // Example 2's monthly split to that same $1,789.
  const monthly = OR_WITHHOLDING.compute({
    payDate: "2026-03-31", periodsPerYear: 12, wages: "2083.3333", basis: "resident",
    certificate: cert({
      marital_status: "single",
      allowances: "0",
      federal_income_tax_withheld: "83.3333",
    }),
  });
  assert.equal(monthly.factors.OR_BASE, money("21090"));
  assert.equal(monthly.factors.OR_ANNUAL_TAX, money("1789"));
  assert.equal(monthly.tax, money("149"));
});

/* ===================================================================== */
/* Examples 3 and 4 — phase-out and allowance cutoffs as printed         */
/* ===================================================================== */

test("OR Example 3 — $132,000 single, FIT $21,098, cap is the $130–135k step", () => {
  // "A single employee earns $132,000 a year … federal tax withheld is
  // $21,098 for the year, they may only subtract [the phase-out amount]."
  // 2026 [S] PHASE OUT: wages ≥ $130,000 and < $135,000 = $5,250.
  // (The 2025 edition printed $5,100 at this step; 2026 reprints $5,250.)
  assert.equal(D(orFederalCap(U("132000"), "single", OR_RATES_2026)), money("5250"));
  assert.notEqual(D(orFederalCap(U("132000"), "single", OR_RATES_2026)), money("5100"));
  assert.equal(orAllowancesUsed("single", 4, U("132000"), OR_RATES_2026), 0);

  const annual = orAnnualWithholding({
    annualWages: U("132000"),
    annualFederalWithheld: U("21098"),
    status: "single",
    claimedAllowances: 4,
    rates: OR_RATES_2026,
  });
  assert.equal(annual.factors.OR_FEDERAL_CAP, money("5250"));
  assert.equal(annual.factors.OR_FEDERAL_USED, money("5250"));
  assert.equal(annual.factors.OR_ALLOWANCES, "0");
  assert.equal(annual.factors.OR_STANDARD_DEDUCTION, money("2910"));
  // Example 3 prints no final dollar. BASE is the publication's own
  // arithmetic on its printed cap and standard deduction:
  // 132,000 − 5,250 − 2,910 = 123,840.
  assert.equal(annual.factors.OR_BASE, money("123840"));
});

test("OR Example 4 — married-higher-single $175,000: no FIT subtraction, no allowances", () => {
  // "A married employee earns $175,000 … choosing to withhold at the higher
  // single rate … annual income is higher than $145,000 which is the final
  // step in the phase-out for the single withholding rates, his employer
  // wouldn’t give any subtraction for federal tax withheld. His employer
  // would also not allow any allowances … because his income is over
  // $100,000 for a single individual."
  assert.equal(orPhaseTableFor("married_higher_single"), "single");
  assert.equal(D(orFederalCap(U("175000"), "single", OR_RATES_2026)), money("0"));
  assert.equal(orAllowancesUsed("married_higher_single", 4, U("175000"), OR_RATES_2026), 0);
  assert.equal(orBracketTableFor("married_higher_single", 0), "single");

  const annual = orAnnualWithholding({
    annualWages: U("175000"),
    annualFederalWithheld: U("30000"),
    status: "married_higher_single",
    claimedAllowances: 4,
    rates: OR_RATES_2026,
  });
  assert.equal(annual.factors.OR_FEDERAL_USED, money("0"));
  assert.equal(annual.factors.OR_ALLOWANCES, "0");
  assert.equal(annual.factors.OR_STANDARD_DEDUCTION, money("2910"));
  assert.equal(annual.factors.OR_BASE, money("172090"));
});

test("OR FAQ 7 — single with 3+ allowances uses the single phase-out and $5,820 deduction", () => {
  assert.equal(orPhaseTableFor("single"), "single");
  assert.equal(orBracketTableFor("single", 3), "married_or_3plus");
  const annual = orAnnualWithholding({
    annualWages: U("40000"),
    annualFederalWithheld: U("2000"),
    status: "single",
    claimedAllowances: 3,
    rates: OR_RATES_2026,
  });
  assert.equal(annual.factors.OR_PHASE, "single");
  assert.equal(annual.factors.OR_BRACKETS, "married_or_3plus");
  assert.equal(annual.factors.OR_STANDARD_DEDUCTION, money("5820"));
  assert.equal(annual.factors.OR_FEDERAL_CAP, money("8750"));
});

test("OR extra withholding is added AFTER the formula; exempt is zero", () => {
  const extra = OR_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 1, wages: "25000.00", basis: "resident",
    certificate: cert({
      marital_status: "single",
      allowances: "0",
      federal_income_tax_withheld: "1000.00",
      additional_per_period: "25.00",
    }),
  });
  assert.equal(extra.tax, money("1814"));

  const exempt = OR_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 1, wages: "25000.00", basis: "resident",
    certificate: cert({
      marital_status: "single",
      federal_income_tax_withheld: "1000.00",
      exempt: "true",
    }),
  });
  assert.equal(exempt.tax, money("0"));
  assert.equal(exempt.factors.OR_EXEMPT, "1");
});

test("OR HB 2119 — no OR-W-4 on file withholds 8% of wages", () => {
  // "HB 2119 (2019) requires employers to withhold income tax at a rate of
  // eight (8) percent of employee wages if the employee hasn’t provided a
  // withholding statement or exception certificate."
  const none = OR_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: resolveCertificate({ certificate: OR_CERTIFICATE }),
  });
  assert.equal(none.factors.OR_METHOD, "eight_percent");
  assert.equal(none.tax, money("80"));
  assert.equal(D(mulRateCents(U("1000"), pctToRate("8"))), money("80"));
});

test("OR refuses without this period's federal income tax withheld", () => {
  assert.throws(
    () => OR_WITHHOLDING.compute({
      payDate: "2026-03-13", periodsPerYear: 1, wages: "25000.00", basis: "resident",
      certificate: cert({ marital_status: "single", allowances: "0" }),
    }),
    /requires this period's federal income tax withheld/,
  );
});

test("OR optional supplemental flat is 8%; compute aggregates (FAQ 5)", () => {
  assert.equal(orSupplementalFlat("2026-03-13", "4000.00"), money("320"));
  const withBonus = OR_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 1, wages: "21000.00", supplemental: "4000.00",
    basis: "resident",
    certificate: cert({
      marital_status: "single",
      allowances: "0",
      federal_income_tax_withheld: "1000.00",
    }),
  });
  // Same annual wages as Example 1 — bonuses are wages.
  assert.equal(withBonus.factors.OR_ANNUAL_WAGES, money("25000"));
  assert.equal(withBonus.tax, money("1789"));
});

test("OR transit districts refuse without an entered rate and never invent one", () => {
  assert.throws(
    () => orTransitWithholding({ wages: "2000.00", rate: null, district: "TriMet" }),
    /150-206-436.*does not publish TriMet or Lane Transit/s,
  );
  assert.throws(
    () => orTransitWithholding({ wages: "2000.00", rate: "", district: "Lane Transit District" }),
    /Inventing 0\.8237% or 0\.80% from Form OQ/,
  );
  // An employer-entered rate computes; 0.8237% is NOT a pack constant.
  assert.equal(
    orTransitWithholding({ wages: "1000.00", rate: "0.01", district: "TriMet" }),
    money("10"),
  );
  const trimet = OR_REGION.subRegions.find((sub) => sub.code === "TRIMET");
  const ltd = OR_REGION.subRegions.find((sub) => sub.code === "LTD");
  const stt = OR_REGION.subRegions.find((sub) => sub.code === "STT");
  assert.equal(trimet?.rateSource.kind, "tenant");
  assert.equal(ltd?.rateSource.kind, "tenant");
  assert.equal(stt?.implemented, false);
});

test("OR FAQ 10 — negative withholding is zero", () => {
  // Many allowances on a small BASE: credit exceeds tax-from-rates.
  const annual = orAnnualWithholding({
    annualWages: U("5000"),
    annualFederalWithheld: U("0"),
    status: "single",
    claimedAllowances: 10,
    rates: OR_RATES_2026,
  });
  assert.equal(D(annual.tax), money("0"));
});

test("OR refuses a year it has not transcribed, and never extrapolates", () => {
  assert.throws(
    () => OR_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 1, wages: "25000", basis: "resident",
      certificate: cert({ federal_income_tax_withheld: "1000" }),
    }),
    /2027 Oregon income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
  assert.throws(
    () => orRatesForPayDate("2025-12-31"),
    /2025 Oregon income tax withholding tables are not loaded/,
  );
});
