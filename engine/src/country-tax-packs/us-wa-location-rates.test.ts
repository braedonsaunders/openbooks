import assert from "node:assert/strict";
import test from "node:test";
import {
  loadWaLocationRateQuarter,
  parseWaLocationRateCsv,
  waLocationQuarterWindow,
  waLocationRateOn,
  WA_LOCATION_RATE_FIXTURE,
} from "./us-wa-location-rates.ts";

const SOURCE = {
  id: "wa_dor_lsu_q4_2026",
  title: "Washington Department of Revenue — Local sales and use tax rates, quarter 4 2026",
  url: "https://dor.wa.gov/sites/default/files/2026-08/Q426_Excel_LSU-rates-alpha.xlsx",
  asOf: "2026-10-10",
};

/** CSV export shape of the department workbook: title row, header, data, footnotes. */
const WORKBOOK_CSV = [
  '"#VALUE!","Local Sales & Use Tax Rates, Effective October 1 - December 31, 2026",,,,',
  "County,Location name,Location code,Local rate,State rate,Combined sales tax (1),,",
  "Pierce,Tacoma,2717,0.04,0.065,0.10500000000000001,,",
  "King,Algona,1701,0.039,0.065,0.104,,",
  '"Adams","Adams County Unincorp. Areas",100,0.015,0.065,0.08,,',
  ",,,,,,",
  ',"Footnotes: (1) Combined sales tax includes the 6.5% state rate, and the local rate.",,,,,',
].join("\n");

test("quarter ids stamp calendar-quarter windows", () => {
  assert.deepEqual(waLocationQuarterWindow("2026-Q4"), { effectiveFrom: "2026-10-01", effectiveTo: "2026-12-31" });
  assert.deepEqual(waLocationQuarterWindow("2026-Q2"), { effectiveFrom: "2026-04-01", effectiveTo: "2026-06-30" });
  assert.throws(() => waLocationQuarterWindow("2026-Q5"), /yyyy-Qn/);
  assert.throws(() => waLocationQuarterWindow("Q4-2026"), /yyyy-Qn/);
});

test("the CSV reader takes the workbook export with float artifacts and footnotes", () => {
  const rows = parseWaLocationRateCsv(WORKBOOK_CSV);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    county: "Pierce",
    locationName: "Tacoma",
    locationCode: "2717",
    localRate: "0.04",
    stateRate: "0.065",
    combinedRate: "0.105",
  });
});

test("the CSV reader refuses a missing header and an empty sheet", () => {
  assert.throws(() => parseWaLocationRateCsv("Pierce,Tacoma,2717,0.04,0.065,0.105\n"), /no department header row/);
  assert.throws(
    () => parseWaLocationRateCsv("County,Location name,Location code,Local rate,State rate,Combined sales tax\n"),
    /no location rows/,
  );
});

test("the loader stamps quarters, converts decimals to percents, and checks the arithmetic", () => {
  const table = loadWaLocationRateQuarter({
    quarter: "2026-Q4",
    source: SOURCE,
    expectedStateRatePercent: "6.5",
    rows: parseWaLocationRateCsv(WORKBOOK_CSV),
  });
  assert.deepEqual(table[0], {
    county: "Pierce",
    locationName: "Tacoma",
    locationCode: "2717",
    localRatePercent: "4",
    stateRatePercent: "6.5",
    combinedRatePercent: "10.5",
    effectiveFrom: "2026-10-01",
    effectiveTo: "2026-12-31",
    sourceId: "wa_dor_lsu_q4_2026",
  });
  assert.equal(table[1]?.combinedRatePercent, "10.4");
  assert.equal(table[2]?.combinedRatePercent, "8");
});

test("the loader refuses an edited combined rate, a moved state share, and a doubled code", () => {
  const rows = parseWaLocationRateCsv(WORKBOOK_CSV);
  assert.throws(
    () =>
      loadWaLocationRateQuarter({
        quarter: "2026-Q4",
        source: SOURCE,
        expectedStateRatePercent: "6.5",
        rows: [{ ...rows[0]!, combinedRate: "0.106" }],
      }),
    /does not add up/,
  );
  assert.throws(
    () =>
      loadWaLocationRateQuarter({
        quarter: "2026-Q4",
        source: SOURCE,
        expectedStateRatePercent: "6.5",
        rows: [{ ...rows[0]!, stateRate: "0.066", combinedRate: "0.106" }],
      }),
    /instead of the expected 6.5%/,
  );
  assert.throws(
    () =>
      loadWaLocationRateQuarter({
        quarter: "2026-Q4",
        source: SOURCE,
        expectedStateRatePercent: "6.5",
        rows: [...rows, rows[0]!],
      }),
    /repeats location code 2717/,
  );
  assert.throws(
    () =>
      loadWaLocationRateQuarter({
        quarter: "2026-Q4",
        source: SOURCE,
        expectedStateRatePercent: "6.5",
        rows: [{ ...rows[0]!, locationCode: "Tacoma" }],
      }),
    /no numeric DOR location code/,
  );
});

test("lookup follows quarters: Tacoma moves from 10.4% to 10.5% on July 1, 2026", () => {
  const june = waLocationRateOn(WA_LOCATION_RATE_FIXTURE, "2717", "2026-06-30");
  assert.equal(june?.combinedRatePercent, "10.4");
  assert.equal(june?.sourceId, "wa_dor_lsu_q2_2026");
  const july = waLocationRateOn(WA_LOCATION_RATE_FIXTURE, "2717", "2026-07-01");
  assert.equal(july?.combinedRatePercent, "10.5");
  assert.equal(july?.sourceId, "wa_dor_lsu_q3_2026");
  assert.equal(waLocationRateOn(WA_LOCATION_RATE_FIXTURE, "9999", "2026-10-15"), undefined);
  assert.equal(waLocationRateOn(WA_LOCATION_RATE_FIXTURE, "2717", "2027-01-01"), undefined);
});
