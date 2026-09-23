import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { resolveCoveringPeriod } from "./period-resolution.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

// The single shared "period covering a date" resolver for ordinary
// postings: default active calendar, regular periods only, deterministic
// under overlaps, null when uncovered or default-less (callers refuse).

const DB = !!process.env.OPENBOOKS_DB_URL;

async function calendarOf(orgId: string, periodId: string): Promise<string> {
  const r = await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id from accounting_periods where id = ${periodId}`);
  return r.rows[0]!.fiscal_calendar_id;
}

test("covering resolution prefers the default calendar under overlap", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const defaultCalendar = await calendarOf(org.orgId, org.periodId);
    const otherCalendar = randomUUID();
    await db.execute(sql`
      insert into fiscal_calendars
        (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
         adjustment_period_enabled, is_default, is_active, config)
      values (${otherCalendar}, ${org.orgId}, 'Secondary', 'monthly',
              1, 1, 'UTC', false, false, true, '{}'::jsonb)`);
    // A second ACTIVE calendar whose period starts EARLIER and still covers
    // the date: without the default filter, every starts_on-ordered variant
    // picks this row first, and unordered variants pick arbitrarily.
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
      values (${randomUUID()}, ${org.orgId}, ${otherCalendar}, 2026, 7, 'SEC-2026-07',
              '2026-06-15', '2026-07-31', false)`);
    const found = await resolveCoveringPeriod(db, org.orgId, "2026-07-15");
    assert.equal(found?.id, org.periodId);
    assert.equal(found?.fiscal_calendar_id, defaultCalendar);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("covering resolution never lands in an adjustment period by date", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const defaultCalendar = await calendarOf(org.orgId, org.periodId);
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
      values (${randomUUID()}, ${org.orgId}, ${defaultCalendar}, 2026, 13, '2026-ADJ',
              '2026-07-01', '2026-07-31', true)`);
    // The adjustment shares July's window; ordinary resolution still
    // returns the regular period.
    const found = await resolveCoveringPeriod(db, org.orgId, "2026-07-15");
    assert.equal(found?.id, org.periodId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("covering resolution returns null uncovered or default-less instead of guessing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.equal(await resolveCoveringPeriod(db, org.orgId, "2026-09-01"), null);
    const defaultCalendar = await calendarOf(org.orgId, org.periodId);
    await db.execute(sql`
      update fiscal_calendars set is_default = false where id = ${defaultCalendar}`);
    // The only calendar left is non-default: refusing (null) is the fix —
    // picking it would be the arbitrary choice this resolver eliminates.
    assert.equal(await resolveCoveringPeriod(db, org.orgId, "2026-07-15"), null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
