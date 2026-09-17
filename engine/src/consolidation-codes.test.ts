import assert from "node:assert/strict";
import test from "node:test";
import { ConsolidationError, type ConsolidationCode } from "./consolidation.ts";

// F-t06-026: consolidation refusals reached the close task as bare message
// text — no surface could map them stably. Every refusal carries a
// machine-readable code alongside the user-language message.
test("consolidation refusals default to the invalid code", () => {
  const err = new ConsolidationError("ownership consolidation must own its source-snapshot transaction");
  assert.equal(err.name, "ConsolidationError");
  assert.equal(err.code, "invalid");
  assert.match(err.message, /source-snapshot/);
});

test("consolidation refusals keep their narrow code", () => {
  const codes: ConsolidationCode[] = [
    "invalid",
    "not-found",
    "not-configured",
    "period-closed",
    "rates-missing",
    "rates-not-derived",
    "ownership-gap",
    "period-conflict",
    "needs-reconciliation",
    "out-of-balance",
    "conflict-retry",
  ];
  for (const code of codes) {
    assert.equal(new ConsolidationError("probe", code).code, code);
  }
});
