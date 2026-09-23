import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { remeasureAsset } from "./asset-lifecycle.ts";
import { buildSchedule, runDepreciation } from "./depreciation.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function calendar(org: ScratchOrg, from: number, until: number) {
  for (let i = from; i < until; i++) {
    const start = new Date(Date.UTC(2026, 6 + i, 1));
    const end = new Date(Date.UTC(2026, 7 + i, 0));
    await db.execute(sql`insert into accounting_periods
      (org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment)
      select ${org.orgId},fiscal_calendar_id,${start.getUTCFullYear()},${start.getUTCMonth() + 1},
        ${start.toISOString().slice(0, 7)},${start.toISOString().slice(0, 10)},${end.toISOString().slice(0, 10)},false
      from accounting_periods where id=${org.periodId}`);
  }
}

async function seedCatchupAsset(org: ScratchOrg, actorId: string, tag: string) {
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await calendar(org, 1, 10);
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, gain_loss_account_id,
       default_method, default_life_months, default_convention,
       tax_attributes, is_active, created_by, updated_by)
    values
      (${categoryId}, ${org.orgId}, 'Catch-up equipment',
       ${org.accounts.invAsset}, ${org.accounts.clearing},
       ${org.accounts.adjustment}, ${org.accounts.adjustment},
       'straight_line', 10, 'full_month', '{}'::jsonb, true, ${actorId}, ${actorId})
  `);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, useful_life_months, depreciation_convention,
       custom, created_by, updated_by)
    values
      (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, ${tag},
       'Catch-up asset', 'in_service',
       '2026-07-15', '2026-07-15', 1000, 0, 'straight_line', 10,
       'full_month', '{}'::jsonb, ${actorId}, ${actorId})
  `);
  await buildSchedule(assetId, org.orgId, actorId);
  return assetId;
}

async function planRows(orgId: string, assetId: string) {
  return (
    await db.execute<{
      planned: string;
      posted: string | null;
    }>(sql`
      select l.planned_amount::text as planned, l.posted_amount::text as posted
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
       where l.org_id = ${orgId} and s.asset_id = ${assetId}
       order by l.sequence`)
  ).rows;
}

test(
  "remeasuring with an ended period unposted measures off posted carrying and re-spreads the plan",
  { skip: !DB },
  async () => {
    const unposted = await createScratchOrg();
    const posted = await createScratchOrg();
    try {
      const unpostedActor = (await seedFlowActors(unposted.orgId)).adminId;
      const postedActor = (await seedFlowActors(posted.orgId)).adminId;
      const unpostedAsset = await seedCatchupAsset(unposted, unpostedActor, "CATCHUP-REMEAS");
      const postedAsset = await seedCatchupAsset(posted, postedActor, "CATCHUP-REMEAS-POSTED");

      // July ended with its 100.00 plan line still unposted: remeasurement
      // stays open and measures the impairment off the posted carrying value
      // (1000), retaining the unposted line instead of refusing. The rebuild
      // re-spreads the remaining plan to reach the new carrying value.
      const impairment = await remeasureAsset(unposted.orgId, unpostedAsset, {
        newCarryingValue: "800",
        date: "2026-07-31",
        actorId: unpostedActor,
      });
      assert.equal(impairment.kind, "impaired");
      assert.equal(impairment.delta, "-200.0000");
      const retained = await planRows(unposted.orgId, unpostedAsset);
      assert.equal(retained.length, 10);
      assert.ok(
        retained.every((line) => line.posted === null),
        "remeasurement posts nothing itself",
      );
      assert.equal(
        retained.reduce((total, line) => total + Number(line.planned), 0).toFixed(4),
        "800.0000",
      );
      const balance = (
        await db.execute<{ total: string }>(sql`
          select coalesce(sum(l.amount), 0)::text as total
            from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           where l.org_id = ${unposted.orgId} and e.id = ${impairment.entryId}`)
      ).rows[0]!;
      assert.equal(balance.total, "0.0000");

      // The posted companion still measures off the posted carrying value:
      // after the July run the same remeasurement is a 100.00 impairment.
      assert.equal(
        (await runDepreciation(posted.orgId, "2026-07-31", postedActor, postedAsset)).totalAmount,
        "100.0000",
      );
      const postedImpairment = await remeasureAsset(posted.orgId, postedAsset, {
        newCarryingValue: "800",
        date: "2026-07-31",
        actorId: postedActor,
      });
      assert.equal(postedImpairment.kind, "impaired");
      assert.equal(postedImpairment.delta, "-100.0000");
    } finally {
      await dropScratchOrg(unposted.orgId);
      await dropScratchOrg(posted.orgId);
    }
  },
);
