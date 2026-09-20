import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { CloseError } from "./period-policy.ts";
import { generateAccountingPeriods } from "./calendar.ts";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";

async function customCalendarId(
  orgId: string,
  actorId: string,
  years: Record<string, Array<{ startsOn: string; endsOn: string; name?: string }>>,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into fiscal_calendars
      (id, org_id, name, cadence, year_start_month, is_default, is_active,
       config, created_by, updated_by)
    values (${id}, ${orgId}, ${`Custom ${id.slice(0, 8)}`}, 'custom', 1, false, true,
            ${JSON.stringify({ years })}::jsonb, ${actorId}, ${actorId})
  `);
  return id;
}

test("custom calendar generation refuses overlapping period ranges", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Calendar keeper", "admin");
    const calendarId = await customCalendarId(org.orgId, actor, {
      "2026": [
        { startsOn: "2026-01-01", endsOn: "2026-06-30" },
        { startsOn: "2026-06-01", endsOn: "2026-12-31" },
      ],
    });
    // June falls in both ranges, so date-derived period resolution (an
    // unordered `limit 1` over the covering periods) would scope June
    // postings — and their close locks — arbitrarily. Fail closed here.
    await assert.rejects(
      generateAccountingPeriods(org.orgId, calendarId, 2026, actor),
      (error: unknown) => error instanceof CloseError && /overlap/i.test(error.message),
    );
    const persisted = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from accounting_periods
       where org_id = ${org.orgId} and fiscal_calendar_id = ${calendarId}
    `)).rows[0]!.n;
    assert.equal(persisted, 0, "no overlapping periods may persist");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("custom calendar generation accepts adjacent period ranges", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Calendar keeper", "admin");
    const calendarId = await customCalendarId(org.orgId, actor, {
      "2026": [
        { startsOn: "2026-01-01", endsOn: "2026-06-30" },
        { startsOn: "2026-07-01", endsOn: "2026-12-31" },
      ],
    });
    const result = await generateAccountingPeriods(org.orgId, calendarId, 2026, actor);
    assert.equal(result.created, 2);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
