import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalNormalizationJson,
  normalizationInputsHash,
  SAAS_METRICS_DENOMINATION_VERSION,
} from "./metrics-normalization.ts";

test("normalization JSON is canonical across key order", () => {
  assert.equal(
    canonicalNormalizationJson({ to: "USD", from: "EUR", scope: { month: 7, year: 2026 } }),
    canonicalNormalizationJson({ scope: { year: 2026, month: 7 }, from: "EUR", to: "USD" }),
  );
  assert.equal(canonicalNormalizationJson(["b", "a"]), '["b","a"]', "array order is significant");
  assert.equal(canonicalNormalizationJson({ a: undefined, b: 1 }), '{"b":1}');
});

test("normalization hash is a stable versioned digest", () => {
  const payload = {
    denominationVersion: SAAS_METRICS_DENOMINATION_VERSION,
    orgId: "org-1",
    month: "2026-07-01",
    reportingCurrency: "USD",
    inputs: { mrrEnd: "110.0000" },
    evidence: { observations: [{ asOf: "2026-07-15", derivedRate: "1.1000000000" }] },
  };
  const first = normalizationInputsHash(payload);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(normalizationInputsHash({ ...payload, inputs: { mrrEnd: "110.0000" } }), first);
  assert.notEqual(
    normalizationInputsHash({ ...payload, denominationVersion: "v2" }),
    first,
    "a new denomination version must never reproduce an old hash",
  );
  assert.notEqual(
    normalizationInputsHash({ ...payload, evidence: { observations: [] } }),
    first,
    "different evidence must never reproduce the stored hash",
  );
});
