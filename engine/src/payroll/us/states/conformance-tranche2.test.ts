/**
 * State withholding CONFORMANCE goldens — New Jersey, Ohio, Michigan,
 * Massachusetts, Georgia, North Carolina.
 *
 * Same rule as the first tranche's conformance.test.ts: every expected figure
 * is TRANSCRIBED FROM AN AGENCY'S OWN WORKED EXAMPLE or derived from the
 * agency's own published table by an arithmetic the agency states, with the
 * publication named beside it. Nothing here was produced by running the engine
 * and pasting the answer.
 *
 * Two states publish no worked example at all — Ohio's percentage-method and
 * computer-formula sheets are bare tables, and Michigan's Form 446 gives the
 * rate and the exemption and stops. Those get the strongest substitute
 * available and it is labelled as a substitute:
 *
 *   OHIO       the five printed per-period tables are DERIVED, line by line,
 *              from the annualized computer formula in the same release. Two
 *              independent transcriptions of the same law reproducing each
 *              other to the cent is real evidence — and it found a defect: the
 *              August 2026 daily table's top line prints a cent less than the
 *              formula gives.
 *   MICHIGAN   the state's own figures are pinned to the guide's masthead, and
 *              the arithmetic is proved against DETROIT's worked example, which
 *              is a Michigan Treasury publication using the same convention.
 *              This is explicitly NOT state-level conformance and is marked so.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  payrollCertificate, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../jurisdictions.ts"; // registers the US pack's certificate declarations
import { D, divIntCents, mulRateCents, U } from "../../canada/decimal.ts";
import { GA_EDITIONS, GA_WITHHOLDING, gaEditionForPayDate } from "./ga.ts";
import { MA_RATES_2026, MA_WITHHOLDING, maSupplementalWithholding } from "./ma.ts";
import {
  DETROIT_WITHHOLDING, MI_RATES_2026, MI_TAXING_CITIES, MI_WITHHOLDING,
  miCityWithholding, miDetroitResidentRate,
} from "./mi.ts";
import { NC_RATES_2026, NC_WITHHOLDING, ncAnnualizedMethod, ncSupplementalFlat } from "./nc.ts";
import { NJ_RATES_2026, NJ_WITHHOLDING } from "./nj.ts";
import {
  OH_EDITIONS, OH_SCHOOL_DISTRICTS_2026, OH_WITHHOLDING,
  ohMunicipalWithholding, ohOptionalComputerFormula, ohPercentageMethod,
  ohSchoolDistrict, ohSchoolDistrictWithholding,
} from "./oh.ts";
import { pctToRate } from "./transcription.ts";

/** numeric(19,4) canonical form, as the engines return. */
const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(key: string, answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: payrollCertificate("US", key),
    stored: [{ certificateKey: key, answers, effectiveFrom: null }],
  });
}

/* ===================================================================== */
/* TRANSCRIPTION HELPERS                                                 */
/* ===================================================================== */

test("a printed percentage converts to a rate by shifting the point, not dividing", () => {
  // The publications print "1.5%", "0.50 %", "11.8%". Every one of those has to
  // become a decimal without a float ever touching it.
  assert.equal(pctToRate("1.5"), "0.015");
  assert.equal(pctToRate("0.50"), "0.0050");
  assert.equal(pctToRate("11.8"), "0.118");
  assert.equal(pctToRate("2.00"), "0.0200");
  assert.equal(pctToRate("1.25 %"), "0.0125");
  assert.equal(pctToRate("100"), "1.00");
  assert.throws(() => pctToRate("2.9%%"), /not a percentage/);
});

/* ===================================================================== */
/* NEW JERSEY — NJ-WT (September 2025) p. 25, percentage method examples */
/* ===================================================================== */

const njw4 = (over: Record<string, string> = {}) => cert("us_nj_njw4", over);

const njCase = (wages: string, over: Record<string, string>) => NJ_WITHHOLDING.compute({
  payDate: "2026-03-06", periodsPerYear: 52, wages, basis: "resident",
  certificate: njw4(over),
});

test("NJ Rate A Example 1 — weekly $300, single, 1 allowance: $4.21", () => {
  // "(1) Total weekly wage payment $300.00; (2) Value per allowance 19.20;
  //  (3) Allowance claimed 1; (5) Amount subject to withholding 280.80;
  //  (6)(a) between $0 and $384 — multiply by 1.5% → 4.21."
  const result = njCase("300.00", { filing_status: "single", allowances: "1" });
  assert.equal(result.factors.NJ_RATE_TABLE, "A");
  assert.equal(result.factors.NJ_EXEMPTION, money("19.20"));
  assert.equal(result.factors.NJ_TAXABLE, money("280.80"));
  assert.equal(result.tax, money("4.21"));
});

test("NJ Rate A Example 2 — weekly $700, single, 1 allowance: $11.84", () => {
  // "between $673 and $769 — $11.54 plus 3.9% of amount over $673": 11.54 + .30.
  const result = njCase("700.00", { filing_status: "single", allowances: "1" });
  assert.equal(result.factors.NJ_TAXABLE, money("680.80"));
  assert.equal(result.tax, money("11.84"));
});

test("NJ Rate B Example 1 — weekly $375, joint, 3 allowances: $4.76", () => {
  const result = njCase("375.00", { filing_status: "married_joint", allowances: "3" });
  assert.equal(result.factors.NJ_RATE_TABLE, "B");
  assert.equal(result.factors.NJ_EXEMPTION, money("57.60"));
  assert.equal(result.factors.NJ_TAXABLE, money("317.40"));
  assert.equal(result.tax, money("4.76"));
});

