import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeNetSuiteAccountingPeriods,
  normalizeNetSuiteTaxCodes,
} from "./netsuite-source.ts";

test("NetSuite fiscal periods retain the source close flags", () => {
  const periods = normalizeNetSuiteAccountingPeriods([
    {
      id: "fy",
      periodname: "FY 2026",
      startdate: "04/01/2025",
      enddate: "03/31/2026",
      isyear: "T",
      isposting: "F",
      isadjust: "F",
      closed: "F",
    },
    {
      id: "apr",
      periodname: "Apr 2025",
      startdate: "04/01/2025",
      enddate: "04/30/2025",
      isyear: "F",
      isposting: "T",
      isadjust: "F",
      closed: "T",
      alllocked: "T",
      aplocked: "T",
      arlocked: "T",
      closedondate: "05/01/2025",
    },
    {
      id: "may",
      periodname: "May 2025",
      startdate: "05/01/2025",
      enddate: "05/31/2025",
      isyear: "F",
      isposting: "T",
      isadjust: "F",
      closed: "F",
      alllocked: "F",
      aplocked: "T",
      arlocked: "F",
    },
  ]);
  assert.equal(periods.length, 2);
  assert.deepEqual(periods[0]?.fields, {
    name: "Apr 2025",
    fiscalYear: 2026,
    periodNumber: 1,
    startsOn: "2025-04-01",
    endsOn: "2025-04-30",
    isAdjustment: false,
    closed: true,
    allLocked: true,
    apLocked: true,
    arLocked: true,
    closedAt: "2025-05-01",
  });
  assert.equal(periods[1]?.fields.closed, false);
  assert.equal(periods[1]?.fields.apLocked, true);
  assert.equal(periods[1]?.fields.arLocked, false);
});

test("NetSuite tax codes keep the source names and mark a colliding group without internal ids", () => {
  const taxCodes = normalizeNetSuiteTaxCodes(
    [{ id: "2525", itemid: "HST", rate: "0.13", isinactive: "F" }],
    [
      { id: "2529", itemid: "HST", rate: "0.13", isinactive: "F" },
      { id: "2823", itemid: "HST_NB", rate: "0.15", isinactive: "F" },
    ],
  );
  assert.deepEqual(
    taxCodes.map((code) => ({
      sourceRef: code.sourceRef,
      code: code.fields.code,
      name: code.fields.name,
      ratePercent: code.fields.ratePercent,
    })),
    [
      { sourceRef: "2525", code: "HST", name: "HST", ratePercent: "13.0000" },
      { sourceRef: "2529", code: "HST (tax group)", name: "HST", ratePercent: "13.0000" },
      { sourceRef: "2823", code: "HST_NB", name: "HST_NB", ratePercent: "15.0000" },
    ],
  );
});

test("NetSuite tax group codes stay unique and stable whatever order the source lists them in", () => {
  const items = [{ id: "10", itemid: "GST", rate: "0.05", isinactive: "F" }];
  const groups = [
    { id: "31", itemid: "GST", rate: "0.05", isinactive: "F" },
    { id: "30", itemid: "GST", rate: "0.15", isinactive: "T" },
    { id: "32", itemid: "GST", rate: "0.05", isinactive: "F" },
    { id: "33", itemid: "GST", rate: "0.05", isinactive: "F" },
  ];
  const codes = (rows: typeof groups) =>
    Object.fromEntries(
      normalizeNetSuiteTaxCodes(items, rows).map((code) => [code.sourceRef, code.fields.code]),
    );
  // Active groups take the plainer codes; the retired one is told apart by its rate.
  const expected = {
    "10": "GST",
    "30": "GST (tax group, 15%)",
    "31": "GST (tax group)",
    "32": "GST (tax group, 5%)",
    "33": "GST (tax group 2)",
  };
  assert.deepEqual(codes(groups), expected);
  assert.deepEqual(codes([...groups].reverse()), expected);
  for (const code of Object.values(expected).slice(1)) {
    for (const group of groups)
      assert.equal(code.includes(group.id), false, `${code} names no internal id`);
  }
});
