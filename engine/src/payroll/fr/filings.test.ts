import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../error.ts";
import {
  assertFrFilingYearSupported,
  parseFrRecapRowId,
} from "./filings.ts";

/**
 * France year-end filing — row grammar and year coverage (no database).
 *
 * The FR pack declares one annual filing, the per-employee per-month
 * récapitulatif of DSN-declared versements. These tests pin the parts that
 * need no database: the row-id grammar the subsidiary-scope guard parses
 * before authorising a byte, and the year gate that refuses years the pack
 * never transcribed rather than reporting them.
 */

const EMPLOYEE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";

test("FR recap row ids round-trip through parseFrRecapRowId", () => {
  const scoped = `${EMPLOYEE}:2026-03:${ACCOUNT}`;
  assert.deepEqual(parseFrRecapRowId(scoped), {
    employees: [EMPLOYEE],
    accounts: [ACCOUNT],
  });
  const unassigned = `${EMPLOYEE}:2026-11:`;
  assert.deepEqual(parseFrRecapRowId(unassigned), {
    employees: [EMPLOYEE],
    accounts: [],
  });
});

test("FR recap parseRowId returns null for anything that is not its row", () => {
  assert.equal(parseFrRecapRowId(""), null);
  assert.equal(parseFrRecapRowId("not-a-row"), null);
  // Two-part W-2 shape: no month, so not an FR row.
  assert.equal(parseFrRecapRowId(`${EMPLOYEE}:${ACCOUNT}`), null);
  // Four parts, a non-UUID employee, a bad month: all foreign.
  assert.equal(parseFrRecapRowId(`${EMPLOYEE}:2026-03:${ACCOUNT}:extra`), null);
  assert.equal(parseFrRecapRowId(`jean-martin:2026-03:${ACCOUNT}`), null);
  assert.equal(parseFrRecapRowId(`${EMPLOYEE}:2026-13:${ACCOUNT}`), null);
  assert.equal(parseFrRecapRowId(`${EMPLOYEE}:2026-3:${ACCOUNT}`), null);
  assert.equal(parseFrRecapRowId(`${EMPLOYEE}:26-03:${ACCOUNT}`), null);
  assert.equal(parseFrRecapRowId(`${EMPLOYEE}:2026-03:not-an-account`), null);
});

test("FR filing year gate admits 2026, the pack's only transcribed year", () => {
  assertFrFilingYearSupported(2026);
});

test("FR filing year gate refuses uncovered years by name, with the remedy", () => {
  for (const year of [2024, 2025, 2027]) {
    assert.throws(
      () => assertFrFilingYearSupported(year),
      (error: unknown) => {
        assert.ok(error instanceof PayrollError, "a payroll refusal, not a bare Error");
        assert.match(
          String((error as Error).message),
          new RegExp(String(year)),
          "the refusal names the year it cannot file",
        );
        assert.match(
          String((error as Error).message).toLowerCase(),
          /transcri/,
          "the refusal names the transcription remedy",
        );
        return true;
      },
    );
  }
});
