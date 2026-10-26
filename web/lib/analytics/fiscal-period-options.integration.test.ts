import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { pool } from "@openbooks/engine/platform/db";
import { createScratchOrg } from "@openbooks/engine/testing/fixtures";
import { analyticsFiscalPeriodOptions } from "./fiscal-period-options";

async function insertPeriod(
  orgId: string,
  calendarId: string,
  period: {
    fiscalYear: number;
    periodNumber: number;
    name: string;
    from: string;
    to: string;
    adjustment?: boolean;
  },
) {
  await pool.query(
    `insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      orgId,
      period.fiscalYear,
      period.periodNumber,
      period.name,
      period.from,
      period.to,
      period.adjustment ?? false,
      calendarId,
    ],
  );
}

test("the analytics picker lists named fiscal periods newest first, skipping adjustments", async () => {
  const { orgId } = await createScratchOrg();
  const calendarId = (
    await pool.query(`select id from fiscal_calendars where org_id = $1 limit 1`, [orgId])
  ).rows[0].id as string;
  // createScratchOrg seeds 2026-07; add older, newer, and adjustment periods.
  await insertPeriod(orgId, calendarId, {
    fiscalYear: 2026,
    periodNumber: 6,
    name: "June 2026 (legacy)",
    from: "2026-06-01",
    to: "2026-06-30",
  });
  await insertPeriod(orgId, calendarId, {
    fiscalYear: 2026,
    periodNumber: 8,
    name: "2026-08",
    from: "2026-08-01",
    to: "2026-08-31",
  });
  await insertPeriod(orgId, calendarId, {
    fiscalYear: 2026,
    periodNumber: 13,
    name: "2026-ADJ",
    from: "2026-08-01",
    to: "2026-08-31",
    adjustment: true,
  });

  const options = await analyticsFiscalPeriodOptions(orgId, "en");
  assert.deepEqual(
    options.map((o) => [o.from, o.to]),
    [
      ["2026-08-01", "2026-08-31"],
      ["2026-07-01", "2026-07-31"],
      ["2026-06-01", "2026-06-30"],
    ],
  );
  // Labels derive from the fiscal position and dates, not the stored name.
  assert.deepEqual(
    options.map((o) => o.label),
    ["P08 FY2026 · Aug 2026", "P07 FY2026 · Jul 2026", "P06 FY2026 · Jun 2026"],
  );
  assert.ok(options.every((o) => o.id));
});

test("the analytics picker is empty when the org has no periods", async () => {
  const { orgId } = await createScratchOrg();
  await pool.query(`delete from accounting_periods where org_id = $1`, [orgId]);
  assert.deepEqual(await analyticsFiscalPeriodOptions(orgId, "en"), []);
});
