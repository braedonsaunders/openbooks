import assert from "node:assert/strict";
import test from "node:test";
import { resAssignments } from "@openbooks/schema";
import type { AvailabilityFigure } from "./availability.ts";
import { buildResourcingForecast } from "./forecast.ts";

type Row = typeof resAssignments.$inferSelect;
const person = "00000000-0000-4000-8000-000000000001";
const benchPerson = "00000000-0000-4000-8000-000000000002";
const row = (id: string, values: Partial<Row> = {}): Row => ({
  id, orgId: "org", projectId: "project", employeePartyId: person, jobTitle: null,
  weekStart: "2026-10-04", plannedHours: "8.0000", isBillable: true, billItemId: null,
  projectTaskId: null, booking: "hard", state: "active", source: "manual", requestId: null,
  custom: {}, createdAt: new Date(0), createdBy: "actor", updatedAt: new Date(0), updatedBy: "actor",
  ...values,
});
const capacity = (weekStart: string, netCapacity: string, employeePartyId = person): AvailabilityFigure => ({
  employeePartyId, weekStart, netCapacity, overage: false,
  capacity: { hours: "40.0000", tier: { tier: "labor-costing-standard", annualHours: 2080 }, scheduleSources: [] },
  holidays: { applied: true, jurisdiction: "US", dates: [], hours: "0.0000" },
  timeOff: { hours: "0.0000", absenceRowIds: [] },
});
const window = { firstWeek: "2026-10-04", lastWeek: "2026-10-25", asOf: "2026-10-04", rolloffWeeks: 4 };

test("hard hours over net capacity are additive facts and signal overallocation", () => {
  const result = buildResourcingForecast([row("hard", { plannedHours: "50.0000" })], [capacity(window.firstWeek, "40.0000")], window);
  assert.equal(result.personWeeks[0]?.availableHours, "-10.0000");
  assert.equal(result.personWeeks[0]?.overallocated, true);
  assert.deepEqual(result.personWeeks[0]?.hardBillableAssignmentIds, ["hard"]);
});

test("soft bookings are cited but do not reduce availability", () => {
  const result = buildResourcingForecast([row("soft", { booking: "soft", plannedHours: "12.0000" })], [capacity(window.firstWeek, "40.0000")], window);
  assert.equal(result.personWeeks[0]?.availableHours, "40.0000");
  assert.equal(result.personWeeks[0]?.softBillableHours, "12.0000");
  assert.deepEqual(result.personWeeks[0]?.assignmentIds, ["soft"]);
});

test("bench, hard-only rolloffs, tentative follow-ons, and generic demand cite assignments", () => {
  const rows = [
    row("bench-soft", { employeePartyId: benchPerson, booking: "soft" }),
    row("roll-hard", { weekStart: "2026-10-11" }),
    row("roll-soft", { weekStart: "2026-10-18", booking: "soft" }),
    row("generic-a", { employeePartyId: null, jobTitle: "Consultant", plannedHours: "4.0000" }),
    row("generic-b", { employeePartyId: null, jobTitle: "consultant", booking: "soft", plannedHours: "3.0000" }),
    row("released", { state: "released", plannedHours: "99.0000" }),
  ];
  const result = buildResourcingForecast(rows, [capacity(window.firstWeek, "40.0000"), capacity("2026-10-11", "40.0000"), capacity(window.firstWeek, "20.0000", benchPerson)], window);
  assert.deepEqual(result.bench[0], { employeePartyId: benchPerson, weekStarts: [window.firstWeek], netCapacity: "20.0000", assignmentIds: ["bench-soft"] });
  assert.deepEqual(result.rolloffs[0], {
    employeePartyId: person, lastHardWeek: "2026-10-11", assignmentIds: ["roll-hard"], tentativeAfterIds: ["roll-soft"],
  });
  assert.equal(result.genericDemand[0]?.hardHours, "4.0000");
  assert.equal(result.genericDemand[0]?.softHours, "3.0000");
  assert.deepEqual(result.genericDemand[0]?.assignmentIds, ["generic-a", "generic-b"]);
});

test("leave can reduce net capacity to zero while hard hours remain overallocated", () => {
  const fullyOnLeave = {
    ...capacity(window.firstWeek, "0.0000"),
    timeOff: { hours: "40.0000", absenceRowIds: ["leave"] },
  };
  const result = buildResourcingForecast([row("booked", { plannedHours: "1.0000" })], [fullyOnLeave], window);
  assert.equal(result.personWeeks[0]?.netCapacity, "0.0000");
  assert.equal(result.personWeeks[0]?.availableHours, "-1.0000");
  assert.equal(result.personWeeks[0]?.overallocated, true);
  assert.deepEqual(result.personWeeks[0]?.timeOff, { hours: "40.0000", absenceRowIds: ["leave"] });
});
