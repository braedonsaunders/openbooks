import assert from "node:assert/strict";
import test from "node:test";
import { PostingError } from "@openbooks/engine/src/journal/posting-contracts.ts";
import { InventoryError } from "@openbooks/engine/src/inventory/contracts.ts";
import { PaymentRevisionConflictError } from "@openbooks/engine/src/payments-core/payment-errors.ts";
import { PayrollError } from "@openbooks/engine/src/payroll/error.ts";
import { TemporalError } from "@openbooks/engine/src/hrm/temporal.ts";
import { conflict, created, notFound, postingRefusal, unprocessable } from "./responses.ts";

class UnbalancedPostError extends PostingError { code = "unbalanced_post"; remedy = "Balance the lines, then post again."; }

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

test("status-less engine refusals map by family, 409 on conflict", async () => {
  const cases: Array<{ error: unknown; status: number; body: unknown }> = [
    { error: new UnbalancedPostError("Out of balance by 0.01", { customGlLineRuns: [] }), status: 422, body: { error: "Out of balance by 0.01", code: "unbalanced_post", remedy: "Balance the lines, then post again." } },
    { error: new InventoryError("No posting book for CAD"), status: 422, body: { error: "No posting book for CAD", code: "inventory_refused" } },
    { error: new PaymentRevisionConflictError(), status: 409, body: { error: "this payment changed after you opened it; reload and review the latest revision", code: "payment_refused" } },
    { error: new PayrollError("No open pay run for 2026-07"), status: 422, body: { error: "No open pay run for 2026-07", code: "payroll_refused" } },
    { error: new TemporalError("OVERLAP", "Ranges overlap"), status: 422, body: { error: "Ranges overlap", code: "OVERLAP" } },
  ];
  for (const { error, status, body } of cases) {
    const response = postingRefusal(error);
    assert.ok(response);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
  }
  for (const notFamily of [new Error("boom"), "nope", null]) assert.equal(postingRefusal(notFamily), null);
});
