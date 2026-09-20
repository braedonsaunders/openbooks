import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import { add } from "../money/money.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * Continue-from-accumulated onboarding for mid-life fixed assets.
 *
 * A tenant arriving with history in a legacy system onboards the asset at its
 * ORIGINAL cost and in-service date plus the accumulated depreciation already
 * recognised before cutover (with its as-of date). The engine must continue
 * the schedule from those figures: pre-as-of months are dropped (covered by
 * the opening figure), never caught up into the first open period and never
 * posted twice. Lifetime recognition stays exactly cost − salvage:
 * opening + posted + remaining plan.
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

const MONTHS_2026 = [
  { n: 1, name: "2026-01", from: "2026-01-01", to: "2026-01-31" },
  { n: 2, name: "2026-02", from: "2026-02-01", to: "2026-02-28" },
  { n: 3, name: "2026-03", from: "2026-03-01", to: "2026-03-31" },
  { n: 4, name: "2026-04", from: "2026-04-01", to: "2026-04-30" },
  { n: 5, name: "2026-05", from: "2026-05-01", to: "2026-05-31" },
  { n: 6, name: "2026-06", from: "2026-06-01", to: "2026-06-30" },
  { n: 8, name: "2026-08", from: "2026-08-01", to: "2026-08-31" },
  { n: 9, name: "2026-09", from: "2026-09-01", to: "2026-09-30" },
  { n: 10, name: "2026-10", from: "2026-10-01", to: "2026-10-31" },
  { n: 11, name: "2026-11", from: "2026-11-01", to: "2026-11-30" },
  { n: 12, name: "2026-12", from: "2026-12-01", to: "2026-12-31" },
];

/** Straight-line 120k/0/120mo from 2021-06-15 → 1000.0000/month. */
async function seedOnboardedAsset(
  orgId: string,
  subsidiaryId: string,
  accounts: { invAsset: string; clearing: string; adjustment: string },
  opening: { amount: string; asOf: string },
): Promise<string> {
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
     depreciation_expense_account_id, default_method, default_life_months, default_convention,
     tax_attributes, is_active)
    values (${categoryId}, ${orgId}, 'Equipment', ${accounts.invAsset}, ${accounts.clearing},
            ${accounts.adjustment}, 'straight_line', 120, 'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`insert into fixed_assets
    (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on,
     acquisition_cost, salvage_value, depreciation_method, useful_life_months,
     opening_accumulated_depreciation, opening_accumulated_as_of, custom)
    values (${assetId}, ${orgId}, ${subsidiaryId}, ${categoryId}, 'ONBOARD-1',
            'Mid-life asset', 'in_service', '2021-06-15', '2021-06-15',
            '120000.0000', '0.0000', 'straight_line', 120,
            ${opening.amount}, ${opening.asOf}, '{}'::jsonb)`);
  return assetId;
}

async function plannedLines(orgId: string, assetId: string, bookId: string) {
  return (await db.execute<{ month: string; planned: string; posted: string | null }>(sql`
    select p.starts_on::text as month, l.planned_amount::text as planned,
           l.posted_amount::text as posted
      from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
      join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
     where s.org_id = ${orgId} and s.asset_id = ${assetId} and s.book_id = ${bookId}
     order by p.starts_on`)).rows;
}

test("an onboarded asset continues from its opening accumulated without catch-up", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedMonthlyPeriods(org.orgId, MONTHS_2026);
    // 55 months × 1000 through 2025-12-31 recognised in the legacy system.
    const assetId = await seedOnboardedAsset(org.orgId, org.subsidiaryId, org.accounts, {
      amount: "55000.0000",
      asOf: "2025-12-31",
    });

    const built = await buildSchedule(assetId, org.orgId, actorId, org.bookId);
    // Pre-cutover months are covered by the opening figure: they must neither
    // sit on the schedule nor wait in the skipped-months backlog.
    for (const m of ["2021-06-01", "2025-12-01"]) {
      assert.ok(!built.skippedMonths.includes(m), `${m} is covered by the opening figure, not skipped (${built.skippedMonths.length} skipped)`);
    }
    assert.ok(built.skippedMonths.includes("2027-01-01"), "post-horizon months stay skipped");

    const lines = await plannedLines(org.orgId, assetId, org.bookId);
    assert.deepEqual(
      lines.map((l) => l.month),
      MONTHS_2026.map((m) => m.from).concat(["2026-07-01"]).sort(),
      "schedule holds exactly the calendared post-cutover months",
    );
    const january = lines.find((l) => l.month === "2026-01-01");
    assert.ok(january, "January 2026 must carry a schedule line");
    assert.equal(january.planned, "1000.0000", `January must be one month, not a catch-up (got ${january.planned})`);
    const written = lines.map((l) => l.planned).reduce(add);
    assert.equal(written, "12000.0000", `twelve post-cutover months written (got ${written})`);

    // The continuation actually posts: Q1 journals, one month each.
    const run = await runDepreciation(org.orgId, "2026-03-31", actorId, assetId);
    assert.equal(run.posted, 3, `expected 3 postings, got ${JSON.stringify(run.problems)}`);
    assert.equal(run.totalAmount, "3000.0000");

    // Lifetime tie-out: opening + posted + remaining plan == cost − salvage.
    const after = await plannedLines(org.orgId, assetId, org.bookId);
    const posted = after.filter((l) => l.posted !== null).map((l) => l.posted!).reduce(add);
    const unposted = after.filter((l) => l.posted === null).map((l) => l.planned).reduce(add);
    assert.equal(posted, "3000.0000");
    assert.equal(unposted, "9000.0000");
    assert.equal(add(add("55000.0000", posted), add(unposted, "53000.0000")), "120000.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an opening beyond the depreciable basis is refused at the storage boundary", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedMonthlyPeriods(org.orgId, MONTHS_2026);
    // 200000 > cost − salvage (120000): the 0156 check fails the insert.
    // Drizzle surfaces the query, not the PG detail, so assert on the cause.
    let cause = "";
    try {
      await seedOnboardedAsset(org.orgId, org.subsidiaryId, org.accounts, {
        amount: "200000.0000",
        asOf: "2025-12-31",
      });
    } catch (e) {
      cause = String((e as { cause?: unknown }).cause ?? e);
    }
    assert.match(cause, /fixed_assets_opening_balances_check/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an opening as-of before the in-service month fails closed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedMonthlyPeriods(org.orgId, MONTHS_2026);
    const assetId = await seedOnboardedAsset(org.orgId, org.subsidiaryId, org.accounts, {
      amount: "1000.0000",
      asOf: "2021-01-01",
    });
    await assert.rejects(buildSchedule(assetId, org.orgId, actorId, org.bookId), /in-service|opening/i);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
