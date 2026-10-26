import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { setupColumnSearchSql, setupDateLabel } from "./date-columns";
import type { SetupColumn } from "./registry";

const DB = !!process.env.OPENBOOKS_DB_URL;

const effectiveFrom: SetupColumn = { key: "effectiveFrom", kind: "date" };
const lastSyncedAt: SetupColumn = { key: "lastSyncedAt", kind: "date" };
const name: SetupColumn = { key: "name", kind: "text" };

async function matches(
  column: SetupColumn,
  query: string,
  locale: string,
  timeZone = "UTC",
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from (values
      ('a', 'Alpha', '2026-01-01'::date, '2026-03-01 03:30:00+00'::timestamptz),
      ('b', 'Beta', '2025-12-31'::date, null::timestamptz),
      ('c', 'Gamma', null::date, '2026-06-15 12:00:00+00'::timestamptz)
    ) as t(id, name, effective_from, last_synced_at)
    where ${setupColumnSearchSql(column, query, locale, timeZone)}
    order by id`,
    "objects",
  );
  return rows.map((row) => row.id);
}

test("a date column is found by the localized text the list shows", { skip: !DB }, async () => {
  assert.equal(setupDateLabel("2026-01-01", "en", "UTC"), "Jan 1, 2026");
  assert.deepEqual(await matches(effectiveFrom, "Jan 1, 2026", "en"), ["a"]);
  assert.deepEqual(await matches(effectiveFrom, "dec 31", "en"), ["b"]);
  assert.deepEqual(await matches(effectiveFrom, "1. Jan. 2026", "de"), ["a"]);
  assert.deepEqual(await matches(effectiveFrom, "2026年1月1日", "ja"), ["a"]);
});

test("a date column is still found by its stored ISO value", { skip: !DB }, async () => {
  assert.deepEqual(await matches(effectiveFrom, "2026-01", "en"), ["a"]);
  assert.deepEqual(await matches(effectiveFrom, "2025-12-31", "fr"), ["b"]);
});

test(
  "a timestamp column is found by its calendar day in the organization time zone",
  { skip: !DB },
  async () => {
    assert.deepEqual(await matches(lastSyncedAt, "Mar 1, 2026", "en"), ["a"]);
    assert.deepEqual(await matches(lastSyncedAt, "Feb 28, 2026", "en", "America/Vancouver"), ["a"]);
    assert.deepEqual(await matches(lastSyncedAt, "Mar 1, 2026", "en", "America/Vancouver"), []);
  },
);

test("non-date columns keep matching their stored text", { skip: !DB }, async () => {
  assert.deepEqual(await matches(name, "amm", "en"), ["c"]);
});
