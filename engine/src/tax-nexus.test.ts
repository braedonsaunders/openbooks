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

test("a period that straddles the start of the range is still an obligation", () => {
  // Range starts mid-Q1. The Jan–Mar quarter opened before the range, but the
  // range's own activity from 15 Feb onwards is reported ON that quarter's
  // return — filing periods are fixed by the jurisdiction and do not shift to
  // suit a registration date. Skipping it left that activity with no return.
  const periods = filingPeriods("quarterly", "2026-02-15", "2026-08-01");
  assert.deepEqual(periods, [
    { periodStart: "2026-01-01", periodEnd: "2026-03-31" },
    { periodStart: "2026-04-01", periodEnd: "2026-06-30" },
    { periodStart: "2026-07-01", periodEnd: "2026-09-30" },
  ]);
});

test("a mid-period registration reports the straddling quarter, but only its registered days", () => {
  const registrations: NexusRegistration[] = [
    {
      jurisdictionId: "j-gb",
      jurisdictionName: "United Kingdom",
      jurisdictionCode: "GB",
      country: "GB",
      filingFrequency: "quarterly",
      returnFormCode: "GB_VAT100",
      registrationNumber: "GB999999973",
      effectiveFrom: "2026-05-01",
      effectiveTo: null,
    },
  ];
  const calendar = buildFilingCalendar(registrations, "2026-01-01", "2026-12-31");
  // Q2 (Apr–Jun) through Q4: three obligations, not two. Losing Q2 would mean
  // May and June never appeared on any return.
  assert.deepEqual(
    calendar.map((o) => o.periodStart),
    ["2026-04-01", "2026-07-01", "2026-10-01"],
  );
  // Q2's return covers only 1 May onwards — April predates the registration.
  assert.equal(calendar[0].periodStart, "2026-04-01");
  assert.equal(calendar[0].reportableFrom, "2026-05-01");
  assert.equal(calendar[0].reportableTo, "2026-06-30");
  // A fully-covered period reports its whole span.
  assert.equal(calendar[1].reportableFrom, "2026-07-01");
  assert.equal(calendar[1].reportableTo, "2026-09-30");
});

test("a mid-period de-registration stops reporting on the day it ends", () => {
  const registrations: NexusRegistration[] = [
    {
      jurisdictionId: "j-gb",
      jurisdictionName: "United Kingdom",
      jurisdictionCode: "GB",
      country: "GB",
      filingFrequency: "quarterly",
      returnFormCode: "GB_VAT100",
      registrationNumber: "GB999999973",
      effectiveFrom: null,
      effectiveTo: "2026-04-15",
    },
  ];
  const calendar = buildFilingCalendar(registrations, "2026-01-01", "2026-12-31");
  assert.deepEqual(
    calendar.map((o) => o.periodStart),
    ["2026-01-01", "2026-04-01"],
  );
  // The final return covers 1–15 April only; activity after de-registration
  // must not be swept into it.
  assert.equal(calendar[1].reportableFrom, "2026-04-01");
  assert.equal(calendar[1].reportableTo, "2026-04-15");
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
