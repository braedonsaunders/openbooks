import assert from "node:assert/strict";
import test from "node:test";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { hrmAuthorizationResponse, recordNotFoundResponse } from "./record-not-found.ts";

test("record visibility failures share one response while missing grants remain forbidden", async () => {
  const hiddenRecords = [
    new HrmAuthorizationError("employment is not visible in this organization"),
    new HrmAuthorizationError("Position is not visible in this organization and legal-entity scope."),
    new HrmAuthorizationError("account is not visible in this organization"),
  ];
  const hiddenResponses = hiddenRecords.map(hrmAuthorizationResponse);
  hiddenResponses.push(recordNotFoundResponse());

  for (const response of hiddenResponses) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.clone().json(), { error: "not_found" });
  }

  const missingGrant = hrmAuthorizationResponse(
    new HrmAuthorizationError("Employment access requires hrm.employment.read — ask an administrator."),
  );
  assert.equal(missingGrant.status, 403);
  assert.match(String((await missingGrant.json() as { error: string }).error), /requires hrm\.employment\.read/);
});
