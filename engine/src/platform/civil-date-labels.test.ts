import assert from "node:assert/strict";
import test from "node:test";
import { civilDateLabel } from "./civil-date-labels.ts";

const LOCALES = ["en", "de", "es", "fr", "ja", "pt-BR", "zh", "ar-EG"];

test("labels match the platform Intl format for every month and locale", () => {
  for (const locale of LOCALES) {
    const full = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const monthYear = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    for (let month = 1; month <= 12; month++) {
      for (const day of ["01", "09", "28"]) {
        const iso = `2026-${String(month).padStart(2, "0")}-${day}`;
        const instant = new Date(`${iso}T12:00:00Z`);
        assert.equal(civilDateLabel(iso, locale), full.format(instant), `${locale} ${iso}`);
        assert.equal(
          civilDateLabel(iso, locale, "monthYear"),
          monthYear.format(instant),
          `${locale} ${iso} month`,
        );
      }
    }
  }
});

test("a civil date reads as its own calendar day, never shifted by a time zone", () => {
  assert.equal(civilDateLabel("2026-01-01", "en"), "Jan 1, 2026");
  assert.equal(civilDateLabel("2026-12-31", "en"), "Dec 31, 2026");
  assert.equal(civilDateLabel("2026-01-01", "de"), "1. Jan. 2026");
  assert.equal(civilDateLabel("2026-01-01", "ja"), "2026年1月1日");
});

test("a timestamp suffix is ignored and a non-date is refused", () => {
  assert.equal(civilDateLabel("2026-03-05T00:00:00.000Z", "en"), "Mar 5, 2026");
  assert.throws(() => civilDateLabel("", "en"), RangeError);
  assert.throws(() => civilDateLabel("2026-13-01", "en"), RangeError);
  assert.throws(() => civilDateLabel("next week", "en"), RangeError);
});
