import assert from "node:assert/strict";
import test from "node:test";
import { presentedWorkPeriods, workCompletedOn, workPeriodRefusal } from "./work-period.ts";

test("presented invoice lines span the work dates of the detail they bill; the invoice completes on the latest", () => {
  // Detail 0 and 2 roll into presented line 0; detail 1 presents as line 1;
  // detail 3 (a rate-card charge) has no work date.
  const periods = presentedWorkPeriods(["2026-07-14", "2026-07-02", "2026-07-03", null], [0, 1, 0, 2], 3);
  assert.deepEqual(periods, [
    { workFrom: "2026-07-03", workTo: "2026-07-14" },
    { workFrom: "2026-07-02", workTo: "2026-07-02" },
    { workFrom: null, workTo: null },
  ]);
  assert.equal(workCompletedOn(periods), "2026-07-14");
  assert.equal(workCompletedOn([{ workFrom: null, workTo: null }]), null);
});

test("an entered work period must be real dates in order", () => {
  assert.equal(workPeriodRefusal(null, undefined), null);
  assert.equal(workPeriodRefusal("2026-07-01", "2026-07-01"), null);
  assert.equal(workPeriodRefusal("2026-07-02", "2026-07-01"), "work to must be on or after work from");
  assert.equal(workPeriodRefusal("2026-02-30", null), "invalid work from date — expected YYYY-MM-DD");
});
