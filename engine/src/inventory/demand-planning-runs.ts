import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { add, cmp, div, fromUnits, mul, neg, toUnits } from "../money/money.ts";
import { businessToday } from "../platform/business-date.ts";
import { addCalendarDays, mondayOfIsoWeek, weekStartsEndingOn } from "../platform/civil-date.ts";
import { purchaseOrderLineRemainders } from "../records/order-line-remainders.ts";
import {
  availabilityEntity,
  demandTermsByItem,
  openBaseQuantity,
  stockedItems,
} from "./availability.ts";
import type { Runner, SqlExecutor } from "./contracts.ts";
import {
  forecastDemand,
  roundedSqrtUnits,
  zForServiceLevel,
  type DemandWeek,
  type PromotionWindow,
} from "./demand-forecast.ts";
import {
  assertDemandPlanningFeature,
  auditPlanningChange,
  listDemandPolicies,
  refuse,
  resolvePolicy,
  ZERO_QTY,
  type ResolvedDemandPolicy,
} from "./demand-planning-policy.ts";

export type HistoryRow = {
  item_id: string;
  stock_location_id: string;
  week_start: string;
  demand_qty: string;
  net_qty: string;
};

/**
 * Weekly gross issues per item and location over the history grid, plus the
 * cumulative position that flags stockout weeks. Reversed movements never
 * count: both the reversal and the row it reverses are excluded, the same
 * way the receipt-vendor reader ignores reversed receipts.
 */
export async function readHistoryRows(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  windowStart: string,
  asOf: string,
): Promise<{ demand: HistoryRow[]; opening: Map<string, string> }> {
  const reversal = sql`m.reverses_movement_id is null
    and not exists (
      select 1 from inventory_movements reversal
       where reversal.org_id = m.org_id and reversal.reverses_movement_id = m.id)`;
  const demand = await tx.execute<HistoryRow>(
    sql`
    select m.item_id, m.stock_location_id,
           date_trunc('week', m.moved_at)::date::text as week_start,
           sum(case when m.kind = 'issue' then -m.quantity else 0 end)::text as demand_qty,
           sum(m.quantity)::text as net_qty
      from inventory_movements m
     where m.org_id = ${orgId} and m.subsidiary_id = ${subsidiaryId}
       and m.status = 'posted'
       and m.moved_at >= ${windowStart}::date and m.moved_at < (${asOf}::date + 1)
       and ${reversal}
     group by 1, 2, 3
     order by 1, 2, 3`,
    "objects",
  );
  const openingRows = await tx.execute<{
    item_id: string;
    stock_location_id: string;
    opening: string;
  }>(
    sql`
    select m.item_id, m.stock_location_id, sum(m.quantity)::text as opening
      from inventory_movements m
     where m.org_id = ${orgId} and m.subsidiary_id = ${subsidiaryId}
       and m.status = 'posted'
       and m.moved_at < ${windowStart}::date
       and ${reversal}
     group by 1, 2`,
    "objects",
  );
  return {
    demand,
    opening: new Map(
      openingRows.map((row) => [`${row.item_id}:${row.stock_location_id}`, row.opening]),
    ),
  };
}

/** Promotion calendar overlapping the planning window, as lift input. */
async function readPromotionWindows(
  tx: SqlExecutor,
  orgId: string,
  windowStart: string,
  horizonEnd: string,
): Promise<PromotionWindow[]> {
  const rows = await tx.execute<{ code: string; starts_on: string; ends_on: string }>(
    sql`
    select code, coalesce(starts_at::date, ${windowStart}::date)::text as starts_on,
           coalesce(ends_at::date, ${horizonEnd}::date)::text as ends_on
      from promotions
     where org_id = ${orgId} and status = 'active'
       and (starts_at is null or starts_at::date <= ${horizonEnd}::date)
       and (ends_at is null or ends_at::date >= ${windowStart}::date)
     order by code`,
    "objects",
  );
  return rows.map((row) => ({ code: row.code, startsOn: row.starts_on, endsOn: row.ends_on }));
}

export type OverrideRow = {
  id: string;
  item_id: string;
  stock_location_id: string;
  period_start: string;
  quantity: string;
  reason: string;
};

