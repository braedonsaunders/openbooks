import assert from "node:assert/strict";
import test from "node:test";
import { NextResponse } from "next/server";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
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

test("an unknown failure is a 500 without internals", async () => {
  const response = recruitingErrorResponse(new Error("s3cr3t stack"));
  assert.equal(response.status, 500);
  assert.deepEqual(await bodyOf(response), { error: "internal error" });
});
