import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { add, cmp, div, fromUnits, mul, neg, normalizeDecimal, toUnits } from "../money/money.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { businessToday } from "../platform/business-date.ts";
import {
  addCalendarDays,
  mondayOfIsoWeek,
  weekStartsEndingOn,
} from "../platform/civil-date.ts";
import { db, withBypassContext, withOrg, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { purchaseOrderLineRemainders } from "../records/order-line-remainders.ts";
import {
  availabilityEntity,
  demandTermsByItem,
  openBaseQuantity,
  stockedItems,
} from "./availability.ts";
import { lastReceiptVendors } from "./replenishment.ts";
import { createTransferOrder } from "./transfer-orders.ts";
import type { Runner } from "./contracts.ts";
import { InventoryError } from "./contracts.ts";
import {
  forecastDemand,
  roundedSqrtUnits,
  zForServiceLevel,
  type DemandWeek,
  type ForecastMethodPreference,
  type PromotionWindow,
} from "./demand-forecast.ts";

/**
 * Demand planning: statistical forecasts per item and stock location become
 * reviewable purchase and transfer suggestions.
 *
 * Data flow, with no second computation anywhere:
 * - demand history reads posted `issue` movements (shipments, cash sales and
 *   invoices issuing stock) by item, location and ISO week — gross issues,
 *   so a return rate stays visible instead of hiding inside net demand;
 * - projected supply reuses the replenishment readers (`demandTermsByItem`
 *   per location, the one open-quantity rule for purchase-order supply), the
 *   same terms the reorder-point proposals net;
 * - promotion lift reads the sales promotion calendar as planning input
 *   (plain SQL — inventory cannot import the sales module without cycling
 *   the module graph, and the window type in demand-forecast.ts is the
 *   named extension point for richer signals);
 * - every stored quantity stays an exact decimal string: the models in
 *   demand-forecast.ts never cross floating point, and lot-size rounding
 *   happens once, on the suggestion, rounded up.
 *
 * A run freezes its inputs in `parameters` (policies, promo windows, the
 * lot-sizing rule), writes one forecast row per item, location and horizon
 * week, then writes suggestions. Older complete runs for the same entity
 * are superseded, never rewritten.
 */

export type DemandPlanningRefusalCode =
  | "demand_planning_disabled"
  | "subsidiary_not_found"
  | "item_not_stocked"
  | "unit_not_convertible"
  | "invalid_planning_input"
  | "planning_write_failed"
  | "suggestion_not_suggested"
  | "suggestion_not_confirmed"
  | "suggestion_already_converted"
  | "run_superseded"
  | "policy_changed"
  | "dismiss_reason_required"
  | "vendor_required"
  | "transfer_locations_required"
  | "scan_actor_required";

export class DemandPlanningError extends InventoryError {
  constructor(
    message: string,
    readonly code: DemandPlanningRefusalCode,
    readonly remedy: string,
    readonly status: 400 | 404 | 409 | 422 = 422,
  ) {
    super(message);
    this.name = "DemandPlanningError";
  }
}

export class DemandPlanningNotFoundError extends DemandPlanningError {
  constructor() {
    super("this planning record does not exist in this organization", "subsidiary_not_found", "choose a planning record listed in Inventory planning", 404);
  }
}

function refuse(
  message: string,
  code: DemandPlanningRefusalCode,
  remedy: string,
  status: 400 | 404 | 409 | 422 = 422,
): never {
  throw new DemandPlanningError(message, code, remedy, status);
}

const PLANNING_REMEDY = "turn on Demand planning in Company Settings → Features";

/** The switch this surface reads and writes under. */
export async function assertDemandPlanningFeature(runner: Runner, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner as SqlExecutor, orgId, "demandPlanning"))) {
    throw new DemandPlanningError(
      `demand planning is turned off for this organization; ${PLANNING_REMEDY}`,
      "demand_planning_disabled",
      PLANNING_REMEDY,
      409,
    );
  }
}

