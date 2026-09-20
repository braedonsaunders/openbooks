import assert from "node:assert/strict";
import test from "node:test";
import { countryName, dateTime } from "./format";

// Timestamps must render in the viewer's locale (F-t01-014): the Users
// list passes its request locale through, so the formatter has to honor
// the argument rather than always falling back to the default.

test("dateTime renders month names in the requested locale", () => {
  const stamp = "2026-07-17T00:37:00Z";
  assert.match(dateTime(stamp, "en"), /Jul/);
  assert.match(dateTime(stamp, "fr"), /juil/);
  assert.notEqual(dateTime(stamp, "en"), dateTime(stamp, "fr"));
});

test("dateTime keeps its default and empty handling", () => {
  assert.equal(dateTime(null), "");
  assert.equal(dateTime(undefined), "");
  assert.match(dateTime("2026-07-17T00:37:00Z"), /2026/);
});

// Country names come from Intl, never a hardcoded map: a newly installed
// pack needs no edit here, and no message-catalog keys are needed.

test("countryName renders a known code in the requested locale", () => {
  assert.equal(countryName("JP", "en"), "Japan");
  assert.equal(countryName("SG", "en"), "Singapore");
});

// The locale must actually reach Intl: a helper that ignores it passes
// every single-locale test while showing every operator English names.
test("countryName honors its locale argument", () => {
  assert.equal(countryName("JP", "fr"), "Japon");
  assert.notEqual(countryName("JP", "en"), countryName("JP", "fr"));
  assert.notEqual(countryName("DE", "en"), countryName("DE", "fr"));
});

// The fallback is the test that matters: an unrecognised code renders as
// itself and never as an invented name — with fourteen packs and seven UI
// locales, "this locale does not know this region" is the normal case.
test("countryName falls back to the code itself, never an invented name", () => {
  assert.equal(countryName("XX", "en"), "XX");
  assert.equal(countryName("XX", "fr"), "XX");
});

// Intl throws RangeError on structurally invalid codes; the helper must fail
// visible (the code itself) rather than fail fatal (taking the page down).
test("countryName never throws on unrenderable codes", () => {
  assert.equal(countryName("", "en"), "");
  assert.equal(countryName("1A", "en"), "1A");
  assert.doesNotThrow(() => countryName("", "en"));
  assert.doesNotThrow(() => countryName("1A", "en"));
  assert.doesNotThrow(() => countryName("XX", "en"));
});
