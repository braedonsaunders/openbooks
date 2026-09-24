import assert from "node:assert/strict";
import test from "node:test";
import { dateTime, trendWeekLabel } from "./format";

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

// Trend week labels must render in the viewer's locale (F2-14): the
// purchasing loader passes its request locale through, so the formatter
// has to honor the argument rather than pinning en-US.

test("trendWeekLabel renders the week start in the requested locale", () => {
  assert.match(trendWeekLabel("2026-01-05", "en-US"), /Jan 5/);
  assert.match(trendWeekLabel("2026-01-05", "fr"), /janv/i);
  assert.notEqual(trendWeekLabel("2026-01-05", "en-US"), trendWeekLabel("2026-01-05", "fr"));
});

test("trendWeekLabel pins the UTC day so time zones cannot shift it", () => {
  assert.match(trendWeekLabel("2026-09-07", "en-US"), /Sep 7/);
  assert.match(trendWeekLabel("2026-09-07", "de"), /Sep/i);
});
