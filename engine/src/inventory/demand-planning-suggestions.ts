import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { mondayOfIsoWeek, weekStartsEndingOn } from "../platform/civil-date.ts";
import { availabilityEntity } from "./availability.ts";
import type { Runner, SqlExecutor } from "./contracts.ts";
import type { DemandWeek } from "./demand-forecast.ts";
import {
  assertDemandPlanningFeature,
  auditPlanningChange,
  DemandPlanningNotFoundError,
  listDemandPolicies,
  refuse,
  ZERO_QTY,
} from "./demand-planning-policy.ts";
import {
  buildSeries,
  readHistoryRows,
  type DemandPlanRun,
  type HistoryRow,
} from "./demand-planning-runs.ts";
import { lastReceiptVendors } from "./replenishment.ts";
import { createTransferOrder } from "./transfer-orders.ts";

export interface PlanSuggestion {
  id: string;
  runId: string;
  runNumber: string;
  runStatus: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  baseUnit: string;
  stockLocationId: string;
  stockLocationCode: string;
  action: "buy" | "transfer";
  quantity: string;
  dueDate: string;
  plannedStart: string | null;
  forecastQty: string;
  projectedSupply: string;
  daysOfCover: string | null;
  status: string;
  convertedRefId: string | null;
  dismissReason: string | null;
  supplierId: string | null;
  supplierName: string | null;
  policyChangedAfterRun: boolean;
}

type SuggestionRow = {
  id: string;
  run_id: string;
  run_number: string;
  run_status: string;
  ran_at: string | null;
  item_id: string;
  item_code: string | null;
  item_name: string;
  base_unit: string | null;
  stock_location_id: string;
  stock_location_code: string;
  action: "buy" | "transfer";
  quantity: string;
  due_date: string;
  planned_start: string | null;
  forecast_qty: string;
  projected_supply: string;
  days_of_cover: string | null;
  status: string;
  converted_ref_id: string | null;
  dismiss_reason: string | null;
  policy_updated_at: string | null;
};

