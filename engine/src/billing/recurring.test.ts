import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceCadence,
  findUnknownPeriodTokens,
  pendingOccurrences,
  remainingOccurrences,
  resolvePeriodTokens,
  toDateArrayLiteral,
} from "./recurring.ts";

test("weekly and biweekly step by exact day counts", () => {
  assert.equal(advanceCadence("2026-07-21", "weekly"), "2026-07-28");
  assert.equal(advanceCadence("2026-07-21", "biweekly"), "2026-08-04");
});

test("monthly clamps a month-end anchor to shorter months", () => {
  assert.equal(advanceCadence("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(advanceCadence("2028-01-31", "monthly"), "2028-02-29"); // leap year
  assert.equal(advanceCadence("2026-01-15", "monthly"), "2026-02-15");
});

test("monthly pins a stored anchor day instead of drifting", () => {
  assert.equal(advanceCadence("2026-01-31", "monthly", null, undefined, 31), "2026-02-28");
  // Feb 28 reached from Jan 31 steps to Mar 31 with the anchor, Mar 28 without.
  assert.equal(advanceCadence("2026-02-28", "monthly", null, undefined, 31), "2026-03-31");
  assert.equal(advanceCadence("2026-02-28", "monthly"), "2026-03-28");
  assert.equal(advanceCadence("2026-01-15", "monthly", null, undefined, 15), "2026-02-15");
});

test("monthly rolls the year over at December", () => {
  assert.equal(advanceCadence("2026-12-10", "monthly"), "2027-01-10");
});

test("quarterly and annually advance by 3 and 12 months", () => {
  assert.equal(advanceCadence("2026-07-21", "quarterly"), "2026-10-21");
  assert.equal(advanceCadence("2026-11-30", "quarterly"), "2027-02-28");
  assert.equal(advanceCadence("2028-02-29", "annually"), "2029-02-28");
  assert.equal(advanceCadence("2026-07-21", "annually"), "2027-07-21");
});

test("invalid dates, cadences, and cron rules fail closed", () => {
  assert.throws(() => advanceCadence("2026-07-21", "custom_cron", "not a cron"));
  assert.throws(() => advanceCadence("2026-02-29", "annually"));
  assert.throws(() => advanceCadence("9999-12-31", "monthly"));
  assert.throws(() => advanceCadence("2026-07-21", "unknown" as never));
  assert.equal(advanceCadence("0001-02-28", "monthly"), "0001-03-28");
  assert.equal(advanceCadence("0099-12-28", "weekly"), "0100-01-04");
});

test("midnight cron includes tomorrow and never skips an extra day", () => {
  assert.equal(advanceCadence("2026-07-21", "custom_cron", "0 0 * * *"), "2026-07-22");
  assert.equal(advanceCadence("2026-07-21", "custom_cron", "0 12 * * *"), "2026-07-22");
});

/* Claim/generation atomicity, the failure path, the occurrence guard, both
 * entry points, success bookkeeping, and the schema-level guard are proven
 * through the real scheduler in recurring-dedupe.integration.test.ts: "a
 * tick retrying an already-posted occurrence replays the same document
 * instead of re-posting", "concurrent generations of the same occurrence
 * converge on one document", "a forced lineage failure rolls back the
 * generated document, lines, and lineage together", "occurrence lineage is
 * append-only outside a sandbox wipe", and "occurrence lineage rejects
 * cross-tenant schedule and document references". */


test("pending occurrences list exactly the missed dates through asOf", () => {
  assert.deepEqual(
    pendingOccurrences(
      { cadence: "monthly", cron: null, nextRunOn: "2025-12-10", endsOn: null, anchorDay: 10 },
      "2026-10-10",
    ),
    {
      occurrences: [
        "2025-12-10", "2026-01-10", "2026-02-10", "2026-03-10", "2026-04-10",
        "2026-05-10", "2026-06-10", "2026-07-10", "2026-08-10", "2026-09-10",
        "2026-10-10",
      ],
      truncated: false,
    },
  );
});

test("pending occurrences stop at the schedule end date", () => {
  assert.deepEqual(
    pendingOccurrences(
      { cadence: "monthly", cron: null, nextRunOn: "2025-12-10", endsOn: "2026-02-10", anchorDay: 10 },
      "2026-10-10",
    ).occurrences,
    ["2025-12-10", "2026-01-10", "2026-02-10"],
  );
});

test("a current schedule has no pending occurrences", () => {
  assert.deepEqual(
    pendingOccurrences(
      { cadence: "monthly", cron: null, nextRunOn: "2026-10-10", endsOn: null, anchorDay: 10 },
      "2026-10-10",
    ),
    { occurrences: ["2026-10-10"], truncated: false },
  );
  assert.deepEqual(
    pendingOccurrences(
      { cadence: "monthly", cron: null, nextRunOn: "2026-10-11", endsOn: null, anchorDay: 11 },
      "2026-10-10",
    ),
    { occurrences: [], truncated: false },
  );
});

test("period tokens resolve from the run period and sequence", () => {
  assert.equal(
    resolvePeriodTokens("Snow contract {month} instalment {n} of {total}", {
      periodStart: "2025-11-10",
      periodEnd: "2025-12-10",
      sequenceNumber: 1,
      totalOccurrences: 5,
      locale: "en",
    }),
    "Snow contract November instalment 1 of 5",
  );
});

test("period tokens render dates in the given locale", () => {
  assert.equal(
    resolvePeriodTokens("{period} · {period_start} → {period_end} · {year}", {
      periodStart: "2025-12-10",
      periodEnd: "2026-01-10",
      sequenceNumber: null,
      totalOccurrences: null,
      locale: "en",
    }),
    "2025-12 · Dec 10, 2025 → Jan 10, 2026 · 2025",
  );
});

test("pending occurrences exclude standing seasonal skips", () => {
  assert.deepEqual(
    pendingOccurrences(
      {
        cadence: "monthly", cron: null, nextRunOn: "2026-05-10", endsOn: null, anchorDay: 10,
        skippedRunOns: ["2026-06-10", "2026-07-10"],
      },
      "2026-08-10",
    ).occurrences,
    ["2026-05-10", "2026-08-10"],
  );
});

test("pending occurrences cap at the remaining occurrence limit", () => {
  assert.deepEqual(
    pendingOccurrences(
      {
        cadence: "monthly", cron: null, nextRunOn: "2026-05-10", endsOn: null, anchorDay: 10,
        remaining: 2,
      },
      "2026-08-10",
    ).occurrences,
    ["2026-05-10", "2026-06-10"],
  );
  assert.deepEqual(
    pendingOccurrences(
      {
        cadence: "monthly", cron: null, nextRunOn: "2026-05-10", endsOn: null, anchorDay: 10,
        remaining: 0,
      },
      "2026-08-10",
    ),
    { occurrences: [], truncated: false },
  );
  assert.equal(remainingOccurrences(null, 7), null);
  assert.equal(remainingOccurrences(3, 1), 2);
  assert.equal(remainingOccurrences(3, 3), 0);
  assert.equal(remainingOccurrences(3, 9), 0);
});

test("skipped dates serialize as a date array literal", () => {
  assert.equal(toDateArrayLiteral([]), "{}");
  assert.equal(toDateArrayLiteral(["2026-07-10", "2026-08-10"]), '{"2026-07-10","2026-08-10"}');
});

test("unknown brace-words and missing counters render verbatim or empty", () => {
  assert.equal(
    resolvePeriodTokens("See {appendix} for {n} of {total}", {
      periodStart: "2025-12-10",
      periodEnd: "2026-01-10",
      sequenceNumber: 2,
      totalOccurrences: null,
      locale: "en",
    }),
    "See {appendix} for 2 of ",
  );
  assert.deepEqual(findUnknownPeriodTokens("See {appendix} for {n} of {total} and {appendix}"), ["{appendix}"]);
  assert.deepEqual(findUnknownPeriodTokens("No braces here"), []);
});
