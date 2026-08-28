import assert from "node:assert/strict";
import test from "node:test";
import {
  addBusinessDays,
  businessDaysBetween,
  computeStatutoryHolidayPay,
  countHolidayQualifyingDays,
  easterSunday,
  emptyLookbackEarnings,
  holidayDateSet,
  isBusinessDay,
  lookbackWindow,
  nextBusinessDay,
  PayrollHolidayError,
  resolveHolidayRule,
  resolveObservedHolidays,
  statutoryHolidayPayRule,
  type HolidayDayEvidence,
  type HolidayOverride,
  type HolidayPayContext,
  type ObservedHoliday,
} from "./payroll-holidays.ts";
import {
  employmentJurisdictionsOf,
  payrollJurisdiction,
  PayrollPackError,
} from "./payroll/packs.ts";
import type { ResolvedWorkSchedule } from "./work-schedules.ts";

/**
 * The statutory holiday calendar and the pay it owes.
 *
 * Every date asserted here is HAND-WORKED against a published calendar, not
 * against the code's own output — a test that computes its expectation the way
 * the implementation does proves only that the implementation is
 * self-consistent. The anchors are the CRA's published 2026 public-holiday
 * list, the statutes' own worked examples (Ontario's ESA guide, CNESST's
 * indemnity example, BC's interpretive guideline), and the US federal
 * observance rule in 5 U.S.C. 6103(b).
 *
 * Pure throughout: no database, no clock.
 */

const dates = (holidays: readonly ObservedHoliday[]) => holidays.map((h) => h.date);
const on = (holidays: readonly ObservedHoliday[], key: string) =>
  holidays.find((h) => h.key === key)?.date;

const year = (jurisdiction: string, y: number, overrides?: readonly HolidayOverride[]) =>
  resolveObservedHolidays({
    jurisdiction, from: `${y}-01-01`, to: `${y}-12-31`, overrides,
  });

// ---------------------------------------------------------------------------
// Computed dates
// ---------------------------------------------------------------------------

test("Easter Sunday is computed, not tabulated", () => {
  // Gregorian computus, cross-checked against published ecclesiastical dates.
  // The CRA's own 2026 list gives Good Friday as April 3, which fixes Easter
  // Sunday at April 5 — an independent anchor for the algorithm.
  assert.equal(easterSunday(2024), "2024-03-31");
  assert.equal(easterSunday(2025), "2025-04-20");
  assert.equal(easterSunday(2026), "2026-04-05");
  assert.equal(easterSunday(2027), "2027-03-28");
  assert.equal(easterSunday(2028), "2028-04-16");
  assert.equal(easterSunday(2030), "2030-04-21");
  // A century boundary, where the naive computus goes wrong.
  assert.equal(easterSunday(2000), "2000-04-23");
  assert.equal(easterSunday(1900), "1900-04-15");
});

test("Good Friday and Easter Monday ride the Easter offset", () => {
  assert.equal(resolveHolidayRule({ kind: "easter_offset", days: -2 }, 2026), "2026-04-03");
  assert.equal(resolveHolidayRule({ kind: "easter_offset", days: 1 }, 2026), "2026-04-06");
  // 2027's Easter is in March, so Good Friday crosses out of April entirely.
  assert.equal(resolveHolidayRule({ kind: "easter_offset", days: -2 }, 2027), "2027-03-26");
});

test("the first Monday in September, across four years", () => {
  const labourDay = { kind: "nth_weekday", month: 9, weekday: 1, nth: 1 } as const;
  assert.equal(resolveHolidayRule(labourDay, 2024), "2024-09-02");
  assert.equal(resolveHolidayRule(labourDay, 2025), "2025-09-01");
  assert.equal(resolveHolidayRule(labourDay, 2026), "2026-09-07");
  assert.equal(resolveHolidayRule(labourDay, 2027), "2027-09-06");
});

test("the last Monday in May is not always the fourth", () => {
  const memorialDay = { kind: "nth_weekday", month: 5, weekday: 1, nth: -1 } as const;
  // May 2026 has five Mondays (4, 11, 18, 25); May 2027 has five as well
  // (3, 10, 17, 24, 31). A fourth-Monday implementation is wrong in both.
  assert.equal(resolveHolidayRule(memorialDay, 2026), "2026-05-25");
  assert.equal(resolveHolidayRule(memorialDay, 2027), "2027-05-31");
  assert.equal(resolveHolidayRule(memorialDay, 2024), "2024-05-27");
});

test("Victoria Day is the Monday STRICTLY before May 25", () => {
  const victoriaDay = { kind: "weekday_before", month: 5, day: 25, weekday: 1 } as const;
  // 2026 is the trap: May 25 is itself a Monday, and the answer is May 18.
  // The CRA's published 2026 list gives Victoria Day as Monday, May 18.
  assert.equal(resolveHolidayRule(victoriaDay, 2026), "2026-05-18");
  assert.equal(resolveHolidayRule(victoriaDay, 2025), "2025-05-19");
  assert.equal(resolveHolidayRule(victoriaDay, 2024), "2024-05-20");
  assert.equal(resolveHolidayRule(victoriaDay, 2023), "2023-05-22");
});

// ---------------------------------------------------------------------------
// Jurisdiction calendars
// ---------------------------------------------------------------------------

test("Ontario's nine ESA public holidays for 2026", () => {
  // ESA s.1 'public holiday'. Civic Holiday, Remembrance Day and Truth and
  // Reconciliation Day are NOT among them, and must not appear unelected.
  assert.deepEqual(dates(year("CA-ON", 2026)), [
    "2026-01-01", // New Year's Day
    "2026-02-16", // Family Day, third Monday in February
    "2026-04-03", // Good Friday
    "2026-05-18", // Victoria Day
    "2026-07-01", // Canada Day
    "2026-09-07", // Labour Day
    "2026-10-12", // Thanksgiving
    "2026-12-25", // Christmas Day
    "2026-12-26", // Boxing Day
  ]);
});

test("the CRA's own 2026 calendar is not any province's calendar", () => {
  // canada.ca/en/revenue-agency/services/tax/public-holidays.html — the list a
  // remittance due date moves against. It carries Easter Monday and the Civic
  // Holiday, which no employment-standards act does.
  assert.deepEqual(dates(year("CA-CRA", 2026)), [
    "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-18", "2026-07-01",
    "2026-08-03", "2026-09-07", "2026-09-30", "2026-10-12", "2026-11-11",
    "2026-12-25", "2026-12-26",
  ]);
  // Quebec's variant: Saint-Jean-Baptiste in, Civic Holiday out.
  const quebec = dates(year("CA-CRA-QC", 2026));
  assert.ok(quebec.includes("2026-06-24"));
  assert.ok(!quebec.includes("2026-08-03"));
});

test("British Columbia moved Family Day to the third Monday in 2019", () => {
  // Second Monday through 2018, third Monday from 2019 — an effective-dated
  // fact of the statute, not of any tenant's configuration.
  assert.equal(on(year("CA-BC", 2018), "family_day"), "2018-02-12");
  assert.equal(on(year("CA-BC", 2019), "family_day"), "2019-02-18");
  assert.equal(on(year("CA-BC", 2026), "family_day"), "2026-02-16");
});

