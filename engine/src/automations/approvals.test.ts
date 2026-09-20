import test from "node:test";
import assert from "node:assert/strict";
import { scoreException, ApprovalPolicyError } from "./approvals.ts";
import { assertWritableField, registryEntity, AutomationRegistryError } from "./registry.ts";

test("timesheet within thresholds passes and names every check with values", () => {
  const score = scoreException(
    "timesheet_week",
    { entity: "timesheet_week", fields: { total_hours: 38, max_day_hours: 8, missing_punches: 0 }, scope: {} },
    { max_hours_per_day: 10, max_week_hours: 40, allow_missing_punch: false },
  );
  assert.equal(score.within, true);
  assert.deepEqual(score.checked, [
    "max_week_hours: threshold 40, actual 38",
    "max_hours_per_day: threshold 10, actual 8",
    "allow_missing_punch: threshold false, actual 0",
  ]);
  assert.deepEqual(score.breaches, []);
});

test("timesheet breach names the breached threshold", () => {
  const score = scoreException(
    "timesheet_week",
    { entity: "timesheet_week", fields: { total_hours: 47, max_day_hours: 8 }, scope: {} },
    { max_hours_per_day: 10, max_week_hours: 40 },
  );
  assert.equal(score.within, false);
  assert.match(score.breaches.join(";"), /exceeds 40h/);
  // The audit still names every threshold checked, including the passing ones.
  assert.deepEqual(score.checked, [
    "max_week_hours: threshold 40, actual 47",
    "max_hours_per_day: threshold 10, actual 8",
  ]);
});

test("missing thresholds refuse instead of passing", () => {
  assert.throws(
    () => scoreException("timesheet_week", { entity: "timesheet_week", fields: { total_hours: 1 }, scope: {} }, {}),
    (e: unknown) => e instanceof ApprovalPolicyError && /needs max_hours_per_day/.test((e as Error).message),
  );
});

test("leave and expense scoring", () => {
  const leave = scoreException(
    "leave_request",
    { entity: "leave_request", fields: { days: 2, has_balance: true }, scope: {} },
    { max_days: 3, requires_balance: true },
  );
  assert.equal(leave.within, true);
  assert.deepEqual(leave.checked, ["max_days: threshold 3, actual 2", "requires_balance: threshold true, actual true"]);
  const expense = scoreException(
    "expense_report",
    { entity: "expense_report", fields: { total: 5000 }, scope: {} },
    { max_amount: 500 },
  );
  assert.equal(expense.within, false);
  assert.deepEqual(expense.checked, ["max_amount: threshold 500, actual 5000"]);
});

test("unknown subject never auto-passes", () => {
  assert.throws(
    () => scoreException("mystery", { entity: "mystery", fields: {}, scope: {} }, {}),
    (e: unknown) => e instanceof ApprovalPolicyError && /never auto-pass/.test((e as Error).message),
  );
});

test("registry pins ten entities with allowlists", () => {
  assert.equal(registryEntity("employment")?.readableFields.includes("status"), true);
  assert.equal(registryEntity("nope"), null);
  // Employment versions change only through change requests.
  assert.throws(
    () => assertWritableField("employment", "department_id"),
    (e: unknown) => e instanceof AutomationRegistryError && /change request/.test((e as Error).message),
  );
  assert.throws(
    () => assertWritableField("employment", "salary"),
    AutomationRegistryError,
  );
  assert.throws(
    () => assertWritableField("mystery", "x"),
    (e: unknown) => e instanceof AutomationRegistryError && /known: employment/.test((e as Error).message),
  );
});
