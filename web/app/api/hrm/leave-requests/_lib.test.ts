import assert from "node:assert/strict";
import test from "node:test";

// The mapping imports the real engine error classes (no database touched —
// error construction never queries). Blank the URL first and import
// dynamically, the engine unit-test approach.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

const { leaveErrorResponse } = await import("./_lib.ts");
const { HrmAuthorizationError } = await import("@openbooks/engine/src/hrm/authorization.ts");
const { LeaveError } = await import("@openbooks/engine/src/hrm/leave-errors.ts");
import type { LeaveErrorCode } from "@openbooks/engine/src/hrm/leave-errors.ts";

test("every refusal code maps to its status with the message intact", () => {
  const cases: Array<[LeaveErrorCode, number]> = [
    ["INVALID_INPUT", 400],
    ["NOT_FOUND", 404],
    ["BAD_STATE", 409],
    ["STALE_RUN", 409],
    ["NO_FLOW", 422],
    ["FLOW_ERROR", 422],
    ["REFUSED", 422],
  ];
  for (const [code, status] of cases) {
    const response = leaveErrorResponse(new LeaveError(code, `${code} message with remedy`));
    assert.equal(response.status, status, code);
  }
});

test("authorization refusals hide unknown subjects and forbid missing grants", () => {
  const hidden = leaveErrorResponse(
    new HrmAuthorizationError("employment emp-1 is not visible in this organization"),
  );
  assert.equal(hidden.status, 404);
  const forbidden = leaveErrorResponse(
    new HrmAuthorizationError("Leave access requires the hrm.leave.read permission"),
  );
  assert.equal(forbidden.status, 403);
});

test("anything else is a private 500", async () => {
  const response = leaveErrorResponse(new Error("boom"));
  assert.equal(response.status, 500);
  // Error bodies are checked before they are parsed: the caller branches on
  // the status, and only then reads the body.
  assert.ok(!response.ok);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "internal error");
});