/** The latest planning suggestions for one entity, supplier-resolved. */
export async function listPlanSuggestions(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  status: "suggested" | "confirmed" | "converted" | "dismissed" | "open" | "all" = "open",
): Promise<PlanSuggestion[]> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const entity = await availabilityEntity(tx as Runner, orgId, subsidiaryId);
  const statusFilter =
    status === "all"
      ? sql``
      : status === "open"
        ? sql`and s.status in ('suggested', 'confirmed')`
        : sql`and s.status = ${status}`;
  const rows = await tx.execute<SuggestionRow>(
    sql`
    select s.id, s.run_id, r.number as run_number, r.status as run_status, r.ran_at::text,
           s.item_id, i.code as item_code, i.name as item_name, p.base_unit,
           s.stock_location_id, sl.code as stock_location_code, s.action,
           s.quantity::text, s.due_date::text, s.planned_start::text,
           s.forecast_qty::text as forecast_qty, s.projected_supply::text as projected_supply,
           s.days_of_cover::text as days_of_cover, s.status,
           s.converted_ref_id::text, s.dismiss_reason,
           p0.updated_at::text as policy_updated_at
      from demand_plan_suggestions s
      join demand_forecast_runs r on r.org_id = s.org_id and r.id = s.run_id
      join items i on i.org_id = s.org_id and i.id = s.item_id
      left join item_inventory_profiles p on p.org_id = s.org_id and p.item_id = s.item_id
      join stock_locations sl on sl.org_id = s.org_id and sl.id = s.stock_location_id
      left join demand_item_policies p0 on p0.org_id = s.org_id and p0.item_id = s.item_id
     where s.org_id = ${orgId} and r.parameters->>'subsidiaryId' = ${entity.subsidiaryId}
       and r.status = 'complete'
       ${statusFilter}
     order by s.due_date, i.code, s.id`,
    "objects",
  );
  const policies = await listDemandPolicies(tx, orgId);
  const vendors = await lastReceiptVendors(tx as Runner, orgId, entity.subsidiaryId, [
    ...new Set(rows.map((row) => row.item_id)),
  ]);
  const names = new Map<string, string>();
  const supplierIds = [
    ...new Set(
      rows
        .map((row) => policies.get(row.item_id)?.preferredSupplierId)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  ];
  if (supplierIds.length > 0) {
    for (const row of await tx.execute<{ id: string; name: string }>(
      sql`
      select id, display_name as name from parties
       where org_id = ${orgId} and id in (${sql.join(
         supplierIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})`,
      "objects",
    )) {
      names.set(row.id, row.name);
    }
  }
  return rows.map((row) => {
    const preferred = policies.get(row.item_id)?.preferredSupplierId ?? null;
    const receipt = vendors.get(row.item_id) ?? null;
    return {
      id: row.id,
      runId: row.run_id,
      runNumber: row.run_number,
      runStatus: row.run_status,
      itemId: row.item_id,
      itemCode: (row.item_code ?? "").trim() || row.item_name,
      itemName: row.item_name,
      baseUnit: row.base_unit ?? "ea",
      stockLocationId: row.stock_location_id,
      stockLocationCode: row.stock_location_code,
      action: row.action,
      quantity: row.quantity,
      dueDate: row.due_date,
      plannedStart: row.planned_start,
      forecastQty: row.forecast_qty,
      projectedSupply: row.projected_supply,
      daysOfCover: row.days_of_cover,
      status: row.status,
      convertedRefId: row.converted_ref_id,
      dismissReason: row.dismiss_reason,
      supplierId: preferred ?? receipt?.id ?? null,
      supplierName: (preferred ? names.get(preferred) : undefined) ?? receipt?.name ?? null,
      policyChangedAfterRun:
        row.policy_updated_at !== null && row.ran_at !== null && row.policy_updated_at > row.ran_at,
    };
  });
}

/**
 * Group buy suggestions by supplier for purchase-order creation: one draft
 * per supplier, each carrying its lines. Suggestions without a resolved
 * supplier stand alone — a draft needs exactly one vendor, so they can never
 * share one. Pure over resolved rows, so the web bulk-convert route and the
 * tests share this grouping instead of each inventing one.
 */
