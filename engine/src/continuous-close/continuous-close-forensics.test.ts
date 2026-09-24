import test from "node:test";
import assert from "node:assert/strict";
import { classifyForensicItem } from "../agents/measure.ts";

test("forensic items escalate at the exact materiality multiple", () => {
  assert.equal(
    classifyForensicItem({ materiality: "4999.9999", threshold: "1000.0000" }),
    "warning",
  );
  assert.equal(
    classifyForensicItem({ materiality: "5000.0000", threshold: "1000.0000" }),
    "critical",
  );
  // Exposure is absolute: credits escalate exactly like debits.
  assert.equal(
    classifyForensicItem({ materiality: "-5000.0000", threshold: "1000.0000" }),
    "critical",
  );
  assert.equal(
    classifyForensicItem({
      materiality: "2999.9999",
      threshold: "1000.0000",
      criticalMaterialityMultiple: 3,
    }),
    "warning",
  );
  assert.equal(
    classifyForensicItem({
      materiality: "3000.0000",
      threshold: "1000.0000",
      criticalMaterialityMultiple: 3,
    }),
    "critical",
  );
});

