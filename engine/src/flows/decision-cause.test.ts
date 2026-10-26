import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeDecisionCause } from "./decision-cause.ts";

// The shared flows contract boundary: a storage failure's driver
// internals never render to a decider, while curated domain and adapter
// refusals keep their message and remedy. Pure leaf, no database.
const DRIVER_SHAPED = Object.assign(
  new Error(
    "Failed query: insert into employment_changes (org_id, employment_id) values ($1, $2) params: 8de50a24-e1e4-4d50-8e637598db93,f5d329ce-5897-4485-8254-72cdf600328a",
  ),
  {
    code: "23514",
    constraint: "employment_changes_kind",
    table: "employment_changes",
    query: "insert into employment_changes (org_id, employment_id) values ($1, $2)",
    params: ["8de50a24-e1e4-4d50-8e637598db93", "f5d329ce-5897-4485-8254-72cdf600328a"],
  },
);

test("a storage failure renders one stable message with no internals", () => {
  const cause = sanitizeDecisionCause(DRIVER_SHAPED);
  assert.equal(cause, "the change could not be recorded because of a storage failure");
  for (const leaked of ["insert into", "params:", "8de50a24", "employment_changes_kind", "23514"]) {
    assert.ok(!cause.includes(leaked), `the cause must not leak ${leaked}`);
  }
});

test("curated domain and adapter refusals render intact", () => {
  assert.equal(
    sanitizeDecisionCause(new Error("no recipients resolved")),
    "no recipients resolved",
  );
  assert.equal(
    sanitizeDecisionCause(new Error("simulated release failure after partial write")),
    "simulated release failure after partial write",
  );
  assert.equal(
    sanitizeDecisionCause("subject record no longer exists"),
    "subject record no longer exists",
  );
});

test("defect-shaped throws keep their defect-reporting path", () => {
  const cause = sanitizeDecisionCause(new TypeError("Cannot read properties of undefined"));
  assert.ok(
    cause.includes("Cannot read properties"),
    "a programming error still reports its message above",
  );
});
