import assert from "node:assert/strict";
import test from "node:test";
import {
  allRemittanceSchedules,
  payrollPack,
  remittanceBandForAverage,
  remittanceFrequencyBand,
  remittanceScheduleInForce,
  type PayrollRemittanceSchedule,
} from "../../packs.ts";
import {
  remittanceDueDateExplained,
  scheduledRemittanceDueDateExplained,
} from "../../../payroll-remittance.ts";
import { CRA_REMITTANCE_SCHEDULE } from "./remittance.ts";

/**
 * The Canada Revenue Agency remittance schedule declared by the CA pack, and
 * the proof that the declared timetable IS the legacy per-account function.
 *
 * The goldens below pin every CRA remitter type's declared due date to the
 * hardcoded `remittanceDueDateExplained` timetable byte-for-byte, so the
 * declaration taking over a destination's dating changes nothing it dates:
 * the data is a transcription of the same CRA "When to remit (pay)" page the
 * function quotes, executed by the generic schedule machinery instead of a
 * bespoke branch.
 *
 * 2026 weekday anchors (shared with the CRA due-date and RQ schedule tests):
 * New Year Thu Jan 1, Good Friday Apr 3, Easter Monday Apr 6, Victoria Day Mon
 * May 18, Saint-Jean Wed Jun 24 (Quebec only), Canada Day Wed Jul 1, Civic
 * Holiday Mon Aug 3 (everywhere but Quebec), Labour Day Mon Sep 7,
 * Thanksgiving Mon Oct 12, Remembrance Wed Nov 11, Christmas Fri Dec 25,
 * Boxing Day Sat Dec 26.
 */

const CRA = CRA_REMITTANCE_SCHEDULE;

test("the CA pack declares the CRA schedule alongside Revenu Québec's", () => {
  const schedules = payrollPack("CA").remittanceSchedules ?? [];
  assert.equal(schedules.length, 2);
  assert.equal(schedules[0]?.vendorSettingsKey, "rqRemittancePartyId");
  assert.equal(schedules[1], CRA_REMITTANCE_SCHEDULE);
  assert.equal(CRA_REMITTANCE_SCHEDULE.vendorSettingsKey, "craRemittancePartyId");
  assert.equal(CRA_REMITTANCE_SCHEDULE.authority, "Canada Revenue Agency");
  assert.ok(CRA_REMITTANCE_SCHEDULE.sources.length > 0);
});

test("the CRA schedule keys its frequencies exactly like filing-account remitter types", () => {
  // The future filing-account handoff feeds remitter_type straight into this
  // schedule — any spelling drift between the two is a silent misdate.
  assert.deepEqual(
    CRA.frequencies.map((band) => band.frequency),
    ["quarterly", "regular", "accelerated_1", "accelerated_2"],
  );
  assert.equal(CRA.frequencySettingsKey, "craRemittanceFrequency");
  assert.equal(CRA.defaultFrequency, "regular");
  for (const frequency of ["quarterly", "regular", "accelerated_1", "accelerated_2"]) {
    assert.ok(remittanceFrequencyBand(CRA, frequency), frequency);
  }
});

test("the CRA schedule declares the published AMWA bands", () => {
  // Under $3,000 quarterly; $3,000 to under $25,000 regular; $25,000 to under
  // $100,000 accelerated threshold 1; $100,000 or more accelerated threshold 2.
  // A value on a shared boundary belongs to the higher band.
  assert.equal(remittanceBandForAverage(CRA, "0")?.frequency, "quarterly");
  assert.equal(remittanceBandForAverage(CRA, "2999.99")?.frequency, "quarterly");
  assert.equal(remittanceBandForAverage(CRA, "3000")?.frequency, "regular");
  assert.equal(remittanceBandForAverage(CRA, "24999.99")?.frequency, "regular");
  assert.equal(remittanceBandForAverage(CRA, "25000")?.frequency, "accelerated_1");
  assert.equal(remittanceBandForAverage(CRA, "99999.99")?.frequency, "accelerated_1");
  assert.equal(remittanceBandForAverage(CRA, "100000")?.frequency, "accelerated_2");
  assert.equal(remittanceBandForAverage(CRA, "2500000")?.frequency, "accelerated_2");
});

