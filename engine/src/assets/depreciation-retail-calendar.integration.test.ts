import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { generateAccountingPeriods } from "../close/calendar.ts";
import { db } from "../platform/db.ts";
import { buildSchedule } from "./depreciation.ts";
import { toUnits } from "../money/money.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * Depreciation on a 4-4-5 retail calendar. Native planning is monthly, but a
 * 35-day fiscal period always contains TWO calendar-month starts (any 35
 * consecutive days span three calendar months). The schedule builder must
 * place both months' depreciation into that period — one line per period,
 * amounts summed — instead of throwing and leaving the asset undepreciated
 * (which in turn blocks close readiness on depreciation-unposted).
 *
 * Concrete 2026 shape (anchor Monday 2026-02-02): P6 = Jun 29–Aug 2 absorbs
 * the July and August months; P9 = Sep 28–Nov 1 absorbs October+November.
 * A 1200/6 straight-line asset in service July 2026 therefore plans
 * P6=400, P8=200, P9=400, P11=200.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

test("depreciation schedules allocate every native month into 4-4-5 periods", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const calendarId = randomUUID();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await db.execute(sql`
      insert into fiscal_calendars
        (id, org_id, name, cadence, year_start_month, week_starts_on, anchor_date, time_zone, is_default, is_active, config)
      values (${calendarId}, ${org.orgId}, 'Retail 4-4-5', 'four_four_five', 2, 1, '2026-02-02', 'UTC', false, true, '{"anchorFiscalYear": 2026}'::jsonb)`);
    await db.execute(sql`update fiscal_calendars set is_default = (id = ${calendarId}) where org_id = ${org.orgId}`);
    const generated = await generateAccountingPeriods(org.orgId, calendarId, 2026, actorId);
    assert.equal(generated.periods.length, 12, "one retail year generates 12 periods");
    const fiveWeek = generated.periods.filter(
      (p) => new Date(p.endsOn).getTime() - new Date(p.startsOn).getTime() === 34 * 86400000,
    );
    assert.ok(fiveWeek.length >= 4, `expected 5-week periods, got ${JSON.stringify(generated.periods)}`);

    const categoryId = randomUUID(), assetId = randomUUID();
    await db.execute(sql`insert into asset_categories
      (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
      values (${categoryId},${org.orgId},'Retail equipment',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',6,'full_month')`);
    await db.execute(sql`insert into fixed_assets
      (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
      values (${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'RTL-445','Retail asset','in_service',${org.date},${org.date},1200,0,'straight_line',6,'full_month')`);
    await buildSchedule(assetId, org.orgId, actorId, org.bookId);

    const lines = (await db.execute<{
      period_id: string; sequence: number; planned: string; starts_on: string; ends_on: string;
    }>(sql`
      select l.period_id, l.sequence, l.planned_amount::text as planned,
             p.starts_on::text as starts_on, p.ends_on::text as ends_on
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
        join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
       where s.org_id = ${org.orgId} and s.asset_id = ${assetId} and s.book_id = ${org.bookId}
       order by l.sequence`)).rows;
    // One line per fiscal period, never two rows for the 5-week mergers.
    assert.equal(new Set(lines.map((l) => l.period_id)).size, lines.length, "duplicate lines for one period");
    // The whole depreciable base is planned, nothing dropped.
    assert.equal(
      lines.reduce((sum, l) => sum + toUnits(l.planned), 0n),
      toUnits("1200.0000"),
      `planned total must equal depreciable base, got ${JSON.stringify(lines.map((l) => l.planned))}`,
    );
    // A 5-week period bears both of its months (2 x 200.00 monthly).
    for (const line of lines) {
      const days = Math.round((new Date(line.ends_on).getTime() - new Date(line.starts_on).getTime()) / 86400000) + 1;
      if (days === 35) {
        assert.equal(toUnits(line.planned), toUnits("400.0000"), `5-week period ${line.starts_on}..${line.ends_on} must carry two months`);
      } else {
        assert.equal(toUnits(line.planned), toUnits("200.0000"), `4-week period ${line.starts_on}..${line.ends_on} must carry one month`);
      }
    }
    assert.equal(lines.length, 4, `expected 4 period lines (Jul–Dec 2026), got ${lines.length}`);
  } finally {
    // Release the default flag before the lease is returned: the fixture
    // reset restores baseline calendar rows in place, and a surviving second
    // default violates fiscal_calendars_one_default during the restore pass.
    await db.execute(sql`update fiscal_calendars set is_default = false where id = ${calendarId} and org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});