/** Operator overrides touching the horizon, keyed for the run. */
export async function readOverrides(
  tx: SqlExecutor,
  orgId: string,
  horizonStarts: readonly string[],
): Promise<Map<string, OverrideRow>> {
  if (horizonStarts.length === 0) return new Map();
  const rows = await tx.execute<OverrideRow>(
    sql`
    select id, item_id, stock_location_id, period_start::text, quantity::text, reason
      from demand_forecast_overrides
     where org_id = ${orgId}
       and period_start in (${sql.join(
         horizonStarts.map((day) => sql`${day}::date`),
         sql`, `,
       )})`,
    "objects",
  );
  return new Map(
    rows.map((row) => [`${row.item_id}:${row.stock_location_id}:${row.period_start}`, row]),
  );
}

/** Assemble one item-by-location weekly series with stockout flags. */
export function buildSeries(
  grid: readonly string[],
  rows: readonly HistoryRow[],
  opening: string,
): DemandWeek[] {
  const byWeek = new Map(rows.map((row) => [row.week_start, row]));
  let cumulative = opening;
  const positioned = grid.map((weekStart) => {
    const row = byWeek.get(weekStart);
    const quantity = row ? row.demand_qty : ZERO_QTY;
    cumulative = add(cumulative, row ? row.net_qty : ZERO_QTY);
    return { weekStart, quantity, closing: cumulative };
  });
  return positioned.map((week, index) => {
    if (cmp(week.quantity, ZERO_QTY) !== 0 || cmp(week.closing, ZERO_QTY) > 0) {
      return { weekStart: week.weekStart, quantity: week.quantity, stockout: false };
    }
    // A zero-demand week that ended with nothing on hand censored demand
    // instead of measuring it — but only beside weeks that sold, so a
    // location that never stocked the item is not rewritten as stocked out.
    const before = positioned[index - 1];
    const after = positioned[index + 1];
    const neighbourSold =
      (before !== undefined && cmp(before.quantity, ZERO_QTY) > 0) ||
      (after !== undefined && cmp(after.quantity, ZERO_QTY) > 0);
    return { weekStart: week.weekStart, quantity: week.quantity, stockout: neighbourSold };
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunDemandPlanOptions {
  subsidiaryId: string;
  asOf?: string;
  horizonWeeks?: number;
  historyWeeks?: number;
  idempotencyKey?: string;
}

export interface DemandPlanRun extends Record<string, unknown> {
  id: string;
  number: string;
  asOf: string;
  horizonWeeks: number;
  status: "draft" | "complete" | "superseded";
  parameters: Record<string, unknown>;
  ranAt: string | null;
  replayed: boolean;
}

/**
 * Round a base-unit quantity up to a whole multiple of the lot size, in
 * integer ledger units: fromUnits renders the canonical four decimals, so
 * sub-unit lots round exactly instead of through string slicing.
 */
function roundUpToMultiple(quantity: string, multiple: string): string {
  const amount = toUnits(quantity);
  const lot = toUnits(multiple);
  if (lot <= 0n) return quantity;
  return fromUnits(((amount + lot - 1n) / lot) * lot);
}

/**
 * The lead-time factor of safety stock as an exact 4dp decimal:
 * round(sqrt(leadDays / 7)). A fractional-week lead still covers its share
 * of weekly variance deterministically, with no float in the path.
 */
function leadTimeFactor(leadDays: number): string {
  if (leadDays <= 0) return ZERO_QTY;
  const scaled = (BigInt(leadDays) * 100_000_000n) / 7n;
  const root = roundedSqrtUnits(scaled < 0n ? 0n : scaled);
  const whole = root / SCALE_UNITS;
  const fraction = (root % SCALE_UNITS).toString().padStart(4, "0");
  return `${whole}.${fraction}`;
}

const SCALE_UNITS = 10_000n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roundUpLot(quantity: string, policy: ResolvedDemandPolicy): string {
  let sized = quantity;
  if (policy.casePackQty !== null && cmp(policy.casePackQty, ZERO_QTY) > 0) {
    sized = roundUpToMultiple(sized, policy.casePackQty);
  }
  if (policy.moqQty !== null && cmp(sized, policy.moqQty) < 0) {
    sized = policy.moqQty;
  }
  return sized;
}

type ForecastInsert = {
  itemId: string;
  stockLocationId: string;
  periodStart: string;
  quantity: string;
  lower: string;
  upper: string;
  method: string;
  explanation: Record<string, unknown>;
};

type SuggestionInsert = {
  itemId: string;
  stockLocationId: string;
  action: "buy" | "transfer";
  quantity: string;
  dueDate: string;
  plannedStart: string;
  forecastQty: string;
  projectedSupply: string;
  daysOfCover: string | null;
};

/** Freeze inputs, forecast every stocked position, and write suggestions. */
export async function runDemandPlan(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  raw: RunDemandPlanOptions,
): Promise<DemandPlanRun> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"demand-plan:" + orgId + ":" + raw.subsidiaryId}, 0))`,
  );
  const entity = await availabilityEntity(tx as Runner, orgId, raw.subsidiaryId);
  const horizonWeeks = raw.horizonWeeks ?? 12;
  if (!Number.isInteger(horizonWeeks) || horizonWeeks < 1 || horizonWeeks > 52) {
    refuse(
      "The planning horizon must be from 1 to 52 weeks.",
      "invalid_planning_input",
      "choose a horizon from 1 to 52 weeks",
      400,
    );
  }
  const asOf = raw.asOf ?? (await businessToday(orgId));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    refuse(
      `Planning date ${asOf} is not a calendar date.`,
      "invalid_planning_input",
      "run the plan for a YYYY-MM-DD date",
      400,
    );
  }
  const asOfMonday = mondayOfIsoWeek(asOf);
  if (raw.idempotencyKey !== undefined && !UUID_RE.test(raw.idempotencyKey)) {
    refuse(
      "The planning idempotency key must be a UUID.",
      "invalid_planning_input",
      "retry with an Idempotency-Key UUID header",
      400,
    );
  }
  const policies = await listDemandPolicies(tx, orgId);
  // One grid for every item: an item that wants longer history extends the
  // window for all, since a shared grid keeps weekly buckets comparable.
  let historyWeeks = raw.historyWeeks ?? 52;
  for (const policy of policies.values()) {
    if (policy.historyWeeks !== null && policy.historyWeeks > historyWeeks)
      historyWeeks = policy.historyWeeks;
  }
  if (
    raw.historyWeeks !== undefined &&
    (!Number.isInteger(raw.historyWeeks) || raw.historyWeeks < 4 || raw.historyWeeks > 156)
  ) {
    refuse(
      "Planning history must cover 4 to 156 weeks.",
      "invalid_planning_input",
      "choose a history window from 4 to 156 weeks",
      400,
    );
  }
  const grid = weekStartsEndingOn(asOfMonday, historyWeeks);
  const windowStart = grid[0]!;
  const horizonStarts = Array.from({ length: horizonWeeks }, (_, step) =>
    addCalendarDays(asOfMonday, (step + 1) * 7),
  );
  const horizonEnd = addCalendarDays(asOfMonday, horizonWeeks * 7 + 6);

  if (raw.idempotencyKey) {
    const existing = (
      await tx.execute<DemandPlanRun>(
        sql`
      select id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
             status, parameters, ran_at::text as "ranAt"
        from demand_forecast_runs where org_id = ${orgId} and id = ${raw.idempotencyKey}`,
        "objects",
      )
    )[0];
    if (existing) return { ...existing, replayed: true };
  }

  const items = new Map(
    [...(await stockedItems(tx as Runner, orgId, null))].filter(
      ([, item]) => item.isActive && item.kind !== "kit",
    ),
  );
  const skipped: Array<{ itemId: string; reason: string }> = [];
  if (items.size === 0) {
    refuse(
      "No stocked item can be planned: nothing carries an inventory costing profile.",
      "item_not_stocked",
      "add an inventory costing profile to an item first",
      422,
    );
  }
  const { demand, opening } = await readHistoryRows(
    tx,
    orgId,
    entity.subsidiaryId,
    windowStart,
    asOf,
  );
  const historyByPair = new Map<string, HistoryRow[]>();
  for (const row of demand) {
    const key = `${row.item_id}:${row.stock_location_id}`;
    historyByPair.set(key, [...(historyByPair.get(key) ?? []), row]);
  }
  const locations = [...new Set(demand.map((row) => row.stock_location_id))].sort();
  const promoWindows = await readPromotionWindows(tx, orgId, windowStart, horizonEnd);
  const overrides = await readOverrides(tx, orgId, horizonStarts);
  const plannedPromoWeeks = horizonStarts.filter((weekStart) =>
    promoWindows.some(
      (window) => weekStart <= window.endsOn && addCalendarDays(weekStart, 6) >= window.startsOn,
    ),
  );

  const onOrder = new Map<string, string>();
  for (const line of await purchaseOrderLineRemainders(tx, orgId, { openOnly: true })) {
    const item = items.get(line.itemId);
    if (!item || (line.subsidiaryId ?? entity.rootId) !== entity.subsidiaryId) continue;
    const quantity = openBaseQuantity(
      line.open,
      line.unit,
      item,
      `${line.documentNumber} line ${line.lineNumber}`,
    );
    onOrder.set(line.itemId, add(onOrder.get(line.itemId) ?? ZERO_QTY, quantity));
  }

  const forecasts: ForecastInsert[] = [];
  const suggestions: SuggestionInsert[] = [];
  const policySnapshot: Record<string, unknown> = {};
  for (const item of items.values()) {
    const policy = resolvePolicy(policies.get(item.itemId) ?? null);
    policySnapshot[item.itemId] = { ...policy, label: item.label };
    const coverDays = policy.leadTimeDays + policy.reviewCycleDays;
    const coverWeeks = Math.max(1, Math.floor((coverDays + 6) / 7));
    const safetyFactor = mul(
      zForServiceLevel(policy.serviceLevel),
      leadTimeFactor(policy.leadTimeDays),
    );
    const itemLocations = locations.filter((location) =>
      historyByPair.has(`${item.itemId}:${location}`),
    );
    if (itemLocations.length === 0) continue;
    // One replenishment-grade terms read per location: on-hand, committed
    // (kit lines exploded onto components) and unallocated demand come from
    // the same reader the reorder proposals net — never a second sum.
    const termsByLocation = new Map<
      string,
      { onHand: string; committed: string; unallocated: string }
    >();
    for (const location of itemLocations) {
      const terms = await demandTermsByItem(tx as Runner, orgId, {
        ...entity,
        items,
        locations: new Set([location]),
      });
      const entry = terms.get(item.itemId)!;
      termsByLocation.set(location, {
        onHand: entry.onHand,
        committed: entry.committed,
        unallocated: entry.unallocated,
      });
    }
    const unallocated = termsByLocation.get(itemLocations[0]!)!.unallocated;
    const arriving = onOrder.get(item.itemId) ?? ZERO_QTY;
    let leadLocation = itemLocations[0]!;
    let leadHave = "";
    for (const location of itemLocations) {
      const terms = termsByLocation.get(location)!;
      const have = add(terms.onHand, neg(terms.committed));
      if (leadHave === "" || cmp(have, leadHave) > 0) {
        leadHave = have;
        leadLocation = location;
      }
    }
    const shortfalls: Array<{
      location: string;
      need: string;
      have: string;
      cover: string;
      avgDaily: string | null;
      daysOfCover: string | null;
    }> = [];
    const surpluses: Array<{ location: string; surplus: string }> = [];
    for (const location of itemLocations) {
      const terms = termsByLocation.get(location)!;
      const have = add(terms.onHand, neg(terms.committed));
      const pairRows = historyByPair.get(`${item.itemId}:${location}`)!;
      const series = buildSeries(
        grid,
        pairRows,
        opening.get(`${item.itemId}:${location}`) ?? ZERO_QTY,
      );
      if (series.every((week) => cmp(week.quantity, ZERO_QTY) === 0 && !week.stockout)) continue;
      let result: ReturnType<typeof forecastDemand>;
      try {
        result = forecastDemand(series, {
          horizonWeeks,
          method: policy.forecastMethod,
          promotionWindows: promoWindows,
          plannedPromotionWeeks: plannedPromoWeeks,
        });
      } catch {
        skipped.push({
          itemId: item.itemId,
          reason: "the demand history fits no forecasting method",
        });
        continue;
      }
      const horizonPeriods = result.periods.slice(0, Math.min(coverWeeks, horizonWeeks));
      const coverQty = horizonPeriods.reduce(
        (total, period) => add(total, period.quantity),
        ZERO_QTY,
      );
      const safety = mul(safetyFactor, result.explanation.residualSigma);
      const avgDaily = coverDays > 0 ? div(coverQty, String(coverDays)) : null;
      const adjusted =
        location === leadLocation ? add(add(have, neg(unallocated)), arriving) : have;
      const need = add(add(coverQty, safety), neg(adjusted));
      const daysOfCover = avgDaily && cmp(avgDaily, ZERO_QTY) > 0 ? div(have, avgDaily) : null;
      for (const [index, period] of result.periods.entries()) {
        const override = overrides.get(`${item.itemId}:${location}:${period.periodStart}`);
        forecasts.push({
          itemId: item.itemId,
          stockLocationId: location,
          periodStart: period.periodStart,
          quantity: override ? override.quantity : period.quantity,
          lower: override ? override.quantity : period.lower,
          upper: override ? override.quantity : period.upper,
          method: override ? "override" : period.method,
          explanation: {
            ...result.explanation,
            policyDefaulted: policy.defaulted,
            overrideReason: override ? override.reason : null,
            horizonIndex: index,
          },
        });
      }
      if (cmp(need, ZERO_QTY) > 0) {
        shortfalls.push({
          location,
          need,
          have,
          cover: add(coverQty, safety),
          avgDaily,
          daysOfCover,
        });
      } else if (cmp(need, ZERO_QTY) < 0) {
        surpluses.push({ location, surplus: neg(need) });
      }
    }
    // Cover shortfalls from surplus locations first (a transfer), then buy
    // the remainder. Surpluses are consumed most-surplus-first so one move
    // clears the deepest overstock before touching the next location.
    shortfalls.sort((a, b) => cmp(b.need, a.need));
    surpluses.sort((a, b) => cmp(b.surplus, a.surplus));
    const dueDate = addCalendarDays(asOf, policy.leadTimeDays);
    for (const shortfall of shortfalls) {
      let remaining = shortfall.need;
      for (const surplus of surpluses) {
        if (cmp(remaining, ZERO_QTY) <= 0 || cmp(surplus.surplus, ZERO_QTY) <= 0) continue;
        const moved = cmp(surplus.surplus, remaining) < 0 ? surplus.surplus : remaining;
        suggestions.push({
          itemId: item.itemId,
          stockLocationId: shortfall.location,
          action: "transfer",
          quantity: moved,
          dueDate,
          plannedStart: asOf,
          forecastQty: shortfall.cover,
          projectedSupply: shortfall.have,
          daysOfCover: shortfall.daysOfCover,
        });
        surplus.surplus = add(surplus.surplus, neg(moved));
        remaining = add(remaining, neg(moved));
      }
      if (cmp(remaining, ZERO_QTY) > 0) {
        // Lot sizes apply to purchases only: a transfer moves exactly what
        // the short location needs, while a purchase rounds up to the case
        // pack and never below the minimum order.
        suggestions.push({
          itemId: item.itemId,
          stockLocationId: shortfall.location,
          action: "buy",
          quantity: roundUpLot(remaining, policy),
          dueDate,
          plannedStart: asOf,
          forecastQty: shortfall.cover,
          projectedSupply: shortfall.have,
          daysOfCover: shortfall.daysOfCover,
        });
      }
    }
  }
  if (forecasts.length === 0) {
    refuse(
      "No demand signal exists for this entity: nothing sold in the history window.",
      "item_not_stocked",
      "receive and sell stock first, then run the plan",
      422,
    );
  }
  const runId = raw.idempotencyKey ?? randomUUID();
  const nextNumber =
    (
      await tx.execute<{ sequence: string }>(
        sql`
    select (coalesce(max(substring(number from 5)::bigint)
      filter (where number ~ '^DFP-[0-9]+$'), 0) + 1)::text as sequence
      from demand_forecast_runs where org_id = ${orgId}`,
        "objects",
      )
    )[0]?.sequence ?? "1";
  const number = `DFP-${BigInt(nextNumber).toString().padStart(6, "0")}`;
  const parameters: Record<string, unknown> = {
    subsidiaryId: raw.subsidiaryId,
    asOf,
    horizonWeeks,
    historyWeeks,
    lotSizingRule: "round_buy_up_to_case_pack_then_minimum_order",
    leadTimeSource: "demand_item_policies.lead_time_days",
    safetyRule: "z_service_level_times_weekly_sigma_times_sqrt_lead_weeks",
    policies: policySnapshot,
    promotionWindows: promoWindows,
    skippedItems: skipped,
  };
  const created = (
    await tx.execute<DemandPlanRun>(
      sql`
    insert into demand_forecast_runs
      (id, org_id, number, as_of, horizon_weeks, parameters, status, run_by, created_by, updated_by)
    values (${runId}, ${orgId}, ${number}, ${asOf}, ${horizonWeeks},
      ${JSON.stringify(parameters)}::jsonb, 'draft', ${actorId}, ${actorId}, ${actorId})
    returning id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
      status, parameters, ran_at::text as "ranAt"`,
      "objects",
    )
  )[0];
  if (!created) refuse("The planning run was not saved.", "planning_write_failed", "retry the run");
  await auditPlanningChange(tx, {
    orgId,
    actorId,
    table: "demand_forecast_runs",
    rowId: created.id,
    action: "insert",
    before: null,
    after: created,
  });
  for (const forecast of forecasts) {
    const inserted = await tx.execute<{ id: string }>(
      sql`
      insert into demand_forecasts
        (org_id, run_id, item_id, stock_location_id, period_start, period_grain,
         forecast_qty, lower_qty, upper_qty, method, explanation, created_by, updated_by)
      values (${orgId}, ${created.id}, ${forecast.itemId}, ${forecast.stockLocationId},
        ${forecast.periodStart}, 'week', ${forecast.quantity}, ${forecast.lower},
        ${forecast.upper}, ${forecast.method}, ${JSON.stringify(forecast.explanation)}::jsonb,
        ${actorId}, ${actorId})
      returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      refuse("A forecast row was not saved.", "planning_write_failed", "retry the run");
  }
  for (const suggestion of suggestions) {
    const inserted = await tx.execute<{ id: string }>(
      sql`
      insert into demand_plan_suggestions
        (org_id, run_id, item_id, stock_location_id, action, quantity, due_date,
         planned_start, forecast_qty, projected_supply, days_of_cover, status, created_by, updated_by)
      values (${orgId}, ${created.id}, ${suggestion.itemId}, ${suggestion.stockLocationId},
        ${suggestion.action}, ${suggestion.quantity}, ${suggestion.dueDate},
        ${suggestion.plannedStart}, ${suggestion.forecastQty}, ${suggestion.projectedSupply},
        ${suggestion.daysOfCover}, 'suggested', ${actorId}, ${actorId})
      returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      refuse("A planning suggestion was not saved.", "planning_write_failed", "retry the run");
  }
  const completed = (
    await tx.execute<DemandPlanRun>(
      sql`
    update demand_forecast_runs set status = 'complete', ran_at = now(), updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${created.id} and status = 'draft'
    returning id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
      status, parameters, ran_at::text as "ranAt"`,
      "objects",
    )
  )[0];
  if (!completed)
    refuse("The planning run did not complete.", "planning_write_failed", "retry the run");
  await auditPlanningChange(tx, {
    orgId,
    actorId,
    table: "demand_forecast_runs",
    rowId: completed.id,
    action: "update",
    before: created,
    after: completed,
  });
  const old = await tx.execute<DemandPlanRun>(
    sql`
    update demand_forecast_runs set status = 'superseded', updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and status = 'complete' and id <> ${created.id}
       and parameters->>'subsidiaryId' = ${raw.subsidiaryId}
    returning id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
      status, parameters, ran_at::text as "ranAt"`,
    "objects",
  );
  for (const before of old) {
    await auditPlanningChange(tx, {
      orgId,
      actorId,
      table: "demand_forecast_runs",
      rowId: before.id,
      action: "update",
      before: { ...before, status: "complete" },
      after: before,
    });
  }
  return { ...completed, replayed: false };
}
