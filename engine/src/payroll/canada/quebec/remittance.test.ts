import assert from "node:assert/strict";
import test from "node:test";
import {
  PayrollPackError,
  allRemittanceSchedules,
  declaredRemittanceFrequencySettingsKeys,
  payrollPack,
  remittanceBandForAverage,
  remittanceFrequencyBand,
  remittanceScheduleInForce,
  type PayrollRemittanceSchedule,
} from "../../packs.ts";
import { RQ_REMITTANCE_SCHEDULE } from "./remittance.ts";

/**
 * The Revenu Québec remittance schedule declared by the CA pack, and the
 * generic resolvers that date a destination's bill from its own declaration.
 * Pure: the schedule is data, and these cases never reach a database.
 *
 * Every band and deadline below is transcribed from Revenu Québec Guide
 * TP-1015.G-V ("Guide for Employers: Source Deductions and Contributions")
 * and form TPZ-1015.R-V — nothing is inferred from the implementation.
 */

test("the CA pack declares the Revenu Québec schedule for its RQ vendor", () => {
  const schedules = payrollPack("CA").remittanceSchedules ?? [];
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0], RQ_REMITTANCE_SCHEDULE);
  assert.equal(RQ_REMITTANCE_SCHEDULE.vendorSettingsKey, "rqRemittancePartyId");
  assert.equal(RQ_REMITTANCE_SCHEDULE.authority, "Revenu Québec");
  assert.ok(RQ_REMITTANCE_SCHEDULE.sources.length > 0);
});

test("the US pack declares no destination schedule", () => {
  assert.deepEqual(payrollPack("US").remittanceSchedules ?? [], []);
});

test("the RQ schedule declares three cited bands with exact thresholds", () => {
  const bands = RQ_REMITTANCE_SCHEDULE.frequencies;
  assert.deepEqual(bands.map((band) => band.frequency), ["quarterly", "monthly", "twice_monthly"]);
  // Under $3,000 quarterly; $3,000 to under $25,000 monthly; $25,000 or more
  // twice a month. A value on a shared boundary belongs to the higher band.
  assert.equal(remittanceBandForAverage(RQ_REMITTANCE_SCHEDULE, "0")?.frequency, "quarterly");
  assert.equal(remittanceBandForAverage(RQ_REMITTANCE_SCHEDULE, "2999.99")?.frequency, "quarterly");
  assert.equal(remittanceBandForAverage(RQ_REMITTANCE_SCHEDULE, "3000")?.frequency, "monthly");
  assert.equal(remittanceBandForAverage(RQ_REMITTANCE_SCHEDULE, "24999.99")?.frequency, "monthly");
  assert.equal(remittanceBandForAverage(RQ_REMITTANCE_SCHEDULE, "25000")?.frequency, "twice_monthly");
  assert.equal(remittanceBandForAverage(RQ_REMITTANCE_SCHEDULE, "250000")?.frequency, "twice_monthly");
});

test("the RQ schedule defaults to monthly — Revenu Québec's new-employer frequency", () => {
  assert.equal(RQ_REMITTANCE_SCHEDULE.defaultFrequency, "monthly");
  assert.ok(remittanceFrequencyBand(RQ_REMITTANCE_SCHEDULE, "monthly"));
});

test("the RQ schedule moves deadlines on the Québec calendar", () => {
  // Revenu Québec observes Québec statutory holidays (Saint-Jean-Baptiste Day),
  // not the federal list (no Civic Holiday) — the CA-CRA-QC due-date calendar.
  assert.equal(RQ_REMITTANCE_SCHEDULE.calendar, "CA-CRA-QC");
});

test("the RQ schedule is in force for current periods", () => {
  assert.equal(remittanceScheduleInForce("rqRemittancePartyId", "2026-07-31"), RQ_REMITTANCE_SCHEDULE);
  assert.equal(remittanceScheduleInForce("craRemittancePartyId", "2026-07-31"), null);
  assert.equal(remittanceScheduleInForce("rqRemittancePartyId", "2023-12-31"), null);
});

