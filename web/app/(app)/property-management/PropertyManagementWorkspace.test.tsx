import assert from "node:assert/strict";
import test from "node:test";
import { decimalCmp, decimalSum } from "../../../lib/statement-format.ts";

test("property-management KPI money aggregates preserve exact decimals", () => {
  assert.equal(decimalSum(["0.1000", "0.2000"]), "0.3000");
  assert.equal(
    decimalSum(["9007199254740992.0000", "1.0000"]),
    "9007199254740993.0000",
  );
  assert.equal(decimalCmp("0.3000", "0") > 0, true);
});