test("the CRA schedule moves deadlines on the federal CRA calendar", () => {
  assert.equal(CRA_REMITTANCE_SCHEDULE.calendar, "CA-CRA");
});

test("the CRA schedule is in force for current periods", () => {
  assert.equal(
    remittanceScheduleInForce("craRemittancePartyId", "2026-07-31"),
    CRA_REMITTANCE_SCHEDULE,
  );
  assert.equal(remittanceScheduleInForce("craRemittancePartyId", "2023-12-31"), null);
});

test("each CRA remitter type dates from the declaration exactly as from the legacy function", () => {
  const due = (frequency: string, periodTo: string): string =>
    scheduledRemittanceDueDateExplained(CRA, frequency, periodTo).dueDate;
  // Regular: the 15th of the following month; August 15 2026 is a Saturday.
  assert.equal(due("regular", "2026-07-31"), "2026-08-17");
  assert.equal(due("regular", "2026-08-31"), "2026-09-15");
  assert.equal(due("regular", "2026-12-31"), "2027-01-15");
  // Quarterly: the 15th after the quarter; October 15 2028 is a Sunday.
  assert.equal(due("quarterly", "2026-01-31"), "2026-04-15");
  assert.equal(due("quarterly", "2026-06-30"), "2026-07-15");
  assert.equal(due("quarterly", "2028-09-30"), "2028-10-16");
  // Accelerated threshold 1: the 25th, then the 10th.
  assert.equal(due("accelerated_1", "2026-01-15"), "2026-01-26");
  assert.equal(due("accelerated_1", "2026-05-15"), "2026-05-25");
  assert.equal(due("accelerated_1", "2026-12-31"), "2027-01-11");
  // Accelerated threshold 2: the 3rd WORKING day after each quarter-month.
  // January 7 2026 is a Wednesday; the 8th and 9th count, the weekend does not.
  assert.equal(due("accelerated_2", "2026-01-07"), "2026-01-12");
  // March 31 2026 is a Tuesday; Good Friday, the weekend and Easter Monday do
  // not count, so the third working day is Tuesday April 7.
  assert.equal(due("accelerated_2", "2026-03-31"), "2026-04-07");
  // December 31 2026 is a Thursday; New Year's Day 2027 is CRA-recognized.
  assert.equal(due("accelerated_2", "2026-12-31"), "2027-01-06");
  for (const [frequency, periodTo, expected] of [
    ["regular", "2026-07-31", "2026-08-17"],
    ["quarterly", "2028-09-30", "2028-10-16"],
    ["accelerated_1", "2026-01-15", "2026-01-26"],
    ["accelerated_2", "2026-03-31", "2026-04-07"],
  ] as const) {
    assert.equal(
      due(frequency, periodTo),
      remittanceDueDateExplained(periodTo, frequency).dueDate,
      `${frequency} ${periodTo}`,
    );
    assert.equal(remittanceDueDateExplained(periodTo, frequency).dueDate, expected);
  }
});

test("the declared CRA timetable matches the legacy function across three years", () => {
  // The byte-identity sweep: every remitter type, every month-end and every
  // quarter-month cut across three years — declared and legacy agree exactly.
  const types = ["regular", "quarterly", "accelerated_1", "accelerated_2"] as const;
  for (const year of [2026, 2027, 2028]) {
    for (let month = 1; month <= 12; month += 1) {
      const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      const prefix = `${year}-${String(month).padStart(2, "0")}-`;
      for (const day of ["07", "14", "21", end.slice(8, 10)]) {
        for (const remitter of types) {
          const periodTo = `${prefix}${day}`;
          assert.equal(
            scheduledRemittanceDueDateExplained(CRA, remitter, periodTo).dueDate,
            remittanceDueDateExplained(periodTo, remitter).dueDate,
            `${remitter} ${periodTo}`,
          );
        }
      }
    }
  }
});

