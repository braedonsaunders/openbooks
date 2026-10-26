import assert from "node:assert/strict";
import test from "node:test";
import { perShareFormatOptions, perShareFractionDigits } from "./equity-price";
import { formatDecimal } from "./money-format";

test("every per-share value reads at four places, so prices in one column agree in precision", () => {
  const shown = ["3.8220000000", "2.1483000000", "2.3210", "3.5", "0.7897999205", "14"].map(
    (value) => formatDecimal("en", value, perShareFormatOptions(value)),
  );
  assert.deepEqual(shown, ["3.8220", "2.1483", "2.3210", "3.5000", "0.7898", "14.0000"]);
});

test("a non-zero value four places would show as zero keeps the places it needs", () => {
  assert.equal(perShareFractionDigits("0.0000100000"), 5);
  assert.equal(perShareFractionDigits("0.0000000001"), 10);
  assert.equal(perShareFractionDigits("0.00005"), 4, "rounds up to 0.0001 at four places");
  assert.equal(perShareFractionDigits("0"), 4);
  assert.equal(perShareFractionDigits("-0.00001"), 5);
});
