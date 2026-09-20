import assert from "node:assert/strict";
import test from "node:test";

// The mapping imports the real engine error classes (no database touched —
// error construction never queries). Blank the URL first and import
// dynamically, the engine unit-test approach.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

const { positionErrorResponse } = await import("./_lib.ts");
const { HrmAuthorizationError } = await import("@openbooks/engine/src/hrm/authorization.ts");
const { HrmPositionError } = await import("@openbooks/engine/src/hrm/positions.ts");

test("every position refusal code maps to its status with the message intact", () => {
  const cases: Array<[string, number]> = [
    ["INVALID_INPUT", 400],
    ["NOT_FOUND", 404],
    ["BAD_STATE", 409],
    ["STALE_REVISION", 409],
    ["REFUSED", 422],
    ["OVER_FILLED", 422],
    ["UNDER_FUNDED", 422],
  ];
  for (const [code, status] of cases) {
    const response = positionErrorResponse(
      new HrmPositionError(code as "REFUSED", `${code} message with remedy`),
    );
    assert.equal(response.status, status, code);
  }
});

test("a refusal message reaches the caller unmodified", async () => {
  const message =
    "position ENG-1042 is still held by employment e1 (assignment primary) as of 2026-07-15 — unassign the holder through a position_assignment change request before closing";
  const response = positionErrorResponse(new HrmPositionError("REFUSED", message));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: message });
});

test("authorization refusals distinguish probing from forbidden", async () => {
  const hidden = positionErrorResponse(
    new HrmAuthorizationError("Position is not visible in this organization and legal-entity scope."),
  );
  assert.equal(hidden.status, 404);
  const forbidden = positionErrorResponse(
    new HrmAuthorizationError("Position access requires the hrm.position.manage permission — ask an administrator to grant it in /admin/roles."),
  );
  assert.equal(forbidden.status, 403);
  assert.match((await forbidden.json() as { error: string }).error, /hrm\.position\.manage/);
});
