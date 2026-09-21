import { assetBasisDelta } from "./asset-basis.ts";import { depreciationPeriodCount } from "./depreciation-limits.ts";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor, withTransactionSavepoint } from "../platform/db.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { add, cmp, fromUnits, isZero, mulRatio, neg, normalizeMoney, toUnits } from "../money/money.ts";
import { BUILTIN_FORMULAS, computeScheduleByFormula, exactRatio } from "./depreciation-formula.ts";
import { bookConventionWindow } from "./depreciation-conventions.ts";
import type { BookDepreciationConvention } from "@openbooks/schema";
import { assertFinalKernelBalance } from "../ledger/posting-invariants.ts";
import { arePeriodModulesOpen, assertPeriodModulesOpen, CloseError } from "../close/period-policy.ts";
import { loadSubsidiaryContext, uuidArray, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";

/** Persist a manual/usage depreciation fact through exact decimal then ledger money. Fail closed. */
function persistDepreciationInputValue(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error("depreciation value must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new Error("depreciation value must be an exact decimal");
  }
}

/**
 * Fixed-asset depreciation.
 *
 * A schedule is a per-book plan of monthly depreciation amounts derived from an
 * asset (cost, salvage, in-service date, useful life, method). Building a
 * schedule stores the plan (depreciation_schedules + one line per calendar
 * month it can be posted into, mapped to an accounting_period).
 *
 * runDepreciation(asOfDate) walks every schedule line whose period has ended on
 * or before the as-of date and is not yet posted, and posts one balanced system
 * journal per line straight through the kernel:
 *
 *     DR depreciation expense        (planned amount)
 *     CR accumulated depreciation    (planned amount)
 *
 * origin = 'depreciation'; the entry is NOT a document. Idempotency: a line is
 * "posted" once its journal_entry_id is set, so re-running never double-posts —
 * the posted period is tracked on the line itself.
 */

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/**
 * The GL accounts a depreciation entry touches. Native asset columns override
 * the category; product behavior never hides in the custom-field JSON blob.
 */
export interface AssetAccounts {
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
}

export function resolveAssetAccounts(
  asset: {
    assetAccountId?: string | null;
    accumulatedDepreciationAccountId?: string | null;
    depreciationExpenseAccountId?: string | null;
  },
  category: {
    assetAccountId: string;
    accumulatedDepreciationAccountId: string;
    depreciationExpenseAccountId: string;
  },
): AssetAccounts {
  return {
    assetAccountId: asset.assetAccountId || category.assetAccountId,
    accumulatedDepreciationAccountId: asset.accumulatedDepreciationAccountId || category.accumulatedDepreciationAccountId,
    depreciationExpenseAccountId: asset.depreciationExpenseAccountId || category.depreciationExpenseAccountId,
  };
}

// ---------------------------------------------------------------------------
// Schedule computation (pure)
// ---------------------------------------------------------------------------

export type DepreciationMethod =
  | "straight_line"
  | "declining_balance"
  | "double_declining"
  | "units_of_production"
  | "manual";

export interface ScheduleInput {
  /** acquisition cost, decimal string */
  cost: string;
  /** salvage value, decimal string */
  salvage: string;
  /** YYYY-MM-DD */
  inServiceOn: string;
  /** total useful life in months (> 0) */
  lifeMonths: number;
  method: DepreciationMethod;
  /**
   * Annual rate percent for declining-balance (e.g. "30" = 30%/yr). Ignored for
   * double_declining (rate is derived as 2 / life-years). Defaults, when absent,
   * to the straight-line-equivalent rate (1 / life-years).
   */
  ratePercent?: string | null;
  /**
   * First-period convention: full_month (default), mid_month, or half_year.
   *
   * mid_month halves the first MONTH and extends the schedule by one month;
   * half_year halves the first YEAR — twelve monthly periods — and extends it
   * by six. See conventionFraction.
   */
  convention?: "full_month" | "mid_month" | "half_year" | null;
}

export interface UnitsOfProductionChargeInput {
  cost: string;
  salvage: string;
  lifetimeUnits: string;
  periodUnits: string;
  unitsAlreadyRecorded?: string;
  depreciationAlreadyPlanned: string;
}

/** Exact units-of-production charge, rounded once to ledger precision. Signed
 * usage corrections are capped so accumulated depreciation remains between
 * zero and the depreciable basis. */
export function computeUnitsOfProductionCharge(input: UnitsOfProductionChargeInput): string {
  const basis = toUnits(input.cost) - toUnits(input.salvage);
  const lifetime = toUnits(input.lifetimeUnits);
  const period = toUnits(input.periodUnits);
  const priorUnits = toUnits(input.unitsAlreadyRecorded ?? "0");
  const already = toUnits(input.depreciationAlreadyPlanned);
  if (basis < 0n) throw new Error("salvage value cannot exceed acquisition cost");
  if (lifetime <= 0n) throw new Error("expected lifetime production units must be greater than zero");
  if (period === 0n) throw new Error("period production units must be non-zero");
  if (priorUnits < 0n || priorUnits > lifetime || priorUnits + period < 0n || priorUnits + period > lifetime) {
    throw new Error("recorded production must remain between zero and expected lifetime units");
  }
  if (already < 0n || already > basis) throw new Error("existing depreciation exceeds the depreciable basis");
  const remaining = basis - already;
  if (priorUnits + period === lifetime) return fromUnits(remaining);
  const magnitude = toUnits(mulRatio(fromUnits(basis), period < 0n ? -period : period, lifetime));
  const proportional = period < 0n ? -magnitude : magnitude;
  if (proportional > remaining) return fromUnits(remaining);
  if (proportional < -already) return fromUnits(-already);
  return fromUnits(proportional);
}

export interface ScheduleLinePlan {
  sequence: number;
  /** YYYY-MM-01 — the calendar month this depreciation belongs to */
  periodMonth: string;
  /** planned depreciation for the month, decimal string (>= 0) */
  planned: string;
  /** accumulated depreciation through and including this month */
  accumulated: string;
  /** net book value at end of month = cost - accumulated */
  netBookValue: string;
}

/** First day of the month for a YYYY-MM-DD date. */
function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Add n months to a YYYY-MM-01 string, returning YYYY-MM-01. */
function addMonths(monthStartDate: string, n: number): string {
  const [y, m] = monthStartDate.split("-").map(Number);
  const total = (y! * 12 + (m! - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/**
 * The reduced-charge window for a convention.
 *
 * Delegates to the SHARED definition (engine/src/assets/depreciation-conventions.ts)
 * rather than restating it. This engine and the tax engine used to each decide
 * what `half_year` meant and disagreed: half of one monthly period here, half
 * of a year there. The shared table is now the only place that answer exists.
 */
function conventionFraction(
  convention: string | null | undefined,
): { firstPeriodFraction: string; firstFractionPeriods: number } {
  return bookConventionWindow(convention as BookDepreciationConvention | null | undefined);
}

/**
 * Compute the monthly depreciation plan for an asset. Every method depreciates
 * from the in-service month forward, one entry per calendar month, and never
 * takes NBV below salvage — the final month absorbs any rounding remainder so
 * total lifetime depreciation is exactly (cost − salvage).
 */
export function computeSchedule(input: ScheduleInput): ScheduleLinePlan[] {
  const life = depreciationPeriodCount(input.lifeMonths);
  const { formula, rateTable } = formulaForMethod(input.method, input.ratePercent, life);
  const { firstPeriodFraction, firstFractionPeriods } = conventionFraction(input.convention);
  const rows = computeScheduleByFormula({
    cost: input.cost,
    salvage: input.salvage,
    lifePeriods: life,
    formula,
    rateTable,
    firstPeriodFraction,
    firstFractionPeriods,
  });
  const start = monthStart(input.inServiceOn);
  return rows.map((r) => ({
    sequence: r.sequence,
    periodMonth: addMonths(start, r.sequence),
    planned: r.planned,
    accumulated: r.accumulated,
    netBookValue: r.netBookValue,
  }));
}

/**
 * Map a built-in method to a formula so the flexible engine drives every method
 * (declining-balance now gets the DB→SL crossover for a clean finish).
 * `declining_balance` passes its exact monthly rate as R1. Manual and
 * units-of-production are input-driven and therefore never reach this
 * formula-only mapper.
 */
function formulaForMethod(
  method: DepreciationMethod,
  ratePercent: string | null | undefined,
  lifeMonths: number,
): { formula: string; rateTable?: string[] } {
  switch (method) {
    case "double_declining":
      return { formula: BUILTIN_FORMULAS.double_declining };
    case "declining_balance": {
      const monthlyRate = ratePercent != null && cmp(ratePercent, "0") > 0
        ? exactRatio(ratePercent, "1200")
        : exactRatio("1", String(lifeMonths));
      return { formula: "(NB-RV)*R1~(NB-RV)/(AL-CP+1)", rateTable: [monthlyRate] };
    }
    case "straight_line":
      return { formula: BUILTIN_FORMULAS.straight_line };
    case "manual":
      throw new Error("manual depreciation requires a recorded period amount and evidence");
    case "units_of_production":
      throw new Error("units-of-production depreciation requires recorded period usage and lifetime units");
    default: {
      const exhaustive: never = method;
      throw new Error(`unsupported depreciation method ${exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Persist a schedule (plan → depreciation_schedules + lines)
// ---------------------------------------------------------------------------

/** Primary accounting book id (schedules are book-aware). */
async function primaryBookId(runner: SqlExecutor, orgId: string): Promise<string> {
  const result = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary limit 1`));
  if (!result.rows[0]) throw new Error("no primary accounting book");
  return result.rows[0].id;
}

/** Retain the schedule's calendar; a new schedule uses the org's active default. */
export async function assetDepreciationCalendar(
  runner: SqlExecutor,
  orgId: string,
  assetId: string,
  bookId: string,
): Promise<string> {
  const retained = (
    await runner.execute<{ id: string }>(sql`
    select distinct period.fiscal_calendar_id as id
      from depreciation_schedules schedule
      join depreciation_schedule_lines line on line.schedule_id = schedule.id and line.org_id = schedule.org_id
      join accounting_periods period on period.id = line.period_id and period.org_id = line.org_id
     where schedule.org_id = ${orgId} and schedule.asset_id = ${assetId} and schedule.book_id = ${bookId}
  `)
  ).rows;
  if (retained.length > 1)
    throw new Error(
      "asset depreciation schedule spans multiple fiscal calendars",
    );
  if (retained[0]) return retained[0].id;
  const defaults = (
    await runner.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${orgId} and is_default and is_active for share
  `)
  ).rows;
  if (defaults.length !== 1)
    throw new Error(
      "asset depreciation requires one active default fiscal calendar",
    );
  return defaults[0]!.id;
}

export interface BuildScheduleResult {
  scheduleId: string;
  lineCount: number;
  /** future months beyond the calendared horizon, still unmapped */
  skippedMonths: string[];
}

/** Resolve the native depreciation policy and its plan before remeasurements. */
async function loadUnremeasuredAssetPlan(
  runner: SqlExecutor,
  assetId: string,
  orgId: string,
  forBookId?: string,
) {
  const assetRes = await runner.execute<{
    id: string;
    category_id: string;
    in_service_on: string | null;
    acquisition_cost: string;
    salvage_value: string;
    depreciation_method: DepreciationMethod | null;
    depreciation_method_id: string | null;
    useful_life_months: number | null;
    depreciation_rate_percent: string | null;
    depreciation_convention: ScheduleInput["convention"];
    depreciation_units_total: string | null;
    opening_accumulated_depreciation: string | null;
    opening_accumulated_as_of: string | null;
  }>(sql`
    select id, org_id, category_id, in_service_on, acquisition_cost, salvage_value,
           depreciation_method, depreciation_method_id, useful_life_months, depreciation_rate_percent,
           depreciation_convention, depreciation_units_total,
           opening_accumulated_depreciation::text as opening_accumulated_depreciation,
           opening_accumulated_as_of::text as opening_accumulated_as_of
      from fixed_assets where id = ${assetId} and org_id = ${orgId} for update`);
  const asset = assetRes.rows[0];
  if (!asset) throw new Error("asset not found");
  if (!asset.in_service_on) throw new Error("asset has no in-service date");

  const catRes = await runner.execute<{
    default_method: DepreciationMethod;
    default_depreciation_method_id: string | null;
    default_life_months: number | null;
    default_convention: string | null;
  }>(sql`
    select default_method, default_depreciation_method_id, default_life_months, default_convention
      from asset_categories where id = ${asset.category_id} and org_id = ${orgId} for update`);
  const category = catRes.rows[0];
  if (!category) throw new Error("asset category not found");

  const bookId = forBookId ?? (await primaryBookId(runner, orgId));
  const calendarId = await assetDepreciationCalendar(
    runner,
    orgId,
    assetId,
    bookId,
  );

  // Multi-book: a per-book policy for this category overrides the method / life /
  // rate / convention on this book; else the asset custom + category defaults.
  // The category fence serializes policy writes (0103). Do not lock the policy
  // tuple: an UPDATE owns it before its trigger waits for this category, which
  // would invert our lock order. MVCC reads the committed policy while it waits.
  const policyRes = await runner.execute<{
    method: DepreciationMethod;
    depreciation_method_id: string | null;
    life_months: number | null;
    rate_percent: string | null;
    units_total: string | null;
    convention: string | null;
  }>(sql`
    select method, depreciation_method_id, life_months, rate_percent, units_total, convention from depreciation_book_policies
     where org_id = ${orgId} and book_id = ${bookId} and category_id = ${asset.category_id} limit 1`);
  const pol = policyRes.rows[0];
  const method: DepreciationMethod =
    pol?.method ??
    asset.depreciation_method ??
    category.default_method ??
    "straight_line";
  const depreciationMethodId = pol
    ? pol.depreciation_method_id
    : asset.depreciation_method_id || asset.depreciation_method
      ? asset.depreciation_method_id
      : category.default_depreciation_method_id;
  const lifeMonths: number = Number(
    pol?.life_months ??
      asset.useful_life_months ??
      category.default_life_months ??
      0,
  );
  const ratePercent: string | null =
    pol?.rate_percent != null
      ? String(pol.rate_percent)
      : asset.depreciation_rate_percent;
  const unitsTotal: string | null =
    pol?.units_total != null
      ? String(pol.units_total)
      : asset.depreciation_units_total;
  const convention = (pol?.convention ??
    asset.depreciation_convention ??
    category.default_convention ??
    null) as ScheduleInput["convention"];
  // Older deployments permitted book-default edits after use. Never silently
  // reinterpret retained schedule policy as if a changed default were history.
  // Convention was not captured on legacy schedule headers, so this comparison
  // deliberately makes no claim to reconstruct a missing convention snapshot.
  const drift = (
    await runner.execute(sql`
    select 1 from depreciation_schedules schedule
     where schedule.org_id = ${orgId} and schedule.asset_id = ${assetId} and schedule.book_id = ${bookId}
       and row(schedule.method, schedule.depreciation_method_id, schedule.life_months, schedule.rate_percent, schedule.units_total)
           is distinct from row(${method}::text, ${depreciationMethodId}::uuid, ${lifeMonths || null}::integer, ${ratePercent}::numeric, ${unitsTotal}::numeric)
       and (exists (select 1 from depreciation_schedule_lines line where line.org_id = schedule.org_id
             and line.schedule_id = schedule.id and line.posted_amount is not null)
         or exists (select 1 from asset_events event join journal_entries entry
             on entry.id = event.journal_entry_id and entry.org_id = event.org_id
            where event.org_id = schedule.org_id and event.asset_id = schedule.asset_id
              and entry.book_id = schedule.book_id and entry.status in ('posted', 'reversed')))
     limit 1
  `)
  ).rows[0];
  if (drift)
    throw new Error(
      "historical depreciation policy differs from the retained schedule; reconcile the policy before rebuilding or restoring impairment",
    );
  if (
    (depreciationMethodId ||
      (method !== "manual" && method !== "units_of_production")) &&
    (!lifeMonths || lifeMonths <= 0)
  ) {
    throw new Error("asset has no useful life (months)");
  }
  if (
    method === "units_of_production" &&
    (unitsTotal == null || cmp(unitsTotal, "0") <= 0)
  ) {
    throw new Error(
      "units-of-production depreciation requires positive expected lifetime units",
    );
  }

  // A user-authored method is a real FK, not a string that can accidentally
  // collide with a built-in. A stale/deactivated reference fails closed.
  // The row is locked FOR SHARE for the whole schedule-build transaction: the
  // entire plan is computed from this formula and only later written as the
  // schedule and its lines, so a concurrent definition edit must park behind
  // the build until it commits — the storage guard then rejects the edit
  // against the now-visible schedule. An unlocked read let the edit commit in
  // that window and left generated lines on a formula the method row no
  // longer carried.
  const custom2 = await runner.execute<{
    id: string;
    formula: string;
    end_of_life: "fully_depreciate" | "retain_balance";
  }>(sql`
    select id, formula, end_of_life from depreciation_methods
     where org_id = ${orgId} and id = ${depreciationMethodId} and is_active limit 1
     for share`);
  if (depreciationMethodId && !custom2.rows[0])
    throw new Error(
      "configured depreciation formula is inactive or unavailable",
    );
  const { firstPeriodFraction, firstFractionPeriods } =
    conventionFraction(convention);

  let plan: ScheduleLinePlan[] = [];
  if (custom2.rows[0]) {
    const start = monthStart(asset.in_service_on);
    plan = computeScheduleByFormula({
      cost: asset.acquisition_cost,
      salvage: asset.salvage_value,
      lifePeriods: lifeMonths,
      formula: custom2.rows[0].formula,
      endOfLife: custom2.rows[0].end_of_life,
      firstPeriodFraction,
      firstFractionPeriods,
    }).map((r) => ({
      sequence: r.sequence,
      periodMonth: addMonths(start, r.sequence),
      planned: r.planned,
      accumulated: r.accumulated,
      netBookValue: r.netBookValue,
    }));
  } else if (method === "manual" || method === "units_of_production") {
    // Input-driven methods create lines only when the accountant records
    // evidence for a period. Never synthesize future usage or manual amounts.
  } else {
    plan = computeSchedule({
      cost: asset.acquisition_cost,
      salvage: asset.salvage_value,
      inServiceOn: asset.in_service_on,
      lifeMonths,
      method,
      ratePercent,
      convention,
    });
  }

  // Continue-from-accumulated onboarding (migration 0156): the storage check
  // guarantees both-or-neither, so a half-set row can only come from a writer
  // that bypassed it — fail closed rather than silently full-life scheduling.
  const openingAmount = asset.opening_accumulated_depreciation;
  const openingAsOf = asset.opening_accumulated_as_of;
  if ((openingAmount === null) !== (openingAsOf === null)) {
    throw new Error(
      "opening accumulated depreciation requires both an amount and an as-of date",
    );
  }
  const opening =
    openingAmount !== null && openingAsOf !== null
      ? { amount: add(openingAmount, "0"), asOf: openingAsOf }
      : null;

  const basisChange = await assetBasisDelta(runner, orgId, assetId, bookId);
  return {
    asset,
    bookId,
    calendarId,
    method,
    depreciationMethodId,
    lifeMonths,
    ratePercent,
    unitsTotal,
    plan,
    opening,
    basisChange,
  };
}

/**
 * Carrying amount without impairment, using the same native policy as schedule
 * generation and only depreciation effective by the requested date. IAS 36.117
 * requires this depreciated ceiling, rather than the original impairment loss.
 * Input-driven methods replay retained evidence against the original basis.
 */
export async function unimpairedAssetCarryingValue(
  runner: SqlExecutor,
  assetId: string,
  orgId: string,
  bookId: string,
  asOfDate: string,
): Promise<string> {
  const {
    asset,
    calendarId,
    method,
    depreciationMethodId,
    unitsTotal,
    plan,
    opening,
  } = await loadUnremeasuredAssetPlan(runner, assetId, orgId, bookId);
  // Continue-from-accumulated (migration 0156): the IAS 36 counterfactual
  // depreciates the ORIGINAL cost from the in-service date, but the opening
  // figure is pre-cutover depreciation already recognised — the ceiling nets
  // it exactly like the carrying amount does.
  const openingAmount = opening ? opening.amount : "0";
  let depreciation = openingAmount;
  if (
    !depreciationMethodId &&
    (method === "manual" || method === "units_of_production")
  ) {
    const evidence = (
      await runner.execute<{
        manual_amount: string | null;
        production_units: string | null;
        held_depreciable: string;
      }>(sql`
      select input.manual_amount::text, input.production_units::text,
       (${asset.acquisition_cost}::numeric-${asset.salvage_value}::numeric+coalesce((select sum(b.cost_delta-b.salvage_delta) from asset_basis_changes b where b.org_id=schedule.org_id and b.asset_id=schedule.asset_id and b.book_id=schedule.book_id and b.effective_on<=period.ends_on),0))::text as held_depreciable
        from depreciation_schedules schedule
        join depreciation_schedule_lines line on line.schedule_id = schedule.id and line.org_id = schedule.org_id
        join depreciation_inputs input on input.id = line.input_id and input.org_id = line.org_id
        join accounting_periods period on period.id = line.period_id and period.org_id = line.org_id
       where schedule.org_id = ${orgId} and schedule.asset_id = ${assetId} and schedule.book_id = ${bookId}
         and input.voided_at is null and period.ends_on <= ${asOfDate}
       order by line.sequence
    `)
    ).rows;
    let usedUnits = "0";
    for (const input of evidence) {
      const originalDepreciable = add(
        asset.acquisition_cost,
        neg(asset.salvage_value),
      );
      if (cmp(input.held_depreciable, "0") <= 0)
        throw new Error(
          "historical depreciation has no retained physical basis",
        );
      const originalEquivalent = (value: string) =>
        mulRatio(
          value,
          toUnits(originalDepreciable),
          toUnits(input.held_depreciable),
        );
      if (method === "manual") {
        if (input.manual_amount === null)
          throw new Error(
            "manual depreciation evidence is unavailable for the restoration ceiling",
          );
        depreciation = add(
          depreciation,
          originalEquivalent(input.manual_amount),
        );
      } else {
        if (input.production_units === null || unitsTotal === null) {
          throw new Error(
            "production evidence is unavailable for the restoration ceiling",
          );
        }
        depreciation = add(
          depreciation,
          computeUnitsOfProductionCharge({
            cost: asset.acquisition_cost,
            salvage: asset.salvage_value,
            lifetimeUnits: unitsTotal,
            periodUnits: originalEquivalent(input.production_units),
            unitsAlreadyRecorded: usedUnits,
            depreciationAlreadyPlanned: depreciation,
          }),
        );
        usedUnits = add(usedUnits, originalEquivalent(input.production_units));
      }
    }
  } else {
    const periods = (
      await runner.execute<{ starts_on: string; ends_on: string }>(sql`
      select starts_on::text, ends_on::text from accounting_periods
       where org_id = ${orgId} and fiscal_calendar_id = ${calendarId} and not is_adjustment and starts_on <= ${asOfDate}
       order by starts_on for share
    `)
    ).rows;
    for (const line of plan) {
      if (line.periodMonth > asOfDate) continue;
      // Continue-from-accumulated (migration 0156): pre-cutover months have
      // no accounting periods in the new books — they are covered by the
      // opening figure already seeded into the total above, not by the plan.
      if (
        opening &&
        cmp(openingAmount, "0") > 0 &&
        line.periodMonth <= opening.asOf
      )
        continue;
      const period = periods.find(
        (period) =>
          period.starts_on <= line.periodMonth &&
          period.ends_on >= line.periodMonth,
      );
      if (!period)
        throw new Error(
          `accounting period missing for restoration ceiling (${line.periodMonth})`,
        );
      if (period.ends_on <= asOfDate) {
        depreciation = add(depreciation, line.planned);
      }
    }
  }
  const carrying = add(asset.acquisition_cost, neg(depreciation));
  const originalCeiling =
    cmp(carrying, asset.salvage_value) < 0
      ? add(asset.salvage_value, "0")
      : carrying;
  const basis = await assetBasisDelta(runner, orgId, assetId, bookId, asOfDate);
  if (!basis.cutoff) return originalCeiling;
  const remainingSalvage = add(asset.salvage_value, basis.salvage),
    originalDepreciable = add(asset.acquisition_cost, neg(asset.salvage_value));
  if (isZero(originalDepreciable)) return remainingSalvage;
  const remainingDepreciable = add(
    add(asset.acquisition_cost, basis.cost),
    neg(remainingSalvage),
  );
  return add(
    remainingSalvage,
    mulRatio(
      add(originalCeiling, neg(asset.salvage_value)),
      toUnits(remainingDepreciable),
      toUnits(originalDepreciable),
    ),
  );
}

/**
 * Rebuild only the unposted plan from native policy and retained remeasurements.
 * Posted depreciation evidence is preserved verbatim.
 */
export async function buildScheduleWithRunner(
  runner: SqlExecutor,
  assetId: string,
  orgId: string,
  actorId: string | null,
  forBookId?: string,
): Promise<BuildScheduleResult> {
  const {
    asset,
    bookId,
    calendarId,
    method,
    depreciationMethodId,
    lifeMonths,
    ratePercent,
    unitsTotal,
    plan,
    opening,
    basisChange,
  } = await loadUnremeasuredAssetPlan(runner, assetId, orgId, forBookId);
  // Continue-from-accumulated pre-validation (migration 0156). Pre-as-of
  // native months are covered by the opening figure and must never be
  // scheduled — but a zero opening covers nothing, so dropping months for it
  // would silently strand basis. That combination is a writer bug: full-life
  // catch-up (no opening fields at all) is the way to recognise those months.
  const openingAmount = opening ? opening.amount : "0";
  if (opening && cmp(openingAmount, "0") > 0) {
    if (!asset.in_service_on) throw new Error("asset has no in-service date");
    if (monthStart(opening.asOf) < monthStart(asset.in_service_on)) {
      throw new Error(
        `opening accumulated as-of ${opening.asOf} precedes the in-service month ${monthStart(asset.in_service_on)}`,
      );
    }
  }
  if (
    opening &&
    cmp(openingAmount, "0") === 0 &&
    plan.some((p) => p.periodMonth <= opening.asOf)
  ) {
    throw new Error(
      "opening accumulated depreciation is zero but pre-cutover months would be dropped — clear the opening fields for full-life catch-up",
    );
  }
  return await (async (tx: SqlExecutor) => {
    // find (or create) the primary-book schedule for this asset
    const existing = await tx.execute<{
      id: string;
      method: DepreciationMethod;
      depreciation_method_id: string | null;
    }>(sql`
      select id, method, depreciation_method_id from depreciation_schedules
       where asset_id = ${assetId} and org_id = ${orgId} and book_id = ${bookId} limit 1`);
    let scheduleId: string;
    if (existing.rows[0]) {
      scheduleId = existing.rows[0].id;
      if (
        existing.rows[0].method !== method ||
        existing.rows[0].depreciation_method_id !== depreciationMethodId
      ) {
        const evidence = await tx.execute(sql`
          select 1 from depreciation_schedule_lines
           where org_id = ${orgId} and schedule_id = ${scheduleId} and source <> 'formula'
           limit 1 for update`);
        if (evidence.rows[0]) {
          throw new Error(
            "depreciation method cannot change after manual or production evidence exists",
          );
        }
      }
      await tx.execute(sql`
        update depreciation_schedules
           set method = ${method}, depreciation_method_id = ${depreciationMethodId}, life_months = ${lifeMonths || null},
               rate_percent = ${ratePercent}, units_total = ${unitsTotal}, updated_at = now(), updated_by = ${actorId}
         where id = ${scheduleId} and org_id = ${orgId}`);
    } else {
      const ins = await tx.execute<{ id: string }>(sql`
        insert into depreciation_schedules (org_id, asset_id, book_id, method, depreciation_method_id, life_months, rate_percent, units_total, created_by, updated_by)
        values (${orgId}, ${assetId}, ${bookId}, ${method}, ${depreciationMethodId}, ${lifeMonths || null}, ${ratePercent}, ${unitsTotal}, ${actorId}, ${actorId})
        returning id`);
      scheduleId = ins.rows[0]!.id;
    }

    // Input-driven amounts are retained evidence, not a formula schedule.
    if (
      !depreciationMethodId &&
      (method === "manual" || method === "units_of_production")
    ) {
      // A method change before first recognition can leave the old formula
      // plan behind. Those unposted estimates are not input evidence and must
      // not reserve the entire basis against the first production reading.
      // Posted history and every operator-supplied input remain intact.
      await tx.execute(sql`
        delete from depreciation_schedule_lines
         where org_id = ${orgId} and schedule_id = ${scheduleId}
           and source = 'formula' and posted_amount is null and journal_entry_id is null`);
      return { scheduleId, lineCount: 0, skippedMonths: [] };
    }

    const periods = (
      await tx.execute<{ id: string; starts_on: string; ends_on: string }>(sql`
      select id, starts_on::text, ends_on::text from accounting_periods
       where org_id = ${orgId} and fiscal_calendar_id = ${calendarId} and not is_adjustment
       order by starts_on for share
    `)
    ).rows;
    const retained = (
      await tx.execute<{
        id: string;
        period_id: string;
        sequence: number;
        planned_amount: string;
        posted_amount: string | null;
        source: string;
        ends_on: string;
      }>(sql`
      select line.id, line.period_id, line.sequence, line.planned_amount::text,
             line.posted_amount::text, line.source, period.ends_on::text
        from depreciation_schedule_lines line
        join accounting_periods period on period.id = line.period_id and period.org_id = line.org_id
       where line.org_id = ${orgId} and line.schedule_id = ${scheduleId}
       for update of line
    `)
    ).rows;

    // A reversal restores basis as of its own date, not retroactively. Keep the
    // latest cutoff even when all valuation deltas have been reversed, so a
    // subsequent explicit rebuild cannot rewrite earlier projections.
    const remeasurement = (
      await tx.execute<{ delta: string; cutoff: string | null }>(sql`
      select coalesce(sum(event.amount) filter (
               where entry.status = 'posted' and reversal.id is null
             ), 0)::text as delta,
             max(greatest(event.occurred_on, reversal.occurred_on))::text as cutoff
        from asset_events event
        join journal_entries entry on entry.id = event.journal_entry_id and entry.org_id = event.org_id
        left join asset_events reversal on reversal.org_id = event.org_id and reversal.reverses_event_id = event.id
       where event.org_id = ${orgId} and event.asset_id = ${assetId}
         and entry.book_id = ${bookId} and entry.status in ('posted', 'reversed')
         and event.kind in ('impaired', 'revalued')
    `)
    ).rows[0]!;
    if (
      basisChange.cutoff &&
      (!remeasurement.cutoff || basisChange.cutoff > remeasurement.cutoff)
    )
      remeasurement.cutoff = basisChange.cutoff;
    const preserved = retained.filter(
      (line) =>
        line.posted_amount !== null ||
        (remeasurement.cutoff !== null && line.ends_on < remeasurement.cutoff),
    );
    const preservedIds = new Set(preserved.map((line) => line.id));
    const preservedPeriods = new Set(preserved.map((line) => line.period_id));
    const byPeriod = new Map(retained.map((line) => [line.period_id, line]));
    // Reserving an earlier unposted projection does not make it posted: it
    // remains due to the depreciation runner and is excluded from current NBV.
    const reserved = preserved.reduce(
      (sum, line) => add(sum, line.posted_amount ?? line.planned_amount),
      "0",
    );
    const depreciableBase = add(
      add(add(asset.acquisition_cost, basisChange.cost), remeasurement.delta),
      neg(add(asset.salvage_value, basisChange.salvage)),
    );
    const postedTotal = preserved.reduce(
      (sum, line) => add(sum, line.posted_amount ?? "0"),
      "0",
    );
    const unpostedReserved = add(reserved, neg(postedTotal));
    const afterPosted = basisChange.cutoff
      ? add(depreciableBase, neg(postedTotal))
      : cmp(depreciableBase, postedTotal) > 0
        ? add(depreciableBase, neg(postedTotal))
        : "0";
    if (
      cmp(unpostedReserved, add(afterPosted, neg(basisChange.accumulated))) > 0
    ) {
      throw new Error(
        "retained unposted depreciation exceeds the remaining depreciable basis; reconcile earlier projections before remeasurement",
      );
    }
    // Legacy posted-over-basis history is still clamped, but unposted amounts
    // must never be left due when the new basis cannot fund them.
    // Continue-from-accumulated (migration 0156): the opening figure is
    // pre-cutover depreciation recognised in the legacy system. It funds part
    // of the depreciable basis exactly like posted depreciation, so only the
    // remainder is apportioned over the remaining periods.
    const remainingBase = add(
      add(add(afterPosted, neg(unpostedReserved)), neg(openingAmount)),
      neg(basisChange.accumulated),
    );
    if (cmp(remainingBase, "0") < 0) {
      throw new Error(
        "opening accumulated depreciation exceeds the remaining depreciable basis; reconcile the opening figure before rebuilding",
      );
    }

    const skippedMonths: string[] = [];
    const future: { periodId: string | null; plan: ScheduleLinePlan }[] = [];
    // Formula storage has one line per period. Several native months can fall
    // inside one broader fiscal period — two calendar-month starts always sit
    // inside a retail 5-week period — and the period then bears the SUM of its
    // months, never a last-month-wins overwrite and never a dropped month.
    const mappedPeriods = new Map<string, number>();
    // The calendared horizon: months starting after every known period ends
    // are future gaps (mapped when their periods are created). A month at or
    // below the horizon with no period is history — a backdated in-service
    // month or a skipped period — and its depreciation must catch up into the
    // next mapped period, never vanish: dropped months would leave lifetime
    // depreciation below cost minus salvage with no error and no signal.
    const horizonEnd = periods.reduce<string | undefined>(
      (max, period) =>
        max === undefined || period.ends_on > max ? period.ends_on : max,
      undefined,
    );
    // Continue-from-accumulated double-count fences (migration 0156). The
    // opening figure already recognises every pre-as-of month, so retained
    // posted history must not overlap it: a posted line in a period ending on
    // or before the as-of date is that same depreciation posted twice, and a
    // posted line carrying MORE than its period's native plan is earlier
    // history caught up into this period (the full-life catch-up path) — also
    // already inside the opening figure. Either way the rebuild refuses
    // instead of quietly double-counting.
    if (opening && cmp(openingAmount, "0") > 0) {
      const nativeByPeriod = new Map<string, bigint>();
      for (const p of plan) {
        const period = periods.find(
          (period) =>
            period.starts_on <= p.periodMonth &&
            period.ends_on >= p.periodMonth,
        );
        if (!period) continue;
        nativeByPeriod.set(
          period.id,
          (nativeByPeriod.get(period.id) ?? 0n) + toUnits(p.planned),
        );
      }
      for (const line of retained) {
        if (line.posted_amount === null) continue;
        if (line.ends_on <= opening.asOf) {
          throw new Error(
            `posted depreciation for period ending ${line.ends_on} overlaps the opening accumulated as-of ${opening.asOf} — clear the opening fields or reverse the overlapping posting before rebuilding`,
          );
        }
        const native = nativeByPeriod.get(line.period_id);
        if (native !== undefined && toUnits(line.planned_amount) > native) {
          throw new Error(
            `posted depreciation for period ending ${line.ends_on} carries pre-period catch-up already covered by the opening accumulated as-of ${opening.asOf} — clear the opening fields or reverse the overlapping posting before rebuilding`,
          );
        }
      }
    }

    let pendingCatchUp = "0";
    let firstUnplacedMonth: string | null = null;
    for (const p of plan) {
      // Continue-from-accumulated (migration 0156): pre-as-of months were
      // recognised in the legacy system and are covered by the opening
      // figure. They leave the plan here — never caught up, never skipped —
      // so the first open period carries exactly one month.
      if (
        opening &&
        cmp(openingAmount, "0") > 0 &&
        p.periodMonth <= opening.asOf
      )
        continue;
      const period = periods.find(
        (period) =>
          period.starts_on <= p.periodMonth && period.ends_on >= p.periodMonth,
      );
      if (!period) {
        // A missing earlier month cannot be reconstructed from today's basis.
        // Future calendar gaps are harmless: they still consume native life.
        if (
          remeasurement.cutoff &&
          p.periodMonth < monthStart(remeasurement.cutoff)
        ) {
          throw new Error(
            `historical accounting period missing for depreciation projection (${p.periodMonth})`,
          );
        }
        if (
          !remeasurement.cutoff &&
          horizonEnd !== undefined &&
          p.periodMonth <= horizonEnd
        ) {
          pendingCatchUp = add(pendingCatchUp, p.planned);
          firstUnplacedMonth ??= p.periodMonth;
          continue;
        }
        skippedMonths.push(p.periodMonth);
      }
      const prior = period ? byPeriod.get(period.id) : undefined;
      if (
        period &&
        remeasurement.cutoff &&
        period.ends_on < remeasurement.cutoff &&
        !prior
      ) {
        throw new Error(
          `historical depreciation projection missing (${p.periodMonth}); reconcile retained evidence before rebuilding`,
        );
      }
      if (period && preservedPeriods.has(period.id)) continue;
      if (prior && prior.source !== "formula")
        throw new Error(
          "formula rebuild cannot reinterpret depreciation input evidence",
        );
      // Caught-up history lands in the next mapped, unposted period — the
      // same SUM semantics as retail months sharing one period.
      const carried =
        period && pendingCatchUp !== "0"
          ? add(p.planned, pendingCatchUp)
          : p.planned;
      if (period) {
        // Same period, same prior row, same preserved outcome as the month
        // already mapped here — the checks above necessarily agreed with it —
        // so accumulate straight into that future entry.
        const merged = mappedPeriods.get(period.id);
        if (merged !== undefined) {
          const target = future[merged]!;
          target.plan = {
            ...target.plan,
            planned: add(target.plan.planned, carried),
          };
          pendingCatchUp = "0";
          continue;
        }
      }
      future.push({
        periodId: period?.id ?? null,
        plan: period ? { ...p, planned: carried } : p,
      });
      if (period) {
        pendingCatchUp = "0";
        mappedPeriods.set(period.id, future.length - 1);
      }
    }
    if (pendingCatchUp !== "0") {
      throw new Error(
        `historical accounting period missing for depreciation projection (${firstUnplacedMonth}); provision the period or shorten the depreciable life before rebuilding`,
      );
    }
    // Continue-from-accumulated (migration 0156): when every native month is
    // covered by the opening figure, no schedule remains — but a positive
    // remainder would strand depreciable basis with no period left to bear
    // it. That is a fully-depreciated asset onboarded with too small an
    // opening figure (or a life that needs extending), never a silent zero.
    if (
      opening &&
      cmp(openingAmount, "0") > 0 &&
      future.length === 0 &&
      cmp(remainingBase, "0") > 0
    ) {
      throw new Error(
        `no depreciable months remain after the opening accumulated as-of ${opening.asOf} but ${remainingBase} of basis is unfunded — raise the opening figure or extend the useful life`,
      );
    }

    // Allocate across the entire native remaining horizon BEFORE mapping to
    // available accounting periods. The last native month gets the remainder,
    // even when that month's accounting period has not been created yet.
    const weights = future.map(({ periodId }) => {
      const period = periods.find((p) => p.id === periodId);
      if (
        !basisChange.cutoff ||
        !period ||
        basisChange.cutoff <= period.starts_on ||
        basisChange.cutoff > period.ends_on
      )
        return 1000000000n;
      const start = Date.parse(period.starts_on + "T00:00:00Z"),
        end = Date.parse(period.ends_on + "T00:00:00Z") + 86400000;
      return (
        (BigInt(end - Date.parse(basisChange.cutoff + "T00:00:00Z")) *
          1000000000n) /
        BigInt(end - start)
      );
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0n);
    let lineCount = 0;
    let plannedSoFar = "0";
    const keptIds = new Set(preservedIds);
    for (const [index, { periodId, plan: p }] of future.entries()) {
      const roomLeft = add(remainingBase, neg(plannedSoFar));
      const proposed = remeasurement.cutoff
        ? index === future.length - 1
          ? roomLeft
          : mulRatio(remainingBase, weights[index]!, totalWeight)
        : p.planned;
      const amount = cmp(proposed, roomLeft) > 0 ? roomLeft : proposed;
      plannedSoFar = add(plannedSoFar, amount);
      if (!periodId) continue;
      const prior = byPeriod.get(periodId);
      if (prior) {
        // Keep line identity and exercise the same transactional update path
        // used by remeasurement. Historical rows never reach this statement.
        await tx.execute(sql`
          update depreciation_schedule_lines
             set planned_amount = ${amount}, sequence = ${p.sequence}, updated_at = now(), updated_by = ${actorId}
           where id = ${prior.id} and org_id = ${orgId}`);
        keptIds.add(prior.id);
      } else {
        await tx.execute(sql`
          insert into depreciation_schedule_lines
            (org_id, schedule_id, period_id, sequence, planned_amount, source, created_by, updated_by)
          values (${orgId}, ${scheduleId}, ${periodId}, ${p.sequence}, ${amount}, 'formula', ${actorId}, ${actorId})`);
      }
      // Zero-valued rows are evidence too: a later reversal must be able to
      // distinguish an earlier zero projection from missing history.
      lineCount++;
    }
    for (const prior of retained) {
      if (!keptIds.has(prior.id) && prior.source === "formula") {
        await tx.execute(
          sql`delete from depreciation_schedule_lines where id = ${prior.id} and org_id = ${orgId}`,
        );
      }
    }
    return { scheduleId, lineCount, skippedMonths };
  })(runner);
}

export async function buildSchedule(
  assetId: string,
  orgId: string,
  actorId: string | null,
  forBookId?: string,
): Promise<BuildScheduleResult> {
  return db.transaction((tx) => buildScheduleWithRunner(tx, assetId, orgId, actorId, forBookId));
}

/**
 * Build the depreciation schedule for every active book (multi-book). Each book
 * gets its own plan from its per-book policy, else the category/asset defaults.
 */
export async function buildAllSchedules(
  assetId: string,
  orgId: string,
  actorId: string | null,
): Promise<BuildScheduleResult[]> {
  return db.transaction((tx) => buildAllSchedulesWithRunner(tx, assetId, orgId, actorId));
}

export async function buildAllSchedulesWithRunner(
  runner: SqlExecutor,
  assetId: string,
  orgId: string,
  actorId: string | null,
): Promise<BuildScheduleResult[]> {
  const books = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_active
     order by is_primary desc, code`));
  const results: BuildScheduleResult[] = [];
  for (const b of books.rows) results.push(await buildScheduleWithRunner(runner, assetId, orgId, actorId, b.id));
  return results;
}

export interface RecordDepreciationInputArgs {
  orgId: string;
  assetId: string;
  bookId?: string;
  effectiveDate: string;
  kind: "manual" | "production_usage";
  /** Manual depreciation amount or production units, according to kind. */
  value: string;
  memo: string;
  evidenceFileId: string;
  actorId: string;
}

export interface RecordDepreciationInputResult {
  inputId: string;
  scheduleLineId: string;
  periodId: string;
  periodName: string;
  plannedAmount: string;
  replacedInputId: string | null;
}

/**
 * Record or replace one unposted manual amount / production-usage fact and
 * atomically materialize its schedule line. Posted facts remain immutable;
 * signed, separately evidenced facts provide the correction path. Both usage
 * and accumulated depreciation are bounded under schedule row locks.
 */
export async function recordDepreciationInput(
  args: RecordDepreciationInputArgs,
): Promise<RecordDepreciationInputResult> {
  const memo = args.memo.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.effectiveDate))
    throw new Error("effective date is required");
  if (!memo) throw new Error("an accounting memo is required");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      args.evidenceFileId,
    )
  ) {
    throw new Error("an attached evidence file is required");
  }
  const value = persistDepreciationInputValue(args.value);

  return db.transaction(async (tx) => {
    const selectedBookId = args.bookId ?? (await primaryBookId(tx, args.orgId));
    await tx.execute(
      sql`select id from fixed_assets where org_id=${args.orgId} and id=${args.assetId} for update`,
    );
    const calendarId = await assetDepreciationCalendar(
      tx,
      args.orgId,
      args.assetId,
      selectedBookId,
    );
    const schedule = await tx.execute<{
      id: string;
      method: DepreciationMethod;
      units_total: string | null;
      book_id: string;
      subsidiary_id: string;
      acquisition_cost: string;
      salvage_value: string;
      status: string;
      in_service_on: string;
      opening_accumulated_depreciation: string | null;
      period_id: string;
      period_name: string;
    }>(sql`
      select s.id, s.method, s.units_total, s.book_id,
             a.subsidiary_id,
             a.acquisition_cost, a.salvage_value, a.status, a.in_service_on,
             a.opening_accumulated_depreciation::text as opening_accumulated_depreciation,
             p.id as period_id, p.name as period_name
        from depreciation_schedules s
        join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
        join accounting_periods p on p.org_id = s.org_id and p.fiscal_calendar_id=${calendarId} and not p.is_adjustment
          and p.starts_on <= ${args.effectiveDate} and p.ends_on >= ${args.effectiveDate}
       where s.org_id = ${args.orgId} and s.asset_id = ${args.assetId}
         and s.book_id=${selectedBookId}
       limit 1
       for update of s, a, p`);
    const row = schedule.rows[0];
    if (!row)
      throw new Error(
        "no depreciation schedule or accounting period covers the effective date",
      );
    if (row.status !== "in_service")
      throw new Error("depreciation inputs require an in-service asset");
    if (args.effectiveDate < row.in_service_on)
      throw new Error("depreciation cannot precede the in-service date");
    // One period gate: the shared assets+GL check replaces the raw
    // period_module_is_closed projection. Recording new evidence is local
    // activity, not historical replay, so source-owned imported locks refuse
    // exactly like user locks.
    try {
      await assertPeriodModulesOpen(tx, {
        orgId: args.orgId,
        periodId: row.period_id,
        bookId: row.book_id,
        subsidiaryIds: [row.subsidiary_id],
        modules: ["assets"],
      });
    } catch (error) {
      if (error instanceof CloseError)
        throw new Error("the asset or GL period is closed");
      throw error;
    }
    const expectedMethod =
      args.kind === "manual" ? "manual" : "units_of_production";
    if (row.method !== expectedMethod)
      throw new Error(
        `schedule method is ${row.method}, not ${expectedMethod}`,
      );
    const evidence = await tx.execute(sql`
      select 1
        from files f
        join file_attachments fa on fa.org_id = f.org_id and fa.file_id = f.id
       where f.id = ${args.evidenceFileId} and f.org_id = ${args.orgId} and not f.is_inactive
         and fa.target_table = 'fixed_assets' and fa.target_id = ${args.assetId}
       limit 1`);
    if (!evidence.rows[0])
      throw new Error("evidence file must be attached to this asset");

    const source = args.kind === "manual" ? "manual" : "production_usage";
    const priorLine = await tx.execute<{
      id: string;
      posted_amount: string | null;
      input_id: string | null;
    }>(sql`
      select id, posted_amount, input_id
        from depreciation_schedule_lines
       where org_id = ${args.orgId} and schedule_id = ${row.id} and period_id = ${row.period_id}
         and source = ${source} and posted_amount is null
       order by created_at desc
       limit 1
       for update`);
    const replacedInputId = priorLine.rows[0]?.input_id ?? null;

    const totals = await tx.execute<{
      planned: string;
      used_units: string;
    }>(sql`
      select coalesce(sum(l.planned_amount), 0)::text as planned,
             coalesce(sum(i.production_units) filter (where i.voided_at is null), 0)::text as used_units
        from depreciation_schedule_lines l
        left join depreciation_inputs i on i.id = l.input_id and i.org_id = l.org_id
       where l.org_id = ${args.orgId} and l.schedule_id = ${row.id}
         ${priorLine.rows[0] ? sql`and l.id <> ${priorLine.rows[0].id}` : sql``}`);
    const basisChange = await assetBasisDelta(
      tx,
      args.orgId,
      args.assetId,
      row.book_id,
    );
    if (basisChange.cutoff && args.effectiveDate < basisChange.cutoff)
      throw new Error(
        "depreciation input cannot precede the approved asset basis change",
      );
    const currentCost = add(row.acquisition_cost, basisChange.cost),
      currentSalvage = add(row.salvage_value, basisChange.salvage);
    const valuation = (
      await tx.execute<{ delta: string; cutoff: string | null }>(
        sql`select coalesce(sum(v.amount),0)::text as delta,max(v.occurred_on)::text as cutoff from asset_events v join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id where v.org_id=${args.orgId} and v.asset_id=${args.assetId} and e.book_id=${row.book_id} and e.status='posted' and v.kind in('impaired','revalued') and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id)`,
      )
    ).rows[0]!;
    if (valuation.cutoff && args.effectiveDate < valuation.cutoff)
      throw new Error(
        "depreciation input cannot precede the retained asset valuation; correct that valuation before changing its historical inputs",
      );
    const basis =
      toUnits(add(currentCost, valuation.delta)) - toUnits(currentSalvage);
    if (basis < 0n)
      throw new Error("salvage value cannot exceed acquisition cost");
    // Continue-from-accumulated (migration 0156): evidence caps run against
    // the REMAINING basis — the opening figure already consumed part of it.
    const alreadyPlanned = add(
      totals.rows[0]?.planned ?? "0",
      add(row.opening_accumulated_depreciation ?? "0", basisChange.accumulated),
    );
    let plannedAmount: string;
    if (args.kind === "manual") {
      if (cmp(value, "0") === 0)
        throw new Error("manual depreciation must be non-zero");
      const next = toUnits(alreadyPlanned) + toUnits(value);
      if (next < 0n || next > basis) {
        throw new Error(
          "manual depreciation must keep accumulated depreciation between zero and the salvage floor",
        );
      }
      plannedAmount = value;
    } else {
      if (cmp(value, "0") === 0)
        throw new Error("production units must be non-zero");
      if (!row.units_total || cmp(row.units_total, "0") <= 0) {
        throw new Error(
          "expected lifetime production units are not configured",
        );
      }
      const valuationCutover =
        valuation.cutoff &&
        (!basisChange.cutoff || valuation.cutoff >= basisChange.cutoff)
          ? valuation.cutoff
          : null;
      const cutoff = valuationCutover ?? basisChange.cutoff;
      const cutoverTotals = cutoff
        ? (
            await tx.execute<{ planned: string; used_units: string }>(
              sql`select coalesce(sum(l.planned_amount),0)::text as planned,coalesce(sum(i.production_units),0)::text as used_units from depreciation_schedule_lines l join accounting_periods p on p.org_id=l.org_id and p.id=l.period_id left join depreciation_inputs i on i.org_id=l.org_id and i.id=l.input_id and i.voided_at is null where l.org_id=${args.orgId} and l.schedule_id=${row.id} ${valuationCutover ? sql`and p.ends_on>${cutoff}` : sql`and p.ends_on>=${cutoff}`} ${priorLine.rows[0] ? sql`and l.id<>${priorLine.rows[0].id}` : sql``}`,
            )
          ).rows[0]!
        : null;
      let lifetimeUnits = basisChange.unitsRemaining ?? row.units_total;
      let cutoverBasis = basisChange.depreciableAfter;
      if (valuationCutover) {
        const prior = (
          await tx.execute<{ planned: string; units: string }>(
            sql`select coalesce(sum(l.planned_amount),0)::text as planned,coalesce(sum(i.production_units) filter(where ${basisChange.cutoff ? sql`p.ends_on>=${basisChange.cutoff}` : sql`true`}),0)::text as units from depreciation_schedule_lines l join accounting_periods p on p.org_id=l.org_id and p.id=l.period_id left join depreciation_inputs i on i.org_id=l.org_id and i.id=l.input_id and i.voided_at is null where l.org_id=${args.orgId} and l.schedule_id=${row.id} and p.ends_on<=${valuationCutover}`,
          )
        ).rows[0]!;
        lifetimeUnits = add(lifetimeUnits, neg(prior.units));
        cutoverBasis = add(
          add(add(currentCost, valuation.delta), neg(currentSalvage)),
          neg(
            add(
              add(prior.planned, row.opening_accumulated_depreciation ?? "0"),
              basisChange.accumulated,
            ),
          ),
        );
      }
      const usedUnits =
        cutoverTotals?.used_units ?? totals.rows[0]?.used_units ?? "0";
      const nextUnits = toUnits(usedUnits) + toUnits(value);
      if (nextUnits < 0n || nextUnits > toUnits(lifetimeUnits))
        throw new Error(
          cutoff
            ? "recorded production must remain between zero and the approved remaining capacity"
            : "recorded production must remain between zero and expected lifetime units",
        );
      plannedAmount = computeUnitsOfProductionCharge({
        cost: cutoverTotals ? cutoverBasis! : currentCost,
        salvage: cutoverTotals ? "0" : currentSalvage,
        lifetimeUnits,
        periodUnits: value,
        unitsAlreadyRecorded: usedUnits,
        depreciationAlreadyPlanned: cutoverTotals?.planned ?? alreadyPlanned,
      });
    }

    if (replacedInputId) {
      await tx.execute(sql`
        update depreciation_inputs
           set voided_at = now(), voided_by = ${args.actorId}, updated_at = now(), updated_by = ${args.actorId}
         where id = ${replacedInputId} and org_id = ${args.orgId} and voided_at is null`);
    }
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into depreciation_inputs
        (org_id, schedule_id, period_id, kind, manual_amount, production_units,
         memo, evidence_file_id, supersedes_input_id, created_by, updated_by)
      values (${args.orgId}, ${row.id}, ${row.period_id}, ${args.kind},
              ${args.kind === "manual" ? value : null}, ${args.kind === "production_usage" ? value : null},
              ${memo}, ${args.evidenceFileId}, ${replacedInputId}, ${args.actorId}, ${args.actorId})
      returning id`);
    const inputId = inserted.rows[0]!.id;

    let scheduleLineId: string;
    if (priorLine.rows[0]) {
      scheduleLineId = priorLine.rows[0].id;
      await tx.execute(sql`
        update depreciation_schedule_lines
           set planned_amount = ${plannedAmount}, source = ${args.kind === "manual" ? "manual" : "production_usage"},
               input_id = ${inputId}, updated_at = now(), updated_by = ${args.actorId}
         where id = ${scheduleLineId} and org_id = ${args.orgId} and posted_amount is null`);
    } else {
      const line = await tx.execute<{ id: string }>(sql`
        insert into depreciation_schedule_lines
          (org_id, schedule_id, period_id, sequence, planned_amount, source, input_id, created_by, updated_by)
        values (${args.orgId}, ${row.id}, ${row.period_id},
                (select coalesce(max(sequence), -1) + 1 from depreciation_schedule_lines where org_id = ${args.orgId} and schedule_id = ${row.id}),
                ${plannedAmount}, ${args.kind === "manual" ? "manual" : "production_usage"},
                ${inputId}, ${args.actorId}, ${args.actorId})
        returning id`);
      scheduleLineId = line.rows[0]!.id;
    }

    return {
      inputId,
      scheduleLineId,
      periodId: row.period_id,
      periodName: row.period_name,
      plannedAmount,
      replacedInputId,
    };
  });
}

// ---------------------------------------------------------------------------
// runDepreciation — recognize due periods in each accounting book
// ---------------------------------------------------------------------------

export interface NextDueDepreciation {
  assetNumber: string;
  period: string;
  endsOn: string;
  amount: string;
}

export interface RunDepreciationResult {
  /** Number of GL journal entries posted. */
  posted: number;
  /** Number of reporting-only book lines recognized without a GL entry. */
  recorded: number;
  recordedAmount: string;
  skipped: number;
  totalAmount: string;
  entries: { assetNumber: string; period: string; amount: string; entryId: string }[];
  problems: string[];
  /** The as-of date the run evaluated (defaults to the org business day). */
  asOfDate: string;
  /** Earliest unrecognized line in scope when nothing was recognized, else null. */
  nextDue: NextDueDepreciation | null;
}

/** Keep the lifecycle state aligned with the current primary-book carrying value. */
export async function reconcileAssetDepreciationStatusWithRunner(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  assetId?: string,
  allowedSubsidiaryIds?: readonly string[],
): Promise<void> {
  // Obtain a fresh carrying-value snapshot after any competing lifecycle write.
  // The caller keeps these locks through its financial transaction.
  await runner.execute(sql`
    select id from fixed_assets
     where org_id = ${orgId} and status in ('in_service', 'fully_depreciated')
       ${allowedSubsidiaryIds ? sql`and subsidiary_id = any(${uuidArray(allowedSubsidiaryIds)}::uuid[])` : sql``}
       ${assetId ? sql`and id = ${assetId}` : sql``}
     order by id for update`);
  await runner.execute(sql`
    with carrying as materialized (
      select a.id, a.status as previous_status, book.id as book_id,
             carrying_values.carrying_value as amount,
             carrying_values.salvage as salvage_value
        from fixed_assets a
        join accounting_books book on book.org_id = a.org_id and book.is_primary and book.is_active and book.posts_gl
        join asset_book_carrying_values carrying_values on carrying_values.org_id=a.org_id and carrying_values.asset_id=a.id and carrying_values.book_id=book.id
       where a.org_id = ${orgId} and a.status in ('in_service', 'fully_depreciated')
         ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${uuidArray(allowedSubsidiaryIds)}::uuid[])` : sql``}
         ${assetId ? sql`and a.id = ${assetId}` : sql``}
    ), changed as (
    update fixed_assets asset
       set status = case when carrying.amount <= carrying.salvage_value then 'fully_depreciated' else 'in_service' end,
           updated_at = now(), updated_by = ${actorId}
      from carrying
     where asset.org_id = ${orgId} and asset.id = carrying.id
       and asset.status <> case when carrying.amount <= carrying.salvage_value then 'fully_depreciated' else 'in_service' end
    returning asset.id, carrying.previous_status, asset.status, carrying.amount, carrying.salvage_value, carrying.book_id
    )
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    select ${orgId}, 'fixed_assets', id, 'update', jsonb_build_object(
      'before', jsonb_build_object('status', previous_status),
      'after', jsonb_build_object('status', status),
      'reason', 'Reconcile asset lifecycle with primary-book carrying value',
      'bookId', book_id, 'carryingValue', amount::text, 'salvageValue', salvage_value::text
    ), ${actorId} from changed`);
}

/**
 * Recognize every due depreciation line through `asOfDate`. Posting books use
 * the kernel draft→lines→posted journal; reporting-only books freeze the same
 * subledger measurement with database-audited non-GL evidence. Both honor the
 * book's assets/GL close controls. The posted_amount claim makes either path
 * idempotent, including zero amounts. When nothing is recognized, name the
 * as-of date and next due line rather than returning unexplained zeroes.
 */
export async function runDepreciation(
  orgId: string,
  asOfDate: string,
  actorId: string | null,
  assetId?: string,
  allowedSubsidiaryIds?: string[],
  bookId?: string,
): Promise<RunDepreciationResult> {
  const result: RunDepreciationResult = {
    posted: 0,
    recorded: 0,
    recordedAmount: "0",
    skipped: 0,
    totalAmount: "0",
    entries: [],
    problems: [],
    asOfDate,
    nextDue: null,
  };

  // Schedules project only months whose accounting periods exist; later
  // months are future gaps the builder leaves to be "mapped when their
  // periods are created" — but no other path rebuilds them, so a run after
  // month-end rollover would find no line and report "nothing due" while an
  // open period accrues. Extend each stale in-scope formula schedule first.
  // Extension is best-effort: a schedule that cannot extend keeps its lines
  // and the reason lands in problems, never a fatal error.
  const stale = (await db.execute<{
    asset_id: string;
    book_id: string;
    asset_number: string;
  }>(sql`
    select distinct s.asset_id, s.book_id, a.asset_number
      from depreciation_schedules s
      join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
      join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_active
     where s.org_id = ${orgId}
       and a.status not in ('disposed', 'written_off')
       and (s.method not in ('manual', 'units_of_production') or s.depreciation_method_id is not null)
       ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${uuidArray(allowedSubsidiaryIds)}::uuid[])` : sql``}
       ${assetId ? sql`and a.id = ${assetId}` : sql``}
       ${bookId ? sql`and s.book_id = ${bookId}` : sql``}
       and exists (
         select 1 from accounting_periods p
          where p.org_id = s.org_id and not p.is_adjustment
            and p.ends_on > coalesce((
              select max(pp.ends_on)
                from depreciation_schedule_lines l
                join accounting_periods pp on pp.id = l.period_id and pp.org_id = l.org_id
               where l.org_id = s.org_id and l.schedule_id = s.id
            ), date '0001-01-01')
       )`));
  for (const s of stale.rows) {
    try {
      await buildSchedule(s.asset_id, orgId, actorId, s.book_id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.problems.push(`${s.asset_number}: schedule extension skipped (${msg.slice(0, 120)})`);
    }
  }

  // Due, unposted lines are only a candidate list. Account, dimension, and
  // other posting fields are reloaded under locks inside each line transaction.
  const due = (await db.execute<{
    line_id: string;
    asset_id: string;
    asset_number: string;
    period_name: string;
  }>(sql`
    select l.id as line_id, a.id as asset_id,
           a.asset_number, p.name as period_name
      from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
      join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_active
      join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
      join subsidiaries sub on sub.id = a.subsidiary_id and sub.org_id = a.org_id
      join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
      join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
     where l.org_id = ${orgId}
       and l.posted_amount is null
       and a.status not in ('disposed', 'written_off')
       and p.ends_on <= ${asOfDate}
       ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
       ${assetId ? sql`and a.id = ${assetId}` : sql``}
       ${bookId ? sql`and s.book_id = ${bookId}` : sql``}
     order by a.asset_number, l.sequence`));

  for (const row of due.rows) {
    try {
      const posted = await db.transaction(async (tx) => withTransactionSavepoint(tx, async () => {
        // Serialize against the authoritative asset edit path before reading
        // any account or dimension-bearing fields. The due query above is only
        // a candidate list; every posting input is reloaded after this lock.
        const assetLock = (await tx.execute<{ category_id: string; subsidiary_id: string }>(sql`
          select category_id, subsidiary_id
            from fixed_assets
           where id = ${row.asset_id} and org_id = ${orgId}
           for update`));
        const assetKey = assetLock.rows[0];
        if (!assetKey) return null;

        // Category account defaults are another authoritative source. Lock it
        // before resolving native asset overrides so a concurrent category edit
        // cannot be mixed with this asset snapshot.
        const categoryLock = (await tx.execute<{ id: string }>(sql`
          select id from asset_categories
           where id = ${assetKey.category_id} and org_id = ${orgId}
           for update`));
        if (!categoryLock.rows[0]) throw new Error("asset category not found");

        // Restriction validation depends on the complete subsidiary tree. Lock
        // that tree before loading it so parent/active-state edits cannot race
        // the account and dimension checks below.
        await tx.execute(sql`
          select id from subsidiaries
           where org_id = ${orgId}
           order by id
           for update`);

        // Claim the schedule line inside the posting transaction. Concurrent
        // runners serialize here and the loser observes posted_amount. The
        // asset/category/subsidiary locks above ensure every selected field is
        // the current committed configuration for this posting.
        const claim = (await tx.execute<{
          line_id: string;
          planned_amount: string;
          period_id: string;
          book_id: string;
          posts_gl: boolean;
          period_name: string;
          period_ends_on: string;
          asset_id: string;
          subsidiary_id: string;
          base_currency: string;
          asset_number: string;
          asset_name: string;
          asset_account: string | null;
          asset_accum: string | null;
          asset_expense: string | null;
          department_id: string | null;
          project_id: string | null;
          location_id: string | null;
          cat_asset: string;
          cat_accum: string;
          cat_expense: string;
        }>(sql`
          select l.id as line_id,
                 l.planned_amount,
                 l.period_id,
                 s.book_id,
                 bk.posts_gl,
                 p.name as period_name,
                 p.ends_on as period_ends_on,
                 a.id as asset_id,
                 a.subsidiary_id,
                 sub.base_currency,
                 a.asset_number,
                 a.name as asset_name,
                 a.asset_account_id as asset_account,
                 a.accumulated_depreciation_account_id as asset_accum,
                 a.depreciation_expense_account_id as asset_expense,
                 a.department_id,
                 a.project_id,
                 a.location_id,
                 c.asset_account_id as cat_asset,
                 c.accumulated_depreciation_account_id as cat_accum,
                 c.depreciation_expense_account_id as cat_expense
            from depreciation_schedule_lines l
            join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
            join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_active
            join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
            join subsidiaries sub on sub.id = a.subsidiary_id and sub.org_id = a.org_id
            join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
            join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
           where l.id = ${row.line_id}
             and l.org_id = ${orgId}
             and l.posted_amount is null
             and a.status not in ('disposed', 'written_off')
             and p.ends_on <= ${asOfDate}
             ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
           for update of l for share of bk`));
        const claimed = claim.rows[0];
        if (!claimed) return null;

        // Use the existing shared posting fence before the close check. A
        // reporting-only recognition must serialize with close even though
        // it will never reach je_guard. The storage guard takes it too.
        await tx.execute(sql`select period_posting_fence(${orgId}, ${claimed.period_id}, ${claimed.book_id})`);
        // One period gate: the shared assets+GL check replaces the raw
        // period_module_is_closed projection. Discovery stays advisory — a
        // closed line is skipped, not fatal — and source-owned imported
        // locks skip exactly like user locks.
        if (!(await arePeriodModulesOpen(tx, {
          orgId,
          periodId: claimed.period_id,
          bookId: claimed.book_id,
          subsidiaryIds: [claimed.subsidiary_id],
          modules: ["assets"],
        }))) {
          return {
            entryId: null,
            amount: String(claimed.planned_amount),
            periodClosed: true,
            assetNumber: claimed.asset_number,
            periodName: claimed.period_name,
          };
        }

        const accounts = resolveAssetAccounts(
          {
            assetAccountId: claimed.asset_account,
            accumulatedDepreciationAccountId: claimed.asset_accum,
            depreciationExpenseAccountId: claimed.asset_expense,
          },
          {
            assetAccountId: claimed.cat_asset,
            accumulatedDepreciationAccountId: claimed.cat_accum,
            depreciationExpenseAccountId: claimed.cat_expense,
          },
        );

        // Lock every account and dimension that will be validated/read by the
        // journal insert. Their rows may carry subsidiary restrictions, so the
        // validation below must run after these locks on this same snapshot.
        const accountIds = [...new Set([
          accounts.assetAccountId,
          accounts.accumulatedDepreciationAccountId,
          accounts.depreciationExpenseAccountId,
        ])];
        await tx.execute(sql`
          select id from accounts
           where org_id = ${orgId}
             and id in (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
           order by id
           for update`);

        const dimensions = [
          { table: "departments", id: claimed.department_id },
          { table: "projects", id: claimed.project_id },
          { table: "locations", id: claimed.location_id },
        ] as const;
        for (const dimension of dimensions) {
          if (!dimension.id) continue;
          await tx.execute(sql`
            select id from ${sql.raw(dimension.table)}
             where org_id = ${orgId} and id = ${dimension.id}
             for update`);
        }

        const subsidiaryContext = await loadSubsidiaryContext(tx, orgId);
        const planned = String(claimed.planned_amount);
        const lines = [
          { accountId: accounts.depreciationExpenseAccountId, amount: planned },
          { accountId: accounts.accumulatedDepreciationAccountId, amount: neg(planned) },
        ];
        await validateSubsidiaryRestrictions(tx, {
          orgId,
          ctx: subsidiaryContext,
          docSubsidiaryId: claimed.subsidiary_id,
          lines: lines.map((line) => ({
            ...line,
            subsidiaryId: claimed.subsidiary_id,
            departmentId: claimed.department_id,
            projectId: claimed.project_id,
            locationId: claimed.location_id,
          })),
        });
        assertFinalKernelBalance(lines.map((line) => ({ amount: line.amount, subsidiaryId: claimed.subsidiary_id })));
        if (!claimed.posts_gl || isZero(planned)) {
          // The database validates the book and close policy, freezes the
          // non-GL timestamp and writes immutable before/after audit evidence.
          // Do not manufacture a journal merely to complete the subledger.
          const recorded = await tx.execute<{ id: string }>(sql`
            update depreciation_schedule_lines
               set posted_amount = ${planned},
                   non_gl_recognized_at = ${claimed.posts_gl ? sql`null` : sql`clock_timestamp()`},
                   updated_at = now(), updated_by = ${actorId}
             where id = ${row.line_id} and org_id = ${orgId} and posted_amount is null
             returning id`);
          if (recorded.rows.length !== 1) throw new Error("depreciation recognition did not record the claimed line; reload the schedule and retry");
          return {
            entryId: null,
            recorded: !claimed.posts_gl,
            amount: planned,
            assetNumber: claimed.asset_number,
            periodName: claimed.period_name,
          };
        }

        // Corrections create another line for the same asset and period, so the
        // schedule-line id distinguishes every physical journal generation.
        const entryRes = (await tx.execute<{ id: string }>(sql`
          insert into journal_entries
            (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
          values (${orgId}, ${claimed.book_id}, ${claimed.subsidiary_id},
                  ${`DEP-${claimed.asset_number}-${claimed.period_name}-${claimed.line_id}`},
                  ${claimed.period_ends_on}, ${claimed.period_id},
                  ${`Depreciation — ${claimed.asset_name} (${claimed.period_name})`},
                  'draft', 'depreciation', ${actorId}, ${actorId})
          returning id`));
        const eid = entryRes.rows[0]!.id;

        for (let i = 0; i < lines.length; i++) {
          const l = lines[i]!;
          await tx.execute(sql`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
               department_id, project_id, location_id, memo)
            values (${orgId}, ${eid}, ${i + 1}, ${l.accountId}, ${claimed.subsidiary_id}, ${l.amount}, ${claimed.base_currency}, ${l.amount}, 1,
                    ${claimed.department_id}, ${claimed.project_id}, ${claimed.location_id},
                    ${`Depreciation ${claimed.period_name}`})`);
        }

        await tx.execute(sql`
          update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId}
           where id = ${eid} and org_id = ${orgId}`);

        await tx.execute(sql`
          update depreciation_schedule_lines
             set posted_amount = ${planned}, journal_entry_id = ${eid}, updated_at = now(), updated_by = ${actorId}
           where id = ${row.line_id} and org_id = ${orgId}`);

        return {
          entryId: eid,
          amount: planned,
          assetNumber: claimed.asset_number,
          periodName: claimed.period_name,
        };
      }));

      if (!posted) {
        result.skipped++;
        continue;
      }
      if (posted.periodClosed) {
        result.skipped++;
        result.problems.push(`${posted.assetNumber} ${posted.periodName}: GL period closed`);
        continue;
      }
      if ("recorded" in posted && posted.recorded) {
        result.recorded++;
        result.recordedAmount = add(result.recordedAmount, posted.amount);
        continue;
      }
      if (!posted.entryId) {
        result.skipped++;
        continue;
      }
      result.posted++;
      result.totalAmount = add(result.totalAmount, posted.amount);
      result.entries.push({
        assetNumber: posted.assetNumber,
        period: posted.periodName,
        amount: posted.amount,
        entryId: posted.entryId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.problems.push(`${row.asset_number} ${row.period_name}: ${msg.slice(0, 120)}`);
    }
  }

  // A run that posts nothing must still say what it ran for and what is
  // next: a mid-period run otherwise answers all-zero counters with an empty
  // problems list while a planned line waits in the open period (F-t07-005).
  // Same scope as the due list above, minus the ended-period filter.
  if (result.posted === 0 && result.recorded === 0) {
    const next = (await db.execute<{
      asset_number: string;
      period_name: string;
      ends_on: string;
      amount: string;
    }>(sql`
      select a.asset_number, p.name as period_name, p.ends_on::text as ends_on,
             l.planned_amount::text as amount
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
        join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_active
        join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
        join subsidiaries sub on sub.id = a.subsidiary_id and sub.org_id = a.org_id
        join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
        join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
       where l.org_id = ${orgId}
         and l.posted_amount is null
         and a.status not in ('disposed', 'written_off')
         ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
         ${assetId ? sql`and a.id = ${assetId}` : sql``}
         ${bookId ? sql`and s.book_id = ${bookId}` : sql``}
       order by p.ends_on, a.asset_number, l.sequence
       limit 1`));
    const upcoming = next.rows[0];
    if (upcoming) {
      result.nextDue = {
        assetNumber: upcoming.asset_number,
        period: upcoming.period_name,
        endsOn: upcoming.ends_on,
        amount: upcoming.amount,
      };
    }
  }

  await db.transaction(tx => reconcileAssetDepreciationStatusWithRunner(tx, orgId, actorId, assetId, allowedSubsidiaryIds));

  return result;
}

/** Sort helper re-export (kept local so callers don't import money directly). */
export { cmp as compareMoney };
