import assert from "node:assert/strict";
import test from "node:test";
import { canadianYearEndCaps } from "./yearend-caps.ts";

test("Canadian year-end caps resolve the published edition for 2024 through 2026", () => {
  assert.deepEqual(canadianYearEndCaps(2024), {
    mie: "63200",
    cppYmpe: "68500",
    cppYampe: "73200",
    qppYmpe: "68500",
    qppYampe: "73200",
    qpipMie: "94000",
  });
  assert.deepEqual(canadianYearEndCaps(2025), {
    mie: "65700",
    cppYmpe: "71300",
    cppYampe: "81200",
    qppYmpe: "71300",
    qppYampe: "81200",
    qpipMie: "98000",
  });
  assert.deepEqual(canadianYearEndCaps(2026), {
    mie: "68900",
    cppYmpe: "74600",
    cppYampe: "85000",
    qppYmpe: "74600",
    qppYampe: "85000",
    qpipMie: "103000",
  });
});

test("Canadian year-end caps refuse a tax year without published rates", () => {
  assert.throws(() => canadianYearEndCaps(2027), /no T4127 constants/);
});