test("NJ-WT's own examples were computed against SUPERSEDED brackets", () => {
  // A defect in the publication, quantified rather than matched.
  //
  // The September 2025 NJ-WT prints three examples per rate table whose stated
  // brackets are NOT the ones in the current rate tables it tells the employer
  // to use. Rate A example 3 says "over $769 — $15.28 plus 6.1%"; the table
  // says $15.29. Rate B examples 2 and 3 say "between $384 and $961 — $5.76"
  // and "over $961 — $17.30"; the table says $385/$962 and $5.77/$17.31.
  //
  // The examples' own arithmetic is right — they reproduce exactly against the
  // brackets they print. It is the brackets that moved and the examples that
  // were not re-run. The engine uses the TABLES, because those are what the
  // instructions direct an employer to, and the difference is a cent or two.

  // Rate A example 3: printed $40.40, tables give $40.41.
  const a3 = njCase("1200.00", { filing_status: "single", allowances: "1" });
  assert.equal(a3.factors.NJ_TAXABLE, money("1180.80"));
  assert.equal(a3.tax, money("40.41"));
  assert.notEqual(a3.tax, money("40.40"));
  // The example's own figures: 15.28 + 6.1% × (1180.80 − 769) = 15.28 + 25.12.
  assert.equal(D(U("15.28") + mulRateCents(U("1180.80") - U("769"), "0.061")), money("40.40"));

  // Rate B example 2: printed $15.93, tables give $15.92.
  const b2 = njCase("950.00", { filing_status: "married_joint", allowances: "3" });
  assert.equal(b2.factors.NJ_TAXABLE, money("892.40"));
  assert.equal(b2.tax, money("15.92"));
  assert.equal(D(U("5.76") + mulRateCents(U("892.40") - U("384"), "0.02")), money("15.93"));

  // Rate B example 3: printed $27.60, tables give $27.58.
  const b3 = njCase("1400.00", { filing_status: "married_joint", allowances: "3" });
  assert.equal(b3.factors.NJ_TAXABLE, money("1342.40"));
  assert.equal(b3.tax, money("27.58"));
  assert.equal(D(U("17.30") + mulRateCents(U("1342.40") - U("961"), "0.027")), money("27.60"));
});

test("NJ line 3 overrides the filing status, and line 6 stops withholding", () => {
  // The Wage Chart's whole purpose: a joint filer in a two-income household
  // moves UP the rate tables so the combined income is not under-withheld.
  const chosen = njCase("1400.00", {
    filing_status: "married_joint", rate_table: "E", allowances: "3",
  });
  assert.equal(chosen.factors.NJ_RATE_TABLE, "E");
  assert.notEqual(chosen.tax, njCase("1400.00", {
    filing_status: "married_joint", allowances: "3",
  }).tax);

  const exempt = njCase("1400.00", { filing_status: "single", exempt: "true" });
  assert.equal(exempt.tax, money("0"));
});

test("NJ Rate E MONTHLY leaves a one-dollar hole, and the engine refuses inside it", () => {
  // A second defect in New Jersey's printed tables. Rate E monthly runs
  // "$1,667 … but not over $2,916" and then "over $2,917", so wages of
  // $2,916.50 fall in no printed line at all. Every other Rate E period is
  // continuous, and the annual table's own boundaries ($35,000 ÷ 12 =
  // $2,916.67) show the intent.
  //
  // The engine refuses by name rather than inventing the bracket. A one-dollar
  // window is almost never hit; a silently invented rate would be wrong every
  // time it was.
  const rows = NJ_RATES_2026.tables.E.monthly.rows;
  assert.equal(rows[1]!.butNotOver, "2916");
  assert.equal(rows[2]!.over, "2917");
  assert.throws(
    () => NJ_WITHHOLDING.compute({
      payDate: "2026-03-06", periodsPerYear: 12, wages: "2916.50", basis: "resident",
      certificate: njw4({ filing_status: "single", rate_table: "E" }),
    }),
    /no New Jersey Rate Table "E" line covers taxable wages of 2916\.5000/,
  );
  // …and the same wage one dollar either side computes normally.
  assert.ok(NJ_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 12, wages: "2916.00", basis: "resident",
    certificate: njw4({ filing_status: "single", rate_table: "E" }),
  }).tax);
});

test("NJ tables are otherwise continuous, and every rate table is complete", () => {
  const periods = [
    "weekly", "biweekly", "semimonthly", "monthly",
    "quarterly", "semiannual", "annual", "daily",
  ] as const;
  const holes: string[] = [];
  for (const table of ["A", "B", "C", "D", "E"] as const) {
    for (const period of periods) {
      const rows = NJ_RATES_2026.tables[table][period].rows;
      assert.ok(rows.length >= 6, `${table}/${period} has too few lines`);
      assert.equal(rows[0]!.over, "0", `${table}/${period} does not start at zero`);
      assert.equal(rows[rows.length - 1]!.butNotOver, null, `${table}/${period} has no top line`);
      for (let i = 0; i + 1 < rows.length; i++) {
        if (rows[i]!.butNotOver !== rows[i + 1]!.over) holes.push(`${table}/${period} row ${i}`);
      }
      // Every line's "of excess over" is its own floor.
      for (const row of rows.slice(1)) {
        assert.equal(row.ofExcessOver, row.over, `${table}/${period} excess column`);
      }
    }
  }
  // Exactly one hole in forty tables, and it is the documented Rate E monthly.
  assert.deepEqual(holes, ["E/monthly row 1"]);
});

test("NJ allowance values are NJ-WT's own table", () => {
  const weekly = NJ_RATES_2026.tables.A.weekly.allowance;
  assert.equal(weekly, "19.20");
  assert.equal(NJ_RATES_2026.tables.A.biweekly.allowance, "38.40");
  assert.equal(NJ_RATES_2026.tables.A.semimonthly.allowance, "41.60");
  assert.equal(NJ_RATES_2026.tables.A.monthly.allowance, "83.30");
  assert.equal(NJ_RATES_2026.tables.A.quarterly.allowance, "250");
  assert.equal(NJ_RATES_2026.tables.A.semiannual.allowance, "500");
  assert.equal(NJ_RATES_2026.tables.A.annual.allowance, "1000");
  assert.equal(NJ_RATES_2026.tables.A.daily.allowance, "2.70");
  // One allowance value per period, shared by all five rate tables.
  for (const table of ["B", "C", "D", "E"] as const) {
    assert.equal(NJ_RATES_2026.tables[table].weekly.allowance, weekly);
  }
});