export function groupSuggestionsBySupplier(suggestions: readonly PlanSuggestion[]): Array<{
  supplierId: string | null;
  supplierName: string | null;
  suggestions: PlanSuggestion[];
}> {
  const groups = new Map<
    string,
    { supplierId: string | null; supplierName: string | null; suggestions: PlanSuggestion[] }
  >();
  for (const suggestion of suggestions) {
    const key = suggestion.supplierId ?? `unassigned:${suggestion.id}`;
    const group = groups.get(key) ?? {
      supplierId: suggestion.supplierId,
      supplierName: suggestion.supplierName,
      suggestions: [],
    };
    group.suggestions.push(suggestion);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Recent planning runs for one entity, newest first. */
export async function listDemandRuns(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  limit = 20,
): Promise<DemandPlanRun[]> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const entity = await availabilityEntity(tx as Runner, orgId, subsidiaryId);
  const rows = await tx.execute<DemandPlanRun>(
    sql`
    select id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
           status, parameters, ran_at::text as "ranAt"
      from demand_forecast_runs
     where org_id = ${orgId} and parameters->>'subsidiaryId' = ${entity.subsidiaryId}
     order by ran_at desc nulls last, created_at desc
     limit ${Math.max(1, Math.min(limit, 100))}`,
    "objects",
  );
  return rows.map((row) => ({ ...row, replayed: false }));
}

export interface DemandHistoryPoint extends DemandWeek {
  itemId: string;
  stockLocationId: string;
}

/** One run with its forecasts, the history behind them, and supplier-resolved suggestions. */
export async function getDemandRun(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  id: string,
): Promise<{
  run: DemandPlanRun;
  forecasts: unknown[];
  history: DemandHistoryPoint[];
  suggestions: PlanSuggestion[];
}> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const entity = await availabilityEntity(tx as Runner, orgId, subsidiaryId);
  const run = (
    await tx.execute<DemandPlanRun>(
      sql`
    select id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
           status, parameters, ran_at::text as "ranAt"
      from demand_forecast_runs
     where org_id = ${orgId} and id = ${id}
       and parameters->>'subsidiaryId' = ${entity.subsidiaryId}`,
      "objects",
    )
  )[0];
  if (!run) throw new DemandPlanningNotFoundError();
  const forecasts = await tx.execute(
    sql`
    select s.id, s.item_id as "itemId", i.code as "itemCode", s.stock_location_id as "stockLocationId",
           sl.code as "stockLocationCode", s.period_start::text as "periodStart",
           s.forecast_qty::text as "quantity", s.lower_qty::text as "lower",
           s.upper_qty::text as "upper", s.method, s.explanation
      from demand_forecasts s
      join items i on i.org_id = s.org_id and i.id = s.item_id
      join stock_locations sl on sl.org_id = s.org_id and sl.id = s.stock_location_id
     where s.org_id = ${orgId} and s.run_id = ${id}
     order by s.period_start, i.code, sl.code`,
    "objects",
  );
  // The drawer's chart re-reads the run's own grid through the same history
  // reader the run used, so the drawing and the stored forecast agree.
  const parameters = run.parameters as { asOf?: string; historyWeeks?: number };
  const asOf = typeof parameters.asOf === "string" ? parameters.asOf : null;
  const historyWeeks = typeof parameters.historyWeeks === "number" ? parameters.historyWeeks : 0;
  let history: DemandHistoryPoint[] = [];
  if (asOf && historyWeeks > 0) {
    const grid = weekStartsEndingOn(mondayOfIsoWeek(asOf), historyWeeks);
    const { demand, opening } = await readHistoryRows(
      tx,
      orgId,
      entity.subsidiaryId,
      grid[0]!,
      asOf,
    );
    const pairs = new Map<
      string,
      { itemId: string; stockLocationId: string; rows: HistoryRow[] }
    >();
    for (const row of demand) {
      const key = `${row.item_id}:${row.stock_location_id}`;
      const pair = pairs.get(key) ?? {
        itemId: row.item_id,
        stockLocationId: row.stock_location_id,
        rows: [],
      };
      pair.rows.push(row);
      pairs.set(key, pair);
    }
    history = [...pairs.values()].flatMap((pair) =>
      buildSeries(
        grid,
        pair.rows,
        opening.get(`${pair.itemId}:${pair.stockLocationId}`) ?? ZERO_QTY,
      ).map((week) => ({ ...week, itemId: pair.itemId, stockLocationId: pair.stockLocationId })),
    );
  }
  const suggestions = await listPlanSuggestions(tx, orgId, subsidiaryId, "all");
  return {
    run: { ...run, replayed: false },
    forecasts,
    history,
    suggestions: suggestions.filter((suggestion) => suggestion.runId === id),
  };
}

// ---------------------------------------------------------------------------
// Suggestion lifecycle
// ---------------------------------------------------------------------------