test("the eight jurisdictions the packs used to refuse, hand-worked for 2026", () => {
  // Every list below is the statute's own, checked day by day against the
  // governing Act rather than against a neighbouring province. They differ far
  // more than a "Canadian statutory holidays" list suggests: six days in Nova
  // Scotia against eleven in the territories, three different August days, and
  // September 30 binding private employers in five of the eight.
  assert.deepEqual(dates(year("CA-MB", 2026)), [
    "2026-01-01", // New Year's Day
    "2026-02-16", // Louis Riel Day
    "2026-04-03", // Good Friday
    "2026-05-18", // Victoria Day
    "2026-07-01", // Canada Day
    "2026-09-07", // Labour Day
    "2026-09-30", // Orange Shirt Day
    "2026-10-12", // Thanksgiving
    "2026-12-25", // Christmas Day
  ], "Manitoba: nine, and Remembrance Day is NOT one of them");

  assert.deepEqual(dates(year("CA-NB", 2026)), [
    "2026-01-01", "2026-02-16", "2026-04-03", "2026-07-01",
    "2026-08-03", // New Brunswick Day, the first Monday in August
    "2026-09-07",
    "2026-11-11", // Remembrance Day IS a public holiday here
    "2026-12-25",
  ], "New Brunswick: eight, no Victoria Day and no Thanksgiving");

  assert.deepEqual(dates(year("CA-NL", 2026)), [
    "2026-01-01", "2026-04-03",
    "2026-07-01", // Memorial Day, not Canada Day
    "2026-09-07", "2026-11-11", "2026-12-25",
  ], "Newfoundland and Labrador: six");
  assert.equal(on(year("CA-NL", 2026), "memorial_day"), "2026-07-01");

  assert.deepEqual(dates(year("CA-NS", 2026)), [
    "2026-01-01",
    "2026-02-16", // Nova Scotia Heritage Day
    "2026-04-03", "2026-07-01", "2026-09-07", "2026-12-25",
  ], "Nova Scotia: six — the thinnest list in the country, and no Remembrance Day");

  assert.deepEqual(dates(year("CA-NT", 2026)), [
    "2026-01-01", "2026-04-03", "2026-05-18",
    "2026-06-21", // National Indigenous Peoples Day
    "2026-07-01",
    "2026-08-03", // the first Monday in August
    "2026-09-07", "2026-09-30", "2026-10-12", "2026-11-11", "2026-12-25",
  ], "Northwest Territories: eleven");

  assert.deepEqual(dates(year("CA-NU", 2026)), [
    "2026-01-01", "2026-04-03", "2026-05-18", "2026-07-01",
    "2026-07-09", // Nunavut Day
    "2026-08-03", "2026-09-07", "2026-09-30", "2026-10-12", "2026-11-11", "2026-12-25",
  ], "Nunavut: eleven, with Nunavut Day and no June 21");

  assert.deepEqual(dates(year("CA-PE", 2026)), [
    "2026-01-01",
    "2026-02-16", // Islander Day
    "2026-04-03", "2026-07-01", "2026-09-07", "2026-09-30", "2026-11-11", "2026-12-25",
  ], "Prince Edward Island: eight");

  assert.deepEqual(dates(year("CA-YT", 2026)), [
    "2026-01-01", "2026-04-03", "2026-05-18", "2026-06-21", "2026-07-01",
    "2026-08-17", // Discovery Day is the THIRD Monday in August
    "2026-09-07", "2026-09-30", "2026-10-12", "2026-11-11", "2026-12-25",
  ], "Yukon: eleven, and no Heritage Day");
});

test("the three different August days, and the one province with none", () => {
  // Getting these interchangeable would move a paid day by up to a fortnight.
  assert.equal(on(year("CA-NB", 2026), "new_brunswick_day"), "2026-08-03");
  assert.equal(on(year("CA-NT", 2026), "august_civic_holiday"), "2026-08-03");
  assert.equal(on(year("CA-YT", 2026), "discovery_day"), "2026-08-17");
  // Nova Scotia's Natal Day and Manitoba's first Monday are not statutory at
  // all — absent unless an employer elects them.
  assert.ok(!dates(year("CA-NS", 2026)).includes("2026-08-03"));
  assert.ok(!dates(year("CA-MB", 2026)).includes("2026-08-03"));
});

test("September 30 binds private employers only where and when it was legislated", () => {
  // Five of the eight, and each from a different year. A day paid one year too
  // early is a day's wages nobody owed.
  const covers = (jurisdiction: string, y: number) =>
    dates(year(jurisdiction, y)).includes(`${y}-09-30`);
  assert.equal(covers("CA-NT", 2021), false);
  assert.equal(covers("CA-NT", 2022), true, "in force 2022-06-03");
  assert.equal(covers("CA-NU", 2021), false);
  assert.equal(covers("CA-NU", 2022), true);
  assert.equal(covers("CA-YT", 2022), false);
  assert.equal(covers("CA-YT", 2023), true, "Bill 305, assent 2022-11-24");
  assert.equal(covers("CA-PE", 2020), false);
  assert.equal(covers("CA-PE", 2021), true, "Bill 22, in force 2021-11-17");
  assert.equal(covers("CA-MB", 2023), false);
  assert.equal(covers("CA-MB", 2024), true, "S.M. 2023 c. 50, royal assent 2023-12-07");
  // And the three where it still binds nobody but federally regulated
  // employers.
  assert.equal(covers("CA-NB", 2026), false);
  assert.equal(covers("CA-NL", 2026), false);
  assert.equal(covers("CA-NS", 2026), false);
});

test("Remembrance Day is a paid holiday in six jurisdictions and not in two", () => {
  // Manitoba and Nova Scotia both put November 11 in a SEPARATE statute whose
  // pay rule is inverted — nothing for an employee who stays home. Declaring it
  // as an ordinary general holiday would pay a day's wages the employment
  // standards code does not require, so it is absent from both.
  for (const jurisdiction of ["CA-NB", "CA-NL", "CA-NT", "CA-NU", "CA-PE", "CA-YT"]) {
    assert.ok(
      dates(year(jurisdiction, 2026)).includes("2026-11-11"),
      `${jurisdiction} observes Remembrance Day`,
    );
  }
  assert.ok(!dates(year("CA-MB", 2026)).includes("2026-11-11"));
  assert.ok(!dates(year("CA-NS", 2026)).includes("2026-11-11"));
  // Ontario has never had it either, which the pack already said.
  assert.ok(!dates(year("CA-ON", 2026)).includes("2026-11-11"));
});

test("holidays that did not exist yet are not observed", () => {
  // Truth and Reconciliation Day became a federal general holiday in 2021 and
  // a BC statutory holiday in 2023; Juneteenth became federal in 2021.
  assert.ok(!dates(year("CA", 2020)).includes("2020-09-30"));
  assert.ok(dates(year("CA", 2021)).includes("2021-09-30"));
  assert.ok(!dates(year("CA-BC", 2022)).includes("2022-09-30"));
  assert.ok(dates(year("CA-BC", 2023)).includes("2023-09-30"));
  assert.ok(!dates(year("US", 2020)).includes("2020-06-19"));
});

// ---------------------------------------------------------------------------
// Weekend observance
// ---------------------------------------------------------------------------

test("a federal general holiday on a weekend moves to the next working day", () => {
  // Canada Labour Code s.195. Boxing Day 2026 is a Saturday, so the observed
  // day is Monday December 28; Christmas that year is a Friday and does not
  // move.
  const federal2026 = year("CA", 2026);
  assert.equal(on(federal2026, "christmas"), "2026-12-25");
  assert.equal(on(federal2026, "boxing_day"), "2026-12-28");
  // Ontario's ESA does NOT move the day — it grants a substitute day off, and
  // the holiday-pay entitlement still attaches to December 26.
  assert.equal(on(year("CA-ON", 2026), "boxing_day"), "2026-12-26");
});

test("Christmas on a Sunday pushes Boxing Day past the day it takes", () => {
  // 2027: Christmas is Saturday and Boxing Day is Sunday. Federally both are
  // owed, so Christmas takes Monday the 27th and Boxing Day walks to Tuesday
  // the 28th — never landing two general holidays on one date.
  const federal2027 = year("CA", 2027);
  assert.equal(on(federal2027, "christmas"), "2027-12-27");
  assert.equal(on(federal2027, "boxing_day"), "2027-12-28");
  assert.equal(new Set(dates(federal2027)).size, dates(federal2027).length);
});

test("effective-dated elections use the observed date after weekend observance", () => {
  // In 2027 Christmas is Saturday and is observed federally on Monday the
  // 27th. An election starting on the observed day must apply; an election
  // ending on the statutory Sunday must already be expired. Comparing against
  // the recurrence date would produce the opposite answers.
  const startsOnObserved = [override({
    jurisdiction: "CA", packKey: "christmas", effectiveFrom: "2027-12-27", isPaid: false,
  })];
  const observed = resolveObservedHolidays({
    jurisdiction: "CA", from: "2027-12-01", to: "2027-12-31", overrides: startsOnObserved,
  });
  assert.equal(observed.find((h) => h.key === "christmas")?.date, "2027-12-27");
  assert.equal(observed.find((h) => h.key === "christmas")?.paid, false);

  const endsOnStatutory = [override({
    jurisdiction: "CA", packKey: "christmas", effectiveFrom: "2000-01-01", effectiveTo: "2027-12-25", isPaid: false,
  })];
  const stillPaid = resolveObservedHolidays({
    jurisdiction: "CA", from: "2027-12-01", to: "2027-12-31", overrides: endsOnStatutory,
  });
  assert.equal(stillPaid.find((h) => h.key === "christmas")?.date, "2027-12-27");
  assert.equal(stillPaid.find((h) => h.key === "christmas")?.paid, true);
});

