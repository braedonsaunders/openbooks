/**
 * District of Columbia withholding CONFORMANCE goldens.
 *
 * The District publishes no 2026 FR-230 and no worked withholding examples:
 * the latest booklet is FR-230 (Rev. 11/17) for 2018, and OTR Tax Notice
 * 2022-08 substitutes the current rate schedule and the federal allowance
 * amount while keeping the booklet's percentage method. So these goldens are
 * the publication's own arithmetic on its own printed numbers, in three
 * layers:
 *
 *   1. the 2026 schedule's cumulative amounts reproduce from the prior
 *      brackets (the OTR rates page's own figures);
 *   2. the engine's scaler re-derives a sample of FR-230's PRINTED 2018
 *      per-period figures (Table 1 allowances and pp. 10–11 tables, read
 *      from the fetched PDF) from the 2018 annual figures — proving the
 *      scaling rule is the publication's, not an invention;
 *   3. end-to-end period computations worked by hand through the three
 *      FR-230 steps, asserted to the cent.
 *
 * FR-230 prints no percentage-method worked example, so layer 3 has no
 * booklet example to cite — that absence is stated here rather than hidden.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, divIntCents, mulRateCents, U } from "../../canada/decimal.ts";
import { RATES_2026 } from "../rates.ts";
import {
  DC_CERTIFICATE, DC_REGION, DC_RATES_2026, DC_WITHHOLDING, dcAllowancePerPeriod,
  dcDivisorForPeriod, dcScaledBrackets, type DcYearRates,
} from "./dc.ts";
import { pctToRate } from "./transcription.ts";
import { unimplementedUsStates, requireUsStateWithholding } from "./index.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(DC_CERTIFICATE, answers);

test("DC certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(DC_CERTIFICATE), null);
  assert.equal(DC_REGION.implemented, true);
  assert.equal(DC_REGION.certificateKey, "us_dc_d4");
});

test("DC has left unimplementedUsStates() — the engine resolves by name", () => {
  assert.ok(!unimplementedUsStates().includes("DC"));
  assert.equal(requireUsStateWithholding("DC"), DC_WITHHOLDING);
});

test("DC 2026 schedule cumulative amounts reproduce from the prior brackets", () => {
  // OTR "DC Individual and Fiduciary Income Tax Rates", tax years beginning
  // after 12/31/2021. Each base is the tax at its threshold.
  assert.equal(D(mulRateCents(U("10000"), pctToRate("4"))), money("400"));
  assert.equal(D(U("400") + mulRateCents(U("30000"), pctToRate("6"))), money("2200"));
  assert.equal(D(U("2200") + mulRateCents(U("20000"), pctToRate("6.5"))), money("3500"));
  assert.equal(D(U("3500") + mulRateCents(U("190000"), pctToRate("8.5"))), money("19650"));
  assert.equal(D(U("19650") + mulRateCents(U("250000"), pctToRate("9.25"))), money("42775"));
  assert.equal(D(U("42775") + mulRateCents(U("500000"), pctToRate("9.75"))), money("91525"));
  // And the engine carries exactly those bases.
  assert.deepEqual(
    DC_RATES_2026.brackets.map((bracket) => bracket.base),
    ["0", "400", "2200", "3500", "19650", "42775", "91525"],
  );
});

test("DC 2026 allowance is the Pub 15-T (2026) line 1k federal amount", () => {
  // IRS Publication 15-T (2026), Worksheet 1A line 1k: "Multiply line 1j by
  // $4,300" — the figure OTR Tax Notice 2022-08 points at. It must agree with
  // the pack's own federal transcription; the DC module carries its own copy
  // only because importing the federal rates would close a module cycle.
  assert.equal(DC_RATES_2026.allowanceAnnual, "4300");
  assert.equal(DC_RATES_2026.allowanceAnnual, RATES_2026.allowanceAmount);
  // Per-period values the 2026 tables would print. Named as
  // `divIntCents(annual, D)` — the same half-up helper DE pins — not as
  // a second literal table. The unused import of that helper was the
  // fingerprint of this pin; dropping it would have left only the
  // rounded cents, which any other rounder that happens to land there
  // would also satisfy.
  const allowances2026 = [
    ["weekly", 52, "82.69"],
    ["biweekly", 26, "165.38"],
    ["semimonthly", 24, "179.17"],
    ["monthly", 12, "358.33"],
    ["quarterly", 4, "1075"],
    ["semiannual", 2, "2150"],
    ["annual", 1, "4300"],
    ["daily", 365, "11.78"],
  ] as const;
  assert.equal(allowances2026.length, 8, "FR-230 Table 1 prints eight periods");
  for (const [period, periods, printed] of allowances2026) {
    const derived = divIntCents(U(DC_RATES_2026.allowanceAnnual), dcDivisorForPeriod(period, periods));
    assert.equal(D(derived), money(printed), `${period} is annual÷${periods} half-up`);
    assert.equal(
      dcAllowancePerPeriod(DC_RATES_2026, period, periods),
      derived,
      `${period} helper is that division`,
    );
  }
  // Daily is 365 even when the payroll runs 260 periods — the booklet
  // prints one daily table, not a 260-day one.
  assert.equal(
    dcAllowancePerPeriod(DC_RATES_2026, "daily", 260),
    divIntCents(U(DC_RATES_2026.allowanceAnnual), 365),
  );
});

test("the scaler reproduces FR-230's printed 2018 figures from the 2018 annuals", () => {
  // 2018 annual inputs read from the fetched FR-230 PDF itself: Table 1
  // annual allowance $4,150 (p. 9) and the single-filer annual percentage
  // schedule (p. 10). These 2018 figures verify the SCALING RULE only — they
  // are not current law and appear nowhere else in this file.
  const rates2018: DcYearRates = {
    year: 2018,
    status: "published",
    allowanceAnnual: "4150",
    brackets: [
      { over: "0", notOver: "10000", base: "0", rate: pctToRate("4") },
      { over: "10000", notOver: "40000", base: "400", rate: pctToRate("6") },
      { over: "40000", notOver: "60000", base: "2200", rate: pctToRate("6.5") },
      { over: "60000", notOver: "350000", base: "3500", rate: pctToRate("8.5") },
      { over: "350000", notOver: "1000000", base: "28150", rate: pctToRate("8.75") },
      { over: "1000000", notOver: null, base: "85025", rate: pctToRate("8.95") },
    ],
  };
  // Table 1 (p. 9) per-period allowances, exactly as printed — and each
  // printed cent is annual÷D half-up, the same `divIntCents` DE pins.
  const table1_2018 = [
    ["weekly", 52, "79.81"],
    ["biweekly", 26, "159.62"],
    ["semimonthly", 24, "172.92"],
    ["monthly", 12, "345.83"],
    ["quarterly", 4, "1037.50"],
    ["semiannual", 2, "2075.00"],
    ["annual", 1, "4150.00"],
    ["daily", 365, "11.37"],
  ] as const;
  assert.equal(table1_2018.length, 8, "FR-230 Table 1 prints eight periods");
  for (const [period, periods, printed] of table1_2018) {
    const derived = divIntCents(U(rates2018.allowanceAnnual), dcDivisorForPeriod(period, periods));
    assert.equal(D(derived), money(printed), `${period} printed is annual÷${periods} half-up`);
    assert.equal(
      dcAllowancePerPeriod(rates2018, period, periods),
      derived,
      `${period} helper is that division`,
    );
  }
  // Weekly percentage table (p. 11), second bracket and top bracket.
  const weekly = dcScaledBrackets(rates2018, "weekly", 52);
  assert.equal(weekly[1]!.over, divIntCents(U("10000"), 52));
  assert.equal(weekly[1]!.notOver, divIntCents(U("40000"), 52));
  assert.equal(weekly[1]!.base, divIntCents(U("400"), 52));
  assert.equal(D(weekly[1]!.over), money("192.31"));
  assert.equal(D(weekly[1]!.notOver!), money("769.23"));
  assert.equal(D(weekly[1]!.base), money("7.69"));
  assert.equal(weekly[5]!.over, divIntCents(U("1000000"), 52));
  assert.equal(weekly[5]!.base, divIntCents(U("85025"), 52));
  assert.equal(D(weekly[5]!.over), money("19230.77"));
  assert.equal(D(weekly[5]!.base), money("1635.10"));
  // Daily percentage table (p. 11), first two brackets.
  const daily = dcScaledBrackets(rates2018, "daily", 365);
  assert.equal(daily[0]!.notOver, divIntCents(U("10000"), 365));
  assert.equal(daily[1]!.over, divIntCents(U("10000"), 365));
  assert.equal(daily[1]!.notOver, divIntCents(U("40000"), 365));
  assert.equal(daily[1]!.base, divIntCents(U("400"), 365));
  assert.equal(D(daily[0]!.notOver!), money("27.40"));
  assert.equal(D(daily[1]!.over), money("27.40"));
  assert.equal(D(daily[1]!.notOver!), money("109.59"));
  assert.equal(D(daily[1]!.base), money("1.10"));
  // Monthly table (p. 10): the joint/head schedule prints $291.67 / $5,000
  // for the 8.5% bracket — identical to the single schedule the scaler
  // carries. The District's schedule is status-blind, so the engine reads no
  // filing status; this is the assertion that the second schedule adds
  // nothing.
  const monthly = dcScaledBrackets(rates2018, "monthly", 12);
  assert.equal(monthly[3]!.over, divIntCents(U("60000"), 12));
  assert.equal(monthly[3]!.base, divIntCents(U("3500"), 12));
  assert.equal(D(monthly[3]!.over), money("5000"));
  assert.equal(D(monthly[3]!.base), money("291.67"));
});

test("DC weekly $1,000 with no allowances: $57.31", () => {
  // Allowance 0 × $82.69; taxable $1,000. Weekly B3 (over $769.23, base
  // $42.31, 6.5%): 42.31 + 6.5% × (1,000 − 769.23) = 42.31 + 15.00.
  const result = DC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00",
    basis: "resident", certificate: cert({ allowances: "0" }),
  });
  assert.equal(result.factors.DC_WAGES, money("1000"));
  assert.equal(result.factors.DC_ALLOWANCE_PER_PERIOD, money("82.69"));
  assert.equal(result.factors.DC_ALLOWANCE, money("0"));
  assert.equal(result.factors.DC_TAXABLE, money("1000"));
  assert.equal(result.tax, money("57.31"));
  assert.equal(result.taxSupplemental, money("0"));
});

test("DC biweekly $3,000 with 2 allowances: $165.35", () => {
  // Allowance 2 × $165.38 = $330.76; taxable $2,669.24. Biweekly B4 (over
  // $2,307.69, base $134.62, 8.5%): 134.62 + 8.5% × 361.55 = 134.62 + 30.73.
  const result = DC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 26, wages: "3000.00",
    basis: "resident", certificate: cert({ allowances: "2" }),
  });
  assert.equal(result.factors.DC_ALLOWANCE, money("330.76"));
  assert.equal(result.factors.DC_TAXABLE, money("2669.24"));
  assert.equal(result.tax, money("165.35"));
});

test("DC monthly $20,000 with 1 allowance: $1,536.21", () => {
  // Allowance $358.33; taxable $19,641.67. Monthly B4 (over $5,000, base
  // $291.67, 8.5%): 291.67 + 8.5% × 14,641.67 = 291.67 + 1,244.54.
  const result = DC_WITHHOLDING.compute({
    payDate: "2026-06-30", periodsPerYear: 12, wages: "20000.00",
    basis: "resident", certificate: cert({ allowances: "1" }),
  });
  assert.equal(result.factors.DC_ALLOWANCE, money("358.33"));
  assert.equal(result.factors.DC_TAXABLE, money("19641.67"));
  assert.equal(result.tax, money("1536.21"));
});

test("DC semimonthly $500 with no allowances: $21.67", () => {
  // Taxable $500. Semimonthly B2 (over $416.67, base $16.67, 6%):
  // 16.67 + 6% × 83.33 = 16.67 + 5.00.
  const result = DC_WITHHOLDING.compute({
    payDate: "2026-02-15", periodsPerYear: 24, wages: "500.00",
    basis: "resident", certificate: cert({ allowances: "0" }),
  });
  assert.equal(result.tax, money("21.67"));
});

test("DC annual $100,000 with 1 allowance: $6,534.50", () => {
  // Taxable $95,700. Annual B4: 3,500 + 8.5% × 35,700 = 3,500 + 3,034.50.
  const result = DC_WITHHOLDING.compute({
    payDate: "2026-12-31", periodsPerYear: 1, wages: "100000.00",
    basis: "resident", certificate: cert({ allowances: "1" }),
  });
  assert.equal(result.tax, money("6534.50"));
});

test("DC daily $400 with no allowances: $29.62, on the 365-day divisor", () => {
  // FR-230's daily table is 365-based. Taxable $400. Daily B4 (over $164.38,
  // base $9.59, 8.5%): 9.59 + 8.5% × 235.62 = 9.59 + 20.03.
  for (const periodsPerYear of [365, 260]) {
    const result = DC_WITHHOLDING.compute({
      payDate: "2026-04-01", periodsPerYear, wages: "400.00",
      basis: "resident", certificate: cert({ allowances: "0" }),
    });
    assert.equal(result.factors.DC_ALLOWANCE_PER_PERIOD, money("11.78"), `${periodsPerYear}`);
    assert.equal(result.tax, money("29.62"), `${periodsPerYear}`);
  }
  assert.equal(dcDivisorForPeriod("daily", 260), 365);
  assert.equal(dcDivisorForPeriod("weekly", 52), 52);
});

test("DC supplemental wages are ordinary wages — no separate rate", () => {
  // FR-230's wages definition covers bonuses and commissions; the booklet
  // prints no supplemental rule. $3,000 + $1,000 supplemental with 2
  // allowances: taxable $3,669.24, biweekly B4:
  // 134.62 + 8.5% × 1,361.55 = 134.62 + 115.73.
  const result = DC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 26, wages: "3000.00", supplemental: "1000.00",
    basis: "resident", certificate: cert({ allowances: "2" }),
  });
  assert.equal(result.factors.DC_WAGES, money("4000"));
  assert.equal(result.tax, money("250.35"));
  assert.equal(result.taxSupplemental, money("0"));
});

test("DC exempt D-4 withholds nothing", () => {
  const result = DC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00",
    basis: "resident", certificate: cert({ allowances: "0", exempt: "true" }),
  });
  assert.equal(result.tax, money("0"));
});

test("DC with no D-4 on file withholds on the full wage", () => {
  const empty = DC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00",
    basis: "resident", certificate: resolveCertificate({ certificate: DC_CERTIFICATE }),
  });
  assert.equal(empty.factors.DC_ALLOWANCE, money("0"));
  assert.equal(empty.tax, money("57.31"));
});

test("DC allowances beyond wages floor at zero, never a refund", () => {
  const result = DC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "50.00",
    basis: "resident", certificate: cert({ allowances: "10" }),
  });
  assert.equal(result.factors.DC_TAXABLE, money("0"));
  assert.equal(result.tax, money("0"));
});

test("DC refuses a year it has not transcribed", () => {
  assert.throws(
    () => DC_WITHHOLDING.compute({
      payDate: "2025-06-15", periodsPerYear: 52, wages: "1000",
      basis: "resident", certificate: cert({ allowances: "0" }),
    }),
    /2025 District of Columbia income tax withholding tables are not available in this pack version.*update the pack.*Never extrapolate the prior year/s,
  );
});

test("DC refuses a pay frequency it prints no table for", () => {
  assert.throws(
    () => DC_WITHHOLDING.compute({
      payDate: "2026-06-15", periodsPerYear: 27, wages: "1000",
      basis: "resident", certificate: cert({ allowances: "0" }),
    }),
    /District of Columbia income tax publishes withholding tables for/,
  );
});
