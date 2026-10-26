import assert from "node:assert/strict";
import test from "node:test";
import {
  ClosedBatchError,
  DepreciationRefusalError,
  StalePreviewError,
} from "@openbooks/engine/assets/depreciation";
import { DepreciationFormulaError } from "@openbooks/engine/assets/depreciation-formula";
import { depreciationFailure } from "./depreciation-error-response.ts";

/**
 * The route's error boundary. A domain refusal names the remedy and must reach
 * the operator as a 4xx carrying that message; an unexpected fault must not
 * disclose its internals. Before the typed error every one of these was a 500
 * with the raw `e.message`, which is the repo's #1 defect class — a computed
 * refusal delivered as something else.
 */

test("a domain refusal is a 409 carrying its remedy", async () => {
  const res = depreciationFailure(
    new DepreciationRefusalError("asset has no in-service date"),
    "en",
  );
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "asset has no in-service date" });
});

test("an inactive or unavailable formula is a 422", async () => {
  const res = depreciationFailure(new DepreciationFormulaError('unknown variable "Q"'), "en");
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'unknown variable "Q"' });
});

test("stale preview and closed period keep their structured 409 bodies", async () => {
  const stale = depreciationFailure(new StalePreviewError("drift"), "en");
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "stale_preview" });

  const september = {
    fiscalYear: 2026,
    periodNumber: 9,
    adjustment: false,
    startsOn: "2026-09-01",
    endsOn: "2026-09-30",
  };
  const closed = depreciationFailure(new ClosedBatchError("FA-0001", september), "en");
  assert.equal(closed.status, 409);
  assert.deepEqual(await closed.json(), {
    error: "period_closed",
    asset: "FA-0001",
    period: "P09 FY2026 · Sep 2026",
  });
});

test("a closed batch names its period by fiscal label, and the response labels it per locale", async () => {
  const december = {
    fiscalYear: 2025,
    periodNumber: 12,
    adjustment: false,
    startsOn: "2025-12-01",
    endsOn: "2025-12-31",
  };
  const error = new ClosedBatchError("FA-0007", december);
  assert.equal(error.periodName, "P12 FY2025");
  assert.equal(
    error.message,
    "FA-0007 P12 FY2025: GL period closed; open the period and confirm again",
  );
  const english = (await depreciationFailure(error, "en").json()) as { period: string };
  const german = (await depreciationFailure(error, "de").json()) as { period: string };
  assert.equal(english.period, "P12 FY2025 · Dec 2025");
  assert.match(german.period, /^P12 FY2025 · Dez\.? 2025$/);
});

test("an unexpected fault is a generic 500 that does not disclose internals", async () => {
  const res = depreciationFailure(
    new Error('relation "openbooks_secret_table" does not exist at character 42'),
    "en",
  );
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.doesNotMatch(body.error, /openbooks_secret_table|character 42/);
});