/* ===================================================================== */
/* OHIO — the printed tables against the computer formula                */
/* ===================================================================== */

test("Ohio's printed per-period tables ARE the annual formula, divided", () => {
  // Ohio publishes no worked example, so this is the substitute: two
  // independent transcriptions of the same law — the annualized computer
  // formula and the five per-period percentage-method tables, both in the same
  // release — are made to reproduce each other line by line.
  //
  // The divisors are the pay periods: 52, 26, 24, 12 and 260. (260, not 365:
  // $26,050 ÷ 260 is the printed $100.19, and ÷ 365 would be $71.37.)
  const divisors: Record<string, number> = {
    weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, daily: 260,
  };
  const mismatches: string[] = [];
  for (const edition of OH_EDITIONS) {
    for (const [period, periods] of Object.entries(divisors)) {
      const key = period as keyof typeof edition.printedTables;
      const rows = edition.printedTables[key];
      // The exemption: $650 a year.
      assert.equal(
        edition.printedExemption[key],
        D(divIntCents(U(edition.exemptionPerYear), periods)).replace(/0{2}$/, ""),
        `${edition.effectiveFrom} ${period} exemption`,
      );
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const band = edition.formula[i]!;
        assert.equal(row.rate, band.rate, `${edition.effectiveFrom} ${period} row ${i} rate`);
        const expectedFloor = band.over === "0"
          ? "0"
          : D(divIntCents(U(band.over), periods));
        assert.equal(
          D(U(row.over)), expectedFloor, `${edition.effectiveFrom} ${period} row ${i} floor`,
        );
        const expectedBase = D(divIntCents(U(band.base), periods));
        if (D(U(row.base)) !== expectedBase) {
          mismatches.push(
            `${edition.effectiveFrom} ${period} row ${i}: printed ${row.base}, formula `
            + `${expectedBase}`,
          );
        }
      }
    }
  }
  // DEFECT, quantified rather than matched: thirty printed lines across the two
  // editions, and one of them is a cent off its own formula. $2,627.91 ÷ 260 is
  // $10.10735, which is $10.11 to the cent by the half-up rule the other
  // twenty-nine lines follow; the August 2026 daily table prints $10.10.
  // It under-withholds by one cent a day for a daily payroll above $384.62.
  assert.deepEqual(mismatches, [
    "2026-08-01 daily row 2: printed 10.10, formula 10.1100",
  ]);
});

test("Ohio's formula bands are internally consistent", () => {
  // Each band's base is the tax on everything below it, so a transcription slip
  // in a rate or a threshold shows up here rather than on a paycheque.
  for (const edition of OH_EDITIONS) {
    const [first, second, third] = edition.formula;
    assert.equal(
      D(mulRateCents(U(first!.upTo!), first!.rate)), money(second!.base),
      `${edition.effectiveFrom} band 2 base`,
    );
    assert.equal(
      D(U(second!.base) + mulRateCents(U(second!.upTo!) - U(second!.over), second!.rate)),
      money(third!.base),
      `${edition.effectiveFrom} band 3 base`,
    );
  }
});

test("Ohio keys its tables to the PERIOD END, and refuses without one", () => {
  const certificate = cert("us_oh_it4", { total_exemptions: "1" });
  assert.throws(
    () => OH_WITHHOLDING.compute({
      payDate: "2026-08-14", periodsPerYear: 26, wages: "3000.00", basis: "resident", certificate,
    }),
    /keyed to the PAYROLL PERIOD END DATE, not the pay date/,
  );

  // The changeover, and the reason it matters: one payroll, paid on the same
  // day, is withheld differently depending on which side of 1 August its period
  // ended.
  const july = OH_WITHHOLDING.compute({
    payDate: "2026-08-07", periodEnd: "2026-07-31", periodsPerYear: 26,
    wages: "3000.00", basis: "resident", certificate,
  });
  const august = OH_WITHHOLDING.compute({
    payDate: "2026-08-07", periodEnd: "2026-08-01", periodsPerYear: 26,
    wages: "3000.00", basis: "resident", certificate,
  });
  assert.equal(july.factors.OH_EDITION, "2025-10-01");
  assert.equal(august.factors.OH_EDITION, "2026-08-01");
  assert.ok(U(august.tax) < U(july.tax), "the August 2026 tables withhold less");
});

test("Ohio's two published methods agree where the arithmetic lets them", () => {
  // The computer formula annualizes and the percentage method does not, so the
  // two land within a cent of each other rather than exactly on it. Both are
  // published; `compute` runs the formula, which is the one written for payroll
  // systems and the only one that answers for an unprinted frequency.
  const formula = ohOptionalComputerFormula({
    periodEnd: "2026-08-31", periodsPerYear: 26, wages: "3000.00", exemptions: 2,
  });
  const printed = ohPercentageMethod({
    periodEnd: "2026-08-31", periodsPerYear: 26, wages: "3000.00", exemptions: 2,
  });
  const gap = U(formula.tax) - U(printed);
  assert.ok(gap <= U("0.01") && gap >= U("-0.01"), `formula ${formula.tax} vs printed ${printed}`);

  // And an unprinted frequency: the formula answers, the printed tables refuse.
  assert.ok(ohOptionalComputerFormula({
    periodEnd: "2026-08-31", periodsPerYear: 4, wages: "20000.00", exemptions: 0,
  }).tax);
  assert.throws(
    () => ohPercentageMethod({
      periodEnd: "2026-08-31", periodsPerYear: 4, wages: "20000.00", exemptions: 0,
    }),
    /Ohio prints percentage-method tables for/,
  );
});

