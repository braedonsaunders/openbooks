import assert from "node:assert/strict";
import test from "node:test";
import {
  isKnownSubdivision,
  normalizeSubdivisionCode,
  SUBDIVISIONS,
  subdivisionName,
} from "./lien-jurisdictions.ts";
import { US_STATES } from "../payroll/us/rates.ts";

/**
 * Derived structural pins over the vendored ISO 3166-2 registry: every code
 * parses, every code is unique per country, and the US slice agrees both
 * ways with the payroll pack's independent state list (a typo inventing a
 * code, or dropping a state, fails here rather than at a waiver filing).
 */

test("every registry code parses as country-subdivision with a non-empty name", () => {
  assert.ok(SUBDIVISIONS.length > 200, `registry looks truncated: ${SUBDIVISIONS.length} entries`);
  for (const entry of SUBDIVISIONS) {
    assert.match(entry.code, /^[A-Z]{2}-[A-Z0-9]{1,3}$/, `unparsable code ${entry.code}`);
    assert.ok(entry.country.length === 2, `bad country on ${entry.code}`);
    assert.ok(entry.code.startsWith(`${entry.country}-`), `code/country mismatch on ${entry.code}`);
    assert.ok(entry.name.trim().length > 0, `nameless code ${entry.code}`);
  }
});

test("codes are unique, including the subdivision part within each country", () => {
  assert.equal(new Set(SUBDIVISIONS.map((entry) => entry.code)).size, SUBDIVISIONS.length);
  const byCountry = new Map<string, Set<string>>();
  for (const entry of SUBDIVISIONS) {
    const seen = byCountry.get(entry.country) ?? new Set<string>();
    const suffix = entry.code.slice(3);
    assert.ok(!seen.has(suffix), `duplicate subdivision ${entry.code}`);
    seen.add(suffix);
    byCountry.set(entry.country, seen);
  }
});

test("the US slice matches the payroll pack's state list both ways", () => {
  const usSuffixes = new Set(
    SUBDIVISIONS.filter((entry) => entry.country === "US").map((entry) => entry.code.slice(3)),
  );
  // Every payroll state is a registry subdivision (nothing dropped).
  for (const state of US_STATES) {
    assert.ok(usSuffixes.has(state), `payroll state ${state} missing from the registry`);
  }
  // Every registry US suffix is a state or a territory (nothing invented).
  const territories = new Set(["AS", "GU", "MP", "PR", "VI"]);
  for (const suffix of usSuffixes) {
    assert.ok(
      (US_STATES as readonly string[]).includes(suffix) || territories.has(suffix),
      `registry US suffix ${suffix} is neither a payroll state nor a territory`,
    );
  }
});

test("normalisation canonicalises case and refuses names, shapes and strangers", () => {
  assert.equal(normalizeSubdivisionCode("us-ca"), "US-CA");
  assert.equal(normalizeSubdivisionCode("  US-NY  "), "US-NY");
  assert.equal(normalizeSubdivisionCode("US-CA"), "US-CA");
  assert.equal(isKnownSubdivision("US-CA"), true);
  for (const bad of ["California", "US-XX", "USA-CA", "CA", "", "US-CA-1", 42, null, undefined]) {
    assert.equal(normalizeSubdivisionCode(bad), null, `${JSON.stringify(bad)} must not normalise`);
  }
  assert.equal(isKnownSubdivision("US-XX"), false);
  assert.equal(subdivisionName("US-CA"), "California");
  assert.equal(subdivisionName("US-XX"), null);
});
