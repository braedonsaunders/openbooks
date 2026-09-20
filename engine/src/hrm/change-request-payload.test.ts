import assert from "node:assert/strict";
import test from "node:test";

// Static imports evaluate before the module body, so in-file assignments
// cannot guard the import-time database-environment resolution in db.ts.
// These tests never touch a database (pure zod validation), but the module
// under test shares the engine import graph — blank the URL first and import
// dynamically, the same approach as authorization.test.ts.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

const {
  HrmChangeRequestError,
  validateChangePayload,
} = await import("./change-requests.ts");

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HrmChangeRequestError);
    return error.code;
  }
  assert.fail("expected a refusal");
}

test("unknown kinds are refused by name", () => {
  assert.equal(codeOf(() => validateChangePayload({ kind: "promote" })), "UNKNOWN_KIND");
  assert.equal(codeOf(() => validateChangePayload({})), "UNKNOWN_KIND");
  assert.equal(codeOf(() => validateChangePayload(null)), "INVALID_PAYLOAD");
  assert.equal(codeOf(() => validateChangePayload([])), "INVALID_PAYLOAD");
  assert.throws(
    () => validateChangePayload({ kind: "promotion" }),
    /hire, status_change, assignment_change, termination, position_assignment, or profile_change/,
    "the refusal lists the governed kinds",
  );
});

test("hire accepts a minimal proposal and defaults status to active", () => {
  const parsed = validateChangePayload({ kind: "hire", effectiveFrom: "2026-09-01" });
  assert.equal(parsed.kind, "hire");
  if (parsed.kind !== "hire") throw new Error("unreachable");
  assert.equal(parsed.status, "active");
  assert.equal(parsed.effectiveTo, null);
});

test("hire refuses terminated status and bad windows", () => {
  assert.equal(
    codeOf(() => validateChangePayload({ kind: "hire", status: "terminated", effectiveFrom: "2026-09-01" })),
    "INVALID_PAYLOAD",
  );
  assert.equal(
    codeOf(() => validateChangePayload({ kind: "hire", effectiveFrom: "2026-13-01" })),
    "INVALID_PAYLOAD",
  );
  assert.equal(
    codeOf(() => validateChangePayload({ kind: "hire", effectiveFrom: "2026-09-01", effectiveTo: "2026-09-01" })),
    "INVALID_PAYLOAD",
  );
  assert.equal(
    codeOf(() => validateChangePayload({ kind: "hire", effectiveFrom: "2026-09-01", rank: "vp" })),
    "INVALID_PAYLOAD",
    "unknown keys are stripped by refusal, never silently stored",
  );
});

test("status_change requires a governed status and a real window", () => {
  const parsed = validateChangePayload({
    kind: "status_change",
    status: "on_leave",
    effectiveFrom: "2026-09-01",
  });
  assert.equal(parsed.kind, "status_change");
  assert.equal(codeOf(() => validateChangePayload({ kind: "status_change", status: "fired", effectiveFrom: "2026-09-01" })), "INVALID_PAYLOAD");
  assert.equal(codeOf(() => validateChangePayload({ kind: "status_change", status: "active", effectiveFrom: "not-a-date" })), "INVALID_PAYLOAD");
});

test("assignment_change needs at least one content field", () => {
  assert.equal(codeOf(() => validateChangePayload({ kind: "assignment_change", assignmentKey: "primary" })), "INVALID_PAYLOAD");
  const parsed = validateChangePayload({ kind: "assignment_change", assignmentKey: "primary", fte: "0.8" });
  assert.equal(parsed.kind, "assignment_change");
});

test("assignment_change refuses manager removal, bad fte, and bad refs", () => {
  assert.equal(
    codeOf(() => validateChangePayload({ kind: "assignment_change", assignmentKey: "k", fte: "1", managerEmploymentId: null })),
    "INVALID_PAYLOAD",
  );
  for (const fte of ["0", "-1", "NaN", "1.23456", "lots", "1000"]) {
    assert.equal(codeOf(() => validateChangePayload({ kind: "assignment_change", assignmentKey: "k", fte })), "INVALID_PAYLOAD", `fte ${fte}`);
  }
  assert.equal(
    codeOf(() => validateChangePayload({ kind: "assignment_change", assignmentKey: "k", fte: "1", departmentId: "nope" })),
    "INVALID_PAYLOAD",
  );
});

test("termination needs a real civil date", () => {
  const parsed = validateChangePayload({ kind: "termination", effectiveDate: "2026-10-31" });
  assert.equal(parsed.kind, "termination");
  assert.equal(codeOf(() => validateChangePayload({ kind: "termination" })), "INVALID_PAYLOAD");
  assert.equal(codeOf(() => validateChangePayload({ kind: "termination", effectiveDate: "2026-02-30" })), "INVALID_PAYLOAD");
});
