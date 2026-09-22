import assert from "node:assert/strict";
import test from "node:test";
import {
  ClosedBatchError,
  DepreciationRefusalError,
  StalePreviewError,
} from "@openbooks/engine/src/assets/depreciation.ts";
import { DepreciationFormulaError } from "@openbooks/engine/src/assets/depreciation-formula.ts";
import { depreciationFailure } from "./depreciation-error-response.ts";

/**
 * The route's error boundary. A domain refusal names the remedy and must reach
 * the operator as a 4xx carrying that message; an unexpected fault must not
 * disclose its internals. Before the typed error every one of these was a 500
 * with the raw `e.message`, which is the repo's #1 defect class — a computed
 * refusal delivered as something else.
 */

test("a domain refusal is a 409 carrying its remedy", async () => {
  const res = depreciationFailure(new DepreciationRefusalError("asset has no in-service date"));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "asset has no in-service date" });
});

test("an inactive or unavailable formula is a 422", async () => {
  const res = depreciationFailure(new DepreciationFormulaError('unknown variable "Q"'));
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'unknown variable "Q"' });
});

test("stale preview and closed period keep their structured 409 bodies", async () => {
  const stale = depreciationFailure(new StalePreviewError("drift"));
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "stale_preview" });

  const closed = depreciationFailure(new ClosedBatchError("FA-0001", "2026-09"));
  assert.equal(closed.status, 409);
  assert.deepEqual(await closed.json(), {
    error: "period_closed",
    asset: "FA-0001",
    period: "2026-09",
  });
});

test("an unexpected fault is a generic 500 that does not disclose internals", async () => {
  const res = depreciationFailure(
    new Error('relation "openbooks_secret_table" does not exist at character 42'),
  );
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.doesNotMatch(body.error, /openbooks_secret_table|character 42/);
});