async function lockSuggestion(tx: SqlExecutor, orgId: string, id: string) {
  const row = (
    await tx.execute<{
      id: string;
      run_id: string;
      run_number: string;
      item_id: string;
      quantity: string;
      due_date: string;
      planned_start: string | null;
      action: "buy" | "transfer";
      status: string;
      converted_ref_id: string | null;
      dismiss_reason: string | null;
      run_status: string;
      parameters: Record<string, unknown>;
      item_code: string | null;
      item_name: string;
      base_unit: string | null;
      stock_location_id: string;
      policy_changed_after_run: boolean | null;
    }>(
      sql`
    select s.id, s.run_id, r.number as run_number, s.item_id, s.quantity::text,
           s.due_date::text, s.planned_start::text, s.action, s.status,
           s.converted_ref_id::text, s.dismiss_reason,
           r.status as run_status, r.parameters,
           i.code as item_code, i.name as item_name, p.base_unit, s.stock_location_id,
           (p0.updated_at > r.ran_at) as policy_changed_after_run
      from demand_plan_suggestions s
      join demand_forecast_runs r on r.org_id = s.org_id and r.id = s.run_id
      join items i on i.org_id = s.org_id and i.id = s.item_id
      left join item_inventory_profiles p on p.org_id = s.org_id and p.item_id = s.item_id
      left join demand_item_policies p0 on p0.org_id = s.org_id and p0.item_id = s.item_id
     where s.org_id = ${orgId} and s.id = ${id} for update of s`,
      "objects",
    )
  )[0];
  if (!row) throw new DemandPlanningNotFoundError();
  return row;
}

/** One suggestion with its run's entity, for subsidiary guarding. */
export async function getPlanSuggestion(tx: SqlExecutor, orgId: string, id: string) {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const row = await lockSuggestion(tx, orgId, id);
  return { ...row, subsidiaryId: String(row.parameters.subsidiaryId ?? "") };
}

/** Move a suggestion to confirmed so it can be converted. */
export async function confirmPlanSuggestion(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
) {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const before = await lockSuggestion(tx, orgId, id);
  if (before.status === "confirmed") return before;
  if (before.status !== "suggested") {
    refuse(
      "Only a suggested planning row can be confirmed.",
      "suggestion_not_suggested",
      "select a suggested planning row",
      409,
    );
  }
  const updated = await tx.execute(
    sql`update demand_plan_suggestions set status = 'confirmed', updated_at = now(), updated_by = ${actorId}
    where org_id = ${orgId} and id = ${id} and status = 'suggested' returning id`,
    "objects",
  );
  if (updated.length !== 1)
    refuse(
      "The suggestion was not confirmed.",
      "planning_write_failed",
      "reload the suggestion and retry",
    );
  await auditPlanningChange(tx, {
    orgId,
    actorId,
    table: "demand_plan_suggestions",
    rowId: id,
    action: "update",
    before,
    after: { ...before, status: "confirmed" },
  });
  return { ...before, status: "confirmed" };
}

/** Dismiss a suggestion with a recorded reason. */
export async function dismissPlanSuggestion(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
  reason: string,
) {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const text = reason.trim();
  if (text.length < 5 || text.length > 500) {
    refuse(
      "A dismissal reason of 5 to 500 characters is required.",
      "dismiss_reason_required",
      "enter why this suggestion is not being pursued",
      400,
    );
  }
  const before = await lockSuggestion(tx, orgId, id);
  if (before.status !== "suggested") {
    refuse(
      "Only a suggested planning row can be dismissed.",
      "suggestion_not_suggested",
      "select a suggested planning row",
      409,
    );
  }
  const updated = await tx.execute(
    sql`update demand_plan_suggestions
    set status = 'dismissed', dismiss_reason = ${text}, updated_at = now(), updated_by = ${actorId}
    where org_id = ${orgId} and id = ${id} and status = 'suggested' returning id`,
    "objects",
  );
  if (updated.length !== 1)
    refuse(
      "The suggestion was not dismissed.",
      "planning_write_failed",
      "reload the suggestion and retry",
    );
  await auditPlanningChange(tx, {
    orgId,
    actorId,
    table: "demand_plan_suggestions",
    rowId: id,
    action: "update",
    before,
    after: { ...before, status: "dismissed", dismiss_reason: text },
  });
  return { ...before, status: "dismissed", dismiss_reason: text };
}

