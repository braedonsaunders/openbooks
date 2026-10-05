import assert from "node:assert/strict";
import test from "node:test";
import {
  isoWeekdayOf,
  statutoryJurisdictionKey,
  StatutoryCoverageError,
} from "./business-calendars.ts";

test("ISO weekdays run Monday 1 through Sunday 7", () => {
  assert.equal(isoWeekdayOf("2026-10-05"), 1);
  assert.equal(isoWeekdayOf("2026-10-10"), 6);
  assert.equal(isoWeekdayOf("2026-10-04"), 7);
  assert.throws(() => isoWeekdayOf("not-a-date"), RangeError);
});

test("a bare country resolves where the pack declares exactly one employment calendar", () => {
  assert.equal(statutoryJurisdictionKey("US", "FEDERAL"), "US");
  assert.equal(statutoryJurisdictionKey("IE", null), "IE-IE");
  assert.equal(statutoryJurisdictionKey("PL", null), "PL-PL");
  assert.equal(statutoryJurisdictionKey("BR", null), "BR-BR");
  assert.equal(statutoryJurisdictionKey("CA", "ON"), "CA-ON");
  assert.equal(statutoryJurisdictionKey("CA", "FEDERAL"), "CA");
  assert.equal(statutoryJurisdictionKey("FR", "FR"), "FR-FR");
});

// A bare federal calendar beside regional ones must not win by default: an
// Ontario employer resolved to "CA" would observe Remembrance Day (a federal
// day Ontario does not) and miss Family Day (an Ontario day the federal
// calendar does not carry). The refusal lists qualifiers — ON, never CA-ON:
// the field holds the qualifier, and listing keys once taught an operator to
// type CA-ON, which built CA-CA-ON.
test("a federal calendar beside regional ones requires an explicit region", () => {
  for (const country of ["CA", "US", "FR", "DE"]) {
    assert.throws(() => statutoryJurisdictionKey(country, null), (error: unknown) => {
      assert.ok(error instanceof StatutoryCoverageError);
      assert.match(error.message, /holiday region/);
      return true;
    }, `${country} without a region refuses`);
  }
  assert.throws(() => statutoryJurisdictionKey("CA", null), (error: unknown) => {
    assert.ok(error instanceof StatutoryCoverageError);
    assert.match(error.message, /\bON\b/);
    assert.match(error.message, /FEDERAL/);
    assert.doesNotMatch(error.message, /CA-ON/);
    return true;
  });
});

test("a full key typed as the region refuses with the qualifier list", () => {
  assert.throws(() => statutoryJurisdictionKey("CA", "CA-ON"), (error: unknown) => {
    assert.ok(error instanceof StatutoryCoverageError);
    assert.match(error.message, /CA-CA-ON/);
    assert.match(error.message, /\bON\b/);
    return true;
  });
});

test("an undeclared region refuses with the qualifier list", () => {
  assert.throws(() => statutoryJurisdictionKey("CA", "XX"), (error: unknown) => {
    assert.ok(error instanceof StatutoryCoverageError);
    assert.match(error.message, /CA-XX/);
    assert.match(error.message, /\bON\b/);
    assert.doesNotMatch(error.message, /CA-ON/);
    return true;
  });
});

test("a tax-administration key never governs working days", () => {
  assert.throws(() => statutoryJurisdictionKey("CA", "CRA"), (error: unknown) => {
    assert.ok(error instanceof StatutoryCoverageError);
    assert.match(error.message, /not an employment calendar/);
    assert.match(error.message, /\bON\b/);
    return true;
  });
});

// Bavaria declares its jurisdiction with no transcribed days (an empty
// calendar is indistinguishable from "works every day"), so it refuses at
// resolution — at save and at read alike — with the closures remedy.
test("a declared but untranscribed calendar refuses with the closures remedy", () => {
  assert.throws(() => statutoryJurisdictionKey("DE", "BY"), (error: unknown) => {
    assert.ok(error instanceof StatutoryCoverageError);
    assert.match(error.message, /"DE-BY"'s statutory holiday calendar is not transcribed yet/);
    assert.match(error.message, /Setup → Payroll → Holidays/);
    return true;
  });
});

test("a country with no transcribed pack refuses without a remedy that does not work", () => {
  for (const country of ["XX", "AE"]) {
    assert.throws(() => statutoryJurisdictionKey(country, null), (error: unknown) => {
      assert.ok(error instanceof StatutoryCoverageError);
      assert.match(error.message, new RegExp(`company closures for ${country} are not available yet`));
      assert.doesNotMatch(error.message, /record closures in Setup/);
      return true;
    }, `${country} refuses plainly`);
  }
});

test("a pack with no employment calendar refuses without a working remedy", () => {
  assert.throws(() => statutoryJurisdictionKey("GB", null), (error: unknown) => {
    assert.ok(error instanceof StatutoryCoverageError);
    assert.match(error.message, /declares no employment holiday calendar/);
    return true;
  });
});
