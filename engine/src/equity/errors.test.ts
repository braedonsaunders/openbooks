import assert from "node:assert/strict";
import test from "node:test";
import { EquityError, formatRefusalDate, localizeRefusalDates } from "./errors.ts";

test("a refusal reads its civil dates in the reader's locale, keeping its own text for logs", () => {
  const error = new EquityError("Only {ceiling} units are vested on 2026-03-01.", {
    remedy: "Date the exercise on or after 2027-02-25 (the next vest), or record no more than {ceiling} units.",
    values: { ceiling: { kind: "shares", value: 12500n } },
  });
  assert.equal(error.message, "Only 12,500 units are vested on 2026-03-01.", "the default rendering keeps ISO dates for logs");
  assert.deepEqual(error.localized("en-US"), {
    message: "Only 12,500 units are vested on Mar 1, 2026.",
    remedy: "Date the exercise on or after Feb 25, 2027 (the next vest), or record no more than 12,500 units.",
  });
  const german = error.localized("de-DE");
  assert.equal(german.message, `Only 12.500 units are vested on ${new Intl.DateTimeFormat("de-DE", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date("2026-03-01T12:00:00Z"))}.`);
});

test("a refusal without figures still localizes its dates, and leaves identifiers that embed a date as written", () => {
  const error = new EquityError("A stock compensation run through 2026-12-31 is already posted as EQ-SBC-2026-12-31.", { remedy: "Run through a date after 2026-12-31." });
  assert.deepEqual(error.localized("en-US"), {
    message: "A stock compensation run through Dec 31, 2026 is already posted as EQ-SBC-2026-12-31.",
    remedy: "Run through a date after Dec 31, 2026.",
  });
  assert.equal(localizeRefusalDates("Period 2026-12 and day 2026-02-30 stay as written.", "en-US"), "Period 2026-12 and day 2026-02-30 stay as written.");
  assert.equal(formatRefusalDate("0099-12-25", "en-US"), "Dec 25, 99", "early civil years are not moved into the twentieth century");
});

test("a date figure renders like every other refusal figure", () => {
  const error = new EquityError("The round closed on {closedOn}.", { remedy: "Date the conversion on {closedOn}.", values: { closedOn: { kind: "date", value: "2026-08-31" } } });
  assert.equal(error.message, "The round closed on Aug 31, 2026.");
  assert.equal(error.localized("fr-FR").remedy, `Date the conversion on ${new Intl.DateTimeFormat("fr-FR", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date("2026-08-31T12:00:00Z"))}.`);
});