test("Ohio school districts: the Department's own totals, and both bases", () => {
  // The publication's own footnotes: "(a) Total number of districts are 214"
  // and "(b) Taxes based on earned income only; 68 districts."
  assert.equal(OH_SCHOOL_DISTRICTS_2026.length, 214);
  assert.equal(
    OH_SCHOOL_DISTRICTS_2026.filter((district) => district.base === "earned_income").length, 68,
  );
  assert.equal(
    new Set(OH_SCHOOL_DISTRICTS_2026.map((district) => district.code)).size, 214,
  );
  for (const district of OH_SCHOOL_DISTRICTS_2026) {
    assert.match(district.code, /^\d{4}$/, district.name);
    // Rates run from 0.25% to 2.00% in 2026; anything outside that is a slip.
    assert.ok(U(district.rate) >= U("0.0025") && U(district.rate) <= U("0.02"), district.name);
  }

  // Two districts from the list, one of each base.
  const traditional = ohSchoolDistrict("2026-03-06", "0303")!; // Loudonville-Perrysville EVSD
  assert.equal(traditional.printedPercent, "1.25");
  assert.equal(traditional.base, "traditional");
  const earned = ohSchoolDistrict("2026-03-06", "0302")!; // Hillsdale LSD
  assert.equal(earned.printedPercent, "1.25");
  assert.equal(earned.base, "earned_income");

  // The distinction is worth real money, and it is a declaration rather than a
  // branch: same wages, same rate, same exemptions, different base.
  const wages = "2000.00";
  const t = ohSchoolDistrictWithholding({
    periodEnd: "2026-08-31", periodsPerYear: 26, wages, exemptions: 3, district: traditional,
  });
  const e = ohSchoolDistrictWithholding({
    periodEnd: "2026-08-31", periodsPerYear: 26, wages, exemptions: 3, district: earned,
  });
  // Traditional deducts 3 × $650 = $1,950 a year of base; earned income
  // deducts nothing. 1.25% of $1,950 is $24.375 a year, $0.94 a fortnight.
  assert.equal(D(U(e.tax) - U(t.tax)), money("0.94"));
  assert.equal(t.factors.OH_SD_BASE, "traditional");
  assert.equal(e.factors.OH_SD_BASE, "earned_income");
});

test("an Ohio district that is NOT on the list levies nothing — and is not a guess", () => {
  // The list is the Department's complete one, so absence is an answer.
  assert.equal(ohSchoolDistrict("2026-03-06", "9999"), null);
  // A code that is not four digits is a data error, not a jurisdiction.
  assert.throws(() => ohSchoolDistrict("2026-03-06", "303"), /not an Ohio school district number/);
  // A year with no transcribed list is refused rather than carried forward.
  assert.throws(
    () => ohSchoolDistrict("2027-01-15", "0303"),
    /2027 Ohio school district income tax rates are not loaded/,
  );
});

test("an Ohio municipal rate that has not been entered stops the run", () => {
  assert.equal(
    ohMunicipalWithholding({ wages: "2000.00", rate: "0.025", municipality: "COLUMBUS" }),
    money("50.00"),
  );
  assert.throws(
    () => ohMunicipalWithholding({ wages: "2000.00", rate: null, municipality: "COLUMBUS" }),
    /no income tax rate has been entered for COLUMBUS \(Ohio\)/,
  );
});

test("Ohio refuses a year it has not transcribed", () => {
  assert.throws(
    () => OH_WITHHOLDING.compute({
      payDate: "2027-01-15", periodEnd: "2027-01-15", periodsPerYear: 26, wages: "3000",
      basis: "resident", certificate: cert("us_oh_it4"),
    }),
    /2027 Ohio income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});

/* ===================================================================== */
/* MICHIGAN — Form 446 and Detroit Form 5469                             */
/* ===================================================================== */

test("Detroit's worked example — weekly $200, resident, 3 exemptions: $3.97", () => {
  // Form 5469 (Rev. 05-25): "Gross pay is $200.00 per week and the wage earner
  // lives in the City of Detroit and has 3 exemptions. The amount taxed is
  // $165.38 ($200.00 - $34.62). Apply the 2.4% resident rate ($165.38 x 0.024),
  // and withhold $3.97 from the employee for the week."
  const result = DETROIT_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "200.00", basis: "resident",
    certificate: cert("us_mi_5527", { exemptions: "3" }),
  });
  assert.equal(result.factors.DETROIT_EXEMPTION_PER_PERIOD, "11.54");
  assert.equal(result.factors.DETROIT_TAXABLE, money("165.38"));
  assert.equal(result.tax, money("3.97"));
});

test("Detroit's nonresident rate is exactly half, and its bonus rule ignores exemptions", () => {
  const nonresident = DETROIT_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "200.00", basis: "nonresident",
    certificate: cert("us_mi_5527", { exemptions: "3" }),
  });
  assert.equal(nonresident.tax, money("1.98")); // 165.38 × 1.2%

  // "For bonuses or other taxable earnings paid in addition to regular payroll,
  // do not adjust for exemptions. Withhold the correct tax percentage from the
  // entire bonus or other taxable earnings amount."
  const withBonus = DETROIT_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "200.00", supplemental: "1000.00",
    basis: "resident", certificate: cert("us_mi_5527", { exemptions: "3" }),
  });
  assert.equal(withBonus.taxSupplemental, money("24.00")); // 1,000 × 2.4%, no exemption
  assert.equal(withBonus.tax, money("27.97"));
});

