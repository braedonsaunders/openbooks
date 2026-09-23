import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_RECOGNITION_TERM_MONTHS,
  recognitionRulePolicyProblem,
} from "./recognition-limits.ts";

test("an empty or fully valid policy is saveable", () => {
  assert.equal(recognitionRulePolicyProblem({}), null);
  assert.equal(
    recognitionRulePolicyProblem({
      recognitionPeriods: 12,
      periodOffset: 0,
      startOffsetDays: 0,
      initialAmountPercent: "0",
    }),
    null,
  );
  assert.equal(
    recognitionRulePolicyProblem({
      recognitionPeriods: 1,
      periodOffset: 0,
      startOffsetDays: -2147483648,
      initialAmountPercent: "0",
    }),
    null,
  );
  assert.equal(
    recognitionRulePolicyProblem({
      recognitionPeriods: MAX_RECOGNITION_TERM_MONTHS,
      periodOffset: MAX_RECOGNITION_TERM_MONTHS,
      startOffsetDays: 2147483647,
      initialAmountPercent: "100",
    }),
    null,
  );
});

test("blanks fall through to defaults instead of refusing", () => {
  assert.equal(
    recognitionRulePolicyProblem({
      recognitionPeriods: "",
      periodOffset: null,
      startOffsetDays: undefined,
      initialAmountPercent: "  ",
    }),
    null,
  );
});

for (const periods of [-1, 0, 1201, "abc", 1.5, "12.5"]) {
  test(`recognitionPeriods ${JSON.stringify(periods)} is refused by field name`, () => {
    assert.match(
      recognitionRulePolicyProblem({ recognitionPeriods: periods }) ?? "",
      /recognitionPeriods/,
    );
  });
}

for (const offset of [-1, 1201, "abc", 0.5]) {
  test(`periodOffset ${JSON.stringify(offset)} is refused by field name`, () => {
    assert.match(
      recognitionRulePolicyProblem({ periodOffset: offset }) ?? "",
      /periodOffset/,
    );
  });
}

for (const days of [-2147483649, 2147483648, "abc", 1.5]) {
  test(`startOffsetDays ${JSON.stringify(days)} is refused by field name`, () => {
    assert.match(
      recognitionRulePolicyProblem({ startOffsetDays: days }) ?? "",
      /startOffsetDays/,
    );
  });
}

for (const percent of ["-1", "150", "100.0001", "abc"]) {
  test(`initialAmountPercent ${JSON.stringify(percent)} is refused by field name`, () => {
    assert.match(
      recognitionRulePolicyProblem({ initialAmountPercent: percent }) ?? "",
      /initialAmountPercent/,
    );
  });
}
