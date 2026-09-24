/**
 * New Mexico withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from FYI-104, New Mexico Withholding
 * Tax, REV. 11/2025 ("Effective January 1, 2026"), Tables 1–8 for the
 * percentage method of withholding, or is those figures' own arithmetic.
 * Nothing here was produced by running the engine and pasting the answer.
 *
 * The publication's own worked example (pp. 2–3) is the anchor: a married
 * employee with $1,000.00 weekly wages and $20.00 additional withholding —
 * "If the amount of wages is over $790 but not over $1,098, the amount of
 * state tax withheld shall be $12.77 + 4.3% of excess over $790",
 * "$1000.00-$790.00 = $210.00 x 0.043 = $9.03", "$12.77 + $9.03 = $21.80",
 * "$21.80 + $20.00 ... = $41.80".
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";
import {
  NM_CERTIFICATE, NM_REGION, NM_RATES_2026, NM_WITHHOLDING, nmScheduleFor,
  nmSupplementalFlat,
} from "./nm.ts";
import { pctToRate } from "./transcription.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(NM_CERTIFICATE, answers);

const compute = (
  args: {
    payDate?: string; periodsPerYear?: number; wages: string; supplemental?: string;
    answers?: Record<string, string>;
  },
) => NM_WITHHOLDING.compute({
  payDate: args.payDate ?? "2026-03-15",
  periodsPerYear: args.periodsPerYear ?? 52,
  wages: args.wages,
  supplemental: args.supplemental,
  basis: "resident",
  certificate: cert(args.answers ?? { filing_status: "single" }),
});

test("NM certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(NM_CERTIFICATE), null);
  assert.equal(NM_REGION.implemented, true);
  assert.equal(NM_REGION.certificateKey, "us_nm_w4");
  assert.equal(NM_REGION.subRegions.length, 0);
  assert.equal(NM_REGION.taxesNonresidentWages, true);
});

test("NM printed percents are the tables' own figures", () => {
  assert.equal(pctToRate("1.5"), "0.015");
  assert.equal(pctToRate("4.3"), "0.043");
  assert.equal(pctToRate("5.9"), "0.059");
  assert.notEqual(pctToRate("5.9"), pctToRate("4.9"));
  // The flat supplemental rate FYI-104 p. 4 prints, carried in the
  // edition data like its siblings — never hard-coded at the call site.
  assert.equal(NM_RATES_2026.supplementalRate, pctToRate("5.9"));
  assert.equal(nmSupplementalFlat("200.00"), money("11.80"));
  assert.equal(nmSupplementalFlat("1000.00"), money("59"));
});

test("NM every schedule chains without gaps or overlaps", () => {
  // A transcription slip (a dropped or doubled boundary) shows up here, not
  // on a stub: 24 schedules × 10 rows each.
  let rows = 0;
  for (const status of ["single", "married", "head_household"] as const) {
    for (const period of Object.keys(NM_RATES_2026.tables[status])) {
      const table = NM_RATES_2026.tables[status][period as keyof typeof NM_RATES_2026.tables.single];
      assert.equal(table.rows.length, 10, `${status} ${period} has ${table.rows.length} rows`);
      assert.equal(table.rows[0]!.over, "0", `${status} ${period} bottom row`);
      for (let i = 1; i < table.rows.length; i++) {
        assert.equal(
          table.rows[i]!.over, table.rows[i - 1]!.butNotOver,
          `${status} ${period} row ${i} does not chain`,
        );
      }
      assert.equal(table.rows[table.rows.length - 1]!.butNotOver, null);
      rows += table.rows.length;
    }
  }
  assert.equal(rows, 240);
});

test("NM publication worked example — married, $1,000 weekly + $20 additional = $41.80", () => {
  const result = compute({
    wages: "1000.00",
    answers: { filing_status: "married", additional_per_period: "20.00" },
  });
  assert.equal(result.state, "NM");
  assert.equal(result.year, 2026);
  assert.equal(result.factors.NM_STATUS, "married");
  assert.equal(result.factors.NM_WAGES, money("1000"));
  assert.equal(result.factors.NM_BRACKET_RATE, "4.3");
  assert.equal(result.factors.NM_TABLE_TAX, money("21.80"));
  assert.equal(result.tax, money("41.80"));
  assert.equal(result.taxSupplemental, money("0"));
});

test("NM single and head-of-household columns at $1,000 weekly", () => {
  // Single Table 1(a): over $799 but not over $1,126: $22.41 + 4.7% of
  // excess over $799. 201 × 4.7% = 9.447 → $9.45; $22.41 + $9.45 = $31.86.
  const single = compute({ wages: "1000.00" });
  assert.equal(single.factors.NM_BRACKET_RATE, "4.7");
  assert.equal(single.factors.NM_TABLE_TAX, money("31.86"));
  assert.equal(single.tax, money("31.86"));
  // Head Table 1(c): over $713 but not over $1,021: $12.77 + 4.3% of excess
  // over $713. 287 × 4.3% = 12.341 → $12.34; $12.77 + $12.34 = $25.11.
  const head = compute({ wages: "1000.00", answers: { filing_status: "head_household" } });
  assert.equal(head.factors.NM_STATUS, "head_household");
  assert.equal(head.factors.NM_BRACKET_RATE, "4.3");
  assert.equal(head.tax, money("25.11"));
});

test("NM bracket boundaries are (over, not-over]: the top belongs to the lower line", () => {
  // Exactly on a breakpoint the LOWER line applies — its "But Not Over" is
  // inclusive while the next line's "Over" is exclusive.
  assert.equal(compute({ wages: "155.00" }).tax, money("0"));
  // $261 single: 106 × 1.5% = $1.59 exact.
  assert.equal(compute({ wages: "261.00" }).tax, money("1.59"));
  assert.equal(
    compute({ wages: "310.00", answers: { filing_status: "married" } }).tax, money("0"),
  );
  // $463 married: the lower line's own arithmetic, 153 × 1.5% = $2.295 →
  // $2.30 — NOT the next line's printed $2.31 base, which is the
  // publication's own rounding carried forward. The next dollar enters the
  // upper line: $464 → $2.31 + 3.2% of $1 ($0.032 → $0.03) = $2.34.
  assert.equal(
    compute({ wages: "463.00", answers: { filing_status: "married" } }).tax, money("2.30"),
  );
  assert.equal(
    compute({ wages: "464.00", answers: { filing_status: "married" } }).tax, money("2.34"),
  );
});

test("NM Table 3 follows the schedule past the misprinted head line", () => {
  // Table 3 (semimonthly) heads column (a) "Not Over $304 → $0.00" but its
  // first schedule line reads "Over $335". The engine follows the schedule
  // (see nm.ts): $320 is inside the zero row, $335 is its top, $340 pays
  // 1.5% of $5 = $0.075 → $0.08.
  const semimonthly = (wages: string, answers: Record<string, string>) =>
    compute({ periodsPerYear: 24, wages, answers });
  assert.equal(semimonthly("320.00", { filing_status: "single" }).tax, money("0"));
  assert.equal(semimonthly("335.00", { filing_status: "single" }).tax, money("0"));
  assert.equal(semimonthly("340.00", { filing_status: "single" }).tax, money("0.08"));
  // The married head line prints $608 against a first "Over" of $671.
  assert.equal(semimonthly("650.00", { filing_status: "married" }).tax, money("0"));
  // The head-of-household head line prints $456 against $503.
  assert.equal(semimonthly("500.00", { filing_status: "head_household" }).tax, money("0"));
});

test("NM married at the higher single rate uses the single column", () => {
  assert.equal(nmScheduleFor({ filingStatus: "married", higherSingleRate: true }), "single");
  assert.equal(nmScheduleFor({ filingStatus: "married", higherSingleRate: false }), "married");
  assert.equal(
    nmScheduleFor({ filingStatus: "head_household", higherSingleRate: false }), "head_household",
  );
  assert.equal(nmScheduleFor({ filingStatus: null, higherSingleRate: false }), "single");
  const higher = compute({
    wages: "1000.00",
    answers: { filing_status: "married", higher_single_rate: "true" },
  });
  assert.equal(higher.factors.NM_STATUS, "single");
  assert.equal(higher.tax, money("31.86"));
});

test("NM other periods read their own tables", () => {
  // Biweekly Table 2(a): over $944 but not over $1,290: $16.71 + 4.3% of
  // excess over $944. 56 × 4.3% = 2.408 → $2.41; $16.71 + $2.41 = $19.12.
  assert.equal(
    compute({ periodsPerYear: 26, wages: "1000.00" }).tax, money("19.12"),
  );
  // Married biweekly Table 2(b): over $1,581 but not over $2,196: $25.54 +
  // 4.3% of excess over $1,581. 419 × 4.3% = 18.017 → $18.02; total $43.56.
  assert.equal(
    compute({
      periodsPerYear: 26, wages: "2000.00", answers: { filing_status: "married" },
    }).tax,
    money("43.56"),
  );
  // Daily Table 8(a): over $94.40 but not over $129.00: $1.67 + 4.3% of
  // excess over $94.40. 5.60 × 4.3% = 0.2408 → $0.24; total $1.91. The
  // table is 260-calibrated, so only a 260-day daily payroll reads it.
  assert.equal(
    compute({ periodsPerYear: 260, wages: "100.00" }).tax, money("1.91"),
  );
  // Annual Table 7(a): over $41,550 but not over $58,550: $1,165.50 + 4.7%
  // of excess over $41,550. 8,450 × 4.7% = $397.15 exact; total $1,562.65.
  assert.equal(
    compute({ periodsPerYear: 1, wages: "50000.00" }).tax, money("1562.65"),
  );
});

test("NM under a dollar a month is not withheld — monthly payrolls only", () => {
  // Monthly Table 4(a): over $671 but not over $1,129: 1.5% of excess over
  // $671. 29 × 1.5% = $0.435 → $0.44, under the dollar FYI-104 p. 2 excuses.
  const small = compute({ periodsPerYear: 12, wages: "700.00" });
  assert.equal(small.tax, money("0"));
  assert.equal(small.factors.NM_DE_MINIMIS, money("0.44"));
  // $800 monthly: 129 × 1.5% = $1.935 → $1.94, over the dollar, withheld.
  assert.equal(compute({ periodsPerYear: 12, wages: "800.00" }).tax, money("1.94"));
  // A weekly $0.44 is NOT excused: the month aggregates periods the engine
  // never sees, so the rule applies where it is decidable and nowhere else.
  assert.equal(compute({ periodsPerYear: 52, wages: "700.00" }).tax, money("18.17"));
});

test("NM supplemental paid with regular wages is aggregated", () => {
  const aggregated = compute({ wages: "800.00", supplemental: "200.00" });
  const together = compute({ wages: "1000.00" });
  assert.equal(aggregated.tax, together.tax);
  assert.equal(aggregated.tax, money("31.86"));
  assert.equal(aggregated.taxSupplemental, money("0"));
  // ...while a payment that stood alone takes the 5.9% flat, not the table.
  assert.equal(nmSupplementalFlat("200.00"), money("11.80"));
  assert.notEqual(aggregated.tax, nmSupplementalFlat("200.00"));
});

test("NM extra withholding is added and exempt is zero", () => {
  const extra = compute({
    wages: "1000.00", answers: { filing_status: "single", additional_per_period: "10.00" },
  });
  assert.equal(extra.tax, money("41.86"));
  assert.equal(compute({ wages: "1000.00", answers: { exempt: "true" } }).tax, money("0"));
});

test("NM no certificate withholds from the single column", () => {
  const empty = NM_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00",
    basis: "resident",
    certificate: resolvedCertificate(NM_CERTIFICATE),
  });
  assert.equal(empty.factors.NM_STATUS, "single");
  assert.equal(empty.tax, money("31.86"));
});

test("NM refuses a year it has not transcribed", () => {
  assert.throws(
    () => compute({ payDate: "2027-01-15", wages: "1000.00" }),
    /2027 New Mexico withholding tax withholding tables are not available in this pack version.*update the pack.*Never extrapolate the prior year/s,
  );
});

test("NM refuses a pay frequency it prints no table for", () => {
  assert.throws(
    () => compute({ periodsPerYear: 27, wages: "1000.00" }),
    /publishes withholding tables for weekly, biweekly, semimonthly, monthly, quarterly, semiannual, annual, daily/s,
  );
  // The daily tables are 260-calibrated: a 365-day daily payroll has no
  // printed table and is refused, not scaled.
  assert.throws(
    () => compute({ periodsPerYear: 365, wages: "100.00" }),
    /publishes withholding tables for .*there is nothing to scale/s,
  );
});