test("the Québec calendar variant counts on CA-CRA-QC from the same data", () => {
  // The declared executor resolves whichever calendar the schedule names — no
  // second declaration, no new calendar. The Québec variant differs exactly
  // where the calendars do: Saint-Jean-Baptiste Day and the Civic Holiday.
  const quebec: PayrollRemittanceSchedule = { ...CRA, calendar: "CA-CRA-QC" };
  const dueQc = (frequency: string, periodTo: string): string =>
    scheduledRemittanceDueDateExplained(quebec, frequency, periodTo).dueDate;
  // Saint-Jean-Baptiste Day, Wednesday June 24 2026, is recognized in Quebec
  // and nowhere else: the 15th-to-21st period's third working day is the 24th
  // nationally and the 25th in Quebec.
  assert.equal(dueQc("accelerated_2", "2026-06-21"), "2026-06-25");
  assert.equal(
    dueQc("accelerated_2", "2026-06-21"),
    remittanceDueDateExplained("2026-06-21", "accelerated_2", { quebec: true }).dueDate,
  );
  assert.equal(remittanceDueDateExplained("2026-06-21", "accelerated_2").dueDate, "2026-06-24");
  // The Civic Holiday, Monday August 3 2026, runs the other way: recognized
  // everywhere EXCEPT Quebec.
  assert.equal(dueQc("accelerated_2", "2026-07-31"), "2026-08-05");
  assert.equal(
    dueQc("accelerated_2", "2026-07-31"),
    remittanceDueDateExplained("2026-07-31", "accelerated_2", { quebec: true }).dueDate,
  );
  assert.equal(remittanceDueDateExplained("2026-07-31", "accelerated_2").dueDate, "2026-08-06");
});

test("the fixed-date CRA rules travel byte-identical with the date", () => {
  // The rule an operator reads on the bill is the same sentence the legacy
  // function stamps — the declaration changed the channel, not the words.
  assert.equal(
    scheduledRemittanceDueDateExplained(CRA, "regular", "2026-08-31").rule,
    remittanceDueDateExplained("2026-08-31", "regular").rule,
  );
  assert.equal(
    scheduledRemittanceDueDateExplained(CRA, "quarterly", "2026-06-30").rule,
    remittanceDueDateExplained("2026-06-30", "quarterly").rule,
  );
  assert.equal(
    scheduledRemittanceDueDateExplained(CRA, "accelerated_1", "2026-01-15").rule,
    remittanceDueDateExplained("2026-01-15", "accelerated_1").rule,
  );
  assert.equal(
    scheduledRemittanceDueDateExplained(CRA, "accelerated_1", "2026-01-31").rule,
    remittanceDueDateExplained("2026-01-31", "accelerated_1").rule,
  );
  // Threshold 2's legacy rule names the quarter-month; the declared rule states
  // all four periods and the same 3rd-working-day sentence.
  assert.match(
    scheduledRemittanceDueDateExplained(CRA, "accelerated_2", "2026-03-31").rule,
    /3rd working day after the end of that period/,
  );
});

test("a CRA schedule whose default names no band is refused", () => {
  const bad: PayrollRemittanceSchedule = { ...CRA, defaultFrequency: "weekly" };
  assert.throws(
    () => allRemittanceSchedules({ CA: { ...payrollPack("CA"), remittanceSchedules: [bad] } }),
    /not one of its declared frequencies/,
  );
});

test("a CRA schedule citing no source is refused — every rule must be verifiable", () => {
  const bad: PayrollRemittanceSchedule = { ...CRA, sources: [] };
  assert.throws(
    () => allRemittanceSchedules({ CA: { ...payrollPack("CA"), remittanceSchedules: [bad] } }),
    /cites no published source/,
  );
});

test("a CRA schedule counting no positive working days is refused", () => {
  const bad: PayrollRemittanceSchedule = {
    ...CRA,
    frequencies: CRA.frequencies.map((band) => band.frequency === "accelerated_2"
      ? { ...band, due: { kind: "quarter_month_working_days", workingDays: 0 } }
      : band),
  };
  assert.throws(
    () => allRemittanceSchedules({ CA: { ...payrollPack("CA"), remittanceSchedules: [bad] } }),
    /no positive working days/,
  );
});

test("a CRA schedule with an unknown due-date rule kind is refused", () => {
  const bad: PayrollRemittanceSchedule = {
    ...CRA,
    vendorSettingsKey: "craRemittancePartyId",
    frequencies: [{
      frequency: "regular",
      label: "Regular",
      due: { kind: "fortnightly" } as never,
      rule: "every fortnight",
    }],
  };
  assert.throws(
    () => allRemittanceSchedules({ CA: { ...payrollPack("CA"), remittanceSchedules: [bad] } }),
    /unknown due-date rule kind/,
  );
});