test("US federal holidays observe on the nearest weekday, both directions", () => {
  // 5 U.S.C. 6103(b): Saturday to the preceding Friday, Sunday to the
  // following Monday.
  assert.equal(on(year("US", 2021), "christmas"), "2021-12-24"); // Sat 25th
  assert.equal(on(year("US", 2021), "independence_day"), "2021-07-05"); // Sun 4th
  assert.equal(on(year("US", 2021), "juneteenth"), "2021-06-18"); // Sat 19th
  // New Year's Day 2022 was a Saturday, so it was observed on December 31,
  // 2021 — the shift crosses the year boundary backwards, and the day must
  // appear in 2021's calendar rather than vanishing from both.
  assert.ok(dates(year("US", 2021)).includes("2021-12-31"));
  assert.ok(!dates(year("US", 2022)).includes("2022-01-01"));
});

// ---------------------------------------------------------------------------
// Tenant overrides
// ---------------------------------------------------------------------------

const override = (patch: Partial<HolidayOverride>): HolidayOverride => ({
  id: "00000000-0000-0000-0000-000000000001",
  jurisdiction: "CA-ON", packKey: null, name: null, ruleKind: null,
  ruleMonth: null, ruleDay: null, ruleWeekday: null, ruleNth: null, ruleOffset: null,
  observedOn: null, observance: "none", isObserved: true, isPaid: true,
  effectiveFrom: "2000-01-01", effectiveTo: null,
  ...patch,
});

test("an employer elects an optional day, effective-dated", () => {
  const elected = [override({
    packKey: "civic_holiday", isObserved: true, effectiveFrom: "2026-01-01",
  })];
  assert.ok(!dates(year("CA-ON", 2025, elected)).includes("2025-08-04"));
  assert.ok(dates(year("CA-ON", 2026, elected)).includes("2026-08-03"));
  assert.equal(
    year("CA-ON", 2026, elected).find((h) => h.key === "civic_holiday")?.elected,
    true,
  );
});

test("an election that has expired stops applying, without restating the past", () => {
  const elected = [override({
    packKey: "civic_holiday", effectiveFrom: "2024-01-01", effectiveTo: "2026-12-31",
  })];
  assert.ok(dates(year("CA-ON", 2026, elected)).includes("2026-08-03"));
  assert.ok(!dates(year("CA-ON", 2027, elected)).includes("2027-08-02"));
});

test("a company holiday carries its own recurrence and can be unpaid", () => {
  const shutdown = [
    override({
      packKey: null, name: "Shop shutdown", ruleKind: "fixed", ruleMonth: 12, ruleDay: 24,
      isPaid: false, effectiveFrom: "2026-01-01",
    }),
    override({
      id: "00000000-0000-0000-0000-000000000002",
      packKey: null, name: "Founders' Friday", ruleKind: "nth_weekday",
      ruleMonth: 8, ruleWeekday: 5, ruleNth: 1, effectiveFrom: "2026-01-01",
    }),
  ];
  const observed = year("CA-ON", 2026, shutdown);
  const closure = observed.find((h) => h.name === "Shop shutdown");
  assert.equal(closure?.date, "2026-12-24");
  assert.equal(closure?.paid, false);
  assert.equal(closure?.source, "company");
  // First Friday in August 2026 is the 7th.
  assert.equal(observed.find((h) => h.name === "Founders' Friday")?.date, "2026-08-07");
});

test("a one-off company holiday is generated once, not every year", () => {
  const oneOff = [override({
    packKey: null, name: "Anniversary", ruleKind: "date", observedOn: "2026-03-11",
    effectiveFrom: "2026-01-01",
  })];
  assert.ok(dates(year("CA-ON", 2026, oneOff)).includes("2026-03-11"));
  assert.equal(year("CA-ON", 2027, oneOff).filter((h) => h.source === "company").length, 0);
});

test("a tenant cannot switch off a holiday the law requires", () => {
  assert.throws(
    () => year("CA-ON", 2026, [override({ packKey: "canada_day", isObserved: false })]),
    (error: unknown) =>
      error instanceof PayrollHolidayError && /cannot be switched off/.test((error as Error).message),
  );
  // Switching off an OPTIONAL day it previously elected is fine.
  assert.ok(!dates(year("CA-ON", 2026, [override({ packKey: "civic_holiday", isObserved: false })]))
    .includes("2026-08-03"));
});

test("an override naming a day the pack does not declare is refused", () => {
  assert.throws(
    () => year("CA-ON", 2026, [override({ packKey: "bastille_day" })]),
    (error: unknown) =>
      error instanceof PayrollHolidayError && /declares no statutory holiday/.test((error as Error).message),
  );
});

// ---------------------------------------------------------------------------
// Refusals: an undeclared jurisdiction never guesses
// ---------------------------------------------------------------------------

test("an undeclared jurisdiction refuses loudly instead of returning nothing", () => {
  // 'ZZ' is T4127's region for an employee employed outside any province: the
  // withholding pack knows it, and no employment-standards act governs it. An
  // empty calendar is indistinguishable from "this employer works every day",
  // which would quietly pay nothing on Canada Day — so it throws, naming what
  // is missing.
  assert.throws(
    () => year("CA-ZZ", 2026),
    (error: unknown) =>
      error instanceof PayrollPackError
      && /no payroll pack declares the statutory holiday calendar for "CA-ZZ"/
        .test((error as Error).message),
  );
  assert.throws(() => statutoryHolidayPayRule("CA-ZZ", "2026-07-01"), PayrollPackError);
  // A typo is refused the same way, and never resolved to the nearest match.
  assert.throws(() => statutoryHolidayPayRule("CA-ONT", "2026-07-01"), PayrollPackError);
  // The eight that used to be on this list are declared now — every Canadian
  // employment-standards jurisdiction states a rule.
  for (const jurisdiction of ["CA-MB", "CA-NB", "CA-NL", "CA-NS", "CA-NT", "CA-NU", "CA-PE", "CA-YT"]) {
    assert.ok(statutoryHolidayPayRule(jurisdiction, "2026-07-01"), `${jurisdiction} states a rule`);
  }
});

test("no mandate and no transcription are different answers", () => {
  // The FLSA requires no private employer to pay for time not worked, so the
  // US declares null — a fact. Massachusetts and Rhode Island DO impose
  // holiday premium-pay statutes that nobody has transcribed, so they are
  // absent and throw rather than inheriting the federal answer.
  assert.equal(statutoryHolidayPayRule("US", "2026-07-04"), null);
  assert.equal(statutoryHolidayPayRule("US-TX", "2026-07-04"), null);
  assert.throws(() => statutoryHolidayPayRule("US-MA", "2026-07-04"), PayrollPackError);
  assert.throws(() => statutoryHolidayPayRule("US-RI", "2026-07-04"), PayrollPackError);
  // And a US state still has a working CALENDAR — the refusal is about pay.
  assert.ok(dates(year("US-TX", 2026)).includes("2026-07-03")); // July 4 is a Saturday
});

// ---------------------------------------------------------------------------
// Business days
// ---------------------------------------------------------------------------

const CRA_2026 = holidayDateSet(
  resolveObservedHolidays({ jurisdiction: "CA-CRA", from: "2025-01-01", to: "2027-12-31" }),
);

test("a business day is neither a weekend nor an observed holiday", () => {
  assert.equal(isBusinessDay("2026-04-02", CRA_2026), true);  // Thursday
  assert.equal(isBusinessDay("2026-04-03", CRA_2026), false); // Good Friday
  assert.equal(isBusinessDay("2026-04-04", CRA_2026), false); // Saturday
  assert.equal(isBusinessDay("2026-04-06", CRA_2026), false); // Easter Monday
  assert.equal(isBusinessDay("2026-04-07", CRA_2026), true);
});

test("addBusinessDays never counts the day it starts on", () => {
  // Wednesday March 31 2026 + 3 working days: April 1 and 2 count, Good
  // Friday, the weekend and Easter Monday do not, so the third is April 7.
  assert.equal(addBusinessDays("2026-03-31", 3, CRA_2026), "2026-04-07");
  // Christmas Day 2026 is a Friday, Boxing Day the Saturday.
  assert.equal(addBusinessDays("2026-12-24", 3, CRA_2026), "2026-12-30");
  // Starting ON a holiday still does not count it.
  assert.equal(addBusinessDays("2026-04-03", 1, CRA_2026), "2026-04-07");
  assert.equal(addBusinessDays("2026-01-05", 0, CRA_2026), "2026-01-05");
  // Backwards, for completeness.
  assert.equal(addBusinessDays("2026-04-07", -3, CRA_2026), "2026-03-31");
});