test("Detroit's printed per-period exemptions are $600 a year, and 260 is not 365", () => {
  // $600 ÷ 52 = $11.538 → $11.54; ÷ 26 → $23.08; ÷ 24 → $25.00; ÷ 12 → $50.00.
  // The printed "per diem/daily" $1.64 is $600 ÷ 365.
  for (const [periods, printed] of Object.entries(MI_RATES_2026.detroit.printedExemption)) {
    assert.equal(
      D(divIntCents(U(MI_RATES_2026.detroit.exemptionPerYear), Number(periods))),
      money(printed),
      `${periods} periods`,
    );
  }
  // A 260-day payroll is refused rather than mapped onto the 365-day column,
  // which would deduct 40% too little exemption every day of the year.
  assert.throws(
    () => DETROIT_WITHHOLDING.compute({
      payDate: "2026-03-06", periodsPerYear: 260, wages: "200.00", basis: "resident",
      certificate: cert("us_mi_5527", { exemptions: "3" }),
    }),
    /publishes withholding tables for/,
  );
});

test("a Detroit resident working in another taxing city: 2.4% MINUS the other city's rate", () => {
  // Form 5469: "the employer must withhold separately for both the City of
  // Detroit and the other city. … Compute the City of Detroit withholding rate
  // by subtracting the other city's nonresident tax rate from 2.4%."
  assert.equal(
    miDetroitResidentRate({ payDate: "2026-03-06", otherCityNonresidentRate: null }),
    "0.024",
  );
  // Working in Grand Rapids (0.75% nonresident) leaves Detroit 1.65%.
  assert.equal(
    miDetroitResidentRate({ payDate: "2026-03-06", otherCityNonresidentRate: "0.0075" }),
    money("0.0165"),
  );
  // Working in a 1%/0.5% city leaves 1.9%.
  assert.equal(
    miDetroitResidentRate({ payDate: "2026-03-06", otherCityNonresidentRate: "0.005" }),
    money("0.019"),
  );
});

test("Michigan's own figures are the guide's masthead — but there is no worked example", () => {
  // NOT CONFORMANCE, and labelled so. Form 446 (Rev. 02-26) prints "Withholding
  // Rate: 4.25%  Personal Exemption Amount: $5,900" and the rule "4.25 percent
  // of compensation after deducting the personal and dependency exemption
  // allowance", and prints no example. Treasury's per-period wage-bracket
  // tables are published separately and michigan.gov refuses automated
  // requests, so they are not transcribed here.
  //
  // What IS evidence: the per-period allowance convention, which Detroit's
  // printed table (a Michigan Treasury table) shows is the annual figure
  // divided by the periods and rounded to the cent.
  assert.equal(MI_RATES_2026.rate, "0.0425");
  assert.equal(MI_RATES_2026.personalExemption, "5900");

  const result = MI_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert("us_mi_miw4", { exemptions: "2" }),
  });
  // $5,900 ÷ 52 = $113.4615 → $113.46 each; two of them is $226.92.
  assert.equal(result.factors.MI_EXEMPTION_PER_PERIOD, money("113.46"));
  assert.equal(result.factors.MI_TAXABLE, money("773.08"));
  assert.equal(result.tax, money("32.86")); // 773.08 × 4.25% = 32.8559
});

test("Michigan's city list is CLOSED, and an unentered rate refuses", () => {
  assert.equal(MI_TAXING_CITIES.length, 24);
  assert.ok(MI_TAXING_CITIES.includes("DETROIT"));
  assert.ok(MI_TAXING_CITIES.includes("HIGHLAND_PARK"));
  assert.throws(
    () => miCityWithholding({
      city: "ANN_ARBOR", wages: "1000", rate: "0.01", exemptionPerYear: "600",
      exemptions: 0, periodsPerYear: 52,
    }),
    /"ANN_ARBOR" is not a Michigan city that levies an income tax/,
  );
  assert.throws(
    () => miCityWithholding({
      city: "SAGINAW", wages: "1000", rate: null, exemptionPerYear: "750",
      exemptions: 0, periodsPerYear: 52,
    }),
    /no income tax rate has been entered for SAGINAW/,
  );
  assert.throws(
    () => miCityWithholding({
      city: "SAGINAW", wages: "1000", rate: "0.015", exemptionPerYear: null,
      exemptions: 0, periodsPerYear: 52,
    }),
    /no annual exemption value has been entered for SAGINAW/,
  );
  // With both supplied it computes on Detroit's own method: Saginaw's exemption
  // is $750 a year, not Detroit's $600, which is why the value is entered
  // rather than assumed.
  const saginaw = miCityWithholding({
    city: "SAGINAW", wages: "1000", rate: "0.015", exemptionPerYear: "750",
    exemptions: 2, periodsPerYear: 52,
  });
  assert.equal(saginaw.factors.MI_CITY_EXEMPTION, money("28.86")); // 2 × 14.43
  assert.equal(saginaw.tax, money("14.57")); // 971.14 × 1.5%
});

/* ===================================================================== */
/* MASSACHUSETTS — Circular M (Rev. 12/25)                               */
/* ===================================================================== */

test("MA supplemental example — $350,000 bonus on a $948,000 salary: $24,854", () => {
  // Circular M p. 13's own worked example, and the only golden in either
  // tranche that no simpler rule reproduces: 9% of the bonus is $31,500 and 5%
  // is $17,500.
  //
  // Step 4: $350,000 + ($948,000 − $2,000 FICA − $4,400 exemption factors) + $0
  // prior = $1,291,600. Step 6: 9% × ($1,291,600 − $1,107,750) + 5% × the
  // remainder = (0.09 × $183,850) + (0.05 × $166,150) = $24,854.
  const result = maSupplementalWithholding({
    payDate: "2026-03-15",
    payment: "350000.00",
    annualizedRegularWagesNet: "941600.00", // 948,000 − 2,000 − 4,400
    priorSupplemental: "0",
  });
  assert.equal(result.factors.MA_SUPP_STEP4, money("1291600"));
  assert.equal(result.factors.MA_SUPP_ABOVE_THRESHOLD, money("183850"));
  assert.equal(result.tax, money("24854"));

  // Below the threshold it is a flat 5% of the payment.
  assert.equal(maSupplementalWithholding({
    payDate: "2026-03-15", payment: "5000.00", annualizedRegularWagesNet: "80000.00",
  }).tax, money("250"));
});

