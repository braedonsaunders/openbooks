import assert from "node:assert/strict";
import test from "node:test";
import { countLabel, currencyLabel, dateLabel, dateTime, decimalLabel, formatCivilDate, formatCount, formatPercent01, monthLabel, monthYearLabel, shortDateLabel, trendWeekLabel } from './format';

// Timestamps must render in the viewer's locale (F-t01-014): the Users
// list passes its request locale through, so the formatter has to honor
// the argument rather than always falling back to the default.

test("dateTime renders month names in the requested locale", () => {
  const stamp = "2026-07-17T00:37:00Z";
  assert.match(dateTime(stamp, "en"), /Jul/);
  assert.match(dateTime(stamp, "fr"), /juil/);
  assert.notEqual(dateTime(stamp, "en"), dateTime(stamp, "fr"));
});

test("dateTime keeps its default and empty handling", () => {
  assert.equal(dateTime(null), "");
  assert.equal(dateTime(undefined), "");
  assert.match(dateTime("2026-07-17T00:37:00Z"), /2026/);
});

// Trend week labels must render in the viewer's locale (F2-14): the
// purchasing loader passes its request locale through, so the formatter
// has to honor the argument rather than pinning en-US.

test("trendWeekLabel renders the week start in the requested locale", () => {
  assert.match(trendWeekLabel("2026-01-05", "en-US"), /Jan 5/);
  assert.match(trendWeekLabel("2026-01-05", "fr"), /janv/i);
  assert.notEqual(trendWeekLabel("2026-01-05", "en-US"), trendWeekLabel("2026-01-05", "fr"));
});

test("trendWeekLabel pins the UTC day so time zones cannot shift it", () => {
  assert.match(trendWeekLabel("2026-09-07", "en-US"), /Sep 7/);
  assert.match(trendWeekLabel("2026-09-07", "de"), /Sep/i);
});

// The F2-14b viewer-locale family: every helper must honor its locale
// argument — a helper that pins one language repeats the defect it exists
// to remove. French differs from en-US on every shape below.

test("dateLabel renders the full date in the requested locale", () => {
  const day = new Date("2026-09-07T00:00:00Z");
  assert.match(dateLabel(day, "en-US"), /Sep 7, 2026/);
  assert.match(dateLabel(day, "fr"), /sept/i);
  assert.notEqual(dateLabel(day, "en-US"), dateLabel(day, "fr"));
});

test("shortDateLabel renders the compact date in the requested locale", () => {
  const day = new Date("2026-01-05T00:00:00Z");
  assert.match(shortDateLabel(day, "en-US"), /Jan 5/);
  assert.match(shortDateLabel(day, "fr"), /janv/i);
  assert.notEqual(shortDateLabel(day, "en-US"), shortDateLabel(day, "fr"));
});

test("monthYearLabel renders the drill grouping in the requested locale", () => {
  const first = new Date(Date.UTC(2026, 8, 1));
  assert.match(monthYearLabel(first, "en-US"), /Sep/);
  assert.match(monthYearLabel(first, "fr"), /sept/i);
  assert.notEqual(monthYearLabel(first, "en-US"), monthYearLabel(first, "fr"));
});

test("monthYearLabel keeps the caller's year width", () => {
  const first = new Date(Date.UTC(2026, 8, 1));
  assert.match(monthYearLabel(first, "en-US", "numeric"), /2026/);
  assert.doesNotMatch(monthYearLabel(first, "en-US"), /2026/);
});

test("monthLabel renders the axis tick in the requested locale", () => {
  const day = new Date(Date.UTC(2026, 6, 1));
  assert.match(monthLabel(day, "en-US"), /Jul/);
  assert.match(monthLabel(day, "fr"), /juil/i);
  assert.notEqual(monthLabel(day, "en-US"), monthLabel(day, "fr"));
});

test("countLabel groups integers in the requested locale", () => {
  assert.equal(countLabel(50000, "en-US"), "50,000");
  assert.notEqual(countLabel(50000, "en-US"), countLabel(50000, "fr"));
});

test("decimalLabel trims trailing zeros in the requested locale", () => {
  assert.equal(decimalLabel(1.75, "en-US", 0, 4), "1.75");
  assert.equal(decimalLabel(40, "en-US", 0, 4), "40");
  assert.notEqual(decimalLabel(1750.5, "en-US", 0, 4), decimalLabel(1750.5, "fr", 0, 4));
});

test("currencyLabel renders whole-unit amounts in the requested locale", () => {
  assert.match(currencyLabel(125000, "USD", "en-US"), /\$125,000/);
  assert.notEqual(currencyLabel(125000, "USD", "en-US"), currencyLabel(125000, "USD", "fr"));
});

test("counts group in the operator locale", () => {
  assert.equal(nbsp(formatCount(1234, "en")), "1,234");
  assert.equal(nbsp(formatCount(1234, "de")), "1.234");
  assert.equal(nbsp(formatCount(1234, "fr")), "1 234");
});

test("percents localize placement instead of concatenating %", () => {
  assert.equal(nbsp(formatPercent01(0.125, "en")), "13%");
  assert.equal(nbsp(formatPercent01(0.125, "de")), "13 %");
  assert.equal(nbsp(formatPercent01(0.125, "fr")), "13 %");
  assert.equal(nbsp(formatPercent01(0, "de")), "0 %");
});

test("civil dates render medium in the operator locale without shifting days", () => {
  assert.equal(formatCivilDate("2026-01-05", "en"), "Jan 5, 2026");
  assert.equal(formatCivilDate("2026-01-05", "de"), "5. Jan. 2026");
  assert.equal(formatCivilDate("2026-01-05", "fr"), "5 janv. 2026");
  assert.equal(formatCivilDate("2026-01-05T00:00:00", "en"), "Jan 5, 2026");
});
