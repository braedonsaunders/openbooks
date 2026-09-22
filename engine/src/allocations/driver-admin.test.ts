import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  NATIVE_MEASURES,
  createDriverValue,
  driverValueWindowsOverlap,
  parseAllocationDimension,
  validateDriverConfig,
  validateDriverKey,
  validateDriverValueDecimal,
  vectorShares,
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
    {
      reportDefinitionId: reportId,
      dimensionColumn: "department",
      valueColumn: "amount",
      params: {},
      temporalMode: "balance_as_of",
    },
  );
  // The temporal contract is declared per driver: each mode passes through,
  // anything else is refused, and absence keeps the current as-of behavior.
  for (const temporalMode of ["period_activity", "balance_as_of", "fixed_query"]) {
    const out = validateDriverConfig("report_definition", {
      reportDefinitionId: reportId,
      dimensionColumn: "department",
      valueColumn: "amount",
      temporalMode,
    });
    assert.equal(out["temporalMode"], temporalMode);
  }
  assert.throws(
    () =>
      validateDriverConfig("report_definition", {
        reportDefinitionId: reportId,
        dimensionColumn: "department",
        valueColumn: "amount",
        temporalMode: "whatever",
      }),
    /temporalMode/,
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

test("vector shares are exact decimals, zero-safe", () => {
  assert.deepEqual(
    vectorShares(new Map([["a", "1.0000"], ["b", "3.0000"]])),
    new Map([["a", "0.2500"], ["b", "0.7500"]]),
  );
  assert.deepEqual(vectorShares(new Map([["a", "0.0000"]])), new Map([["a", "0.0000"]]));
  assert.deepEqual(vectorShares(new Map()), new Map());
});

test("vector share totals keep the sign of a negative weight (canonical add, not whole-part BigInt)", () => {
  // The old addDecimal parsed BigInt("-5") * 10000 + 2500 → -4.7500.
  assert.deepEqual(
    vectorShares(new Map([["credit", "-5.2500"], ["debit", "10.2500"]])),
    new Map([["credit", "-1.0500"], ["debit", "2.0500"]]),
  );
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

test("free-text dimension values fail in user language, never field-name jargon (F-t06-016)", async () => {
  // The manual-values form fell back to a bare textbox when no dimension
  // options existed, and free text died with "dimensionValueId must be a
  // uuid". The rejection must name the action in user words. Rejects before
  // any database access (the shape check precedes the transaction), so this
  // runs without a database.
  const error = await createDriverValue(randomUUID(), randomUUID(), randomUUID(), {
    dimensionValueId: "Overhead",
    effectiveFrom: "2026-08-01",
    value: "3",
  }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(error instanceof Error, "free text must be rejected");
  assert.match(error.message, /Choose a dimension value from the list/);
  assert.ok(!/dimensionValueId|uuid/i.test(error.message), "no internal field names leak");
});