test("MA exemption factors: the printed 'claiming 1' column is the formula at n=1", () => {
  // Circular M prints two columns — a flat figure for "claiming 1" and
  // "$19 multiplied by number claimed, plus $66" for more than one. They agree
  // at n = 1 in every period, which is what makes one formula safe to use for
  // both. Proving it here means an edition where they diverge fails rather than
  // being absorbed.
  for (const [period, factor] of Object.entries(MA_RATES_2026.exemptionFactors)) {
    assert.equal(
      D(U(factor.perExemption) + U(factor.base)),
      money(factor.printedClaimingOne),
      period,
    );
  }
  // …and zero exemptions means NO deduction at all, not the $66 base.
  const zero = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert("us_ma_m4", { total_exemptions: "0" }),
  });
  assert.equal(zero.factors.MA_EXEMPTION_FACTOR, money("0"));
});

test("MA wage-bracket tables and the percentage method DISAGREE, by design", () => {
  // Circular M's weekly bracket table, wages "1,110 but less than 1,120":
  // $53.83 at 0 exemptions, $49.60 at 1, $48.63 at 2.
  //
  // The bracket table taxes the band's MIDPOINT ($1,115) after subtracting the
  // full $2,000-a-year retirement deduction ($38.4615 a week) and the EXACT
  // annual exemption factors divided by 52 ($4,400 ÷ 52 = $84.6154, $1,000 ÷ 52
  // = $19.2308). The percentage method on p. 12 uses ROUNDED per-period factors
  // ($85, and $19 + $66). The two therefore differ by a cent or two, exactly as
  // Illinois's two published methods do, and neither is wrong.
  const exact = (wages: string, exemptions: number) => {
    const perPeriod = U(wages) - divIntCents(U("2000"), 52)
      - (exemptions > 0 ? divIntCents(U("4400") + U("1000") * BigInt(exemptions - 1), 52) : 0n);
    return D(divIntCents(mulRateCents(perPeriod * 52n, "0.05"), 52));
  };
  assert.equal(exact("1115.00", 0), money("53.83"));
  assert.equal(exact("1115.00", 1), money("49.60"));
  assert.equal(exact("1115.00", 2), money("48.63"));

  // The percentage method, with the same facts, lands two cents away at one
  // exemption — and this engine implements the percentage method.
  const percentage = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1115.00", basis: "resident",
    socialInsuranceDeducted: { period: "38.46", yearToDate: "0" },
    certificate: cert("us_ma_m4", { total_exemptions: "1" }),
  });
  assert.equal(percentage.factors.MA_EXEMPTION_FACTOR, money("85"));
  assert.equal(percentage.tax, money("49.58"));
});

test("MA head of household and blindness come off the TAX, and the surtax is annualized", () => {
  const base = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert("us_ma_m4", { total_exemptions: "1" }),
  });
  const hoh = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert("us_ma_m4", { total_exemptions: "1", head_of_household: "true" }),
  });
  // "withhold $2.31 less than the amount shown in the tax column" (weekly).
  assert.equal(D(U(base.tax) - U(hoh.tax)), money("2.31"));

  const bothBlind = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert("us_ma_m4", {
      total_exemptions: "1", blind: "true", spouse_blind: "true",
    }),
  });
  assert.equal(D(U(base.tax) - U(bothBlind.tax)), money("4.24")); // 2 × $2.12

  // The 4% surtax: a weekly wage that annualizes above $1,107,750 carries 9% on
  // the excess. $25,000 a week is $1,300,000 a year.
  const surtaxed = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "25000.00", basis: "resident",
    certificate: cert("us_ma_m4", { total_exemptions: "0" }),
  });
  // 1,300,000 − 1,107,750 = 192,250 at 9% = 17,302.50; 1,107,750 at 5% =
  // 55,387.50; total 72,690.00 ÷ 52 = 1,397.88…
  assert.equal(surtaxed.factors.MA_ANNUAL_TAX, money("72690"));
  assert.equal(surtaxed.tax, money("1397.88"));

  // …and a wage that does not annualize over the threshold is plain 5%.
  const plain = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "2000.00", basis: "resident",
    certificate: cert("us_ma_m4", { total_exemptions: "0" }),
  });
  assert.equal(plain.tax, money("100")); // 2,000 × 5%
});

test("MA does not withhold below the printed wage floor, or from a student", () => {
  // "Do not withhold from employees who claim one or more exemptions if their
  // wages are less than: weekly $154 …"
  const belowFloor = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "150.00", basis: "resident",
    certificate: cert("us_ma_m4", { total_exemptions: "1" }),
  });
  assert.equal(belowFloor.tax, money("0"));
  assert.equal(belowFloor.factors.MA_BELOW_WITHHOLDING_FLOOR, money("154"));

  // The floor applies only where an exemption is claimed — with zero
  // exemptions the same wage is withheld on.
  const noExemption = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "150.00", basis: "resident",
    certificate: cert("us_ma_m4", { total_exemptions: "0" }),
  });
  assert.equal(noExemption.tax, money("7.50"));

  const student = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "500.00", basis: "resident",
    certificate: cert("us_ma_m4", { total_exemptions: "1", student_exempt: "true" }),
  });
  assert.equal(student.tax, money("0"));
});