async function auditPlanningChange(
  tx: SqlExecutor,
  args: { orgId: string; actorId: string; table: string; rowId: string; action: "insert" | "update"; before: unknown; after: unknown },
): Promise<void> {
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, ${args.table}, ${args.rowId}, ${args.action},
      ${JSON.stringify({ before: args.before, after: args.after })}::jsonb, ${args.actorId})
    returning id`);
  if (inserted.rows.length !== 1) {
    refuse("The planning change was not recorded in the audit history.", "planning_write_failed", "retry the change");
  }
}

// ---------------------------------------------------------------------------
// Planning policy
// ---------------------------------------------------------------------------

export interface DemandItemPolicy {
  itemId: string;
  leadTimeDays: number | null;
  reviewCycleDays: number | null;
  serviceLevel: string | null;
  moqQty: string | null;
  casePackQty: string | null;
  preferredSupplierId: string | null;
  forecastMethod: ForecastMethodPreference | null;
  historyWeeks: number | null;
}

export interface ResolvedDemandPolicy extends DemandItemPolicy {
  leadTimeDays: number;
  reviewCycleDays: number;
  serviceLevel: string;
  forecastMethod: ForecastMethodPreference;
  defaulted: boolean;
}

const DEFAULT_POLICY = {
  leadTimeDays: 7,
  reviewCycleDays: 7,
  serviceLevel: "0.95",
  forecastMethod: "auto" as ForecastMethodPreference,
};

function resolvePolicy(policy: DemandItemPolicy | null): ResolvedDemandPolicy {
  if (!policy) {
    return {
      itemId: "",
      leadTimeDays: DEFAULT_POLICY.leadTimeDays,
      reviewCycleDays: DEFAULT_POLICY.reviewCycleDays,
      serviceLevel: DEFAULT_POLICY.serviceLevel,
      moqQty: null,
      casePackQty: null,
      preferredSupplierId: null,
      forecastMethod: DEFAULT_POLICY.forecastMethod,
      historyWeeks: null,
      defaulted: true,
    };
  }
  return {
    ...policy,
    leadTimeDays: policy.leadTimeDays ?? DEFAULT_POLICY.leadTimeDays,
    reviewCycleDays: policy.reviewCycleDays ?? DEFAULT_POLICY.reviewCycleDays,
    serviceLevel: policy.serviceLevel ?? DEFAULT_POLICY.serviceLevel,
    forecastMethod: policy.forecastMethod ?? DEFAULT_POLICY.forecastMethod,
    defaulted:
      policy.leadTimeDays === null &&
      policy.reviewCycleDays === null &&
      policy.serviceLevel === null &&
      policy.moqQty === null &&
      policy.casePackQty === null &&
      policy.preferredSupplierId === null &&
      policy.forecastMethod === null &&
      policy.historyWeeks === null,
  };
}

type PolicyRow = {
  item_id: string;
  lead_time_days: number | null;
  review_cycle_days: number | null;
  service_level: string | null;
  moq_qty: string | null;
  case_pack_qty: string | null;
  preferred_supplier_id: string | null;
  forecast_method: ForecastMethodPreference | null;
  history_weeks: number | null;
};

function toPolicy(row: PolicyRow): DemandItemPolicy {
  return {
    itemId: row.item_id,
    leadTimeDays: row.lead_time_days,
    reviewCycleDays: row.review_cycle_days,
    serviceLevel: row.service_level,
    moqQty: row.moq_qty,
    casePackQty: row.case_pack_qty,
    preferredSupplierId: row.preferred_supplier_id,
    forecastMethod: row.forecast_method,
    historyWeeks: row.history_weeks,
  };
}

/** Every stored planning policy, by item. */
export async function listDemandPolicies(
  tx: SqlExecutor,
  orgId: string,
): Promise<Map<string, DemandItemPolicy>> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const rows = (await tx.execute<PolicyRow>(sql`
    select item_id, lead_time_days, review_cycle_days, service_level::text,
           moq_qty::text, case_pack_qty::text, preferred_supplier_id::text,
           forecast_method, history_weeks
      from demand_item_policies where org_id = ${orgId}`)).rows;
  return new Map(rows.map((row) => [row.item_id, toPolicy(row)]));
}

function checkPolicyInput(input: DemandItemPolicy): void {
  const fail = (message: string, remedy: string): never =>
    refuse(message, "invalid_planning_input", remedy, 400);
  if (input.leadTimeDays !== null && (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0)) {
    fail("Lead time must be a whole number of days, zero or more.", "enter a lead time of 0 days or more");
  }
  if (input.reviewCycleDays !== null && (!Number.isInteger(input.reviewCycleDays) || input.reviewCycleDays < 0)) {
    fail("Review cycle must be a whole number of days, zero or more.", "enter a review cycle of 0 days or more");
  }
  if (input.serviceLevel !== null) {
    try {
      const level = normalizeDecimal(input.serviceLevel, 4);
      if (cmp(level, "0.5") < 0 || cmp(level, "0.9999") > 0) {
        fail(`Service level ${input.serviceLevel} is outside 50% to 99.99%.`, "choose a service level from 50% to 99.99%");
      }
    } catch {
      fail(`Service level ${input.serviceLevel} is not a decimal.`, "enter the service level as a decimal, for example 0.95");
    }
  }
  for (const [label, value] of [["MOQ", input.moqQty], ["case pack", input.casePackQty]] as const) {
    if (value !== null) {
      try {
        const quantity = normalizeDecimal(value, 4);
        if (cmp(quantity, ZERO_QTY) < 0 || (label === "case pack" && cmp(quantity, ZERO_QTY) === 0)) {
          fail(`${label} must be ${label === "case pack" ? "positive" : "zero or more"}.`, `enter a ${label === "case pack" ? "positive" : "non-negative"} ${label}`);
        }
      } catch {
        fail(`${label} ${value} is not a quantity.`, `enter the ${label} as a decimal quantity`);
      }
    }
  }
  if (input.historyWeeks !== null && (!Number.isInteger(input.historyWeeks) || input.historyWeeks < 4 || input.historyWeeks > 156)) {
    fail("History must cover 4 to 156 weeks.", "choose a history window from 4 to 156 weeks");
  }
  if (input.forecastMethod !== null && !["auto", "seasonal", "intermittent", "average"].includes(input.forecastMethod)) {
    fail(`Forecast method ${input.forecastMethod} is not a planning method.`, "choose auto, seasonal, intermittent or average");
  }
}

const ZERO_QTY = "0.0000";

/** Insert or replace one item's planning policy. */
export async function saveDemandPolicy(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: DemandItemPolicy,
): Promise<DemandItemPolicy> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  checkPolicyInput(input);
  const stocked = await stockedItems(tx as Runner, orgId, [input.itemId]);
  if (!stocked.has(input.itemId)) {
    refuse("This item carries no stock: it has no inventory costing profile.", "item_not_stocked", "add an inventory costing profile to the item first", 422);
  }
  if (input.preferredSupplierId) {
    const supplier = (await tx.execute<{ id: string }>(sql`
      select id from parties where org_id = ${orgId} and id = ${input.preferredSupplierId}`)).rows[0];
    if (!supplier) {
      refuse("The preferred supplier is not a party of this organization.", "invalid_planning_input", "choose a supplier from this organization's parties", 422);
    }
  }
  const before = (await tx.execute<PolicyRow>(sql`
    select item_id, lead_time_days, review_cycle_days, service_level::text,
           moq_qty::text, case_pack_qty::text, preferred_supplier_id::text,
           forecast_method, history_weeks
      from demand_item_policies where org_id = ${orgId} and item_id = ${input.itemId}`)).rows[0] ?? null;
  const saved = (await tx.execute<PolicyRow>(sql`
    insert into demand_item_policies
      (org_id, item_id, lead_time_days, review_cycle_days, service_level, moq_qty,
       case_pack_qty, preferred_supplier_id, forecast_method, history_weeks, created_by, updated_by)
    values (${orgId}, ${input.itemId}, ${input.leadTimeDays}, ${input.reviewCycleDays},
      ${input.serviceLevel}, ${input.moqQty}, ${input.casePackQty}, ${input.preferredSupplierId},
      ${input.forecastMethod}, ${input.historyWeeks}, ${actorId}, ${actorId})
    on conflict (org_id, item_id) do update set
      lead_time_days = excluded.lead_time_days, review_cycle_days = excluded.review_cycle_days,
      service_level = excluded.service_level, moq_qty = excluded.moq_qty,
      case_pack_qty = excluded.case_pack_qty, preferred_supplier_id = excluded.preferred_supplier_id,
      forecast_method = excluded.forecast_method, history_weeks = excluded.history_weeks,
      updated_at = now(), updated_by = ${actorId}
    returning item_id, lead_time_days, review_cycle_days, service_level::text,
      moq_qty::text, case_pack_qty::text, preferred_supplier_id::text,
      forecast_method, history_weeks`)).rows[0];
  // The upsert targets one item row, so anything but one saved row is a lost
  // write, never a merge into another item's policy.
  if (!saved) refuse("The planning policy was not saved.", "planning_write_failed", "retry saving the policy");
  await auditPlanningChange(tx, {
    orgId,
    actorId,
    table: "demand_item_policies",
    rowId: input.itemId,
    action: before ? "update" : "insert",
    before: before ? toPolicy(before) : null,
    after: toPolicy(saved),
  });
  return toPolicy(saved);
}

// ---------------------------------------------------------------------------
// Demand history
// ---------------------------------------------------------------------------

type HistoryRow = {
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
async function readHistoryRows(
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
  const demand = (await tx.execute<HistoryRow>(sql`
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
     order by 1, 2, 3`)).rows;
  const openingRows = (await tx.execute<{ item_id: string; stock_location_id: string; opening: string }>(sql`
    select m.item_id, m.stock_location_id, sum(m.quantity)::text as opening
      from inventory_movements m
     where m.org_id = ${orgId} and m.subsidiary_id = ${subsidiaryId}
       and m.status = 'posted'
       and m.moved_at < ${windowStart}::date
       and ${reversal}
     group by 1, 2`)).rows;
  return {
    demand,
    opening: new Map(openingRows.map((row) => [`${row.item_id}:${row.stock_location_id}`, row.opening])),
  };
}

/** Promotion calendar overlapping the planning window, as lift input. */
async function readPromotionWindows(
  tx: SqlExecutor,
  orgId: string,
  windowStart: string,
  horizonEnd: string,
): Promise<PromotionWindow[]> {
  const rows = (await tx.execute<{ code: string; starts_on: string; ends_on: string }>(sql`
    select code, coalesce(starts_at::date, ${windowStart}::date)::text as starts_on,
           coalesce(ends_at::date, ${horizonEnd}::date)::text as ends_on
      from promotions
     where org_id = ${orgId} and status = 'active'
       and (starts_at is null or starts_at::date <= ${horizonEnd}::date)
       and (ends_at is null or ends_at::date >= ${windowStart}::date)
     order by code`)).rows;
  return rows.map((row) => ({ code: row.code, startsOn: row.starts_on, endsOn: row.ends_on }));
}

type OverrideRow = {
  id: string;
  item_id: string;
  stock_location_id: string;
  period_start: string;
  quantity: string;
  reason: string;
};

/** Operator overrides touching the horizon, keyed for the run. */
async function readOverrides(
  tx: SqlExecutor,
  orgId: string,
  horizonStarts: readonly string[],
): Promise<Map<string, OverrideRow>> {
  if (horizonStarts.length === 0) return new Map();
  const rows = (await tx.execute<OverrideRow>(sql`
    select id, item_id, stock_location_id, period_start::text, quantity::text, reason
      from demand_forecast_overrides
     where org_id = ${orgId}
       and period_start in (${sql.join(horizonStarts.map((day) => sql`${day}::date`), sql`, `)})`)).rows;
  return new Map(rows.map((row) => [`${row.item_id}:${row.stock_location_id}:${row.period_start}`, row]));
}

/** Assemble one item-by-location weekly series with stockout flags. */
function buildSeries(
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
    const neighbourSold = (before !== undefined && cmp(before.quantity, ZERO_QTY) > 0)
      || (after !== undefined && cmp(after.quantity, ZERO_QTY) > 0);
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
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"demand-plan:" + orgId + ":" + raw.subsidiaryId}, 0))`);
  const entity = await availabilityEntity(tx as Runner, orgId, raw.subsidiaryId);
  const horizonWeeks = raw.horizonWeeks ?? 12;
  if (!Number.isInteger(horizonWeeks) || horizonWeeks < 1 || horizonWeeks > 52) {
    refuse("The planning horizon must be from 1 to 52 weeks.", "invalid_planning_input", "choose a horizon from 1 to 52 weeks", 400);
  }
  const asOf = raw.asOf ?? await businessToday(orgId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    refuse(`Planning date ${asOf} is not a calendar date.`, "invalid_planning_input", "run the plan for a YYYY-MM-DD date", 400);
  }
  const asOfMonday = mondayOfIsoWeek(asOf);
  if (raw.idempotencyKey !== undefined && !UUID_RE.test(raw.idempotencyKey)) {
    refuse("The planning idempotency key must be a UUID.", "invalid_planning_input", "retry with an Idempotency-Key UUID header", 400);
  }
  const policies = await listDemandPolicies(tx, orgId);
  // One grid for every item: an item that wants longer history extends the
  // window for all, since a shared grid keeps weekly buckets comparable.
  let historyWeeks = raw.historyWeeks ?? 52;
  for (const policy of policies.values()) {
    if (policy.historyWeeks !== null && policy.historyWeeks > historyWeeks) historyWeeks = policy.historyWeeks;
  }
  if (raw.historyWeeks !== undefined && (!Number.isInteger(raw.historyWeeks) || raw.historyWeeks < 4 || raw.historyWeeks > 156)) {
    refuse("Planning history must cover 4 to 156 weeks.", "invalid_planning_input", "choose a history window from 4 to 156 weeks", 400);
  }
  const grid = weekStartsEndingOn(asOfMonday, historyWeeks);
  const windowStart = grid[0]!;
  const horizonStarts = Array.from({ length: horizonWeeks }, (_, step) => addCalendarDays(asOfMonday, (step + 1) * 7));
  const horizonEnd = addCalendarDays(asOfMonday, horizonWeeks * 7 + 6);

  if (raw.idempotencyKey) {
    const existing = (await tx.execute<DemandPlanRun>(sql`
      select id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
             status, parameters, ran_at::text as "ranAt"
        from demand_forecast_runs where org_id = ${orgId} and id = ${raw.idempotencyKey}`)).rows[0];
    if (existing) return { ...existing, replayed: true };
  }

  const items = new Map(
    [...(await stockedItems(tx as Runner, orgId, null))].filter(([, item]) => item.isActive && item.kind !== "kit"),
  );
  const skipped: Array<{ itemId: string; reason: string }> = [];
  if (items.size === 0) {
    refuse("No stocked item can be planned: nothing carries an inventory costing profile.", "item_not_stocked", "add an inventory costing profile to an item first", 422);
  }
  const { demand, opening } = await readHistoryRows(tx, orgId, entity.subsidiaryId, windowStart, asOf);
  const historyByPair = new Map<string, HistoryRow[]>();
  for (const row of demand) {
    const key = `${row.item_id}:${row.stock_location_id}`;
    historyByPair.set(key, [...(historyByPair.get(key) ?? []), row]);
  }
  const locations = [...new Set(demand.map((row) => row.stock_location_id))].sort();
  const promoWindows = await readPromotionWindows(tx, orgId, windowStart, horizonEnd);
  const overrides = await readOverrides(tx, orgId, horizonStarts);
  const plannedPromoWeeks = horizonStarts.filter((weekStart) =>
    promoWindows.some((window) => weekStart <= window.endsOn && addCalendarDays(weekStart, 6) >= window.startsOn),
  );

  const onOrder = new Map<string, string>();
  for (const line of await purchaseOrderLineRemainders(tx, orgId, { openOnly: true })) {
    const item = items.get(line.itemId);
    if (!item || (line.subsidiaryId ?? entity.rootId) !== entity.subsidiaryId) continue;
    const quantity = openBaseQuantity(line.open, line.unit, item, `${line.documentNumber} line ${line.lineNumber}`);
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
    const safetyFactor = mul(zForServiceLevel(policy.serviceLevel), leadTimeFactor(policy.leadTimeDays));
    const itemLocations = locations.filter((location) =>
      historyByPair.has(`${item.itemId}:${location}`),
    );
    if (itemLocations.length === 0) continue;
    // One replenishment-grade terms read per location: on-hand, committed
    // (kit lines exploded onto components) and unallocated demand come from
    // the same reader the reorder proposals net — never a second sum.
    const termsByLocation = new Map<string, { onHand: string; committed: string; unallocated: string }>();
    for (const location of itemLocations) {
      const terms = await demandTermsByItem(tx as Runner, orgId, {
        ...entity,
        items,
        locations: new Set([location]),
      });
      const entry = terms.get(item.itemId)!;
      termsByLocation.set(location, { onHand: entry.onHand, committed: entry.committed, unallocated: entry.unallocated });
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
    const shortfalls: Array<{ location: string; need: string; have: string; cover: string; avgDaily: string | null; daysOfCover: string | null }> = [];
    const surpluses: Array<{ location: string; surplus: string }> = [];
    for (const location of itemLocations) {
      const terms = termsByLocation.get(location)!;
      const have = add(terms.onHand, neg(terms.committed));
      const pairRows = historyByPair.get(`${item.itemId}:${location}`)!;
      const series = buildSeries(grid, pairRows, opening.get(`${item.itemId}:${location}`) ?? ZERO_QTY);
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
        skipped.push({ itemId: item.itemId, reason: "the demand history fits no forecasting method" });
        continue;
      }
      const horizonPeriods = result.periods.slice(0, Math.min(coverWeeks, horizonWeeks));
      const coverQty = horizonPeriods.reduce((total, period) => add(total, period.quantity), ZERO_QTY);
      const safety = mul(safetyFactor, result.explanation.residualSigma);
      const avgDaily = coverDays > 0 ? div(coverQty, String(coverDays)) : null;
      const adjusted = location === leadLocation ? add(add(have, neg(unallocated)), arriving) : have;
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
        shortfalls.push({ location, need, have, cover: add(coverQty, safety), avgDaily, daysOfCover });
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
    refuse("No demand signal exists for this entity: nothing sold in the history window.", "item_not_stocked", "receive and sell stock first, then run the plan", 422);
  }
  const runId = raw.idempotencyKey ?? randomUUID();
  const nextNumber = (await tx.execute<{ sequence: string }>(sql`
    select (coalesce(max(substring(number from 5)::bigint)
      filter (where number ~ '^DFP-[0-9]+$'), 0) + 1)::text as sequence
      from demand_forecast_runs where org_id = ${orgId}`)).rows[0]?.sequence ?? "1";
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
  const created = (await tx.execute<DemandPlanRun>(sql`
    insert into demand_forecast_runs
      (id, org_id, number, as_of, horizon_weeks, parameters, status, run_by, created_by, updated_by)
    values (${runId}, ${orgId}, ${number}, ${asOf}, ${horizonWeeks},
      ${JSON.stringify(parameters)}::jsonb, 'draft', ${actorId}, ${actorId}, ${actorId})
    returning id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
      status, parameters, ran_at::text as "ranAt"`)).rows[0];
  if (!created) refuse("The planning run was not saved.", "planning_write_failed", "retry the run");
  await auditPlanningChange(tx, { orgId, actorId, table: "demand_forecast_runs", rowId: created.id, action: "insert", before: null, after: created });
  for (const forecast of forecasts) {
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into demand_forecasts
        (org_id, run_id, item_id, stock_location_id, period_start, period_grain,
         forecast_qty, lower_qty, upper_qty, method, explanation, created_by, updated_by)
      values (${orgId}, ${created.id}, ${forecast.itemId}, ${forecast.stockLocationId},
        ${forecast.periodStart}, 'week', ${forecast.quantity}, ${forecast.lower},
        ${forecast.upper}, ${forecast.method}, ${JSON.stringify(forecast.explanation)}::jsonb,
        ${actorId}, ${actorId})
      returning id`);
    if (inserted.rows.length !== 1) refuse("A forecast row was not saved.", "planning_write_failed", "retry the run");
  }
  for (const suggestion of suggestions) {
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into demand_plan_suggestions
        (org_id, run_id, item_id, stock_location_id, action, quantity, due_date,
         planned_start, forecast_qty, projected_supply, days_of_cover, status, created_by, updated_by)
      values (${orgId}, ${created.id}, ${suggestion.itemId}, ${suggestion.stockLocationId},
        ${suggestion.action}, ${suggestion.quantity}, ${suggestion.dueDate},
        ${suggestion.plannedStart}, ${suggestion.forecastQty}, ${suggestion.projectedSupply},
        ${suggestion.daysOfCover}, 'suggested', ${actorId}, ${actorId})
      returning id`);
    if (inserted.rows.length !== 1) refuse("A planning suggestion was not saved.", "planning_write_failed", "retry the run");
  }
  const completed = (await tx.execute<DemandPlanRun>(sql`
    update demand_forecast_runs set status = 'complete', ran_at = now(), updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${created.id} and status = 'draft'
    returning id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
      status, parameters, ran_at::text as "ranAt"`)).rows[0];
  if (!completed) refuse("The planning run did not complete.", "planning_write_failed", "retry the run");
  await auditPlanningChange(tx, { orgId, actorId, table: "demand_forecast_runs", rowId: completed.id, action: "update", before: created, after: completed });
  const old = (await tx.execute<DemandPlanRun>(sql`
    update demand_forecast_runs set status = 'superseded', updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and status = 'complete' and id <> ${created.id}
       and parameters->>'subsidiaryId' = ${raw.subsidiaryId}
    returning id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
      status, parameters, ran_at::text as "ranAt"`)).rows;
  for (const before of old) {
    await auditPlanningChange(tx, { orgId, actorId, table: "demand_forecast_runs", rowId: before.id, action: "update", before: { ...before, status: "complete" }, after: before });
  }
  return { ...completed, replayed: false };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

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
  const statusFilter = status === "all"
    ? sql``
    : status === "open"
      ? sql`and s.status in ('suggested', 'confirmed')`
      : sql`and s.status = ${status}`;
  const rows = (await tx.execute<SuggestionRow>(sql`
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
     order by s.due_date, i.code, s.id`)).rows;
  const policies = await listDemandPolicies(tx, orgId);
  const vendors = await lastReceiptVendors(
    tx as Runner,
    orgId,
    entity.subsidiaryId,
    [...new Set(rows.map((row) => row.item_id))],
  );
  const names = new Map<string, string>();
  const supplierIds = [...new Set(rows.map((row) => policies.get(row.item_id)?.preferredSupplierId).filter((id): id is string => id !== null && id !== undefined))];
  if (supplierIds.length > 0) {
    for (const row of (await tx.execute<{ id: string; name: string }>(sql`
      select id, display_name as name from parties
       where org_id = ${orgId} and id in (${sql.join(supplierIds.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows) {
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
      policyChangedAfterRun: row.policy_updated_at !== null && row.ran_at !== null && row.policy_updated_at > row.ran_at,
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
export function groupSuggestionsBySupplier(
  suggestions: readonly PlanSuggestion[],
): Array<{ supplierId: string | null; supplierName: string | null; suggestions: PlanSuggestion[] }> {
  const groups = new Map<string, { supplierId: string | null; supplierName: string | null; suggestions: PlanSuggestion[] }>();
  for (const suggestion of suggestions) {
    const key = suggestion.supplierId ?? `unassigned:${suggestion.id}`;
    const group = groups.get(key) ?? { supplierId: suggestion.supplierId, supplierName: suggestion.supplierName, suggestions: [] };
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
  const rows = (await tx.execute<DemandPlanRun>(sql`
    select id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
           status, parameters, ran_at::text as "ranAt"
      from demand_forecast_runs
     where org_id = ${orgId} and parameters->>'subsidiaryId' = ${entity.subsidiaryId}
     order by ran_at desc nulls last, created_at desc
     limit ${Math.max(1, Math.min(limit, 100))}`)).rows;
  return rows.map((row) => ({ ...row, replayed: false }));
}

/** One run with its forecasts and supplier-resolved suggestions. */
export async function getDemandRun(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  id: string,
): Promise<{ run: DemandPlanRun; forecasts: unknown[]; suggestions: PlanSuggestion[] }> {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const entity = await availabilityEntity(tx as Runner, orgId, subsidiaryId);
  const run = (await tx.execute<DemandPlanRun>(sql`
    select id, number, as_of::text as "asOf", horizon_weeks as "horizonWeeks",
           status, parameters, ran_at::text as "ranAt"
      from demand_forecast_runs
     where org_id = ${orgId} and id = ${id}
       and parameters->>'subsidiaryId' = ${entity.subsidiaryId}`)).rows[0];
  if (!run) throw new DemandPlanningNotFoundError();
  const forecasts = (await tx.execute(sql`
    select s.id, s.item_id as "itemId", i.code as "itemCode", s.stock_location_id as "stockLocationId",
           sl.code as "stockLocationCode", s.period_start::text as "periodStart",
           s.forecast_qty::text as "quantity", s.lower_qty::text as "lower",
           s.upper_qty::text as "upper", s.method, s.explanation
      from demand_forecasts s
      join items i on i.org_id = s.org_id and i.id = s.item_id
      join stock_locations sl on sl.org_id = s.org_id and sl.id = s.stock_location_id
     where s.org_id = ${orgId} and s.run_id = ${id}
     order by s.period_start, i.code, sl.code`)).rows;
  const suggestions = await listPlanSuggestions(tx, orgId, subsidiaryId, "all");
  return { run: { ...run, replayed: false }, forecasts, suggestions: suggestions.filter((suggestion) => suggestion.runId === id) };
}

// ---------------------------------------------------------------------------
// Suggestion lifecycle
// ---------------------------------------------------------------------------

async function lockSuggestion(tx: SqlExecutor, orgId: string, id: string) {
  const row = (await tx.execute<{
    id: string; run_id: string; run_number: string; item_id: string; quantity: string;
    due_date: string; planned_start: string | null; action: "buy" | "transfer";
    status: string; converted_ref_id: string | null; dismiss_reason: string | null;
    run_status: string; parameters: Record<string, unknown>;
    item_code: string | null; item_name: string; base_unit: string | null;
    stock_location_id: string;
    policy_changed_after_run: boolean | null;
  }>(sql`
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
     where s.org_id = ${orgId} and s.id = ${id} for update of s`)).rows[0];
  if (!row) throw new DemandPlanningNotFoundError();
  return row;
}

/** Move a suggestion to confirmed so it can be converted. */
export async function confirmPlanSuggestion(tx: SqlExecutor, orgId: string, actorId: string, id: string) {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const before = await lockSuggestion(tx, orgId, id);
  if (before.status === "confirmed") return before;
  if (before.status !== "suggested") {
    refuse("Only a suggested planning row can be confirmed.", "suggestion_not_suggested", "select a suggested planning row", 409);
  }
  const updated = await tx.execute(sql`update demand_plan_suggestions set status = 'confirmed', updated_at = now(), updated_by = ${actorId}
    where org_id = ${orgId} and id = ${id} and status = 'suggested' returning id`);
  if (updated.rows.length !== 1) refuse("The suggestion was not confirmed.", "planning_write_failed", "reload the suggestion and retry");
  await auditPlanningChange(tx, { orgId, actorId, table: "demand_plan_suggestions", rowId: id, action: "update", before, after: { ...before, status: "confirmed" } });
  return { ...before, status: "confirmed" };
}

/** Dismiss a suggestion with a recorded reason. */
export async function dismissPlanSuggestion(tx: SqlExecutor, orgId: string, actorId: string, id: string, reason: string) {
  await assertDemandPlanningFeature(tx as Runner, orgId);
  const text = reason.trim();
  if (text.length < 5 || text.length > 500) {
    refuse("A dismissal reason of 5 to 500 characters is required.", "dismiss_reason_required", "enter why this suggestion is not being pursued", 400);
  }
  const before = await lockSuggestion(tx, orgId, id);
  if (before.status !== "suggested") {
    refuse("Only a suggested planning row can be dismissed.", "suggestion_not_suggested", "select a suggested planning row", 409);
  }
  const updated = await tx.execute(sql`update demand_plan_suggestions
    set status = 'dismissed', dismiss_reason = ${text}, updated_at = now(), updated_by = ${actorId}
    where org_id = ${orgId} and id = ${id} and status = 'suggested' returning id`);
  if (updated.rows.length !== 1) refuse("The suggestion was not dismissed.", "planning_write_failed", "reload the suggestion and retry");
  await auditPlanningChange(tx, { orgId, actorId, table: "demand_plan_suggestions", rowId: id, action: "update", before, after: { ...before, status: "dismissed", dismiss_reason: text } });
  return { ...before, status: "dismissed", dismiss_reason: text };
}

function assertConvertible(row: Awaited<ReturnType<typeof lockSuggestion>>) {
  if (row.status === "converted" && row.converted_ref_id) return;
  if (row.status !== "confirmed") {
    refuse("Confirm this suggestion before converting it.", "suggestion_not_confirmed", "confirm the suggestion first", 409);
  }
  if (row.run_status === "superseded") {
    refuse("This planning run was superseded; re-run the plan before converting its suggestions.", "run_superseded", "re-run the demand plan", 409);
  }
  if (row.policy_changed_after_run) {
    refuse("The planning policy changed after this run.", "policy_changed", "re-run the demand plan to use the updated policy", 409);
  }
}

async function markConverted(tx: SqlExecutor, orgId: string, actorId: string, row: Awaited<ReturnType<typeof lockSuggestion>>, targetId: string) {
  const updated = await tx.execute(sql`update demand_plan_suggestions
    set status = 'converted', converted_ref_id = ${targetId}, updated_at = now(), updated_by = ${actorId}
    where org_id = ${orgId} and id = ${row.id} and status = 'confirmed' returning id`);
  if (updated.rows.length !== 1) refuse("The suggestion conversion was not recorded.", "planning_write_failed", "reload the suggestion before converting it");
  await auditPlanningChange(tx, { orgId, actorId, table: "demand_plan_suggestions", rowId: row.id, action: "update", before: row, after: { ...row, status: "converted", converted_ref_id: targetId } });
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
    refuse("Only a purchase suggestion converts to a purchase order.", "transfer_locations_required", "convert the transfer suggestion with its locations", 409);
  }
  if (row.status === "converted" && row.converted_ref_id) return { id: row.converted_ref_id, action: "buy", replayed: true };
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
    refuse("Only a transfer suggestion converts to a transfer order.", "transfer_locations_required", "convert the purchase suggestion to a purchase order", 409);
  }
  if (row.status === "converted" && row.converted_ref_id) {
    return { id: row.converted_ref_id, action: "transfer", replayed: true };
  }
  assertConvertible(row);
  const subsidiaryId = String(row.parameters.subsidiaryId ?? "");
  if (!subsidiaryId) {
    refuse("This planning run carries no legal entity.", "planning_write_failed", "re-run the demand plan", 409);
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

// ---------------------------------------------------------------------------
// Forecast overrides
// ---------------------------------------------------------------------------

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
    refuse(`Override week ${input.periodStart} must start on a Monday.`, "invalid_planning_input", "choose the Monday of the forecast week", 400);
  }
  try {
    const quantity = normalizeDecimal(input.quantity, 4);
    if (cmp(quantity, ZERO_QTY) < 0) {
      refuse(`Override quantity ${input.quantity} must be zero or more.`, "invalid_planning_input", "enter a non-negative override quantity", 400);
    }
  } catch {
    refuse(`Override quantity ${input.quantity} is not a quantity.`, "invalid_planning_input", "enter the override as a decimal quantity", 400);
  }
  if (input.reason.trim().length < 5 || input.reason.trim().length > 500) {
    refuse("An override reason of 5 to 500 characters is required.", "invalid_planning_input", "enter why the model forecast is being replaced", 400);
  }
  const stocked = await stockedItems(tx as Runner, orgId, [input.itemId]);
  if (!stocked.has(input.itemId)) {
    refuse("This item carries no stock: it has no inventory costing profile.", "item_not_stocked", "add an inventory costing profile to the item first", 422);
  }
  const location = (await tx.execute<{ id: string }>(sql`
    select id from stock_locations where org_id = ${orgId} and id = ${input.stockLocationId}`)).rows[0];
  if (!location) {
    refuse("The override location is not a stock location of this organization.", "invalid_planning_input", "choose a stock location of this organization", 422);
  }
  const before = (await tx.execute<OverrideRow>(sql`
    select id, item_id, stock_location_id, period_start::text as period_start, quantity::text as quantity, reason
      from demand_forecast_overrides
     where org_id = ${orgId} and item_id = ${input.itemId}
       and stock_location_id = ${input.stockLocationId} and period_start = ${input.periodStart}::date`)).rows[0] ?? null;
  // One override per item, location and week: a repeat replaces the earlier
  // row, so the latest reason always wins and no week forecasts twice.
  const saved = (await tx.execute<OverrideRow>(sql`
    insert into demand_forecast_overrides
      (org_id, item_id, stock_location_id, period_start, quantity, reason, created_by, updated_by)
    values (${orgId}, ${input.itemId}, ${input.stockLocationId}, ${input.periodStart}::date,
      ${input.quantity}, ${input.reason.trim()}, ${actorId}, ${actorId})
    on conflict (org_id, item_id, stock_location_id, period_start) do update set
      quantity = excluded.quantity, reason = excluded.reason,
      updated_at = now(), updated_by = ${actorId}
    returning id, item_id, stock_location_id, period_start::text as period_start,
      quantity::text as quantity, reason`)).rows[0];
  if (!saved) refuse("The override was not saved.", "planning_write_failed", "retry saving the override");
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
  const result: DemandForecastScanResult = { ran: 0, skippedFeatureOff: 0, skippedFresh: 0, orgErrors: [] };
  // bypass: scheduler-tick — the unscoped scan lists every organization
  // before checking each one's feature gate.
  const orgIds = await withBypassContext(async () =>
    (await db.execute<{ id: string }>(sql`select id from orgs order by id`)).rows.map((row) => row.id));
  for (const orgId of orgIds) {
    const enabled = await withOrg(orgId, () => orgFeatureEnabled(orgId, "demandPlanning", db));
    if (!enabled) {
      result.skippedFeatureOff += 1;
      continue;
    }
    try {
      await withOrg(orgId, async () => {
        const today = asOf ?? await businessToday(orgId);
        const weekAgo = addCalendarDays(today, -7);
        const subsidiaries = (await db.execute<{ id: string }>(sql`
          select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id`)).rows;
        for (const subsidiary of subsidiaries) {
          const fresh = (await db.execute<{ id: string }>(sql`
            select id from demand_forecast_runs
             where org_id = ${orgId} and status = 'complete' and as_of > ${weekAgo}::date
               and parameters->>'subsidiaryId' = ${subsidiary.id}
             limit 1`)).rows[0];
          if (fresh) {
            result.skippedFresh += 1;
            continue;
          }
          // The scheduled run attributes to the org's earliest active
          // administrator: an unattributed plan would hide who the weekly
          // refresh belongs to, and the actor must satisfy the run's user
          // reference, so an org with no administrator fails this scan
          // loudly instead of planning anonymously.
          const actor = (await db.execute<{ id: string }>(sql`
            select u.id from users u
              join role_assignments ra on ra.user_id = u.id and ra.org_id = u.org_id
              join app_roles ar on ar.id = ra.role_id and ar.org_id = ra.org_id and ar.org_id = u.org_id
             where u.org_id = ${orgId} and u.is_active and ar.key = 'admin'
             order by u.created_at, u.id limit 1`)).rows[0];
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
      result.orgErrors.push({ orgId, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) });
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
  const rows = (await tx.execute<{
    item_class: string;
    periods: string;
    mape: string | null;
    bias: string | null;
  }>(sql`
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
     order by item_class`)).rows;
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
  const run = (await tx.execute<{ horizon: string[] }>(sql`
    select array_agg(s.period_start::text order by s.period_start) as horizon
      from demand_forecasts s
      join demand_forecast_runs r on r.org_id = s.org_id and r.id = s.run_id
     where s.org_id = ${orgId} and s.run_id = ${runId}
       and r.parameters->>'subsidiaryId' = ${subsidiaryId}`)).rows[0];
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
