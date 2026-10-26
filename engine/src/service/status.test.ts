import assert from "node:assert/strict";
import test from "node:test";
import {
  jobTransitionAllowed,
  nextVisitStatuses,
  requestTransitionAllowed,
  responseHours,
  VISIT_STATUSES,
  visitIsReschedulable,
  visitTransitionAllowed,
  visitTransitionPermitted,
} from "./status.ts";

test("the visit field lifecycle moves forward from booking to an outcome", () => {
  const path = [
    "unscheduled",
    "scheduled",
    "dispatched",
    "en_route",
    "on_site",
    "completed",
  ] as const;
  for (let index = 1; index < path.length; index += 1)
    assert.equal(
      visitTransitionAllowed(path[index - 1]!, path[index]!),
      true,
      `${path[index - 1]} → ${path[index]}`,
    );
  assert.equal(
    visitTransitionAllowed("scheduled", "en_route"),
    true,
    "a technician may leave without a separate dispatch",
  );
  for (const from of ["en_route", "on_site"] as const)
    assert.equal(visitTransitionAllowed(from, "unable_to_complete"), true);
  for (const terminal of ["unable_to_complete", "cancelled"] as const) {
    for (const to of VISIT_STATUSES)
      assert.equal(visitTransitionAllowed(terminal, to), false, `${terminal} is final`);
  }
  assert.equal(
    visitTransitionAllowed("unscheduled", "on_site"),
    false,
    "work starts only on a booked visit",
  );
  assert.equal(
    visitTransitionAllowed("en_route", "cancelled"),
    false,
    "a visit someone left for ends with an outcome, not a cancellation",
  );
});

test("technicians move only the field statuses of their own work; staff also dispatch and cancel", () => {
  assert.deepEqual(nextVisitStatuses("dispatched", "technician"), ["en_route"]);
  assert.deepEqual(nextVisitStatuses("on_site", "technician"), ["completed", "unable_to_complete"]);
  assert.equal(visitTransitionPermitted("scheduled", "dispatched", "technician"), false);
  assert.equal(visitTransitionPermitted("scheduled", "cancelled", "technician"), false);
  assert.deepEqual(nextVisitStatuses("scheduled", "staff"), [
    "dispatched",
    "en_route",
    "cancelled",
  ]);
  assert.equal(
    visitTransitionPermitted("completed", "on_site", "staff"),
    false,
    "only a completion review reopens a visit",
  );
});

test("bookings move only before anyone leaves", () => {
  assert.deepEqual(VISIT_STATUSES.filter(visitIsReschedulable), [
    "unscheduled",
    "scheduled",
    "dispatched",
  ]);
});

test("jobs complete, reopen while uninvoiced or cancel; requests close once", () => {
  assert.equal(jobTransitionAllowed("open", "completed"), true);
  assert.equal(jobTransitionAllowed("completed", "open"), true);
  assert.equal(jobTransitionAllowed("cancelled", "open"), false);
  assert.equal(
    requestTransitionAllowed("quoted", "assessed"),
    true,
    "a declined quote returns the request to assessed",
  );
  assert.equal(requestTransitionAllowed("converted", "new"), false);
  assert.equal(requestTransitionAllowed("declined", "converted"), false);
});

test("response targets come from the policy by priority, and an unset target is none", () => {
  const policy = {
    urgentResponseHours: 4,
    highResponseHours: 24,
    normalResponseHours: 72,
    lowResponseHours: null,
  };
  assert.equal(responseHours(policy, "urgent"), 4);
  assert.equal(responseHours(policy, "normal"), 72);
  assert.equal(responseHours(policy, "low"), null);
});
