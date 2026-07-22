import assert from "node:assert/strict";
import test from "node:test";
import { buildFilingCalendar, filingPeriods, type NexusRegistration } from "./tax-nexus.ts";

test("quarterly periods align to calendar quarters", () => {
  const periods = filingPeriods("quarterly", "2026-01-01", "2026-12-31");
  assert.deepEqual(periods, [
    { periodStart: "2026-01-01", periodEnd: "2026-03-31" },
    { periodStart: "2026-04-01", periodEnd: "2026-06-30" },
    { periodStart: "2026-07-01", periodEnd: "2026-09-30" },
    { periodStart: "2026-10-01", periodEnd: "2026-12-31" },
  ]);
});

test("monthly periods honor month lengths and leap years", () => {
  const periods = filingPeriods("monthly", "2028-01-01", "2028-03-31");
  assert.deepEqual(periods, [
    { periodStart: "2028-01-01", periodEnd: "2028-01-31" },
    { periodStart: "2028-02-01", periodEnd: "2028-02-29" }, // 2028 is a leap year
    { periodStart: "2028-03-01", periodEnd: "2028-03-31" },
  ]);
});

test("annual and semiannual periods span the right months", () => {
  assert.deepEqual(filingPeriods("annual", "2026-01-01", "2026-12-31"), [
    { periodStart: "2026-01-01", periodEnd: "2026-12-31" },
  ]);
  assert.deepEqual(filingPeriods("semiannual", "2026-01-01", "2026-12-31"), [
    { periodStart: "2026-01-01", periodEnd: "2026-06-30" },
    { periodStart: "2026-07-01", periodEnd: "2026-12-31" },
  ]);
});

test("periods only include those opening within the range", () => {
  // Range starts mid-Q1: the Jan period opened before the range, so it's skipped.
  const periods = filingPeriods("quarterly", "2026-02-15", "2026-08-01");
  assert.deepEqual(periods, [
    { periodStart: "2026-04-01", periodEnd: "2026-06-30" },
    { periodStart: "2026-07-01", periodEnd: "2026-09-30" },
  ]);
});

test("empty/invalid ranges yield no periods", () => {
  assert.deepEqual(filingPeriods("monthly", "2026-06-01", "2026-01-01"), []);
  assert.deepEqual(filingPeriods("monthly", "not-a-date", "2026-01-01"), []);
});

test("filing calendar expands registrations and honors effective windows", () => {
  const regs: NexusRegistration[] = [
    {
      jurisdictionId: "j-ca",
      jurisdictionName: "Canada",
      jurisdictionCode: "CA",
      country: "CA",
      filingFrequency: "quarterly",
      returnFormCode: "CA_GST34",
      registrationNumber: "123456789RT0001",
      effectiveFrom: null,
      effectiveTo: null,
    },
    {
      jurisdictionId: "j-uk",
      jurisdictionName: "United Kingdom",
      jurisdictionCode: "GB",
      country: "GB",
      filingFrequency: "quarterly",
      returnFormCode: "GB_VAT100",
      registrationNumber: "GB999999973",
      // Registered mid-year: only periods opening on/after Jul 1 count.
      effectiveFrom: "2026-07-01",
      effectiveTo: null,
    },
  ];
  const calendar = buildFilingCalendar(regs, "2026-01-01", "2026-12-31");
  // CA: 4 quarters. GB: 2 quarters (Q3, Q4). Total 6, sorted by period end.
  assert.equal(calendar.length, 6);
  assert.equal(calendar[0].returnFormCode, "CA_GST34"); // Q1 ends first
  const gb = calendar.filter((o) => o.country === "GB");
  assert.equal(gb.length, 2);
  assert.equal(gb[0].periodStart, "2026-07-01");
});
