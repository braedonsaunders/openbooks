import assert from "node:assert/strict";
import test from "node:test";
import { statementBalanceMismatch } from "./statement-import.ts";

test("a statement whose opening plus lines reaches its closing raises no flag", () => {
  assert.equal(statementBalanceMismatch("243.36", "1161.10", "917.74", "asset_bank"), null);
  assert.equal(
    statementBalanceMismatch(null, "1161.10", "917.74", "asset_bank"),
    null,
    "an absent balance is not checked",
  );
});

test("a closing the lines cannot reach is named with the closing they do reach", () => {
  assert.deepEqual(statementBalanceMismatch("0", "1161.10", "243.36", "asset_bank"), {
    opening: "0.0000",
    linesTotal: "243.3600",
    expectedClosing: "243.3600",
    closing: "1161.1000",
  });
});

test("card statements accept either sign pairing, as their statement totals do", () => {
  assert.equal(statementBalanceMismatch("100", "150", "-50", "liability_card"), null);
  assert.equal(statementBalanceMismatch("100", "150", "50", "liability_card"), null);
  assert.notEqual(statementBalanceMismatch("100", "150", "-50", "asset_bank"), null);
});