test("MA accepts a 27-payday biweekly year, which the pack's general mapping does not", () => {
  // Circular M step 3: "multiply the result by the number of periods in the
  // year (52 for weekly, 12 for monthly, 24 for semimonthly and 26 OR 27 for
  // biweekly)".
  const result = MA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 27, wages: "2000.00", basis: "resident",
    certificate: cert("us_ma_m4", { total_exemptions: "1" }),
  });
  assert.equal(result.factors.MA_PERIOD, "biweekly");
  assert.equal(result.factors.MA_EXEMPTION_FACTOR, money("169"));
});

/* ===================================================================== */
/* GEORGIA — Employer's Withholding Tax Guide 2026, both revisions       */
/* ===================================================================== */

const g4 = (over: Record<string, string> = {}) => cert("us_ga_g4", over);

test("GA June 2026 Example #1 — semi-monthly $2,000, married one income, 1 dependent: $27.03", () => {
  // "Step 1: Total Taxable Wages $2,000.00; Less Standard Deduction $1250.00
  //  per Table E (1); Step 2: Less Dependent Allowance $208.33 X 1; Wages
  //  subject to withholding 541.67; Step 3: Multiply 541.67 x 0.0499 = 27.03."
  const result = GA_WITHHOLDING.compute({
    payDate: "2026-06-15", periodsPerYear: 24, wages: "2000.00", basis: "resident",
    certificate: g4({ marital_status: "C", dependent_allowances: "1" }),
  });
  assert.equal(result.factors.GA_RATE, "0.0499");
  assert.equal(result.factors.GA_STANDARD_DEDUCTION, "1250.00");
  assert.equal(result.factors.GA_TAXABLE, money("541.67"));
  assert.equal(result.tax, money("27.03"));
});

test("GA June 2026 Example #2 — head of household biweekly $935, 2 dependents: $0.00", () => {
  // "$935.00 less $576.92 less $384.62 … The person would have $0 withheld."
  // The subtraction goes negative and the guide prints $0.00 rather than a
  // refund, which is what `max0` does.
  const result = GA_WITHHOLDING.compute({
    payDate: "2026-06-15", periodsPerYear: 26, wages: "935.00", basis: "resident",
    certificate: g4({ marital_status: "D", dependent_allowances: "2" }),
  });
  assert.equal(result.factors.GA_STANDARD_DEDUCTION, "576.92");
  assert.equal(result.factors.GA_TAXABLE, money("0"));
  assert.equal(result.tax, money("0"));
});

test("GA December 2025 example — semi-monthly $1,470.83 at 5.19%: $15.79", () => {
  // The edition in force for the first four months of 2026, with its own
  // worked example: $1,470.83 − $1,000.00 − $166.67 = $304.16 × 0.0519 = 15.79.
  const result = GA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1470.83", basis: "resident",
    certificate: g4({ marital_status: "C", dependent_allowances: "1" }),
  });
  assert.equal(result.factors.GA_RATE, "0.0519");
  assert.equal(result.factors.GA_TAXABLE, money("304.16"));
  assert.equal(result.tax, money("15.79"));
});

test("GA's rate change is keyed to 11 May 2026, not to 1 January", () => {
  // "Employers must continue to withhold at the rate of 5.19% BEFORE the
  // effective date of the change and can begin withholding at the new rate of
  // 4.99%, starting May 11, 2026" — even though the rate cut is retroactive to
  // 1 January for the RETURN.
  assert.equal(gaEditionForPayDate("2026-05-10").rate, "0.0519");
  assert.equal(gaEditionForPayDate("2026-05-11").rate, "0.0499");
  assert.equal(gaEditionForPayDate("2026-01-01").rate, "0.0519");
});

test("GA Table E and Table F are one schedule printed twice", () => {
  // Both revisions print "TABLE E — EXAMPLE #1" and "TABLE F — EXAMPLE #2" with
  // identical figures. Pinned so an edition where they diverge is caught.
  for (const edition of GA_EDITIONS) {
    assert.deepEqual(edition.tableE, edition.tableF, edition.effectiveFrom);
  }
});

test("GA's marital letters pick the column the guide's NOTE says they do", () => {
  // "Married couples, both having income, should use the standard deduction
  // allowed in column (3)" — so B is the SINGLE-sized deduction, not the joint
  // one. Reading B as "married therefore joint" doubles a two-earner couple's
  // deduction.
  const at = (status: string) => GA_WITHHOLDING.compute({
    payDate: "2026-06-15", periodsPerYear: 24, wages: "3000.00", basis: "resident",
    certificate: g4({ marital_status: status }),
  }).factors.GA_STANDARD_DEDUCTION;
  assert.equal(at("A"), "625.00");
  assert.equal(at("B"), "625.00");
  assert.equal(at("C"), "1250.00");
  assert.equal(at("D"), "625.00");

  // Line 7 totals lines 4 and 5, and the employer uses the total.
  const both = GA_WITHHOLDING.compute({
    payDate: "2026-06-15", periodsPerYear: 24, wages: "3000.00", basis: "resident",
    certificate: g4({ marital_status: "A", dependent_allowances: "1", adjustment_allowances: "2" }),
  });
  assert.equal(both.factors.GA_ALLOWANCES, "3");
  assert.equal(both.factors.GA_ALLOWANCE_VALUE, money("624.99")); // 3 × 208.33
});

/* ===================================================================== */
/* NORTH CAROLINA — NC-30 (2026)                                         */
/* ===================================================================== */

const nc4 = (over: Record<string, string> = {}) => cert("us_nc_nc4", over);

