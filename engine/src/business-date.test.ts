import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { withSimClock } from "./clock.ts";
import {
  addCalendarDays, addCalendarMonthsStart, businessToday, calendarQuarterBounds,
  formatInZone, mondayOfIsoWeek, startOfMonth, weekStartsEndingOn,
} from "./business-date.ts";
import { createScratchOrg, dropScratchOrgReporting } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("formatInZone lands local midnights on the local calendar day", () => {
  // 2026-01-15T00:00 in Toronto (EST, UTC−5) is 05:00Z on the same day.
  assert.equal(formatInZone(new Date("2026-01-15T05:00:00Z"), "America/Toronto"), "2026-01-15");
  // 2026-01-15T00:00 in Auckland (NZDT, UTC+13) is 11:00Z the previous day.
  assert.equal(formatInZone(new Date("2026-01-14T11:00:00Z"), "Pacific/Auckland"), "2026-01-15");
});

test("one instant falls on different calendar days either side of UTC", () => {
  const instant = new Date("2026-06-15T02:30:00Z");
  assert.equal(formatInZone(instant, "UTC"), "2026-06-15");
  assert.equal(formatInZone(instant, "America/Toronto"), "2026-06-14");
  assert.equal(formatInZone(instant, "Pacific/Auckland"), "2026-06-15");
  assert.equal(formatInZone(new Date("2026-06-15T23:30:00Z"), "Pacific/Auckland"), "2026-06-16");
});

test("formatInZone in UTC matches the plain ISO day", () => {
  for (const iso of ["2026-01-01T00:00:30Z", "2026-12-31T23:59:59Z"]) {
    assert.equal(formatInZone(new Date(iso), "UTC"), iso.slice(0, 10));
  }
});

test("calendar helpers stay on the YYYY-MM-DD grid, not the host timezone", () => {
  assert.equal(startOfMonth("2026-08-21"), "2026-08-01");
  // 2026-08-21 is a Friday; the ISO week starts Monday the 17th.
  assert.equal(mondayOfIsoWeek("2026-08-21"), "2026-08-17");
  assert.deepEqual(weekStartsEndingOn("2026-08-21", 3), [
    "2026-08-03", "2026-08-10", "2026-08-17",
  ]);
  assert.deepEqual(calendarQuarterBounds("2026-08-21"), {
    start: "2026-07-01", end: "2026-09-30",
  });
  assert.deepEqual(calendarQuarterBounds("2026-01-01"), {
    start: "2026-01-01", end: "2026-03-31",
  });
  assert.equal(addCalendarDays("2026-08-21", -7), "2026-08-14");
  assert.equal(addCalendarMonthsStart("2026-08-21", -11), "2025-09-01");
});

test("an unrecognized zone is refused, never silently misformatted", () => {
  assert.throws(() => formatInZone(new Date(), "Mars/Olympus_Mons"), RangeError);
});

test("businessToday honours the org's zone and falls back to the UTC day", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // 13:00Z on Jun 15 is already 01:00 on Jun 16 in Auckland (NZST, +12).
    await db.execute(sql`
      update orgs set settings = ${JSON.stringify({ timeZone: "Pacific/Auckland" })}::jsonb
       where id = ${org.orgId}`);
    await withSimClock("2026-06-15T13:00:00Z", async () => {
      assert.equal(await businessToday(org.orgId), "2026-06-16");
    });
    // An absent or unrecognized zone must fall back to the plain UTC day.
    for (const settings of ["{}", JSON.stringify({ timeZone: "Not/AZone" })]) {
      await db.execute(sql`update orgs set settings = ${settings}::jsonb where id = ${org.orgId}`);
      await withSimClock("2026-06-15T23:30:00Z", async () => {
        assert.equal(await businessToday(org.orgId), "2026-06-15");
      });
    }
    // An org that does not exist has no zone either.
    await withSimClock("2026-06-15T23:30:00Z", async () => {
      assert.equal(await businessToday("00000000-0000-0000-0000-000000000000"), "2026-06-15");
    });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