test("nextBusinessDay is the identity on a working day", () => {
  assert.equal(nextBusinessDay("2026-04-07", CRA_2026), "2026-04-07");
  assert.equal(nextBusinessDay("2026-04-03", CRA_2026), "2026-04-07");
  assert.equal(nextBusinessDay("2026-08-15", CRA_2026), "2026-08-17"); // Saturday
});

test("businessDaysBetween counts inclusively", () => {
  // 2026-04-01 (Wed) through 2026-04-07 (Tue): April 1, 2 and 7 only.
  assert.equal(businessDaysBetween("2026-04-01", "2026-04-07", CRA_2026), 3);
});

// ---------------------------------------------------------------------------
// Statutory holiday pay — the statutes' own worked examples
// ---------------------------------------------------------------------------

const holiday = (date: string, key = "canada_day"): ObservedHoliday => ({
  jurisdiction: "CA-ON", key, name: "Canada Day", statutoryDate: date, date,
  source: "pack", elected: false, paid: true,
});

const payContext = (patch: Partial<HolidayPayContext>): HolidayPayContext => ({
  employee: "Test Employee",
  holiday: holiday("2026-07-01"),
  earnings: emptyLookbackEarnings(),
  daysWorked: 20,
  employmentDays: 400,
  hoursWorked: "0",
  hourlyRate: "0",
  ...patch,
});

/** The edition in force on the date the worked examples are all anchored to.
 *  Every rule is now effective-dated, so every read states its date. */
const ruleFor = (jurisdiction: string, onDate = "2026-07-01") => {
  const rule = statutoryHolidayPayRule(jurisdiction, onDate);
  assert.ok(rule, `${jurisdiction} declares a holiday-pay rule on ${onDate}`);
  return rule;
};

test("Ontario: regular wages plus vacation pay, divided by 20", () => {
  // Ontario's own guide: $2,400 of regular wages and no vacation pay payable
  // gives $120.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "2400.00" },
    })).holidayPay,
    "120.0000",
  );
  // And the common compliance error the guide names: $4,000 of wages with
  // $640 of vacation pay payable is $232, not $200.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "4000.00", vacationPay: "640.00" },
    })).holidayPay,
    "232.0000",
  );
});

test("Ontario excludes overtime and other public holidays from the base", () => {
  const result = computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext({
    earnings: { regular: "2400.00", overtime: "900.00", vacationPay: "0", holidayPay: "150.00" },
  }));
  // Only the $2,400 counts: ESA s.24 'regular wages' excludes overtime pay,
  // premium pay and pay for other public holidays.
  assert.equal(result.holidayPay, "120.0000");
});

test("Quebec: one twentieth of four complete weeks of pay", () => {
  // CNESST's example: $12.50/hour, 8 hours a day, five days a week is $500 a
  // week; four weeks is $2,000 and the indemnity is $100.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-QC"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "2000.00" },
    })).holidayPay,
    "100.0000",
  );
});

test("Quebec pays a commission earner one sixtieth of twelve weeks", () => {
  const result = computeStatutoryHolidayPay(ruleFor("CA-QC"), payContext({
    paidOnCommission: true,
    employmentWeeks: 30,
    earnings: { ...emptyLookbackEarnings(), regular: "2000.00" },
    commissionEarnings: { ...emptyLookbackEarnings(), regular: "9000.00" },
  }));
  assert.equal(result.holidayPay, "150.0000"); // 9,000 ÷ 60
  // Under twelve complete weeks of employment the long window does not apply
  // and the ordinary 1/20 of four weeks does.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-QC"), payContext({
      paidOnCommission: true,
      employmentWeeks: 8,
      earnings: { ...emptyLookbackEarnings(), regular: "2000.00" },
      commissionEarnings: { ...emptyLookbackEarnings(), regular: "9000.00" },
    })).holidayPay,
    "100.0000",
  );
});

test("the Canada Labour Code divides four weeks by 20", () => {
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "4000.00" },
    })).holidayPay,
    "200.0000",
  );
});

test("British Columbia divides thirty days by the days actually worked", () => {
  // The BC interpretive guideline's example: $3,200 over 20 days is $160.00.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "3200.00" },
      daysWorked: 20, daysWorkedInQualifyingWindow: 20,
    })).holidayPay,
    "160.0000",
  );
  // A part-timer with the same total over fewer days is paid MORE per day —
  // the divisor is days worked, not a notional 20.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "3200.00" },
      daysWorked: 16, daysWorkedInQualifyingWindow: 16,
    })).holidayPay,
    "200.0000",
  );
});

test("Alberta's average daily wage is wages over days worked, overtime out", () => {
  const result = computeStatutoryHolidayPay(ruleFor("CA-AB"), payContext({
    earnings: { regular: "3000.00", overtime: "600.00", vacationPay: "120.00", holidayPay: "0" },
    daysWorked: 15,
  }));
  // (3,000 + 120) ÷ 15 = 208.00. Overtime pay is not wages for this purpose.
  assert.equal(result.holidayPay, "208.0000");
});

test("Saskatchewan takes five per cent of four weeks", () => {
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-SK"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "2000.00" },
    })).holidayPay,
    "100.0000",
  );
});

test("the divisor rounds once, at the cent, half away from zero", () => {
  // 1,234.57 ÷ 20 = 61.7285 exactly; the cent is 61.73, and a float
  // reciprocal lands on 61.72 often enough to be a real complaint.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "1234.57" },
    })).holidayPay,
    "61.7300",
  );
  // 1,234.50 ÷ 20 = 61.725 — the exact half, which must go up.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "1234.50" },
    })).holidayPay,
    "61.7300",
  );
  // 5% of 1,234.57 = 61.7285 by the other route, and must agree to the cent.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-SK"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "1234.57" },
    })).holidayPay,
    "61.7300",
  );
  // BC's days-worked divisor on an awkward denominator: 1,000 ÷ 7 = 142.857…
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "1000.00" },
      daysWorked: 7, daysWorkedInQualifyingWindow: 20,
    })).holidayPay,
    "142.8600",
  );
});

// ---------------------------------------------------------------------------
// Qualifying tests
// ---------------------------------------------------------------------------

test("British Columbia's 30-day and 15-of-30 qualifiers both bite", () => {
  const tooNew = computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({
    earnings: { ...emptyLookbackEarnings(), regular: "1600.00" },
    employmentDays: 21, daysWorked: 16, daysWorkedInQualifyingWindow: 16,
  }));
  assert.equal(tooNew.qualified, false);
  assert.equal(tooNew.holidayPay, "0");
  assert.match(tooNew.disqualifiedReason!, /employed 21 of the 30 calendar days/);

  const tooFewDays = computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({
    earnings: { ...emptyLookbackEarnings(), regular: "1600.00" },
    employmentDays: 400, daysWorked: 14, daysWorkedInQualifyingWindow: 14,
  }));
  assert.equal(tooFewDays.qualified, false);
  assert.match(tooFewDays.disqualifiedReason!, /14 of the 30 days/);

  // Exactly 15 qualifies.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "1500.00" },
      employmentDays: 30, daysWorked: 15, daysWorkedInQualifyingWindow: 15,
    })).qualified,
    true,
  );
});

test("a jurisdiction with a service test and no hire date refuses", () => {
  // Guessing the qualifying period either denies a real entitlement or pays
  // one that was not earned; both are silent. It stops instead.
  assert.throws(
    () => computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({ employmentDays: null })),
    (error: unknown) =>
      error instanceof PayrollHolidayError && /needs a hire date/.test((error as Error).message),
  );
  // Ontario has no service test, so a missing hire date is harmless there.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext({
      employmentDays: null, earnings: { ...emptyLookbackEarnings(), regular: "2000.00" },
    })).holidayPay,
    "100.0000",
  );
});

test("the last-and-first test denies only when the absence is asserted", () => {
  const base = {
    earnings: { ...emptyLookbackEarnings(), regular: "2000.00" },
  };
  // Ontario declares the test; asserting the unapproved absence denies the day.
  const denied = computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext({
    ...base, absentWithoutConsent: true,
  }));
  assert.equal(denied.qualified, false);
  assert.match(denied.disqualifiedReason!, /without the employer's consent/);
  // Not asserting it does NOT deny: consent is not a fact a timesheet records,
  // and inferring it would strip statutory pay on a guess.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext(base)).qualified,
    true,
  );
  // The federal code has no such test, so the assertion cannot deny the day.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA"), payContext({
      ...base, absentWithoutConsent: true,
    })).qualified,
    true,
  );
});

