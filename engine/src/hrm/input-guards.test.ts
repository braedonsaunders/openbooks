import assert from "node:assert/strict";
import test from "node:test";
import { inputGuards, type InputGuardKind } from "./input-guards.ts";

class Refusal extends Error {
  constructor(message: string, readonly kind: InputGuardKind) { super(message); }
}
const guards = inputGuards((message, kind) => new Refusal(message, kind));
const refusedWith = (message: string, kind: InputGuardKind) => (error: unknown) =>
  error instanceof Refusal && error.message === message && error.kind === kind;

test("input guards refuse through the caller's error, naming the field and whether scope or input failed", () => {
  assert.throws(() => guards.requireOrgId(""), refusedWith("orgId must be a non-empty string", "scope"));
  assert.throws(() => guards.requireActorId(undefined), refusedWith("actorId must be a non-empty string", "scope"));
  assert.throws(() => guards.requireId(42, "stepId"), refusedWith("stepId must be a non-empty string", "input"));
  assert.throws(() => guards.requireUuid("-".repeat(36), "goalId"), refusedWith("goalId must be a uuid", "input"));
  assert.equal(guards.requireId("not-a-uuid", "stepId"), "not-a-uuid");
  const upper = "0F8FAD5B-D9CB-469F-A165-70867728950E";
  assert.equal(guards.requireUuid(upper, "goalId"), upper);
});
