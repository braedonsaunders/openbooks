import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_MEASURES,
  driverValueWindowsOverlap,
  parseAllocationDimension,
  validateDriverConfig,
  validateDriverKey,
  validateDriverValueDecimal,
} from "./driver-admin.ts";

// Pure input validation for the driver registry (A8). Service SQL is covered
// by driver-admin.integration.test.ts; these pin the exact rejection rules.

test("driver key must be a slug", () => {
  assert.equal(validateDriverKey("headcount-fte"), "headcount-fte");
  assert.throws(() => validateDriverKey("Head Count"), /slug/);
  assert.throws(() => validateDriverKey(""), /slug/);
  assert.throws(() => validateDriverKey("-lead"), /slug/);
  assert.throws(() => validateDriverKey(42), /slug/);
});

test("dimension accepts built-ins and extra:<segment>", () => {
  assert.equal(parseAllocationDimension("department"), "department");
  assert.equal(parseAllocationDimension("subsidiary"), "subsidiary");
  assert.equal(parseAllocationDimension("extra:region"), "extra:region");
  assert.throws(() => parseAllocationDimension("account"), /dimension/);
  assert.throws(() => parseAllocationDimension("extra:"), /dimension/);
  assert.throws(() => parseAllocationDimension("extra:has space"), /dimension/);
});

test("statistical_journal config requires a unit", () => {
  const config = validateDriverConfig("statistical_journal", { unit: "FTE" });
  assert.deepEqual(config, { unit: "FTE" });
  assert.throws(() => validateDriverConfig("statistical_journal", {}), /unit/);
  assert.throws(() => validateDriverConfig("statistical_journal", { unit: "  " }), /unit/);
});

test("gl configs require a well-formed account scope", () => {
  assert.deepEqual(validateDriverConfig("gl_activity", { accountScope: { kind: "any" } }), {
    accountScope: { kind: "any" },
  });
  assert.throws(() => validateDriverConfig("gl_balance", {}), /accountScope/);
  assert.throws(() => validateDriverConfig("gl_activity", { accountScope: { kind: "bogus" } }), /accountScope/);
  assert.throws(
    () => validateDriverConfig("gl_activity", { accountScope: { kind: "accounts", accountIds: [] } }),
    /accountIds/,
  );
  assert.throws(
    () => validateDriverConfig("gl_activity", { accountScope: { kind: "accounts", accountIds: ["nope"] } }),
    /accountIds/,
  );
});

test("native_measure config requires a known measure", () => {
  assert.ok(NATIVE_MEASURES.includes("headcount"));
  assert.deepEqual(validateDriverConfig("native_measure", { measure: "headcount" }), {
    measure: "headcount",
  });
  assert.throws(() => validateDriverConfig("native_measure", { measure: "vibes" }), /measure/);
});

test("manual config is empty; report_definition needs columns", () => {
  assert.deepEqual(validateDriverConfig("manual", {}), {});
  assert.deepEqual(validateDriverConfig("manual", undefined), {});
  const reportId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    validateDriverConfig("report_definition", {
      reportDefinitionId: reportId,
      dimensionColumn: "department",
      valueColumn: "amount",
    }),
    { reportDefinitionId: reportId, dimensionColumn: "department", valueColumn: "amount", params: {} },
  );
  assert.throws(() => validateDriverConfig("report_definition", {}), /reportDefinitionId/);
  assert.throws(
    () =>
      validateDriverConfig("report_definition", {
        reportDefinitionId: reportId,
        dimensionColumn: "",
        valueColumn: "amount",
      }),
    /dimensionColumn/,
  );
});

test("manual values keep exact decimals, never negative", () => {
  assert.equal(validateDriverValueDecimal("12.5"), "12.5000");
  assert.equal(validateDriverValueDecimal("0"), "0.0000");
  // Exact text survives: no IEEE-754 rounding of the input.
  assert.equal(validateDriverValueDecimal("9007199254740993.1234"), "9007199254740993.1234");
  assert.throws(() => validateDriverValueDecimal("-1"), /negative|>= 0/);
  assert.throws(() => validateDriverValueDecimal("1.23456"), /precision/);
  assert.throws(() => validateDriverValueDecimal("lots"), /decimal/);
});

test("effective windows overlap on shared days", () => {
  assert.equal(
    driverValueWindowsOverlap({ from: "2026-01-01", to: null }, { from: "2026-06-01", to: null }),
    true,
  );
  assert.equal(
    driverValueWindowsOverlap({ from: "2026-01-01", to: "2026-03-31" }, { from: "2026-04-01", to: null }),
    false,
  );
  assert.equal(
    driverValueWindowsOverlap({ from: "2026-01-01", to: "2026-04-01" }, { from: "2026-04-01", to: null }),
    true,
  );
});
