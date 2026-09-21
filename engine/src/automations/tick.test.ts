import test from "node:test";
import assert from "node:assert/strict";
import { addDaysCivil, orgCivilDate } from "./tick.ts";

/**
 * HR-16 date math: the date_relative scan compares civil dates in the
 * org's timezone, never 24h arithmetic. These cases straddle the DST
 * boundaries in America/Toronto (non-UTC): spring forward 2026-03-08
 * (02:00 EST → 03:00 EDT) and fall back 2026-11-01 (02:00 EDT → 01:00 EST).
 * A naive now-minus-N×24h scan would attribute the boundary day to the
 * wrong civil date; the zone calendar day never moves.
 */

test("spring forward: the skipped hour does not move the civil date", () => {
  // 2026-03-08T06:59:59Z is 01:59:59 EST (UTC-5), one second before the jump.
  assert.equal(orgCivilDate(new Date("2026-03-08T06:59:59Z"), "America/Toronto"), "2026-03-08");
  // 2026-03-08T07:00:01Z is 03:00:01 EDT — the 02:00 hour never existed,
  // but the civil date still advanced exactly once.
  assert.equal(orgCivilDate(new Date("2026-03-08T07:00:01Z"), "America/Toronto"), "2026-03-08");
  // The evening before is still the 7th in Toronto while UTC says the 8th.
  assert.equal(orgCivilDate(new Date("2026-03-08T04:59:59Z"), "America/Toronto"), "2026-03-07");
});

test("fall back: the repeated hour does not duplicate the civil date", () => {
  // 2026-11-01T05:59:59Z is 01:59:59 EDT; 06:00:01Z is 01:00:01 EST —
  // the same civil date twice, never a skip, never a duplicate firing day.
  assert.equal(orgCivilDate(new Date("2026-11-01T05:59:59Z"), "America/Toronto"), "2026-11-01");
  assert.equal(orgCivilDate(new Date("2026-11-01T06:00:01Z"), "America/Toronto"), "2026-11-01");
  assert.equal(orgCivilDate(new Date("2026-11-02T04:59:59Z"), "America/Toronto"), "2026-11-01");
});

test("offset arithmetic is civil-day based", () => {
  assert.equal(addDaysCivil("2026-03-08", 3), "2026-03-11");
  assert.equal(addDaysCivil("2026-03-08", -3), "2026-03-05");
  assert.equal(addDaysCivil("2026-11-01", 1), "2026-11-02");
  assert.equal(addDaysCivil("2026-02-28", 1), "2026-03-01");
});

test("invalid timezones fall back to UTC rather than throwing the scan", () => {
  assert.equal(orgCivilDate(new Date("2026-03-08T00:30:00Z"), "UTC"), "2026-03-08");
});
