import { sql } from "drizzle-orm";
import { cmp, normalizeDecimal } from "../money/money.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { stockedItems } from "./availability.ts";
import { InventoryError, type Runner, type SqlExecutor } from "./contracts.ts";
import type { ForecastMethodPreference } from "./demand-forecast.ts";

export type DemandPlanningRefusalCode =
  | "demand_planning_disabled"
  | "orders_disabled"
  | "order_edit_refused"
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
    super(
      "this planning record does not exist in this organization",
      "subsidiary_not_found",
      "choose a planning record listed in Inventory planning",
      404,
    );
  }
}

/** Shared refusal constructor for the planning layers above this module. */
export function refuse(
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

/** Shared audit writer for the planning layers above this module. */
export async function auditPlanningChange(
  tx: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    table: string;
    rowId: string;
    action: "insert" | "update";
    before: unknown;
    after: unknown;
  },
): Promise<void> {
  const inserted = await tx.execute<{ id: string }>(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, ${args.table}, ${args.rowId}, ${args.action},
      ${JSON.stringify({ before: args.before, after: args.after })}::jsonb, ${args.actorId})
    returning id`,
    "objects",
  );
  if (inserted.length !== 1) {
    refuse(
      "The planning change was not recorded in the audit history.",
      "planning_write_failed",
      "retry the change",
    );
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

/** Fill a stored policy with defaults; shared with the plan run. */
export function resolvePolicy(policy: DemandItemPolicy | null): ResolvedDemandPolicy {
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
  const rows = await tx.execute<PolicyRow>(
    sql`
    select item_id, lead_time_days, review_cycle_days, service_level::text,
           moq_qty::text, case_pack_qty::text, preferred_supplier_id::text,
           forecast_method, history_weeks
      from demand_item_policies where org_id = ${orgId}`,
    "objects",
  );
  return new Map(rows.map((row) => [row.item_id, toPolicy(row)]));
}

function checkPolicyInput(input: DemandItemPolicy): void {
  const fail = (message: string, remedy: string): never =>
    refuse(message, "invalid_planning_input", remedy, 400);
  if (
    input.leadTimeDays !== null &&
    (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0)
  ) {
    fail(
      "Lead time must be a whole number of days, zero or more.",
      "enter a lead time of 0 days or more",
    );
  }
  if (
    input.reviewCycleDays !== null &&
    (!Number.isInteger(input.reviewCycleDays) || input.reviewCycleDays < 0)
  ) {
    fail(
      "Review cycle must be a whole number of days, zero or more.",
      "enter a review cycle of 0 days or more",
    );
  }
  if (input.serviceLevel !== null) {
    try {
      const level = normalizeDecimal(input.serviceLevel, 4);
      if (cmp(level, "0.5") < 0 || cmp(level, "0.9999") > 0) {
        fail(
          `Service level ${input.serviceLevel} is outside 50% to 99.99%.`,
          "choose a service level from 50% to 99.99%",
        );
      }
    } catch {
      fail(
        `Service level ${input.serviceLevel} is not a decimal.`,
        "enter the service level as a decimal, for example 0.95",
      );
    }
  }
  for (const [label, value] of [
    ["MOQ", input.moqQty],
    ["case pack", input.casePackQty],
  ] as const) {
    if (value !== null) {
      try {
        const quantity = normalizeDecimal(value, 4);
        if (
          cmp(quantity, ZERO_QTY) < 0 ||
          (label === "case pack" && cmp(quantity, ZERO_QTY) === 0)
        ) {
          fail(
            `${label} must be ${label === "case pack" ? "positive" : "zero or more"}.`,
            `enter a ${label === "case pack" ? "positive" : "non-negative"} ${label}`,
          );
        }
      } catch {
        fail(`${label} ${value} is not a quantity.`, `enter the ${label} as a decimal quantity`);
      }
    }
  }
  if (
    input.historyWeeks !== null &&
    (!Number.isInteger(input.historyWeeks) || input.historyWeeks < 4 || input.historyWeeks > 156)
  ) {
    fail("History must cover 4 to 156 weeks.", "choose a history window from 4 to 156 weeks");
  }
  if (
    input.forecastMethod !== null &&
    !["auto", "seasonal", "intermittent", "average"].includes(input.forecastMethod)
  ) {
    fail(
      `Forecast method ${input.forecastMethod} is not a planning method.`,
      "choose auto, seasonal, intermittent or average",
    );
  }
}

/** The zero against which planning quantities compare. Shared so every layer nets to the same nothing. */
export const ZERO_QTY = "0.0000";

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
    refuse(
      "This item carries no stock: it has no inventory costing profile.",
      "item_not_stocked",
      "add an inventory costing profile to the item first",
      422,
    );
  }
  if (input.preferredSupplierId) {
    const supplier = (
      await tx.execute<{ id: string }>(
        sql`
      select id from parties where org_id = ${orgId} and id = ${input.preferredSupplierId}`,
        "objects",
      )
    )[0];
    if (!supplier) {
      refuse(
        "The preferred supplier is not a party of this organization.",
        "invalid_planning_input",
        "choose a supplier from this organization's parties",
        422,
      );
    }
  }
  const before =
    (
      await tx.execute<PolicyRow>(
        sql`
    select item_id, lead_time_days, review_cycle_days, service_level::text,
           moq_qty::text, case_pack_qty::text, preferred_supplier_id::text,
           forecast_method, history_weeks
      from demand_item_policies where org_id = ${orgId} and item_id = ${input.itemId}`,
        "objects",
      )
    )[0] ?? null;
  const saved = (
    await tx.execute<PolicyRow>(
      sql`
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
      forecast_method, history_weeks`,
      "objects",
    )
  )[0];
  // The upsert targets one item row, so anything but one saved row is a lost
  // write, never a merge into another item's policy.
  if (!saved)
    refuse(
      "The planning policy was not saved.",
      "planning_write_failed",
      "retry saving the policy",
    );
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