test("NC percentage method example — weekly $450, single, 2 allowances: $4.00", () => {
  // NC-30 p. 18: "1. Enter weekly wages $450.00; 2. Weekly portion of N.C.
  // standard deduction $245.19; 3. Multiply the number of allowances by $48.08
  // → $96.16; 4. Add → $341.35; 5. Net weekly wages $108.65; 6. Multiply by
  // .0409 (round to the nearest whole dollar) → $4.00."
  const result = NC_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "450.00", basis: "resident",
    certificate: nc4({ filing_status: "single_or_separate", allowances: "2" }),
  });
  assert.equal(result.factors.NC_STANDARD_DEDUCTION, money("245.19"));
  assert.equal(result.factors.NC_ALLOWANCES, money("96.16"));
  assert.equal(result.factors.NC_NET_WAGES, money("108.65"));
  assert.equal(result.tax, money("4"));
});

test("NC annualized method example — the same facts, the same $4.00", () => {
  // NC-30 p. 19: annualized wages $23,400.00, less $12,750.00 and $5,000.00 =
  // $5,650.00; × .0409 = $231.09; ÷ 52 = $4.00.
  const result = ncAnnualizedMethod({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "450.00",
    schedule: "single_married_surviving", allowances: 2,
  });
  assert.equal(result.annualTax, money("231.09"));
  assert.equal(result.tax, money("4"));
});

test("NC withholds at 4.09%, which is NOT the 3.99% income tax rate", () => {
  // Printed at the head of every NC-30 formula table: "the individual income
  // tax rate of 3.99% plus 0.1%. This results in a withholding tax rate of
  // 4.09%." Correcting it to the statutory rate under-withholds every North
  // Carolina employee.
  assert.equal(NC_RATES_2026.incomeTaxRate, "0.0399");
  assert.equal(NC_RATES_2026.withholdingRate, "0.0409");
  assert.notEqual(NC_RATES_2026.incomeTaxRate, NC_RATES_2026.withholdingRate);
});

test("NC rounds to the DOLLAR, and only at the end", () => {
  // $1,000 weekly, single, no allowances: 1,000 − 245.19 = 754.81 × .0409 =
  // $30.87, which rounds to $31.
  const result = NC_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: nc4({ filing_status: "single_or_separate" }),
  });
  assert.equal(result.factors.NC_NET_WAGES, money("754.81"));
  assert.equal(result.tax, money("31"));
  // The supplemental flat election rounds the same way: $5,000 × 4.09% =
  // $204.50 → $205.
  assert.equal(ncSupplementalFlat("2026-03-06", "5000.00"), money("205"));
});

test("NC's head-of-household schedule is a different standard deduction", () => {
  const hoh = NC_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: nc4({ filing_status: "head_household" }),
  });
  assert.equal(hoh.factors.NC_SCHEDULE, "head_household");
  assert.equal(hoh.factors.NC_STANDARD_DEDUCTION, money("367.79"));
  assert.equal(hoh.tax, money("26")); // 632.21 × .0409 = 25.86
  // "Married Filing Jointly or Surviving Spouse" shares the single schedule,
  // which is the printed table's own heading.
  const joint = NC_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: nc4({ filing_status: "joint_or_surviving" }),
  });
  assert.equal(joint.factors.NC_SCHEDULE, "single_married_surviving");
});

test("NC's per-period standard deductions are the annual figures, divided", () => {
  // NC-30 prints both, and they have to agree: $12,750 ÷ 52 = $245.19,
  // ÷ 26 = $490.38, ÷ 24 = $531.25, ÷ 12 = $1,062.50; head of household
  // $19,125 the same way; the allowance $2,500 the same way.
  const divisors: Record<string, number> = {
    weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12,
  };
  for (const [period, periods] of Object.entries(divisors)) {
    const values = NC_RATES_2026.periods[period as keyof typeof NC_RATES_2026.periods];
    for (const schedule of ["single_married_surviving", "head_household"] as const) {
      assert.equal(
        D(divIntCents(U(NC_RATES_2026.annual.standardDeduction[schedule]), periods)),
        money(values.standardDeduction[schedule]),
        `${period}/${schedule}`,
      );
    }
    assert.equal(
      D(divIntCents(U(NC_RATES_2026.annual.allowance), periods)),
      money(values.allowance),
      `${period} allowance`,
    );
  }
});

test("NC refuses a frequency it prints no table for, rather than scaling one", () => {
  assert.throws(
    () => NC_WITHHOLDING.compute({
      payDate: "2026-03-06", periodsPerYear: 4, wages: "10000", basis: "resident",
      certificate: nc4(),
    }),
    /publishes withholding tables for .*there is nothing to scale/s,
  );
  // The state's own answer for that payroll is the annualized method.
  assert.ok(ncAnnualizedMethod({
    payDate: "2026-03-06", periodsPerYear: 4, wages: "10000",
    schedule: "single_married_surviving", allowances: 0,
  }).tax);
});

/* ===================================================================== */
/* EVERY NEW ENGINE REFUSES AN UNTRANSCRIBED YEAR                        */
/* ===================================================================== */

test("no engine in this tranche will calculate a year it has not transcribed", () => {
  const cases: readonly [string, () => unknown][] = [
    ["NJ", () => NJ_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000", basis: "resident",
      certificate: njw4(),
    })],
    ["MI", () => MI_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000", basis: "resident",
      certificate: cert("us_mi_miw4"),
    })],
    ["MA", () => MA_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000", basis: "resident",
      certificate: cert("us_ma_m4"),
    })],
    ["GA", () => GA_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000", basis: "resident",
      certificate: g4(),
    })],
    ["NC", () => NC_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000", basis: "resident",
      certificate: nc4(),
    })],
    ["OH", () => OH_WITHHOLDING.compute({
      payDate: "2027-01-15", periodEnd: "2027-01-15", periodsPerYear: 52, wages: "1000",
      basis: "resident", certificate: cert("us_oh_it4"),
    })],
  ];
  for (const [state, run] of cases) {
    assert.throws(run, /2027 .* withholding tables are not loaded/, state);
    assert.throws(run, /Never extrapolate the prior year/, state);
  }
});
