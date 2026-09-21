import assert from "node:assert/strict";
import test from "node:test";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { HrmDocumentsError } from "@openbooks/engine/src/hrm/documents/errors.ts";
import { hrmDocumentsErrorResponse } from "./_lib.ts";

test("computed refusals map to statuses with the message intact", async () => {
  assert.equal((await hrmDocumentsErrorResponse(new HrmDocumentsError("VALIDATION", "title is required"))).status, 400);
  assert.equal((await hrmDocumentsErrorResponse(new HrmDocumentsError("NOT_FOUND", "document is not visible"))).status, 404);
  assert.equal((await hrmDocumentsErrorResponse(new HrmDocumentsError("FORBIDDEN", "someone else's"))).status, 403);
  const refused = await hrmDocumentsErrorResponse(new HrmDocumentsError("REFUSED", "signatures run in order — ask HR"));
  assert.equal(refused.status, 422);
  assert.equal(((await refused.json()) as { error: string }).error, "signatures run in order — ask HR");
});

test("authorization failures distinguish probing from missing grants", async () => {
  const probed = await hrmDocumentsErrorResponse(
    new HrmAuthorizationError("subject is not visible in this organization"),
  );
  assert.equal(probed.status, 404);
  const denied = await hrmDocumentsErrorResponse(new HrmAuthorizationError("needs the grant"));
  assert.equal(denied.status, 403);
});

test("unknown failures are a bare 500, never a leaked refusal", async () => {
  const res = await hrmDocumentsErrorResponse(new Error("boom"));
  assert.equal(res.status, 500);
  assert.equal(((await res.json()) as { error: string }).error, "internal error");
});