test("an unpaid company closure pays nothing, and says so", () => {
  const closure = computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext({
    holiday: { ...holiday("2026-12-24", "shutdown"), source: "company", paid: false },
    earnings: { ...emptyLookbackEarnings(), regular: "2000.00" },
  }));
  assert.equal(closure.qualified, false);
  assert.equal(closure.holidayPay, "0");
  assert.match(closure.disqualifiedReason!, /unpaid closure/);
});

test("an average-day rule with earnings but no days worked refuses", () => {
  // The average is undefined, not zero. Paying zero would lose a real
  // entitlement silently; this names the employee and stops.
  assert.throws(
    () => computeStatutoryHolidayPay(ruleFor("CA-AB"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "2000.00" }, daysWorked: 0,
    })),
    (error: unknown) =>
      error instanceof PayrollHolidayError && /the average is undefined/.test((error as Error).message),
  );
  // With no earnings either, zero really is the answer.
  const nothing = computeStatutoryHolidayPay(ruleFor("CA-AB"), payContext({ daysWorked: 0 }));
  assert.equal(nothing.qualified, false);
  assert.equal(nothing.holidayPay, "0");
});

// ---------------------------------------------------------------------------
// Premium pay for working the day
// ---------------------------------------------------------------------------

test("the premium is the UPLIFT, because the hours are already paid once", () => {
  // Ontario: time and a half for hours worked plus public holiday pay. The
  // timesheet already pays the eight hours at 1.0×, so the premium line is the
  // remaining 0.5× — emitting 1.5× here would pay the hours twice.
  const result = computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext({
    earnings: { ...emptyLookbackEarnings(), regular: "2000.00" },
    hoursWorked: "8.00", hourlyRate: "25.00",
  }));
  assert.equal(result.premiumPay, "100.0000"); // 8 × 25 × 0.5
  assert.equal(result.holidayPay, "100.0000"); // still owed on top
});

test("British Columbia pays double time past twelve hours", () => {
  // ESA s.46: 1.5× to 12 hours, 2× beyond, plus an average day's pay.
  const result = computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({
    earnings: { ...emptyLookbackEarnings(), regular: "3200.00" },
    daysWorked: 20, daysWorkedInQualifyingWindow: 20,
    hoursWorked: "14.00", hourlyRate: "20.00",
  }));
  // 12 × 20 × 0.5 = 120, plus 2 × 20 × 1.0 = 40.
  assert.equal(result.premiumPay, "160.0000");
  assert.equal(result.holidayPay, "160.0000");
});

test("Quebec owes the indemnity and ordinary wages, and no premium at all", () => {
  const result = computeStatutoryHolidayPay(ruleFor("CA-QC"), payContext({
    earnings: { ...emptyLookbackEarnings(), regular: "2000.00" },
    hoursWorked: "8.00", hourlyRate: "25.00",
  }));
  assert.equal(result.premiumPay, "0.0000");
  assert.equal(result.holidayPay, "100.0000");
});

// ---------------------------------------------------------------------------
// Lookback windows
// ---------------------------------------------------------------------------

test("a lookback ends where its own statute says, and the two differ by days", () => {
  // Canada Day 2026 is a WEDNESDAY, so the two wordings are four days apart.
  //
  // Ontario s. 24(1)(a) is "the four work weeks BEFORE THE WORK WEEK with the
  // public holiday": the holiday's own week (Sunday June 28 onward) is outside
  // the window entirely, so it runs Sunday May 31 to Saturday June 27 — four
  // COMPLETE weeks, which is what the statute asks for and what a window ending
  // June 30 was not.
  assert.deepEqual(
    lookbackWindow(ruleFor("CA-ON"), "2026-07-01"),
    { from: "2026-05-31", to: "2026-06-27" },
  );
  // The Canada Labour Code s. 196 and Quebec s. 62 are worded the same way.
  assert.deepEqual(
    lookbackWindow(ruleFor("CA"), "2026-07-01"),
    { from: "2026-05-31", to: "2026-06-27" },
  );
  assert.deepEqual(
    lookbackWindow(ruleFor("CA-QC"), "2026-07-01"),
    { from: "2026-05-31", to: "2026-06-27" },
  );
  // BC s. 45(1) is "the 30 CALENDAR DAY period preceding the statutory
  // holiday" — the day, not the week, and unchanged.
  assert.deepEqual(
    lookbackWindow(ruleFor("CA-BC"), "2026-07-01"),
    { from: "2026-06-01", to: "2026-06-30" },
  );
  // Alberta, Saskatchewan, Manitoba and Prince Edward Island are all worded
  // "immediately preceding the general holiday" and all end June 30.
  for (const jurisdiction of ["CA-AB", "CA-SK", "CA-MB", "CA-PE"]) {
    assert.equal(
      lookbackWindow(ruleFor(jurisdiction), "2026-07-01").to, "2026-06-30",
      `${jurisdiction} counts to the day before the holiday`,
    );
  }
  // A holiday that lands on the FIRST day of the week makes the two boundaries
  // identical — the difference is not a constant offset, it is how far into its
  // week the holiday fell. 2026-11-01 is a Sunday.
  assert.equal(lookbackWindow(ruleFor("CA-ON"), "2026-11-01").to, "2026-10-31");
  assert.equal(lookbackWindow(ruleFor("CA-AB"), "2026-11-01").to, "2026-10-31");
  // …and one landing on a Saturday makes it the full six days. 2026-08-01.
  assert.equal(lookbackWindow(ruleFor("CA"), "2026-08-01").to, "2026-07-25");
  assert.equal(lookbackWindow(ruleFor("CA-AB"), "2026-08-01").to, "2026-07-31");
});

test("every declared jurisdiction either states a rule or states there is none", () => {
  // The pack is the single source of truth, and it answers for every key it
  // declares — no key resolves to undefined.
  for (const key of [
    "CA", "CA-ON", "CA-QC", "CA-BC", "CA-AB", "CA-SK",
    "CA-MB", "CA-NB", "CA-NL", "CA-NS", "CA-NT", "CA-NU", "CA-PE", "CA-YT",
    "CA-CRA", "US", "US-NY",
  ]) {
    const declaration = payrollJurisdiction(key);
    assert.ok(declaration.holidays.length > 0, `${key} declares holidays`);
    assert.ok(declaration.citation.length > 0, `${key} cites its statute`);
    assert.notEqual(declaration.holidayPay, undefined, `${key} answers the holiday-pay question`);
  }
});

