import assert from "node:assert/strict";
import test from "node:test";
import { conflict, created, notFound, unprocessable } from "./responses.ts";

test("notFound hides the probed kind and id behind one spelling", async () => {
  for (const response of [notFound("account"), notFound("account", "some-id")]) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  }
});

test("unprocessable defaults to 422 with field detail", async () => {
  const response = unprocessable("name_required", {
    field: "name",
    fieldErrors: { name: ["required"] },
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "name_required",
    field: "name",
    fieldErrors: { name: ["required"] },
  });
});

test("idempotency keys refuse with two codes: 400 malformed, 409 conflict", async () => {
  const malformed = unprocessable("invalid_idempotency_key", { status: 400 });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_idempotency_key" });

  const replayed = conflict("idempotency_key_conflict", {
    remedy: "Close and reopen the drawer to try again with a fresh request.",
  });
  assert.equal(replayed.status, 409);
  assert.deepEqual(await replayed.json(), {
    error: "idempotency_key_conflict",
    remedy: "Close and reopen the drawer to try again with a fresh request.",
  });
});

test("conflict without options deep-equals the bare error", async () => {
  const response = conflict("invalid_idempotency_key");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "invalid_idempotency_key" });
});

test("created answers 201 with the payload", async () => {
  const response = created({ id: "key-1" });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "key-1" });
});