test("schedule versions are effective-dated: the version in force on the period end wins", () => {
  const v1: PayrollRemittanceSchedule = {
    ...RQ_REMITTANCE_SCHEDULE, effectiveFrom: "2024-01-01", effectiveTo: "2027-01-01",
  };
  const v2: PayrollRemittanceSchedule = {
    ...RQ_REMITTANCE_SCHEDULE, effectiveFrom: "2027-01-01",
  };
  const schedules = [v2, v1];
  assert.equal(remittanceScheduleInForce("rqRemittancePartyId", "2026-12-31", schedules), v1);
  assert.equal(remittanceScheduleInForce("rqRemittancePartyId", "2027-01-01", schedules), v2);
  assert.equal(remittanceScheduleInForce("other", "2027-06-30", schedules), null);
});

test("overlapping schedule versions for one vendor are refused, never a coin toss", () => {
  const v1: PayrollRemittanceSchedule = {
    ...RQ_REMITTANCE_SCHEDULE, effectiveFrom: "2024-01-01", effectiveTo: "2027-01-01",
  };
  const v2: PayrollRemittanceSchedule = {
    ...RQ_REMITTANCE_SCHEDULE, effectiveFrom: "2026-01-01",
  };
  const overlapping = {
    CA: { ...payrollPack("CA"), remittanceSchedules: [v1] },
    US: { ...payrollPack("US"), remittanceSchedules: [v2] },
  };
  assert.throws(() => allRemittanceSchedules(overlapping), PayrollPackError);
  // Contiguous ranges are the lawful handoff, not an overlap.
  const v3: PayrollRemittanceSchedule = {
    ...RQ_REMITTANCE_SCHEDULE, effectiveFrom: "2027-01-01",
  };
  const contiguous = {
    CA: { ...payrollPack("CA"), remittanceSchedules: [v1] },
    US: { ...payrollPack("US"), remittanceSchedules: [v3] },
  };
  assert.deepEqual(allRemittanceSchedules(contiguous), [v1, v3]);
});

test("a schedule whose default names no band is refused", () => {
  const bad: PayrollRemittanceSchedule = { ...RQ_REMITTANCE_SCHEDULE, defaultFrequency: "weekly" };
  assert.throws(
    () => allRemittanceSchedules({ CA: { ...payrollPack("CA"), remittanceSchedules: [bad] } }),
    /not one of its declared frequencies/,
  );
});

test("a schedule with an empty average-monthly band is refused", () => {
  const bad: PayrollRemittanceSchedule = {
    ...RQ_REMITTANCE_SCHEDULE,
    frequencies: RQ_REMITTANCE_SCHEDULE.frequencies.map((band) => band.frequency === "monthly"
      ? { ...band, averageMonthlyMin: "25000", averageMonthlyMaxExclusive: "3000" }
      : band),
  };
  assert.throws(
    () => allRemittanceSchedules({ CA: { ...payrollPack("CA"), remittanceSchedules: [bad] } }),
    /empty average-monthly band/,
  );
});

test("a schedule citing no source is refused — every rule must be verifiable", () => {
  const bad: PayrollRemittanceSchedule = { ...RQ_REMITTANCE_SCHEDULE, sources: [] };
  assert.throws(
    () => allRemittanceSchedules({ CA: { ...payrollPack("CA"), remittanceSchedules: [bad] } }),
    /cites no published source/,
  );
});

test("a schedule on an undeclared calendar is refused", () => {
  const bad: PayrollRemittanceSchedule = { ...RQ_REMITTANCE_SCHEDULE, calendar: "CA-NOWHERE" };
  assert.throws(
    () => allRemittanceSchedules({ CA: { ...payrollPack("CA"), remittanceSchedules: [bad] } }),
    /no payroll pack declares/,
  );
});

test("frequency settings keys derive from the declared schedules", () => {
  assert.deepEqual(declaredRemittanceFrequencySettingsKeys(), ["rqRemittanceFrequency"]);
});

test("an unknown frequency resolves to no band — the caller falls back, never guesses", () => {
  assert.equal(remittanceFrequencyBand(RQ_REMITTANCE_SCHEDULE, "weekly"), null);
});