test("every Canadian employment jurisdiction cites the Act its rule came from", () => {
  // A rule with no citation is a number somebody remembered. Each one must name
  // a statute and sections, and no two provinces may share a citation — which
  // is what would happen if one were copied from its neighbour.
  const employment = employmentJurisdictionsOf("CA");
  assert.equal(employment.length, 14, "the federal code and thirteen provinces and territories");
  const citations = new Set<string>();
  for (const jurisdiction of employment) {
    const editions = jurisdiction.holidayPay;
    assert.ok(editions && editions.length > 0, `${jurisdiction.key} states a holiday-pay rule`);
    for (const edition of editions) {
      // Named statute plus the part or sections it came from. The shape varies
      // — Alberta cites a Division, Quebec a CQLR chapter with no year — so
      // what is asserted is that something substantial is there and that it is
      // not a neighbour's.
      assert.ok(edition.rule.citation.length >= 30, `${jurisdiction.key} names its instrument`);
      assert.ok(
        !citations.has(edition.rule.citation),
        `${jurisdiction.key}'s citation is its own`,
      );
      citations.add(edition.rule.citation);
      // An edition must say when it starts, even when the answer is "no earlier
      // transcription exists". Omission and assertion are different claims.
      assert.ok(
        edition.effectiveFrom === null || /^\d{4}-\d{2}-\d{2}$/.test(edition.effectiveFrom),
        `${jurisdiction.key} dates its edition`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The eight new jurisdictions' formulas
// ---------------------------------------------------------------------------

/** Monday to Friday, `hours` a day, anchored on a Sunday. */
const pattern = (hours: string, days = [1, 2, 3, 4, 5]): ResolvedWorkSchedule => ({
  id: "sched", name: null, scope: "employee", pattern: "cycle",
  cycleDays: 7, cycleAnchor: "2026-01-04",
  days: days.map((dayIndex) => ({ dayIndex, hours })),
  effectiveFrom: "2020-01-01",
});

const VARIES: ResolvedWorkSchedule = {
  id: "varies", name: null, scope: "employee", pattern: "varies",
  cycleDays: null, cycleAnchor: null, days: [], effectiveFrom: "2020-01-01",
};

test("a normal-day jurisdiction pays ONE normal working day, from the schedule", () => {
  // Manitoba s. 23(1): the wages for regular hours on a normal workday.
  // Mon–Fri, 8 hours, $25.00 → $200.00.
  const result = computeStatutoryHolidayPay(ruleFor("CA-MB"), payContext({
    schedule: pattern("8"), hourlyRate: "25.00",
    earnings: { ...emptyLookbackEarnings(), regular: "4000.00" },
  }));
  assert.equal(result.holidayPay, "200.0000");
  assert.match(result.basis, /one normal working day/);

  // And the case a single weekly-hours number gets wrong twice: four ten-hour
  // days is the same forty hours a week and a TEN-hour normal day. 40 ÷ 5 = 8
  // would pay $200; the pattern pays $250.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-MB"), payContext({
      schedule: pattern("10", [1, 2, 3, 4]), hourlyRate: "25.00",
      earnings: { ...emptyLookbackEarnings(), regular: "4000.00" },
    })).holidayPay,
    "250.0000",
  );
});

test("a holiday landing on the employee's day off still owes a normal day", () => {
  // Manitoba and Nova Scotia both give a normal workday off WITH general
  // holiday pay when the holiday falls on a day the employee does not work, so
  // the answer must not depend on which weekday the holiday occupied.
  // 2026-07-01 is a Wednesday; a Thursday-and-Friday employee does not work it.
  const result = computeStatutoryHolidayPay(ruleFor("CA-MB"), payContext({
    schedule: pattern("8", [4, 5]), hourlyRate: "25.00",
    earnings: { ...emptyLookbackEarnings(), regular: "1600.00" },
  }));
  assert.equal(result.holidayPay, "200.0000");
});

test("Manitoba falls through to five per cent only where the hours vary", () => {
  // s. 23(2): the percentage applies where the normal workday's wage CANNOT be
  // determined. 5% of $4,000 = $200.00, and the derivation says why it took it.
  const varying = computeStatutoryHolidayPay(ruleFor("CA-MB"), payContext({
    schedule: VARIES, hourlyRate: "25.00",
    earnings: { ...emptyLookbackEarnings(), regular: "4000.00", overtime: "900.00" },
  }));
  assert.equal(varying.holidayPay, "200.0000", "overtime is out of the base");
  assert.match(varying.basis, /hours vary/);
  assert.match(varying.basis, /5% of 4000/);

  // Unequal hours across the working days are varying hours just as much.
  const unequal = computeStatutoryHolidayPay(ruleFor("CA-MB"), payContext({
    schedule: {
      ...pattern("8"),
      days: [
        { dayIndex: 1, hours: "10" }, { dayIndex: 2, hours: "10" },
        { dayIndex: 3, hours: "10" }, { dayIndex: 4, hours: "4" },
      ],
    },
    hourlyRate: "25.00",
    earnings: { ...emptyLookbackEarnings(), regular: "4000.00" },
  }));
  assert.equal(unequal.holidayPay, "200.0000");
});

test("a normal-day jurisdiction REFUSES when no schedule is recorded", () => {
  // The whole point of the refusal: eight hours is not a default, it is a
  // guess, and a guessed day's pay is indistinguishable on the stub from a
  // correct one. Every jurisdiction whose measure is the normal day must stop.
  for (const jurisdiction of ["CA-MB", "CA-NB", "CA-NS", "CA-NT", "CA-NU", "CA-YT"]) {
    assert.throws(
      () => computeStatutoryHolidayPay(ruleFor(jurisdiction), payContext({
        hourlyRate: "25.00", daysWorkedInQualifyingWindow: 30,
        earnings: { ...emptyLookbackEarnings(), regular: "4000.00" },
      })),
      (error: unknown) =>
        error instanceof PayrollHolidayError
        && /no work schedule is in force/.test((error as Error).message)
        && /Test Employee/.test((error as Error).message),
      `${jurisdiction} refuses by name`,
    );
  }
  // …and the jurisdictions whose measure is a lookback are UNAFFECTED by the
  // absence, because they never needed it.
  for (const jurisdiction of ["CA", "CA-ON", "CA-QC", "CA-BC", "CA-AB", "CA-SK", "CA-NL", "CA-PE"]) {
    assert.doesNotThrow(() => computeStatutoryHolidayPay(ruleFor(jurisdiction), payContext({
      hourlyRate: "25.00", daysWorked: 20, daysWorkedInQualifyingWindow: 20,
      earnings: { ...emptyLookbackEarnings(), regular: "4000.00" },
    })), `${jurisdiction} needs no schedule`);
  }
});

test("New Brunswick averages thirty days only when the wages vary", () => {
  // s. 18(2) regular wages for the day; s. 21(1) average daily earnings,
  // exclusive of overtime, over the days worked in the preceding 30 days.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-NB"), payContext({
      schedule: pattern("7.5"), hourlyRate: "24.00", employmentDays: 400,
      earnings: { ...emptyLookbackEarnings(), regular: "3600.00" },
    })).holidayPay,
    "180.0000",
  );
  // $3,600 over 20 days worked = $180.00 — and the 30-day window is the rule's.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-NB"), payContext({
      schedule: VARIES, hourlyRate: "24.00", employmentDays: 400, daysWorked: 20,
      earnings: { ...emptyLookbackEarnings(), regular: "3600.00" },
    })).holidayPay,
    "180.0000",
  );
  assert.deepEqual(
    lookbackWindow(ruleFor("CA-NB"), "2026-07-01"),
    { from: "2026-06-01", to: "2026-06-30" },
  );
});

test("New Brunswick's ninety-day service test is the longest in the country", () => {
  const denied = computeStatutoryHolidayPay(ruleFor("CA-NB"), payContext({
    schedule: pattern("8"), hourlyRate: "24.00", employmentDays: 89,
  }));
  assert.equal(denied.qualified, false);
  assert.match(denied.disqualifiedReason ?? "", /89 of the 90 calendar days/);
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-NB"), payContext({
      schedule: pattern("8"), hourlyRate: "24.00", employmentDays: 90,
    })).qualified,
    true,
  );
});

test("Newfoundland pays DOUBLE for the day worked, instead of stacking", () => {
  // s. 17(1): double wages for that day, or a lieu day, at the employee's
  // election — the only jurisdiction in the country where working the holiday
  // REPLACES the day's holiday pay rather than adding to it.
  const worked = computeStatutoryHolidayPay(ruleFor("CA-NL"), payContext({
    daysWorked: 15, hoursWorked: "8", hourlyRate: "25.00", employmentDays: 400,
    earnings: { ...emptyLookbackEarnings(), regular: "3000.00" },
  }));
  // The 8 hours are already on the stub at 1.0×, so the uplift is one more
  // times, and the day's pay is dropped.
  assert.equal(worked.premiumPay, "200.0000");
  assert.equal(worked.holidayPay, "0");

  // Not worked: an average day over the three-week window. $3,000 ÷ 15 = $200.
  const rested = computeStatutoryHolidayPay(ruleFor("CA-NL"), payContext({
    daysWorked: 15, hourlyRate: "25.00", employmentDays: 400,
    earnings: { ...emptyLookbackEarnings(), regular: "3000.00" },
  }));
  assert.equal(rested.holidayPay, "200.0000");
  assert.deepEqual(
    lookbackWindow(ruleFor("CA-NL"), "2026-07-01"),
    { from: "2026-06-10", to: "2026-06-30" },
  );
});

test("Nova Scotia's fifteen-of-thirty test bites, and stacks the premium", () => {
  const denied = computeStatutoryHolidayPay(ruleFor("CA-NS"), payContext({
    schedule: pattern("8"), hourlyRate: "25.00", daysWorkedInQualifyingWindow: 14,
  }));
  assert.equal(denied.qualified, false);
  assert.match(denied.disqualifiedReason ?? "", /14 of the 30 days/);

  const worked = computeStatutoryHolidayPay(ruleFor("CA-NS"), payContext({
    schedule: pattern("8"), hourlyRate: "25.00",
    daysWorkedInQualifyingWindow: 15, hoursWorked: "8",
  }));
  // s. 41(2): the day's pay PLUS time and a half for the hours worked.
  assert.equal(worked.holidayPay, "200.0000");
  assert.equal(worked.premiumPay, "100.0000");
});

