import assert from "node:assert/strict";
import test from "node:test";
import { readLocaleDecimal } from "./decimal-refusal.ts";

const EN = { group: ",", decimal: "." };
const DE = { group: ".", decimal: "," };
const FR = { group: "\u00a0", decimal: "," };
const CH = { group: "\u2019", decimal: "." };

test("an amount written in the locale's own grouping reads as the amount it shows", () => {
  assert.deepEqual(readLocaleDecimal("74,424,261.56", EN, 4), {
    kind: "value",
    value: "74424261.56",
  });
  assert.deepEqual(readLocaleDecimal("74.424.261,56", DE, 4), {
    kind: "value",
    value: "74424261.56",
  });
  assert.deepEqual(
    readLocaleDecimal("74 424 261,56", FR, 4),
    { kind: "value", value: "74424261.56" },
    "a typed space reads as the locale's non-breaking group",
  );
  assert.deepEqual(
    readLocaleDecimal("74\u202f424\u202f261,56", FR, 4),
    { kind: "value", value: "74424261.56" },
    "the narrow no-break space Intl writes reads too",
  );
  assert.deepEqual(readLocaleDecimal("1'250'000.50", CH, 4), { kind: "value", value: "1250000.5" });
  assert.deepEqual(readLocaleDecimal("-1,000", EN, 4), { kind: "value", value: "-1000" });
  assert.deepEqual(readLocaleDecimal(",5", DE, 4), { kind: "value", value: "0.5" });
});

test("the plain dotted form reads in every locale", () => {
  assert.deepEqual(readLocaleDecimal("74424261.56", EN, 4), {
    kind: "value",
    value: "74424261.56",
  });
  assert.deepEqual(readLocaleDecimal("74424261.56", DE, 4), {
    kind: "value",
    value: "74424261.56",
  });
  assert.deepEqual(readLocaleDecimal("980.5", DE, 4), { kind: "value", value: "980.5" });
});

test("a value both readings accept but disagree on names both instead of guessing", () => {
  assert.deepEqual(readLocaleDecimal("1.234", DE, 4), {
    kind: "ambiguous",
    grouped: "1234",
    dotted: "1.234",
  });
  assert.deepEqual(
    readLocaleDecimal("1.234", EN, 4),
    { kind: "value", value: "1.234" },
    "a dot is never grouping where the locale groups with commas",
  );
});

test("misplaced grouping is refused rather than folded into the number", () => {
  assert.deepEqual(readLocaleDecimal("1,23,4", EN, 4), { kind: "unreadable" });
  assert.deepEqual(
    readLocaleDecimal("12,34", EN, 4),
    { kind: "unreadable" },
    "a decimal comma is not read where the locale's decimal is a dot",
  );
  assert.deepEqual(readLocaleDecimal("1.234.56", DE, 4), { kind: "unreadable" });
  assert.deepEqual(readLocaleDecimal("$1,000", EN, 4), { kind: "unreadable" });
  assert.deepEqual(readLocaleDecimal("1e6", EN, 4), { kind: "unreadable" });
  assert.deepEqual(readLocaleDecimal("", EN, 4), { kind: "unreadable" });
});

test("too many decimals name the scale in either notation", () => {
  assert.deepEqual(readLocaleDecimal("1,000.123456", EN, 4), { kind: "scale", decimals: 6 });
  assert.deepEqual(readLocaleDecimal("1.000,123456", DE, 4), { kind: "scale", decimals: 6 });
  assert.deepEqual(readLocaleDecimal("12.34567", EN, 4), { kind: "scale", decimals: 5 });
  assert.deepEqual(readLocaleDecimal("2.8446389082", EN, 10), {
    kind: "value",
    value: "2.8446389082",
  });
});
