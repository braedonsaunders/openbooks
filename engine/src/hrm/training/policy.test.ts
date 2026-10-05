import assert from "node:assert/strict";
import test from "node:test";
import { trainingPolicy, trainingRequestHash, trainingResult, trainingSessionWindow, trainingWindow } from "./policy.ts";

const policy = { qualificationTypeId: null, minimumAttendancePercent: 67, passingScore: 70 };

test("attendance decisions preserve the exact integer threshold, including a one-second boundary", () => {
  assert.equal(trainingResult(policy, 3, 2, 100).passed, false, "two seconds out of three must not be rounded up to a declared 67% threshold");
  assert.equal(trainingResult({ ...policy, minimumAttendancePercent: 66 }, 3, 2, 100).passed, true);
  for (let threshold = 0; threshold <= 100; threshold++) {
    for (const duration of [1, 59, 3600, 2678400]) {
      const minimum = Math.ceil(duration * threshold / 100);
      assert.equal(trainingResult({ ...policy, minimumAttendancePercent: threshold }, duration, minimum, 70).passed, true);
      if (minimum > 0) assert.equal(trainingResult({ ...policy, minimumAttendancePercent: threshold }, duration, minimum - 1, 70).passed, false);
    }
  }
});

test("a qualification-producing result needs both attendance and its declared assessment", () => {
  assert.equal(trainingResult(policy, 3600, 3600, 69).passed, false);
  assert.throws(() => trainingResult(policy, 3600, 3600, null), /requires an assessment score.*record the score/);
  assert.equal(trainingResult({ ...policy, passingScore: null }, 3600, 3600, null).passed, true);
  assert.throws(() => trainingResult({ ...policy, passingScore: null }, 3600, 3600, 80), /has no assessment.*leave the score empty/);
  for (const invalid of [-1, 3601, 1.5, NaN, Infinity, "3600", undefined]) assert.throws(() => trainingResult(policy, 3600, invalid, 80), /Attendance seconds.*whole number/);
  for (const invalid of [-1, 101, 70.5, "70", undefined]) assert.throws(() => trainingResult(policy, 3600, 3600, invalid), /Assessment score.*whole number/);
});

test("session instants distinguish repeated daylight-saving hours and derive the actual local completion day", () => {
  const repeated = trainingSessionWindow("2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00", "America/Toronto");
  assert.equal(repeated.durationSeconds, 3600);
  assert.equal(repeated.startsAt, "2026-11-01T05:30:00.000Z");
  assert.equal(repeated.endsAt, "2026-11-01T06:30:00.000Z");
  assert.equal(repeated.endsOn, "2026-11-01");
  const midnight = trainingSessionWindow("2026-01-09T00:00:00.000Z", "2026-01-09T01:00:00Z", "America/Toronto");
  assert.equal(midnight.startsOn, "2026-01-08");
  assert.equal(midnight.endsOn, "2026-01-08");
});

test("unreadable or ambiguous session times never acquire a guessed time zone or a normalized calendar date", () => {
  assert.throws(() => trainingSessionWindow("2026-01-09T10:00:00Z", "2026-01-09T11:00:00Z", "+03:00"), /choose an IANA time zone/);
  for (const start of ["2026-02-30T10:00:00Z", "2026-01-09T24:00:00Z", "2026-01-09T10:00:00", "2026-01-09T10:00:00+14:01", "2026-01-09T10:00:00.001Z"]) {
    assert.throws(() => trainingSessionWindow(start, "2026-01-09T11:00:00Z", "America/Toronto"), /Session time|Session times/);
  }
  assert.throws(() => trainingSessionWindow("2026-01-09T10:00:00Z", "2026-01-09T10:00:00Z", "America/Toronto"), /end after its start/);
  assert.throws(() => trainingSessionWindow("2026-01-09T10:00:00Z", "2026-01-09T11:00:00Z", "Imaginary/Place"), /Time zone is unknown.*IANA/);
});

test("course windows and policy bounds refuse malformed definitions before storage", () => {
  assert.deepEqual(trainingWindow("2026-01-01", null), { effectiveFrom: "2026-01-01", effectiveTo: null });
  for (const to of [undefined, "2025-12-31", "2026-02-30"]) assert.throws(() => trainingWindow("2026-01-01", to), /effective dates.*ordered/);
  for (const minimum of [-1, 101, 50.5, undefined]) assert.throws(() => trainingPolicy({ ...policy, minimumAttendancePercent: minimum as number }), /Minimum attendance percentage.*whole number/);
});

test("creation and completion fingerprints preserve actual policy inputs and ignore only object key order", () => {
  const request = { policy, result: trainingResult(policy, 3600, 3600, 80) };
  assert.equal(trainingRequestHash(request), trainingRequestHash({ result: request.result, policy }));
  assert.notEqual(trainingRequestHash(request), trainingRequestHash({ ...request, result: trainingResult(policy, 3600, 3599, 80) }));
});
