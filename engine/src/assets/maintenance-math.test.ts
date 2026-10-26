import assert from "node:assert/strict";
import test from "node:test";
import { AssetRefusal } from "./asset-refusal.ts";
import {
  addMonthsClamped,
  daysBetween,
  maintenanceDueKey,
  maintenanceStanding,
  nextMaintenanceDue,
} from "./maintenance-math.ts";

function refusedWith(code: string, fn: () => void): void {
  assert.throws(fn, (error: unknown) => error instanceof AssetRefusal && error.code === code);
}

test("month intervals clamp to the end of shorter months and cross years", () => {
  assert.equal(addMonthsClamped("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsClamped("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonthsClamped("2026-11-15", 3), "2027-02-15");
  assert.equal(addMonthsClamped("2026-03-31", 12), "2027-03-31");
  refusedWith("date_invalid", () => addMonthsClamped("2026-02-30", 1));
  assert.equal(daysBetween("2026-07-01", "2026-07-15"), 14);
  assert.equal(daysBetween("2026-07-15", "2026-07-01"), -14);
  assert.equal(addMonthsClamped("0099-12-31", 2), "0100-02-28");
  assert.equal(daysBetween("0099-12-31", "0100-01-01"), 1);
  refusedWith("date_invalid", () => addMonthsClamped("0000-01-01", 1));
});

test("the next due point counts from the last service, or the start date and a zero meter", () => {
  assert.deepEqual(
    nextMaintenanceDue({
      intervalMonths: 6,
      intervalUsage: null,
      startsOn: "2026-01-10",
      lastPerformedOn: null,
      lastPerformedUsage: null,
    }),
    { nextDueOn: "2026-07-10", nextDueUsage: null },
  );
  assert.deepEqual(
    nextMaintenanceDue({
      intervalMonths: 6,
      intervalUsage: "250",
      startsOn: "2026-01-10",
      lastPerformedOn: "2026-05-02",
      lastPerformedUsage: "1180.5",
    }),
    { nextDueOn: "2026-11-02", nextDueUsage: "1430.5000" },
  );
  assert.deepEqual(
    nextMaintenanceDue({
      intervalMonths: null,
      intervalUsage: "500",
      startsOn: "2026-01-10",
      lastPerformedOn: null,
      lastPerformedUsage: null,
    }),
    { nextDueOn: null, nextDueUsage: "500.0000" },
  );
  refusedWith("interval_required", () =>
    nextMaintenanceDue({
      intervalMonths: null,
      intervalUsage: null,
      startsOn: "2026-01-10",
      lastPerformedOn: null,
      lastPerformedUsage: null,
    }),
  );
  refusedWith("interval_invalid", () =>
    nextMaintenanceDue({
      intervalMonths: 0,
      intervalUsage: null,
      startsOn: "2026-01-10",
      lastPerformedOn: null,
      lastPerformedUsage: null,
    }),
  );
  refusedWith("interval_invalid", () =>
    nextMaintenanceDue({
      intervalMonths: null,
      intervalUsage: "0",
      startsOn: "2026-01-10",
      lastPerformedOn: null,
      lastPerformedUsage: null,
    }),
  );
});

test("standing is due within the lead window, overdue after the date, and the worse of time and meter", () => {
  const base = { nextDueOn: "2026-07-31", nextDueUsage: null, currentUsage: null, leadDays: 14 };
  assert.equal(maintenanceStanding({ ...base, today: "2026-07-16" }), "scheduled");
  assert.equal(maintenanceStanding({ ...base, today: "2026-07-17" }), "due");
  assert.equal(maintenanceStanding({ ...base, today: "2026-07-31" }), "due");
  assert.equal(maintenanceStanding({ ...base, today: "2026-08-01" }), "overdue");
  const meter = {
    nextDueOn: "2026-12-31",
    nextDueUsage: "1500",
    leadDays: 14,
    today: "2026-07-01",
  };
  assert.equal(maintenanceStanding({ ...meter, currentUsage: "1499.9" }), "scheduled");
  assert.equal(maintenanceStanding({ ...meter, currentUsage: "1500" }), "due");
  assert.equal(
    maintenanceStanding({ ...meter, currentUsage: "1500.1" }),
    "overdue",
    "the meter can make a date-scheduled task overdue",
  );
  assert.equal(
    maintenanceStanding({ ...meter, currentUsage: null }),
    "scheduled",
    "no reading yet leaves usage undecided",
  );
});

test("each due point has one stable identity", () => {
  assert.equal(maintenanceDueKey("2026-07-31", "1500"), "2026-07-31|1500.0000");
  assert.equal(
    maintenanceDueKey("2026-07-31", "1500.0000"),
    maintenanceDueKey("2026-07-31", "1500"),
  );
  assert.equal(maintenanceDueKey(null, null), "-|-");
});
