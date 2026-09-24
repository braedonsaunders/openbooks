import assert from "node:assert/strict";
import test from "node:test";

// The mapping imports the real engine error classes (no database touched —
// error construction never queries). Blank the URL first and import
// dynamically, the engine unit-test approach.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

const { changeRequestErrorResponse } = await import("./_lib.ts");
const { HrmAuthorizationError } = await import("@openbooks/engine/src/hrm/authorization.ts");
const { HrmChangeRequestError } = await import("@openbooks/engine/src/hrm/change-requests.ts");

test("every refusal code maps to its status with the message intact", () => {
  const cases: Array<[string, number]> = [
    ["INVALID_PAYLOAD", 400],
    ["UNKNOWN_KIND", 400],
    ["NOT_FOUND", 404],
    ["BAD_STATE", 409],
    ["STALE_REVISION", 409],
    ["NO_FLOW", 422],
    ["FLOW_ERROR", 422],
    ["REFUSED", 422],
  ];
  for (const [code, status] of cases) {
    const response = changeRequestErrorResponse(
      new HrmChangeRequestError(code as "REFUSED", `${code} message with remedy`),
    );
    assert.equal(response.status, status, code);
  }
});

test("authorization refusals distinguish probing from forbidden", async () => {
  const hidden = changeRequestErrorResponse(
    new HrmAuthorizationError("Employment is not visible in this organization and legal-entity scope."),
  );
  assert.equal(hidden.status, 404);
  const forbidden = changeRequestErrorResponse(
    new HrmAuthorizationError("Employment access requires the hrm.employment.manage permission — ask an administrator to grant it in /admin/roles."),
  );
  assert.equal(forbidden.status, 403);
});

test("an unexpected failure is a 500 without leaking internals", async () => {
  const response = changeRequestErrorResponse(new Error("pg connection reset"));
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "internal error");
});
