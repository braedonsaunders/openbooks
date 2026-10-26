import assert from "node:assert/strict";
import test from "node:test";
import {
  assignmentDecision,
  evaluateAssignment,
  hoursToMinutes,
  type AssignmentProposal,
  type TechnicianDayFacts,
} from "./dispatch-rules.ts";

const open: TechnicianDayFacts = {
  bookings: [],
  absences: [],
  qualificationTypeIds: new Set(["gas"]),
  scheduledDay: true,
  scheduledHours: "8.0000",
  workingWindow: { startsAt: "2026-05-04T12:00:00.000Z", endsAt: "2026-05-04T21:00:00.000Z" },
};
const visit: AssignmentProposal = {
  startsAt: "2026-05-04T14:00:00.000Z",
  endsAt: "2026-05-04T16:00:00.000Z",
  requiredQualificationTypeIds: ["gas"],
  qualificationNames: { gas: "Gas fitter", elec: "Electrician" },
  arrivalWindow: { startsAt: "2026-05-04T13:00:00.000Z", endsAt: "2026-05-04T15:00:00.000Z" },
  responseDueAt: "2026-05-04T18:00:00.000Z",
};

test("a technician free, qualified and inside working hours meets no conflict", () => {
  assert.deepEqual(evaluateAssignment(visit, open), []);
  assert.deepEqual(assignmentDecision([], null), { ok: true, warnings: [] });
});

test("overlap with any other booking, recorded leave and a missing qualification block and cannot be overridden", () => {
  const conflicts = evaluateAssignment(
    { ...visit, requiredQualificationTypeIds: ["gas", "elec"] },
    {
      ...open,
      bookings: [
        {
          id: "b1",
          startsAt: "2026-05-04T15:30:00.000Z",
          endsAt: "2026-05-04T17:00:00.000Z",
          label: "Shift on Ward A",
        },
      ],
      absences: [{ onDate: "2026-05-04", leaveTypeName: "Vacation" }],
    },
  );
  assert.deepEqual(
    conflicts.map((conflict) => [conflict.code, conflict.severity]),
    [
      ["overlap", "block"],
      ["leave", "block"],
      ["qualification", "block"],
    ],
  );
  assert.match(conflicts[2]!.message, /Electrician/);
  const decision = assignmentDecision(conflicts, "The customer insists");
  assert.equal(decision.ok, false);
  assert.equal(
    decision.ok === false && decision.blocking,
    true,
    "an override reason never admits a blocking conflict",
  );
});

test("touching bookings do not overlap", () => {
  const conflicts = evaluateAssignment(visit, {
    ...open,
    bookings: [
      {
        id: "b1",
        startsAt: "2026-05-04T16:00:00.000Z",
        endsAt: "2026-05-04T17:00:00.000Z",
        label: "Next visit",
      },
    ],
  });
  assert.deepEqual(
    conflicts.filter((conflict) => conflict.code === "overlap"),
    [],
  );
});

test("working hours, a day off, scheduled capacity, the arrival window and the response target warn and need a reason", () => {
  const late: AssignmentProposal = {
    ...visit,
    startsAt: "2026-05-04T20:00:00.000Z",
    endsAt: "2026-05-04T22:00:00.000Z",
  };
  const conflicts = evaluateAssignment(late, {
    ...open,
    scheduledDay: false,
    bookings: [
      {
        id: "b1",
        startsAt: "2026-05-04T12:00:00.000Z",
        endsAt: "2026-05-04T19:00:00.000Z",
        label: "Install",
      },
    ],
  });
  assert.deepEqual(conflicts.map((conflict) => conflict.code).sort(), [
    "after_response_target",
    "non_working_day",
    "outside_arrival_window",
    "outside_working_hours",
    "over_capacity",
  ]);
  assert.ok(conflicts.every((conflict) => conflict.severity === "warn"));
  const withoutReason = assignmentDecision(conflicts, null);
  assert.equal(withoutReason.ok, false);
  assert.equal(withoutReason.ok === false && withoutReason.blocking, false);
  assert.equal(assignmentDecision(conflicts, "   ").ok, false, "a blank reason is no reason");
  const withReason = assignmentDecision(conflicts, "Customer asked for an evening visit");
  assert.equal(withReason.ok, true);
  assert.equal(withReason.ok && withReason.warnings.length, 5);
});

test("unknown schedules and windows impose nothing", () => {
  const conflicts = evaluateAssignment(
    {
      ...visit,
      arrivalWindow: null,
      responseDueAt: null,
      startsAt: "2026-05-04T23:00:00.000Z",
      endsAt: "2026-05-05T01:00:00.000Z",
    },
    { ...open, scheduledDay: null, scheduledHours: null, workingWindow: null },
  );
  assert.deepEqual(conflicts, []);
});

test("scheduled hours convert to minutes exactly", () => {
  assert.equal(hoursToMinutes("7.5000"), 450);
  assert.equal(hoursToMinutes("8"), 480);
  assert.equal(hoursToMinutes("0.3333"), 20);
  assert.equal(hoursToMinutes("x"), null);
});

test("a booking that does not end after it starts is refused outright", () => {
  const conflicts = evaluateAssignment({ ...visit, endsAt: visit.startsAt }, open);
  assert.deepEqual(
    conflicts.map((conflict) => conflict.severity),
    ["block"],
  );
});
