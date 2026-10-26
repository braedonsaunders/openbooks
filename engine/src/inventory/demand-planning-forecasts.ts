import { sql } from "drizzle-orm";
import { cmp, normalizeDecimal } from "../money/money.ts";
import { businessToday } from "../platform/business-date.ts";
import { addCalendarDays, mondayOfIsoWeek } from "../platform/civil-date.ts";
import {
  db,
  withBypassContext,
  withOrg,
  withOrgTransaction,
  type SqlExecutor,
} from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { availabilityEntity, stockedItems } from "./availability.ts";
import type { Runner } from "./contracts.ts";
import {
  assertDemandPlanningFeature,
  auditPlanningChange,
  DemandPlanningError,
  refuse,
  ZERO_QTY,
} from "./demand-planning-policy.ts";
import { readOverrides, runDemandPlan, type OverrideRow } from "./demand-planning-runs.ts";

export interface ForecastOverrideInput {
  itemId: string;
  stockLocationId: string;
  periodStart: string;
  quantity: string;
  reason: string;
}

/** Save (or replace) one period override with its reason. */
export async function saveForecastOverride(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: ForecastOverrideInput,
): Promise<ForecastOverrideInput> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  if (mondayOfIsoWeek(input.periodStart) !== input.periodStart) {
    refuse(
      `Override week ${input.periodStart} must start on a Monday.`,
      "invalid_planning_input",
      "choose the Monday of the forecast week",
      400,
    );
  }
  try {
    const quantity = normalizeDecimal(input.quantity, 4);
    if (cmp(quantity, ZERO_QTY) < 0) {
      refuse(
        `Override quantity ${input.quantity} must be zero or more.`,
        "invalid_planning_input",
        "enter a non-negative override quantity",
        400,
      );
    }
  } catch {
    refuse(
      `Override quantity ${input.quantity} is not a quantity.`,
      "invalid_planning_input",
      "enter the override as a decimal quantity",
      400,
    );
  }
  if (input.reason.trim().length < 5 || input.reason.trim().length > 500) {
    refuse(
      "An override reason of 5 to 500 characters is required.",
      "invalid_planning_input",
      "enter why the model forecast is being replaced",
      400,
    );
  }
  const stocked = await stockedItems(tx as Runner, orgId, [input.itemId]);
  if (!stocked.has(input.itemId)) {
    refuse(
      "This item carries no stock: it has no inventory costing profile.",
      "item_not_stocked",
      "add an inventory costing profile to the item first",
      422,
    );
  }
  const location = (
    await tx.execute<{ id: string }>(
      sql`
    select id from stock_locations where org_id = ${orgId} and id = ${input.stockLocationId}`,
      "objects",
    )
  )[0];
  if (!location) {
    refuse(
      "The override location is not a stock location of this organization.",
      "invalid_planning_input",
      "choose a stock location of this organization",
      422,
    );
  }
  const before =
    (
      await tx.execute<OverrideRow>(
        sql`
    select id, item_id, stock_location_id, period_start::text as period_start, quantity::text as quantity, reason
      from demand_forecast_overrides
     where org_id = ${orgId} and item_id = ${input.itemId}
       and stock_location_id = ${input.stockLocationId} and period_start = ${input.periodStart}::date`,
        "objects",
      )
    )[0] ?? null;
  // One override per item, location and week: a repeat replaces the earlier
  // row, so the latest reason always wins and no week forecasts twice.
  const saved = (
    await tx.execute<OverrideRow>(
      sql`
    insert into demand_forecast_overrides
      (org_id, item_id, stock_location_id, period_start, quantity, reason, created_by, updated_by)
    values (${orgId}, ${input.itemId}, ${input.stockLocationId}, ${input.periodStart}::date,
      ${input.quantity}, ${input.reason.trim()}, ${actorId}, ${actorId})
    on conflict (org_id, item_id, stock_location_id, period_start) do update set
      quantity = excluded.quantity, reason = excluded.reason,
      updated_at = now(), updated_by = ${actorId}
    returning id, item_id, stock_location_id, period_start::text as period_start,
      quantity::text as quantity, reason`,
      "objects",
    )
  )[0];
  if (!saved)
    refuse("The override was not saved.", "planning_write_failed", "retry saving the override");
  await auditPlanningChange(tx, {
    orgId,
    actorId,
    table: "demand_forecast_overrides",
    rowId: saved.id,
    action: before ? "update" : "insert",
    before,
    after: saved,
  });
  return {
    itemId: saved.item_id,
    stockLocationId: saved.stock_location_id,
    periodStart: saved.period_start,
    quantity: saved.quantity,
    reason: saved.reason,
  };
}

/** Weekly scheduled refresh: every opted-in org whose plan is stale. */
export interface DemandForecastScanResult {
  ran: number;
  skippedFeatureOff: number;
  skippedFresh: number;
  orgErrors: Array<{ orgId: string; error: string }>;
}

