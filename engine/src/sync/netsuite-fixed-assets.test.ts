import assert from "node:assert/strict";
import test from "node:test";
import { netSuiteFamDate, netSuiteFamPeriodForDate, netSuiteFamState } from "./netsuite-fixed-assets.ts";


test("NetSuite FAM dates remain date-only", () => {
  assert.equal(netSuiteFamDate("11/14/2021"), "2021-11-14");
  assert.equal(netSuiteFamDate("2026-07-21T14:00:00Z"), "2026-07-21");
  assert.equal(netSuiteFamDate(null), null);
});

test("NetSuite FAM depreciation dates outside the accounting calendar are not shifted", () => {
  const periods = [
    { id: "2026-12", starts_on: "2026-12-01", ends_on: "2026-12-31", is_adjustment: false },
  ];
  assert.equal(netSuiteFamPeriodForDate(periods, "2027-01-15"), null);
  assert.equal(netSuiteFamPeriodForDate(periods, "2026-12-15")?.id, "2026-12");
});

test("NetSuite FAM state reconciles current cost to exact book value", () => {
  const state = netSuiteFamState(
    { id: "2", custrecord_assetcurrentcost: "20316.15" },
    { custrecord_slavebookvalue: "19477.38" },
    [{ id: "3", custrecord_deprhistamount: "19477.38" }],
  );
  assert.deepEqual(
    { cost: state.cost, accumulated: state.accumulated, bookValue: state.bookValue },
    { cost: "20316.1500", accumulated: "838.7700", bookValue: "19477.3800" },
  );
});

test("NetSuite FAM state refuses a carrying value above cost", () => {
  assert.throws(
    () => netSuiteFamState(
      { id: "bad", custrecord_assetcurrentcost: "10" },
      { custrecord_slavebookvalue: "10.01" },
      [],
    ),
    /book value .* above current cost/,
  );
});
