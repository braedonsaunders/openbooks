import assert from "node:assert/strict";
import test from "node:test";
import { setupDateLabel } from "./date-columns";

test("a civil effective date reads as a localized calendar day", () => {
  assert.equal(setupDateLabel("2026-01-01", "en", "UTC"), "Jan 1, 2026");
  assert.equal(setupDateLabel("2026-01-01", "de", "UTC"), "1. Jan. 2026");
  assert.equal(setupDateLabel("2026-01-01", "ja", "UTC"), "2026年1月1日");
});

test("a civil date never shifts with the organization time zone", () => {
  for (const timeZone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "America/Vancouver"]) {
    assert.equal(setupDateLabel("2026-01-01", "en", timeZone), "Jan 1, 2026");
    assert.equal(setupDateLabel("2026-12-31", "en", timeZone), "Dec 31, 2026");
  }
});

test("a timestamp reads as its calendar day in the organization time zone", () => {
  assert.equal(setupDateLabel("2026-03-01 03:30:00+00", "en", "UTC"), "Mar 1, 2026");
  assert.equal(setupDateLabel("2026-03-01 03:30:00+00", "en", "America/Vancouver"), "Feb 28, 2026");
  assert.equal(
    setupDateLabel(new Date("2026-03-01T03:30:00Z"), "en", "America/Vancouver"),
    "Feb 28, 2026",
  );
});

test("an empty value reads as a dash and an unrecognised value is shown as stored", () => {
  assert.equal(setupDateLabel(null, "en", "UTC"), "—");
  assert.equal(setupDateLabel("", "en", "UTC"), "—");
  assert.equal(setupDateLabel("open-ended", "en", "UTC"), "open-ended");
});
