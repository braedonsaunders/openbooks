import assert from "node:assert/strict";
import test from "node:test";
import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { HrmChangeRequestError } from "@openbooks/engine/src/hrm/change-requests.ts";
import { CompensationError } from "@openbooks/engine/src/hrm/compensation/errors.ts";
import { HrmPositionError } from "@openbooks/engine/src/hrm/positions.ts";
import { RecruitingError } from "@openbooks/engine/src/hrm/recruiting/errors.ts";
import { recruitingErrorResponse } from "./_lib.ts";

async function bodyOf(response: NextResponse): Promise<{ error: string }> {
  return (await response.json()) as { error: string };
}

test("every recruiting refusal code maps with its message intact", async () => {
  const cases: Array<{ code: "INVALID_INPUT" | "NOT_FOUND" | "BAD_STATE" | "STALE_REVISION" | "REFUSED"; status: number }> = [
    { code: "INVALID_INPUT", status: 400 },
    { code: "NOT_FOUND", status: 404 },
    { code: "BAD_STATE", status: 409 },
    { code: "STALE_REVISION", status: 409 },
    { code: "REFUSED", status: 422 },
  ];
  for (const { code, status } of cases) {
    const message = `refusal ${code} names its remedy`;
    const response = recruitingErrorResponse(new RecruitingError(code, message));
    assert.equal(response.status, status);
    assert.deepEqual(await bodyOf(response), { error: message });
  }
});

test("authorization failures hide existence but name missing grants", async () => {
  const hidden = recruitingErrorResponse(
    new HrmAuthorizationError("Requisition is not visible in this organization and legal-entity scope."),
  );
  assert.equal(hidden.status, 404);
  const forbidden = recruitingErrorResponse(
    new HrmAuthorizationError("Recruiting access requires the hrm.recruiting.manage permission — ask an administrator to grant it in /admin/roles."),
  );
  assert.equal(forbidden.status, 403);
  assert.match((await bodyOf(forbidden)).error, /hrm\.recruiting\.manage/);
});

test("accept without an employment-change flow answers 422 with the NO_FLOW remedy", async () => {
  // The hire transaction rolls back (engine integration: "hire without an
  // approval flow rolls back whole"); the API layer must carry the computed
  // refusal instead of a 500 'internal error'.
  const message =
    "no enabled approval flow produced an approval gate for employment change requests — configure a flow for employment change requests before submitting";
  const response = recruitingErrorResponse(new HrmChangeRequestError("NO_FLOW", message));
  assert.equal(response.status, 422);
  assert.deepEqual(await bodyOf(response), { error: message });
});

test("every change-request refusal code maps with its message intact", async () => {
  const cases: Array<{ code: "UNKNOWN_KIND" | "INVALID_PAYLOAD" | "NOT_FOUND" | "BAD_STATE" | "STALE_REVISION" | "FLOW_ERROR" | "REFUSED"; status: number }> = [
    { code: "INVALID_PAYLOAD", status: 400 },
    { code: "NOT_FOUND", status: 404 },
    { code: "BAD_STATE", status: 409 },
    { code: "STALE_REVISION", status: 409 },
    { code: "UNKNOWN_KIND", status: 422 },
    { code: "FLOW_ERROR", status: 422 },
    { code: "REFUSED", status: 422 },
  ];
  for (const { code, status } of cases) {
    const message = `change refusal ${code} names its remedy`;
    const response = recruitingErrorResponse(new HrmChangeRequestError(code, message));
    assert.equal(response.status, status, code);
    assert.deepEqual(await bodyOf(response), { error: message });
  }
});

test("hire-path vacancy and headcount refusals map with their message intact", async () => {
  const position = recruitingErrorResponse(new HrmPositionError("REFUSED", "the position is no longer vacant as of 2026-10-01"));
  assert.equal(position.status, 422);
  assert.match((await bodyOf(position)).error, /no longer vacant/);
  const plan = recruitingErrorResponse(new CompensationError("REFUSED", "the plan line cannot absorb this hire"));
  assert.equal(plan.status, 422);
  assert.match((await bodyOf(plan)).error, /plan line/);
});

test("an unknown failure is a 500 without internals", async () => {
  const response = recruitingErrorResponse(new Error("s3cr3t stack"));
  assert.equal(response.status, 500);
  assert.deepEqual(await bodyOf(response), { error: "internal error" });
});
