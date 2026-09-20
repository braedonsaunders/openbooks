import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { buildSchedule, computeSchedule, runDepreciation } from "./depreciation.ts";
import { add } from "../money/money.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * Depreciation catch-up for schedule months with no accounting period.
 *
 * Native planning is monthly from the in-service month, but schedule lines
 * must live in an accounting period. When a month has no period — a backdated
 * asset placed in service before the first calendared period, or a skipped
 * period in the middle of the horizon — the runner can never post it: lines
 * are per-period. Dropping those months silently understates depreciation for
 * the life of the asset (lifetime planned < cost − salvage) with no error and
 * no signal. The skipped amount must catch up into the next mapped period so
 * every native month is recognized exactly once. Future months beyond the
 * calendared horizon stay skipped: they still consume native life and are
 * mapped when their periods are created.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedMonthlyPeriods(
  orgId: string,
  months: { n: number; name: string; from: string; to: string }[],
): Promise<void> {
  const cal = (await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where org_id = ${orgId} limit 1`)).rows[0]!.id;
  for (const m of months) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${orgId}, 2026, ${m.n}, ${m.name}, ${m.from}, ${m.to}, false, ${cal})`);
  }
}

async function seedStraightLineAsset(
  orgId: string,
  subsidiaryId: string,
  accounts: { invAsset: string; clearing: string; adjustment: string },
  inServiceOn: string,
): Promise<string> {
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
     depreciation_expense_account_id, default_method, default_life_months, default_convention,
     tax_attributes, is_active)
    values (${categoryId}, ${orgId}, 'Equipment', ${accounts.invAsset}, ${accounts.clearing},
            ${accounts.adjustment}, 'straight_line', 12, 'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`insert into fixed_assets
    (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on,
     acquisition_cost, salvage_value, depreciation_method, useful_life_months, custom)
    values (${assetId}, ${orgId}, ${subsidiaryId}, ${categoryId}, 'CATCHUP-1',
            'Backdated asset', 'in_service', ${inServiceOn}, ${inServiceOn},
            '12000.0000', '2000.0000', 'straight_line', 12, '{}'::jsonb)`);
  return assetId;
}

async function plannedByMonth(orgId: string, assetId: string, bookId: string) {
  return (await db.execute<{ month: string; planned: string }>(sql`
    select p.starts_on::text as month, l.planned_amount::text as planned
      from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
      join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
     where s.org_id = ${orgId} and s.asset_id = ${assetId} and s.book_id = ${bookId}
     order by p.starts_on`)).rows;
}

test("backdated in-service months catch up into the first calendared period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    // Scratch spine is 2026-07 only; extend to August/September. April–June
    // 2026 have no accounting period: the asset below predates the calendar.
    await seedMonthlyPeriods(org.orgId, [
      { n: 8, name: "2026-08", from: "2026-08-01", to: "2026-08-31" },
      { n: 9, name: "2026-09", from: "2026-09-01", to: "2026-09-30" },
    ]);
    const assetId = await seedStraightLineAsset(org.orgId, org.subsidiaryId, org.accounts, "2026-04-15");

    const native = computeSchedule({
      cost: "12000.0000", salvage: "2000.0000", inServiceOn: "2026-04-15",
      lifeMonths: 12, method: "straight_line",
    });
    const expectedJuly = [0, 1, 2, 3].map((i) => native[i]!.planned).reduce(add);

    const built = await buildSchedule(assetId, org.orgId, actorId, org.bookId);
    // April–June are recognized (caught up), not skipped; only future months
    // beyond the horizon stay skipped.
    for (const m of ["2026-04-01", "2026-05-01", "2026-06-01"]) {
      assert.ok(!built.skippedMonths.includes(m), `${m} must catch up, not skip (skipped: ${built.skippedMonths})`);
    }
    assert.ok(built.skippedMonths.includes("2026-10-01"), "future months beyond the horizon stay skipped");

    const lines = await plannedByMonth(org.orgId, assetId, org.bookId);
    const july = lines.find((l) => l.month === "2026-07-01");
    assert.ok(july, "July must carry a schedule line");
    assert.equal(
      july.planned, expectedJuly,
      `July must catch up April–June (expected ${expectedJuly}, got ${july.planned})`,
    );

    // The catch-up actually posts: one July journal for all four months.
    const run = await runDepreciation(org.orgId, "2026-07-31", actorId, assetId);
    assert.equal(run.posted, 1, `expected July catch-up posted, got ${JSON.stringify(run.problems)}`);
    assert.equal(run.totalAmount, expectedJuly);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a skipped mid-horizon month catches up into the next mapped period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    // Deliberate gap: no June 2026 period.
    await seedMonthlyPeriods(org.orgId, [
      { n: 4, name: "2026-04", from: "2026-04-01", to: "2026-04-30" },
      { n: 5, name: "2026-05", from: "2026-05-01", to: "2026-05-31" },
      { n: 8, name: "2026-08", from: "2026-08-01", to: "2026-08-31" },
    ]);
    const assetId = await seedStraightLineAsset(org.orgId, org.subsidiaryId, org.accounts, "2026-04-15");

    const native = computeSchedule({
      cost: "12000.0000", salvage: "2000.0000", inServiceOn: "2026-04-15",
      lifeMonths: 12, method: "straight_line",
    });
    const expectedJuly = add(native[2]!.planned, native[3]!.planned);

    const built = await buildSchedule(assetId, org.orgId, actorId, org.bookId);
    assert.ok(!built.skippedMonths.includes("2026-06-01"), "June must catch up into July, not skip");

    const lines = await plannedByMonth(org.orgId, assetId, org.bookId);
    assert.deepEqual(lines.map((l) => l.month), ["2026-04-01", "2026-05-01", "2026-07-01", "2026-08-01"]);
    const july = lines.find((l) => l.month === "2026-07-01");
    assert.equal(july!.planned, expectedJuly, `July must carry June + July (expected ${expectedJuly}, got ${july!.planned})`);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
