import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalTimeZone,
  civilDateTimeToInstant,
  isKnownTimeZone,
  listCanonicalTimeZones,
} from "./time-zone.ts";

// The shared zone validator accepts every zone the runtime formats —
// supportedValuesOf membership is the wrong test (US/Eastern formats fine
// but is absent from the list), and the save path canonicalizes aliases so
// a stored alias never silently becomes UTC.

test("canonical zones are accepted as-is", () => {
  for (const zone of ["UTC", "America/Toronto", "America/New_York", "Pacific/Auckland", "Etc/GMT+5"]) {
    assert.equal(isKnownTimeZone(zone), true, zone);
    assert.equal(canonicalTimeZone(zone), zone, zone);
  }
});

test("aliases Intl accepts but supportedValuesOf omits are canonicalized, not dropped", () => {
  assert.equal(Intl.supportedValuesOf("timeZone").includes("US/Eastern"), false);
  assert.equal(isKnownTimeZone("US/Eastern"), true);
  assert.equal(canonicalTimeZone("US/Eastern"), "America/New_York");
  // The canonical name days identically to the alias it replaces.
  const instant = new Date("2026-09-23T03:30:00Z");
  const day = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  assert.equal(day("America/New_York"), day("US/Eastern"));
});

test("surrounding whitespace is forgiven, not stored", () => {
  assert.equal(canonicalTimeZone("  America/Toronto\t"), "America/Toronto");
});

test("unknown zones and non-strings are refused, never coerced", () => {
  for (const bad of ["", "   ", "Mars/Olympus_Mons", "Not/AZone", "12,34", "EST5EDT,"]) {
    assert.equal(isKnownTimeZone(bad), false, JSON.stringify(bad));
    assert.equal(canonicalTimeZone(bad), null, JSON.stringify(bad));
  }
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(isKnownTimeZone(bad), false, String(bad));
    assert.equal(canonicalTimeZone(bad), null, String(bad));
  }
});

test("the picker list offers UTC first, then sorted canonical names", () => {
  const zones = listCanonicalTimeZones();
  assert.ok(zones.length > 0);
  assert.equal(zones[0], "UTC");
  assert.deepEqual(zones.slice(1), [...zones.slice(1)].sort());
});

test("civil date-times resolve in their named zone without interpreting local input as UTC", () => {
  assert.equal(civilDateTimeToInstant("2026-07-01T09:30", "America/Toronto").toISOString(), "2026-07-01T13:30:00.000Z");
  assert.equal(civilDateTimeToInstant("2026-07-01T09:30", "UTC").toISOString(), "2026-07-01T09:30:00.000Z");
});

test("civil date-time conversion refuses nonexistent and repeated daylight-saving times", () => {
  assert.throws(() => civilDateTimeToInstant("2026-03-08T02:30", "America/Toronto"), /does not exist/);
  assert.throws(() => civilDateTimeToInstant("2026-11-01T01:30", "America/Toronto"), /occurs twice/);
  assert.throws(() => civilDateTimeToInstant("2026-02-31T09:30", "America/Toronto"), /valid local date/);
});
