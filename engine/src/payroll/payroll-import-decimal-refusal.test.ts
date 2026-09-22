import assert from "node:assert/strict";
import test from "node:test";
import { decimalNullCause } from "../money/decimal-refusal.ts";
import { normalizeOpeningBalance, normalizeOpeningComponents } from "./opening-balances.ts";
import { parsePriorStubAmount } from "./parallel-run-store.ts";
import { parseEntitlementCarryInAmount } from "./entitlements-openings-save.ts";
import type { OpeningComponentField } from "./opening-balances.ts";

/**
 * PAYROLL-1: payroll imports must refuse locale money with a precise remedy,
 * never strip separators before exact-decimal validation. "12,34" is
 * twelve-thirty-four written correctly in seven installed packs (IT/FR/DE/NL/
 * ES/PL/BR) — storing it as 1234.0000 is a 100x error in a YTD ceiling that
 * feeds every later run's statutory math.
 */

const RRSP: OpeningComponentField = {
  componentId: "11111111-1111-4111-8111-111111111111",
  code: "RRSP",
  name: "RRSP employee contribution",
  kind: "deduction",
  basisCapAmountPerYear: "10000.0000",
  capped: true,
};

/* Opening statutory normalizer -------------------------------------- */

test("payroll-1: plain opening YTD is accepted", () => {
  const amounts = normalizeOpeningBalance({ pensionableYtd: "1234.56" });
  assert.equal(amounts.pensionableYtd, "1234.5600");
});

test("payroll-1: US-grouped opening YTD is refused with the grouping remedy", () => {
  assert.throws(
    () => normalizeOpeningBalance({ pensionableYtd: "1,234.56" }),
    /must not contain a thousands separator/,
  );
});

test("payroll-1: decimal-comma opening YTD is refused with the correct dotted reading", () => {
  assert.throws(
    () => normalizeOpeningBalance({ pensionableYtd: "12,34" }),
    /must use "\." as the decimal point — write "12,34" as "12\.34"/,
  );
});

test("payroll-1: European mixed opening YTD is refused with the correct reading", () => {
  assert.throws(
    () => normalizeOpeningBalance({ pensionableYtd: "1.234,56" }),
    /write "1\.234,56" as "1234\.56"/,
  );
});

test("payroll-1: ambiguous opening YTD names both readings instead of guessing", () => {
  assert.throws(
    () => normalizeOpeningBalance({ pensionableYtd: "1,234" }),
    /is ambiguous — "1,234" could mean 1234 \(thousands separator\) or 1\.234 \(decimal comma\)/,
  );
});

test("payroll-1: opening refusals keep currency, scientific, and scale remedies", () => {
  assert.throws(() => normalizeOpeningBalance({ pensionableYtd: "$100" }), /currency symbol/);
  assert.throws(
    () => normalizeOpeningBalance({ pensionableYtd: "1e3" }),
    /written out in full, not in scientific notation/,
  );
  assert.throws(
    () => normalizeOpeningBalance({ pensionableYtd: "1.23456" }),
    /allows at most 4 decimal places/,
  );
});

test("payroll-1: blank stays zero and negatives stay refused", () => {
  assert.equal(normalizeOpeningBalance({}).pensionableYtd, "0.0000");
  assert.equal(normalizeOpeningBalance({ pensionableYtd: "  " }).pensionableYtd, "0.0000");
  assert.throws(() => normalizeOpeningBalance({ pensionableYtd: "-1" }), /cannot be negative/);
  assert.throws(() => normalizeOpeningBalance({ pensionableYtd: "lots" }), /is not a number/);
});

/* Opening component normalizer --------------------------------------- */

test("payroll-1: component openings refuse comma money and accept plain digits", () => {
  assert.deepEqual(normalizeOpeningComponents({ RRSP: "10" }, [RRSP]), {
    [RRSP.componentId]: "10.0000",
  });
  assert.throws(
    () => normalizeOpeningComponents({ RRSP: "12,34" }, [RRSP]),
    /must use "\." as the decimal point — write "12,34" as "12\.34"/,
  );
  assert.throws(
    () => normalizeOpeningComponents({ RRSP: "1,234" }, [RRSP]),
    /is ambiguous/,
  );
  assert.throws(
    () => normalizeOpeningComponents({ RRSP: "23,000.00" }, [RRSP]),
    /must not contain a thousands separator/,
  );
});

/* Prior-stub import parser ------------------------------------------- */

test("payroll-1: prior-stub amounts refuse comma money and keep blank-as-null", () => {
  assert.equal(parsePriorStubAmount(null, "gross"), null);
  assert.equal(parsePriorStubAmount("  ", "gross"), null);
  assert.equal(parsePriorStubAmount("1234.56", "gross"), "1234.5600");
  assert.throws(
    () => parsePriorStubAmount("12,34", "gross"),
    /gross must use "\." as the decimal point — write "12,34" as "12\.34"/,
  );
  assert.throws(() => parsePriorStubAmount("1,234", "gross"), /is ambiguous/);
  assert.throws(
    () => parsePriorStubAmount("1 234", "gross"),
    /must not contain a thousands separator/,
  );
  assert.throws(() => parsePriorStubAmount("$100", "gross"), /currency symbol/);
});

/* Entitlement carry-in parser ---------------------------------------- */

test("payroll-1: carry-in amounts refuse comma money and keep blank-as-zero", () => {
  assert.equal(parseEntitlementCarryInAmount("", "VAC"), "0.0000");
  assert.equal(parseEntitlementCarryInAmount("  ", "VAC"), "0.0000");
  assert.equal(parseEntitlementCarryInAmount("12.5", "VAC"), "12.5000");
  // Sign is the caller's domain check (accrue vs owe), not the parser's.
  assert.equal(parseEntitlementCarryInAmount("-5", "VAC"), "-5.0000");
  assert.throws(
    () => parseEntitlementCarryInAmount("12,34", "VAC"),
    /VAC carry-in must use "\." as the decimal point — write "12,34" as "12\.34"/,
  );
  assert.throws(() => parseEntitlementCarryInAmount("1,234", "VAC"), /is ambiguous/);
  assert.throws(
    () => parseEntitlementCarryInAmount("1.234,56", "VAC"),
    /write "1\.234,56" as "1234\.56"/,
  );
});

/* Shared classifier: all seven causes --------------------------------- */

test("payroll-1: shared classifier names all seven refusal causes", () => {
  assert.equal(decimalNullCause("1.23456").cause, "scale");
  assert.equal(decimalNullCause("1,234.56").cause, "separator");
  assert.equal(decimalNullCause("12,34").cause, "decimal-comma");
  assert.equal(decimalNullCause("1,234").cause, "ambiguous-comma");
  assert.equal(decimalNullCause("$100").cause, "currency");
  assert.equal(decimalNullCause("1e3").cause, "scientific");
  assert.equal(decimalNullCause("lots").cause, "not-a-number");
});
