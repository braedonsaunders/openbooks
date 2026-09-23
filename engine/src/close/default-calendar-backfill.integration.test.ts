import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

// Migration 0275 backfills the ACTIVE DEFAULT fiscal calendar the shared
// posting-period resolver reads: for each org with calendars but no active
// default it promotes the active calendar holding the most periods (oldest,
// then id, on ties), and refuses naming the org when first place ties on
// both usage and age instead of guessing.

const MIGRATION_URL = new URL(
  "../../../schema/migrations/generated/0275_default_calendar_backfill.sql",
  import.meta.url,
);

async function runBackfill(): Promise<void> {
  // Execute the shipped migration bytes verbatim, minus the runner-owned
  // SET header: those session GUCs belong to the migration runner, and
  // running them here would leak onto this pooled test connection.
  const body = readFileSync(MIGRATION_URL, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("SET "))
    .join("\n");
  assert.match(body, /0275_default_calendar_backfill/, "migration file must be the shipped artifact");
  await db.execute(sql.raw(body));
}

async function addCalendar(orgId: string, periodCount: number, createdAt: string | null): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, is_default, is_active)
    values (${id}, ${orgId}, ${`Backfill ${id.slice(0, 8)}`}, 'monthly', 1, false, true)`);
  for (let number = 1; number <= periodCount; number++) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
      values (${randomUUID()}, ${orgId}, ${id}, 2025, ${number},
              ${`2025-${String(number).padStart(2, "0")}`},
              ${`2025-${String(number).padStart(2, "0")}-01`},
              ${`2025-${String(number).padStart(2, "0")}-28`}, false)`);
  }
  if (createdAt) {
    await db.execute(sql`
      update fiscal_calendars set created_at = ${createdAt}::timestamptz where id = ${id}`);
  }
  return id;
}

async function defaultCalendarId(orgId: string): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${orgId} and is_default and is_active`);
  return rows.rows[0]?.id ?? null;
}

test("0275 promotes the active calendar holding the most periods, and reruns cleanly", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      // Fixture default holds the single 2026-07 period; strip its flag so
      // the org needs a backfill, then add a busier and a quieter calendar.
      const fixtureDefault = (await defaultCalendarId(org.orgId))!;
      await db.execute(sql`update fiscal_calendars set is_default = false where id = ${fixtureDefault}`);
      const busy = await addCalendar(org.orgId, 3, null);
      await addCalendar(org.orgId, 1, null);
      assert.equal(await defaultCalendarId(org.orgId), null);

      await runBackfill();
      assert.equal(await defaultCalendarId(org.orgId), busy);

      await runBackfill();
      assert.equal(await defaultCalendarId(org.orgId), busy, "second run must be a no-op");
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("0275 breaks a period-count tie by oldest creation", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      const fixtureDefault = (await defaultCalendarId(org.orgId))!;
      await db.execute(sql`update fiscal_calendars set is_default = false where id = ${fixtureDefault}`);
      const older = await addCalendar(org.orgId, 2, "2024-01-01T00:00:00Z");
      await addCalendar(org.orgId, 2, "2024-06-01T00:00:00Z");
      await runBackfill();
      assert.equal(await defaultCalendarId(org.orgId), older);
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("0275 refuses with the org id when first place ties on usage and age", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      const fixtureDefault = (await defaultCalendarId(org.orgId))!;
      await db.execute(sql`update fiscal_calendars set is_default = false where id = ${fixtureDefault}`);
      await addCalendar(org.orgId, 2, "2024-01-01T00:00:00Z");
      await addCalendar(org.orgId, 2, "2024-01-01T00:00:00Z");
      await assert.rejects(runBackfill, (error: unknown) => {
        // Drizzle reports the migration SQL as the error message and the
        // PostgreSQL RAISE text (which carries the org id) as the cause.
        const text = [error, (error as { cause?: unknown }).cause]
          .map((part) => (part instanceof Error ? part.message : String(part)))
          .join(" ");
        return /tied active calendars/.test(text) && text.includes(org.orgId);
      });
      assert.equal(await defaultCalendarId(org.orgId), null, "a refused backfill must promote nothing");
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("0275 refuses when every calendar is inactive, naming the org", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      await db.execute(sql`update fiscal_calendars set is_default = false, is_active = false where org_id = ${org.orgId}`);
      await assert.rejects(runBackfill, (error: unknown) => {
        const text = [error, (error as { cause?: unknown }).cause]
          .map((part) => (part instanceof Error ? part.message : String(part)))
          .join(" ");
        return /every fiscal calendar is inactive/.test(text) && text.includes(org.orgId);
      });
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