test("the territories share one formula and two different calendars", () => {
  // NT s. 23(1) and NU s. 24 are word for word; the days are not.
  const context = {
    schedule: pattern("8"), hourlyRate: "30.00", daysWorkedInQualifyingWindow: 30,
  };
  assert.equal(computeStatutoryHolidayPay(ruleFor("CA-NT"), payContext(context)).holidayPay, "240.0000");
  assert.equal(computeStatutoryHolidayPay(ruleFor("CA-NU"), payContext(context)).holidayPay, "240.0000");
  // Thirty days WORKED in the preceding twelve months, not thirty days of
  // service — a genuinely different test, and it is declared as the one it is.
  const denied = computeStatutoryHolidayPay(ruleFor("CA-NT"), payContext({
    ...context, daysWorkedInQualifyingWindow: 29,
  }));
  assert.equal(denied.qualified, false);
  assert.match(denied.disqualifiedReason ?? "", /29 of the 365 days/);
  // The irregular arm averages the four weeks worked: $4,800 ÷ 20 = $240.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-NU"), payContext({
      ...context, schedule: VARIES, daysWorked: 20,
      earnings: { ...emptyLookbackEarnings(), regular: "4800.00" },
    })).holidayPay,
    "240.0000",
  );
});

test("Prince Edward Island's five per cent counts vacation and prior holidays in", () => {
  // s. 28(2) is the only provision in the country that says so expressly.
  // 5% of (3,800 + 160 + 40) = 5% of 4,000 = $200.00, overtime excluded.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-PE"), payContext({
      earnings: { regular: "3800.00", overtime: "900.00", vacationPay: "160.00", holidayPay: "40.00" },
    })).holidayPay,
    "200.0000",
  );
  // No service qualifier in the new Act: a two-day-old employee qualifies.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-PE"), payContext({
      employmentDays: 2, earnings: { ...emptyLookbackEarnings(), regular: "400.00" },
    })).qualified,
    true,
  );
});

test("Yukon splits on STANDARD hours, not on whether the hours vary", () => {
  // s. 30(1) v s. 30(2): a perfectly regular twenty-hour week takes the
  // percentage arm in Yukon and the normal-day arm everywhere else.
  const fullTime = computeStatutoryHolidayPay(ruleFor("CA-YT"), payContext({
    schedule: pattern("8"), hourlyRate: "28.00", employmentDays: 400,
    earnings: { ...emptyLookbackEarnings(), regular: "2240.00" },
  }));
  assert.equal(fullTime.holidayPay, "224.0000", "40 hours a week is standard");

  const partTime = computeStatutoryHolidayPay(ruleFor("CA-YT"), payContext({
    schedule: pattern("5"), hourlyRate: "28.00", employmentDays: 400,
    // Two weeks of wages: 25 hours a week at $28.00 = $1,400, plus $200 of
    // overtime, which Yukon INCLUDES, and $90 of vacation pay, which it does
    // not. 10% of $1,600 = $160.00.
    earnings: { regular: "1400.00", overtime: "200.00", vacationPay: "90.00", holidayPay: "0" },
  }));
  assert.equal(partTime.holidayPay, "160.0000");
  assert.match(partTime.basis, /less than the 40/);
  // Two weeks, not four — the shortest lookback of any Canadian jurisdiction —
  // and s. 30(2) counts them "immediately preceding the WEEK in which the
  // general holiday occurs", so it stops on the Saturday before Canada Day's
  // week rather than on June 30.
  assert.deepEqual(
    lookbackWindow(ruleFor("CA-YT"), "2026-07-01"),
    { from: "2026-06-14", to: "2026-06-27" },
  );
});

test("declaring eight jurisdictions moved NONE of the six that were already there", () => {
  // The regression that matters. Every previously declared rule is asserted
  // whole — basis, inclusions, qualifiers and premium — so a change to the
  // shared shape that quietly altered one of them fails here rather than in
  // somebody's pay run.
  assert.deepEqual(ruleFor("CA").basis, {
    kind: "fixed_divisor", divisor: 20, lookbackWeeks: 4,
    commission: { divisor: 60, lookbackWeeks: 12, minWeeksEmployed: 12 },
  });
  assert.deepEqual(ruleFor("CA-ON").basis, { kind: "fixed_divisor", divisor: 20, lookbackWeeks: 4 });
  // BC's denominator is "worked OR EARNED WAGES" (s. 45(1)); Alberta's is days
  // worked. Two different sentences that used to be one implementation.
  assert.deepEqual(ruleFor("CA-BC").basis, {
    kind: "average_day", lookbackDays: 30, counting: "worked_or_earned_wages",
  });
  assert.deepEqual(ruleFor("CA-AB").basis, {
    kind: "average_day", lookbackWeeks: 4, counting: "worked",
  });
  assert.deepEqual(ruleFor("CA-SK").basis, {
    kind: "percent_of_earnings", percent: "5", lookbackWeeks: 4,
  });
  assert.deepEqual(ruleFor("CA-QC").premium, { multiplier: "1", plusHolidayPay: true });
  assert.deepEqual(ruleFor("CA-BC").premium, {
    multiplier: "1.5", overtimeAfterHours: 12, overtimeMultiplier: "2", plusHolidayPay: true,
  });
  assert.deepEqual(ruleFor("CA-ON").include, { overtime: false, vacationPay: true, holidayPay: false });

  // The four numbers the statutes' own worked examples produce, recomputed with
  // a schedule present — which must change nothing at all, because none of
  // these six reads one.
  const withSchedule = {
    schedule: pattern("8"), hourlyRate: "999.00",
    earnings: { ...emptyLookbackEarnings(), regular: "2400.00" },
  };
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-ON"), payContext(withSchedule)).holidayPay, "120.0000",
  );
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA"), payContext(withSchedule)).holidayPay, "120.0000",
  );
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-SK"), payContext(withSchedule)).holidayPay, "120.0000",
  );
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-AB"), payContext({
      ...withSchedule, daysWorked: 20,
    })).holidayPay,
    "120.0000",
  );
});

// ---------------------------------------------------------------------------
// "Worked, or earned wages, on a day" — the three predicates
// ---------------------------------------------------------------------------

/**
 * The defect these cases exist for, stated once:
 *
 * `minDaysWorkedInWindow` and the `average_day` denominator were both counted
 * from approved TIME ENTRIES and nothing else. British Columbia's ESA s. 44 and
 * s. 45 do not say "worked" — they say "worked OR EARNED WAGES", and the
 * Branch's guideline counts paid vacation, paid sick days and other paid
 * statutory holidays among them. An employee on paid leave in the thirty days
 * before Canada Day therefore had a day count of zero and was refused statutory
 * holiday pay outright, in a province where they plainly qualify.
 */

const JUNE_2026 = { from: "2026-06-01", to: "2026-06-30" };

/** Two committed biweekly periods spanning June 1–28 on which the employee was
 *  paid but recorded no hours: a salary, or a fortnight of paid leave drawn
 *  from a bank. Neither leaves a single `time_entries` row behind. */
const PAID_FORTNIGHT: HolidayDayEvidence = {
  workedOn: [],
  paidPeriodsWithoutHours: [
    { from: "2026-06-01", to: "2026-06-14" },
    { from: "2026-06-15", to: "2026-06-28" },
  ],
  paidHolidays: [],
};

test("BC: paid vacation with no time entries now qualifies, and did not before", () => {
  // 2026-06-01 is a Monday, so a Monday-to-Friday pattern has twenty working
  // days inside the two periods: June 1–5, 8–12, 15–19 and 22–26.
  const counted = (counting: "worked" | "worked_or_earned_wages") =>
    countHolidayQualifyingDays({
      employee: "Test Employee", window: JUNE_2026, counting,
      evidence: PAID_FORTNIGHT, schedule: pattern("8"),
    });

  // What the engine used to count — approved timesheets, and there are none.
  assert.equal(counted("worked"), 0, "the old measure: no time entries, no days");
  // What ESA s. 44 actually asks.
  assert.equal(counted("worked_or_earned_wages"), 20);

  // And the money. Under the old measure the 15-of-30 gate denied the day…
  const denied = computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({
    holiday: holiday("2026-07-01"),
    earnings: { ...emptyLookbackEarnings(), regular: "4000.00" },
    daysWorked: counted("worked"), daysWorkedInQualifyingWindow: counted("worked"),
  }));
  assert.equal(denied.qualified, false);
  assert.match(denied.disqualifiedReason!, /worked or earned wages on 0 of the 30 days/);
  assert.equal(denied.holidayPay, "0");

  // …and under the statute's own words the employee is paid an average day.
  // $4,000 over twenty days on which wages were earned is $200.00.
  const paid = computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({
    holiday: holiday("2026-07-01"),
    earnings: { ...emptyLookbackEarnings(), regular: "4000.00" },
    daysWorked: counted("worked_or_earned_wages"),
    daysWorkedInQualifyingWindow: counted("worked_or_earned_wages"),
  }));
  assert.equal(paid.qualified, true);
  assert.equal(paid.holidayPay, "200.0000");
  assert.match(paid.basis, /÷ 20 days worked or earned wages/);
});

