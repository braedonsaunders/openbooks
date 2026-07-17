import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNetSuiteAccountingPeriods } from "./netsuite-source.ts";

test("NetSuite fiscal periods retain the source close flags", () => {
  const periods = normalizeNetSuiteAccountingPeriods([
    {
      id: "fy", periodname: "FY 2026", startdate: "04/01/2025", enddate: "03/31/2026",
      isyear: "T", isposting: "F", isadjust: "F", closed: "F",
    },
    {
      id: "apr", periodname: "Apr 2025", startdate: "04/01/2025", enddate: "04/30/2025",
      isyear: "F", isposting: "T", isadjust: "F", closed: "T", alllocked: "T",
      aplocked: "T", arlocked: "T", closedondate: "05/01/2025",
    },
    {
      id: "may", periodname: "May 2025", startdate: "05/01/2025", enddate: "05/31/2025",
      isyear: "F", isposting: "T", isadjust: "F", closed: "F", alllocked: "F",
      aplocked: "T", arlocked: "F",
    },
  ]);
  assert.equal(periods.length, 2);
  assert.deepEqual(periods[0]?.fields, {
    name: "Apr 2025", fiscalYear: 2026, periodNumber: 1,
    startsOn: "2025-04-01", endsOn: "2025-04-30", isAdjustment: false,
    closed: true, allLocked: true, apLocked: true, arLocked: true,
    closedAt: "2025-05-01",
  });
  assert.equal(periods[1]?.fields.closed, false);
  assert.equal(periods[1]?.fields.apLocked, true);
  assert.equal(periods[1]?.fields.arLocked, false);
});
