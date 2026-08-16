import assert from "node:assert/strict";
import test from "node:test";
import {
  addBusinessDays,
  businessDaysBetween,
  computeStatutoryHolidayPay,
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
  type HolidayOverride,
  type HolidayPayContext,
  type ObservedHoliday,
} from "./payroll-holidays.ts";
import { payrollJurisdiction, PayrollPackError } from "./payroll/packs.ts";

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
  // Nova Scotia's calendar has not been transcribed. An empty calendar is
  // indistinguishable from "this employer works every day", which would
  // quietly pay nothing on Canada Day — so it throws, naming what is missing.
  assert.throws(
    () => year("CA-NS", 2026),
    (error: unknown) =>
      error instanceof PayrollPackError
      && /no payroll pack declares the statutory holiday calendar for "CA-NS"/
        .test((error as Error).message),
  );
  assert.throws(() => statutoryHolidayPayRule("CA-YT"), PayrollPackError);
  assert.throws(() => statutoryHolidayPayRule("CA-NB"), PayrollPackError);
});

test("no mandate and no transcription are different answers", () => {
  // The FLSA requires no private employer to pay for time not worked, so the
  // US declares null — a fact. Massachusetts and Rhode Island DO impose
  // holiday premium-pay statutes that nobody has transcribed, so they are
  // absent and throw rather than inheriting the federal answer.
  assert.equal(statutoryHolidayPayRule("US"), null);
  assert.equal(statutoryHolidayPayRule("US-TX"), null);
  assert.throws(() => statutoryHolidayPayRule("US-MA"), PayrollPackError);
  assert.throws(() => statutoryHolidayPayRule("US-RI"), PayrollPackError);
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

const ruleFor = (jurisdiction: string) => {
  const rule = statutoryHolidayPayRule(jurisdiction);
  assert.ok(rule, `${jurisdiction} declares a holiday-pay rule`);
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

test("each rule's lookback ends the day before the holiday", () => {
  // Four weeks before Canada Day 2026: June 3 through June 30.
  assert.deepEqual(
    lookbackWindow(ruleFor("CA-ON"), "2026-07-01"),
    { from: "2026-06-03", to: "2026-06-30" },
  );
  // BC counts 30 CALENDAR days, not four weeks.
  assert.deepEqual(
    lookbackWindow(ruleFor("CA-BC"), "2026-07-01"),
    { from: "2026-06-01", to: "2026-06-30" },
  );
});

test("every declared jurisdiction either states a rule or states there is none", () => {
  // The pack is the single source of truth, and it answers for every key it
  // declares — no key resolves to undefined.
  for (const key of ["CA", "CA-ON", "CA-QC", "CA-BC", "CA-AB", "CA-SK", "CA-CRA", "US", "US-NY"]) {
    const declaration = payrollJurisdiction(key);
    assert.ok(declaration.holidays.length > 0, `${key} declares holidays`);
    assert.ok(declaration.citation.length > 0, `${key} cites its statute`);
    assert.notEqual(declaration.holidayPay, undefined, `${key} answers the holiday-pay question`);
  }
});