test("a paid day is not every calendar day — the denominator would sag if it were", () => {
  // The distinction that keeps the average honest. BC's own worked example
  // reaches TWENTY days inside thirty, not thirty inside thirty: a Sunday
  // nobody was scheduled for is not a day wages were earned on. Counting the
  // whole calendar would divide the same wages by 28 instead of 20 and quietly
  // cut every salaried employee's holiday pay by nearly a third.
  const days = countHolidayQualifyingDays({
    employee: "Test Employee", window: JUNE_2026, counting: "worked_or_earned_wages",
    evidence: PAID_FORTNIGHT, schedule: pattern("8"),
  });
  assert.equal(days, 20);
  assert.notEqual(days, 28);
  // A four-day compressed week earns wages on four days a week, not five.
  assert.equal(
    countHolidayQualifyingDays({
      employee: "Test Employee", window: JUNE_2026, counting: "worked_or_earned_wages",
      evidence: PAID_FORTNIGHT, schedule: pattern("10", [1, 2, 3, 4]),
    }),
    16,
  );
});

test("a paid statutory holiday is itself a day wages were earned on", () => {
  // BC's guideline: "$3,200 ÷ 20 days", where the twentieth day is a paid
  // Christmas Day the employee did not work. The engine counts an observed paid
  // holiday it can see the employee was actually paid for.
  const evidence: HolidayDayEvidence = {
    workedOn: ["2026-06-01", "2026-06-02", "2026-06-03"],
    paidPeriodsWithoutHours: [],
    paidHolidays: ["2026-06-15"],
  };
  const base = { employee: "Test Employee", window: JUNE_2026, evidence, schedule: pattern("8") };
  assert.equal(countHolidayQualifyingDays({ ...base, counting: "worked" }), 3);
  assert.equal(countHolidayQualifyingDays({ ...base, counting: "worked_or_earned_wages" }), 4);
  // Nova Scotia's "entitled to receive pay" is broader again in the statute,
  // and identical here — the one place it reaches further is pay the employer
  // owed and never recorded, which is by construction not in the database.
  assert.equal(countHolidayQualifyingDays({ ...base, counting: "entitled_to_pay" }), 4);
});

test("hours on the stub mean the day count is the timesheet's, not the period's", () => {
  // The self-limiting rule that stops the broader predicates from swallowing
  // every hourly employee. A stub carrying hours was paid FOR THOSE HOURS, and
  // those days are already counted; adding the period's other days would credit
  // a four-day-a-week employee with fourteen days a fortnight, and would make
  // the fifteen-of-thirty test meaningless everywhere it applies.
  const evidence: HolidayDayEvidence = {
    workedOn: ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22"],
    paidPeriodsWithoutHours: [],
    paidHolidays: [],
  };
  assert.equal(
    countHolidayQualifyingDays({
      employee: "Test Employee", window: JUNE_2026, counting: "worked_or_earned_wages",
      evidence, schedule: pattern("8"),
    }),
    4,
  );
});

test("a jurisdiction that counts days WORKED is untouched by any of it", () => {
  // Alberta, New Brunswick, Newfoundland and the territories all divide by the
  // days the employee WORKED. A paid period with no hours must not move their
  // denominators by one day, and no schedule is consulted for them at all.
  assert.equal(
    countHolidayQualifyingDays({
      employee: "Test Employee", window: JUNE_2026, counting: "worked",
      evidence: { ...PAID_FORTNIGHT, workedOn: ["2026-06-02", "2026-06-03"] },
      schedule: null,
    }),
    2,
  );
});

test("an untimed paid period with no schedule REFUSES rather than invent a week", () => {
  // The same refusal a `normal_day` basis makes, for the same reason: which
  // days of a paid fortnight were working days is not something five-over-seven
  // can be guessed at. It can only fire where an untimed paid period actually
  // overlaps the window, so every employee whose time is on a timesheet is
  // unaffected.
  assert.throws(
    () => countHolidayQualifyingDays({
      employee: "Robin Salaried", window: JUNE_2026, counting: "worked_or_earned_wages",
      evidence: PAID_FORTNIGHT, schedule: null,
    }),
    (error: unknown) =>
      error instanceof PayrollHolidayError
      && /Robin Salaried/.test((error as Error).message)
      && /WORKED OR EARNED WAGES/.test((error as Error).message),
  );
  // "Their hours vary" is a recorded answer and still cannot say which days
  // were worked, so it refuses too — pointing at the recording that can.
  assert.throws(
    () => countHolidayQualifyingDays({
      employee: "Robin Salaried", window: JUNE_2026, counting: "entitled_to_pay",
      evidence: PAID_FORTNIGHT, schedule: VARIES,
    }),
    (error: unknown) =>
      error instanceof PayrollHolidayError
      && /record the leave as time entries/.test((error as Error).message),
  );
});

test("Nova Scotia's qualifier quotes its own section, not British Columbia's", () => {
  // s. 42(1) is "received or was ENTITLED TO RECEIVE pay", and an employee
  // refused under it was not "not working enough" — a different fact, and a
  // different conversation with their employer.
  const denied = computeStatutoryHolidayPay(ruleFor("CA-NS"), payContext({
    schedule: pattern("8"), hourlyRate: "25.00", daysWorkedInQualifyingWindow: 14,
  }));
  assert.match(denied.disqualifiedReason!, /was paid, or entitled to be paid on 14 of the 30/);
  const bc = computeStatutoryHolidayPay(ruleFor("CA-BC"), payContext({
    employmentDays: 400, daysWorked: 14, daysWorkedInQualifyingWindow: 14,
  }));
  assert.match(bc.disqualifiedReason!, /worked or earned wages on 14 of the 30/);
});

// ---------------------------------------------------------------------------
// Effective-dated formulas
// ---------------------------------------------------------------------------

test("Prince Edward Island's Act changed mid-2026, and the date decides which", () => {
  // SPEI 2024 c 66 came into force 2026-06-30 and replaced a regular day's pay
  // with five per cent of four weeks. Canada Day 2026 is under the new Act.
  assert.equal(
    computeStatutoryHolidayPay(ruleFor("CA-PE", "2026-07-01"), payContext({
      earnings: { ...emptyLookbackEarnings(), regular: "4000.00" },
    })).holidayPay,
    "200.0000",
  );
  // Good Friday 2026 (April 3) is not, and the repealed RSPEI 1988 c E-6.2 has
  // not been transcribed. The engine REFUSES and names the gap rather than
  // applying a formula that was not the law that day — which is exactly what
  // it did before editions existed, silently, for every pre-July PEI period.
  assert.throws(
    () => statutoryHolidayPayRule("CA-PE", "2026-04-03"),
    (error: unknown) =>
      error instanceof PayrollHolidayError
      && /no statutory holiday-pay formula in force on 2026-04-03/.test((error as Error).message)
      && /has not been transcribed/.test((error as Error).message),
  );
  assert.throws(() => statutoryHolidayPayRule("CA-PE", "2026-06-29"), PayrollHolidayError);
  assert.ok(statutoryHolidayPayRule("CA-PE", "2026-06-30"), "in force on the day it commenced");
});

test("adding a time dimension re-dated nothing: every other rule answers for any date", () => {
  // The assertion that makes the edition change safe. Thirteen of the fourteen
  // declare a single edition with `effectiveFrom: null` — "no earlier
  // transcription is carried" — so they answer for 2019 exactly as they answer
  // for 2026, which is what they did before this existed.
  for (const key of [
    "CA", "CA-ON", "CA-QC", "CA-BC", "CA-AB", "CA-SK",
    "CA-MB", "CA-NB", "CA-NL", "CA-NS", "CA-NT", "CA-NU", "CA-YT",
  ]) {
    for (const date of ["2019-07-01", "2026-07-01", "2031-07-01"]) {
      assert.equal(
        statutoryHolidayPayRule(key, date),
        statutoryHolidayPayRule(key, "2026-07-01"),
        `${key} resolves to the same rule object on ${date}`,
      );
    }
  }
  // And the two answers that are not a formula are still not a formula.
  assert.equal(statutoryHolidayPayRule("US-TX", "2019-07-04"), null);
  assert.throws(() => statutoryHolidayPayRule("CA-ZZ", "2019-07-01"), PayrollPackError);
});