export async function runDueDemandForecasts(asOf?: string): Promise<DemandForecastScanResult> {
  const result: DemandForecastScanResult = {
    ran: 0,
    skippedFeatureOff: 0,
    skippedFresh: 0,
    orgErrors: [],
  };
  // bypass: scheduler-tick — the unscoped scan lists every organization
  // before checking each one's feature gate.
  const orgIds = await withBypassContext(async () =>
    (await db.execute<{ id: string }>(sql`select id from orgs order by id`, "objects")).map(
      (row) => row.id,
    ),
  );
  for (const orgId of orgIds) {
    const enabled = await withOrg(orgId, () => orgFeatureEnabled(orgId, "demandPlanning", db));
    if (!enabled) {
      result.skippedFeatureOff += 1;
      continue;
    }
    try {
      await withOrg(orgId, async () => {
        const today = asOf ?? (await businessToday(orgId));
        const weekAgo = addCalendarDays(today, -7);
        const subsidiaries = await db.execute<{ id: string }>(
          sql`
          select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id`,
          "objects",
        );
        for (const subsidiary of subsidiaries) {
          const fresh = (
            await db.execute<{ id: string }>(
              sql`
            select id from demand_forecast_runs
             where org_id = ${orgId} and status = 'complete' and as_of > ${weekAgo}::date
               and parameters->>'subsidiaryId' = ${subsidiary.id}
             limit 1`,
              "objects",
            )
          )[0];
          if (fresh) {
            result.skippedFresh += 1;
            continue;
          }
          // The scheduled run attributes to the org's earliest active
          // administrator: an unattributed plan would hide who the weekly
          // refresh belongs to, and the actor must satisfy the run's user
          // reference, so an org with no administrator fails this scan
          // loudly instead of planning anonymously.
          const actor = (
            await db.execute<{ id: string }>(
              sql`
            select u.id from users u
              join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
              join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id and ar.org_id = u.org_id
             where u.org_id = ${orgId} and u.is_active and ar.key = 'admin'
             order by u.created_at, u.id limit 1`,
              "objects",
            )
          )[0];
          if (!actor) {
            throw new DemandPlanningError(
              "The weekly demand plan needs an administrator to attribute the run to.",
              "scan_actor_required",
              "assign the administrator role to a user of this organization",
            );
          }
          await withOrgTransaction(orgId, () =>
            runDemandPlan(db, orgId, actor.id, { subsidiaryId: subsidiary.id, asOf: today }),
          );
          result.ran += 1;
        }
      });
    } catch (error) {
      result.orgErrors.push({
        orgId,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      });
    }
  }
  return result;
}

/** Forecast accuracy by item class: MAPE and bias of past complete runs. */
export interface ForecastAccuracyRow {
  itemClass: string;
  periods: number;
  /** Mean absolute percentage error over weeks that actually sold. */
  mape: string | null;
  /** Sum(forecast − actual) / sum(actual): positive reads over-forecast. */
  bias: string | null;
}

export async function forecastAccuracy(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
): Promise<ForecastAccuracyRow[]> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const entity = await availabilityEntity(tx as Runner, orgId, subsidiaryId);
  const rows = await tx.execute<{
    item_class: string;
    periods: string;
    mape: string | null;
    bias: string | null;
  }>(
    sql`
    with actuals as (
      select m.item_id, date_trunc('week', m.moved_at)::date as week_start,
             sum(case when m.kind = 'issue' then -m.quantity else 0 end) as actual
        from inventory_movements m
       where m.org_id = ${orgId} and m.subsidiary_id = ${entity.subsidiaryId}
         and m.status = 'posted'
         and m.reverses_movement_id is null
         and not exists (
           select 1 from inventory_movements reversal
            where reversal.org_id = m.org_id and reversal.reverses_movement_id = m.id)
       group by 1, 2
    ),
    scored as (
      select coalesce(nullif(i.category, ''), 'uncategorized') as item_class,
             f.forecast_qty, a.actual
        from demand_forecasts f
        join demand_forecast_runs r on r.org_id = f.org_id and r.id = f.run_id
        join items i on i.org_id = f.org_id and i.id = f.item_id
        left join actuals a on a.item_id = f.item_id and a.week_start = f.period_start
       where f.org_id = ${orgId} and r.status = 'complete'
         and r.parameters->>'subsidiaryId' = ${entity.subsidiaryId}
         and f.period_start < current_date
         and f.method <> 'override'
    )
    select item_class,
           count(*)::text as periods,
           case when sum(case when actual > 0 then 1 else 0 end) = 0 then null
             else (avg(case when actual > 0
               then case when forecast_qty >= actual
                 then (forecast_qty - actual) / actual
                 else (actual - forecast_qty) / actual end
               end))::text end as mape,
           case when coalesce(sum(actual), 0) = 0 then null
             else (sum(forecast_qty - coalesce(actual, 0)) / sum(actual))::text end as bias
      from scored
     group by item_class
     order by item_class`,
    "objects",
  );
  return rows.map((row) => ({
    itemClass: row.item_class,
    periods: Number(row.periods),
    mape: row.mape,
    bias: row.bias,
  }));
}

/** Overrides touching one run's horizon, for the run view. */
export async function listForecastOverrides(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  runId: string,
): Promise<ForecastOverrideInput[]> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const run = (
    await tx.execute<{ horizon: string[] }>(
      sql`
    select array_agg(s.period_start::text order by s.period_start) as horizon
      from demand_forecasts s
      join demand_forecast_runs r on r.org_id = s.org_id and r.id = s.run_id
     where s.org_id = ${orgId} and s.run_id = ${runId}
       and r.parameters->>'subsidiaryId' = ${subsidiaryId}`,
      "objects",
    )
  )[0];
  const horizon = run?.horizon ?? [];
  const rows = [...(await readOverrides(tx, orgId, horizon)).values()];
  return rows.map((row) => ({
    itemId: row.item_id,
    stockLocationId: row.stock_location_id,
    periodStart: row.period_start,
    quantity: row.quantity,
    reason: row.reason,
  }));
}
