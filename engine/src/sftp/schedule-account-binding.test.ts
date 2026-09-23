import assert from "node:assert/strict";
import test from "node:test";
import { assertScheduleAccountBinding } from "./import-job.ts";

/**
 * The schedule account-identity gate, unit-pinned: a stranger file for
 * another account refuses naming the file, the found account, and the
 * expected one; an identified file with no binding refuses with the
 * schedule remedy; an unidentified file (CSV) relies on folder isolation
 * and passes. The live-folder behavior is covered by
 * sftp-import-account-binding.integration.test.ts.
 */

test("a match across spacing and case imports", () => {
  assertScheduleAccountBinding({
    scheduleId: "sched-1",
    filename: "stmt.ofx",
    expectedExternalAccountId: "DE975203000012345678",
    foundExternalAccountId: "de97 5203 0000 1234 5678",
  });
});

test("a stranger file for another account refuses naming both sides", () => {
  assert.throws(
    () =>
      assertScheduleAccountBinding({
        scheduleId: "sched-1",
        filename: "stmt-b.ofx",
        expectedExternalAccountId: "111",
        foundExternalAccountId: "222",
      }),
    (e: unknown) =>
      e instanceof Error && /stmt-b\.ofx/.test(e.message) && /222/.test(e.message) && /111/.test(e.message),
    "the refusal must name the file, the found account, and the expected one",
  );
});

test("an identified file with no binding refuses with the schedule remedy", () => {
  assert.throws(
    () =>
      assertScheduleAccountBinding({
        scheduleId: "sched-1",
        filename: "stmt.ofx",
        expectedExternalAccountId: null,
        foundExternalAccountId: "12345678",
      }),
    (e: unknown) => e instanceof Error && /expected.*account/i.test(e.message) && /12345678/.test(e.message),
    "an unconfigured schedule must pause with the binding remedy, not import strangers",
  );
});

test("an unidentified file relies on folder isolation and passes", () => {
  assertScheduleAccountBinding({
    scheduleId: "sched-1",
    filename: "statement.csv",
    expectedExternalAccountId: "111",
    foundExternalAccountId: undefined,
  });
});