function assertConvertible(row: Awaited<ReturnType<typeof lockSuggestion>>) {
  if (row.status === "converted" && row.converted_ref_id) return;
  if (row.status !== "confirmed") {
    refuse(
      "Confirm this suggestion before converting it.",
      "suggestion_not_confirmed",
      "confirm the suggestion first",
      409,
    );
  }
  if (row.run_status === "superseded") {
    refuse(
      "This planning run was superseded; re-run the plan before converting its suggestions.",
      "run_superseded",
      "re-run the demand plan",
      409,
    );
  }
  if (row.policy_changed_after_run) {
    refuse(
      "The planning policy changed after this run.",
      "policy_changed",
      "re-run the demand plan to use the updated policy",
      409,
    );
  }
}

async function markConverted(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  row: Awaited<ReturnType<typeof lockSuggestion>>,
  targetId: string,
) {
  const updated = await tx.execute(
    sql`update demand_plan_suggestions
    set status = 'converted', converted_ref_id = ${targetId}, updated_at = now(), updated_by = ${actorId}
    where org_id = ${orgId} and id = ${row.id} and status = 'confirmed' returning id`,
    "objects",
  );
  if (updated.length !== 1)
    refuse(
      "The suggestion conversion was not recorded.",
      "planning_write_failed",
      "reload the suggestion before converting it",
    );
  await auditPlanningChange(tx, {
    orgId,
    actorId,
    table: "demand_plan_suggestions",
    rowId: row.id,
    action: "update",
    before: row,
    after: { ...row, status: "converted", converted_ref_id: targetId },
  });
}

/**
 * Record a purchase suggestion's conversion to a purchase-order draft the
 * web route created: the draft carries the vendor and lines, this marks the
 * suggestion converted exactly once. A replay of the same draft id returns
 * the stored result instead of converting twice.
 */
export async function markBuySuggestionConverted(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
  targetId: string,
): Promise<{ id: string; action: "buy"; replayed: boolean }> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const row = await lockSuggestion(tx, orgId, id);
  if (row.action !== "buy") {
    refuse(
      "Only a purchase suggestion converts to a purchase order.",
      "transfer_locations_required",
      "convert the transfer suggestion with its locations",
      409,
    );
  }
  if (row.status === "converted" && row.converted_ref_id)
    return { id: row.converted_ref_id, action: "buy", replayed: true };
  assertConvertible(row);
  await markConverted(tx, orgId, actorId, row, targetId);
  return { id: targetId, action: "buy", replayed: false };
}

/**
 * Convert a transfer suggestion into a transfer order. The source location
 * arrives with the call (the planning page proposes the deepest surplus);
 * the suggestion's own location is always the destination.
 */
export async function convertTransferSuggestion(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
  input: { fromStockLocationId: string },
): Promise<{ id: string; action: "transfer"; replayed: boolean }> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const row = await lockSuggestion(tx, orgId, id);
  if (row.action !== "transfer") {
    refuse(
      "Only a transfer suggestion converts to a transfer order.",
      "transfer_locations_required",
      "convert the purchase suggestion to a purchase order",
      409,
    );
  }
  if (row.status === "converted" && row.converted_ref_id) {
    return { id: row.converted_ref_id, action: "transfer", replayed: true };
  }
  assertConvertible(row);
  const subsidiaryId = String(row.parameters.subsidiaryId ?? "");
  if (!subsidiaryId) {
    refuse(
      "This planning run carries no legal entity.",
      "planning_write_failed",
      "re-run the demand plan",
      409,
    );
  }
  const transfer = await createTransferOrder(orgId, actorId, {
    fromStockLocationId: input.fromStockLocationId,
    toStockLocationId: row.stock_location_id,
    subsidiaryId,
    orderedOn: await businessToday(orgId),
    memo: `Demand plan ${row.run_number}: ${row.item_code?.trim() || row.item_name} due ${row.due_date}`,
    lines: [{ itemId: row.item_id, quantity: row.quantity }],
  });
  await markConverted(tx, orgId, actorId, row, transfer.id);
  return { id: transfer.id, action: "transfer", replayed: false };
}
