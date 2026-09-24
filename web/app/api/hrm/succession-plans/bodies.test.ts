import assert from "node:assert/strict";
import test from "node:test";
import { createSuccessionPlanBody, patchSuccessionPlanBody } from "./bodies";

const positionId = "11111111-1111-4111-8111-111111111111";

test("succession plans accept nullable plan notes on create and notes-only edits", () => {
  assert.deepEqual(
    createSuccessionPlanBody.parse({ positionId, notes: "Interim coverage plan" }),
    { positionId, notes: "Interim coverage plan" },
  );
  assert.deepEqual(
    patchSuccessionPlanBody.parse({ notes: "Updated coverage plan" }),
    { notes: "Updated coverage plan" },
  );
  assert.deepEqual(patchSuccessionPlanBody.parse({ notes: null }), { notes: null });
});

test("succession plan patch requires a status or notes change", () => {
  assert.equal(patchSuccessionPlanBody.safeParse({}).success, false);
  assert.equal(
    patchSuccessionPlanBody.safeParse({ status: "draft", notes: "Not an atomic single-field edit" }).success,
    false,
  );
});
