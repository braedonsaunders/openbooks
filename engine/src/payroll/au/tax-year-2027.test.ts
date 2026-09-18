/**
 * AU 2026–27 transcribed tables: every legislated figure present and quoted,
 * edition resolution refusing out-of-range pay dates, refusals named.
 * No engine assertions here — those live in au-goldens.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AU_HELP_2027,
  AU_MEDICARE_2027,
  AU_NONRESIDENT_BANDS_2027,
  AU_REFUSED_2027,
  AU_RESIDENT_BANDS_2027,
  AU_SUPER_2027,
  AU_WHM_BANDS_2027,
  auTablesForPayDate,
} from "./tax-year-2027.ts";

test("AU 2026–27 resident bands match Schedule 7 Part I", () => {
  assert.deepEqual(AU_RESIDENT_BANDS_2027, [
    { from: "18200", upTo: "45000", rate: "0.15" },
    { from: "45000", upTo: "135000", rate: "0.30" },
    { from: "135000", upTo: "190000", rate: "0.37" },
    { from: "190000", upTo: null, rate: "0.45" },
  ]);
});

test("AU 2026–27 non-resident bands match Schedule 7 Part II", () => {
  assert.deepEqual(AU_NONRESIDENT_BANDS_2027, [
    { from: "0", upTo: "135000", rate: "0.30" },
    { from: "135000", upTo: "190000", rate: "0.37" },
    { from: "190000", upTo: null, rate: "0.45" },
  ]);
});

test("AU 2026–27 working-holiday-maker bands match Schedule 7 Part III", () => {
  assert.deepEqual(AU_WHM_BANDS_2027, [
    { from: "0", upTo: "45000", rate: "0.15" },
    { from: "45000", upTo: "135000", rate: "0.30" },
    { from: "135000", upTo: "190000", rate: "0.37" },
    { from: "190000", upTo: null, rate: "0.45" },
  ]);
});

test("AU 2026–27 Medicare levy figures match MLA ss3/6/7", () => {
  assert.deepEqual(AU_MEDICARE_2027, {
    rate: "0.02",
    threshold: "28011",
    phaseInLimit: "35013",
    shadeRate: "0.10",
  });
});

test("AU 2026–27 super charge is 12% with the max-base formula", () => {
  assert.equal(AU_SUPER_2027.chargeRate, "0.12");
  assert.equal(AU_SUPER_2027.maxBaseNumerator, "100");
});

test("AU 2026–27 HELP figures match HESA plus Gazette C2026G00249", () => {
  assert.deepEqual(AU_HELP_2027, {
    minimumIncome: "69528",
    secondBandCap: "129717",
    firstRate: "0.15",
    secondRate: "0.17",
    incomeCapRate: "0.10",
  });
});

test("AU edition resolution accepts FY2026–27 pay dates only", () => {
  assert.equal(auTablesForPayDate("2026-07-01").taxYear, 2027);
  assert.equal(auTablesForPayDate("2027-01-15").taxYear, 2027);
  assert.equal(auTablesForPayDate("2027-06-30").taxYear, 2027);
  assert.throws(() => auTablesForPayDate("2026-06-30"), /no transcribed PAYG tables/);
  assert.throws(() => auTablesForPayDate("2027-07-01"), /no transcribed PAYG tables/);
  assert.throws(() => auTablesForPayDate("2028-01-01"), /no transcribed PAYG tables/);
});

test("AU refusals name every untranscribed scale and cap", () => {
  const joined = AU_REFUSED_2027.join("\n");
  for (const name of [
    "scale 4",
    "scales 5 and 6",
    "Schedule 15",
    "Schedules 2, 3, 4, 6, 7, 9, 10, 11, 12, 13 and 14",
    "surcharge",
    "family reduction s8",
    "160AAAA",
    "maximum contributions base",
    "repayable-debt",
    "53-week",
    "payroll tax",
  ]) {
    assert.match(joined, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `refusal missing: ${name}`);
  }
});
