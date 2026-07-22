import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, fromUnits, isZero, mulRatio, neg, normalizeMoney, toUnits } from "./money.ts";
import { BUILTIN_FORMULAS, computeScheduleByFormula, exactRatio } from "./depreciation-formula.ts";
import { assertFinalKernelBalance } from "./posting.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions } from "./subsidiaries.ts";

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
  /** First-period convention: full_month (default), or mid_month / half_year
   *  which prorate the first period (and extend the schedule by one). */
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
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/**
 * Compute the monthly depreciation plan for an asset. Every method depreciates
 * from the in-service month forward, one entry per calendar month, and never
 * takes NBV below salvage — the final month absorbs any rounding remainder so
 * total lifetime depreciation is exactly (cost − salvage).
 */
export function computeSchedule(input: ScheduleInput): ScheduleLinePlan[] {
  const life = Math.max(1, Math.trunc(input.lifeMonths));
  const { formula, rateTable } = formulaForMethod(input.method, input.ratePercent, life);
  const firstPeriodFraction =
    input.convention === "mid_month" || input.convention === "half_year" ? "0.5" : "1";
  const rows = computeScheduleByFormula({
    cost: input.cost,
    salvage: input.salvage,
    lifePeriods: life,
    formula,
    rateTable,
    firstPeriodFraction,
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
async function primaryBookId(runner: any, orgId: string): Promise<string> {
  const result = (await runner.execute(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary limit 1`)) as unknown as {
    rows: { id: string }[];
  };
  if (!result.rows[0]) throw new Error("no primary accounting book");
  return result.rows[0].id;
}

/** Resolve the (non-adjustment) accounting period covering a date, or null. */
async function periodForDate(runner: any, orgId: string, date: string): Promise<string | null> {
  const res = (await runner.execute(sql`
    select id from accounting_periods
     where org_id = ${orgId} and is_adjustment = false
       and starts_on <= ${date} and ends_on >= ${date}
     limit 1`)) as unknown as { rows: { id: string }[] };
  return res.rows[0]?.id ?? null;
}

export interface BuildScheduleResult {
  scheduleId: string;
  lineCount: number;
  /** months that had no accounting period and were skipped */
  skippedMonths: string[];
}

/**
 * (Re)build the primary-book depreciation schedule for an asset from its
 * current cost / salvage / in-service / life / method. Any existing schedule
 * lines that have NOT yet posted are replaced; posted lines are preserved so a
 * rebuild after some periods have run never disturbs history.
 *
 * Called from the asset save path and by "Run depreciation".
 */
async function buildScheduleWithRunner(
  runner: any,
  assetId: string,
  orgId: string,
  actorId: string | null,
  forBookId?: string,
): Promise<BuildScheduleResult> {
  const assetRes = (await runner.execute(sql`
    select id, org_id, category_id, in_service_on, acquisition_cost, salvage_value,
           depreciation_method, depreciation_method_id, useful_life_months, depreciation_rate_percent,
           depreciation_convention, depreciation_units_total
      from fixed_assets where id = ${assetId} and org_id = ${orgId}`)) as unknown as {
    rows: {
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
    }[];
  };
  const asset = assetRes.rows[0];
  if (!asset) throw new Error("asset not found");
  if (!asset.in_service_on) throw new Error("asset has no in-service date");

  const catRes = (await runner.execute(sql`
    select default_method, default_depreciation_method_id, default_life_months, default_convention
      from asset_categories where id = ${asset.category_id} and org_id = ${orgId}`)) as unknown as {
    rows: { default_method: DepreciationMethod; default_depreciation_method_id: string | null; default_life_months: number | null; default_convention: string | null }[];
  };
  const category = catRes.rows[0];
  if (!category) throw new Error("asset category not found");

  const bookId = forBookId ?? (await primaryBookId(runner, orgId));

  // Multi-book: a per-book policy for this category overrides the method / life /
  // rate / convention on this book; else the asset custom + category defaults.
  const policyRes = (await runner.execute(sql`
    select method, depreciation_method_id, life_months, rate_percent, units_total, convention from depreciation_book_policies
     where org_id = ${orgId} and book_id = ${bookId} and category_id = ${asset.category_id} limit 1`)) as unknown as {
    rows: { method: DepreciationMethod; depreciation_method_id: string | null; life_months: number | null; rate_percent: string | null; units_total: string | null; convention: string | null }[];
  };
  const pol = policyRes.rows[0];
  const method: DepreciationMethod = pol?.method ?? asset.depreciation_method ?? category.default_method ?? "straight_line";
  const depreciationMethodId = pol
    ? pol.depreciation_method_id
    : (asset.depreciation_method_id || asset.depreciation_method)
      ? asset.depreciation_method_id
      : category.default_depreciation_method_id;
  const lifeMonths: number = Number(pol?.life_months ?? asset.useful_life_months ?? category.default_life_months ?? 0);
  const ratePercent: string | null =
    pol?.rate_percent != null ? String(pol.rate_percent) : asset.depreciation_rate_percent;
  const unitsTotal: string | null = pol?.units_total != null ? String(pol.units_total) : asset.depreciation_units_total;
  const convention = (pol?.convention ?? asset.depreciation_convention ?? category.default_convention ?? null) as ScheduleInput["convention"];
  if ((depreciationMethodId || (method !== "manual" && method !== "units_of_production")) && (!lifeMonths || lifeMonths <= 0)) {
    throw new Error("asset has no useful life (months)");
  }
  if (method === "units_of_production" && (unitsTotal == null || cmp(unitsTotal, "0") <= 0)) {
    throw new Error("units-of-production depreciation requires positive expected lifetime units");
  }

  // A user-authored method is a real FK, not a string that can accidentally
  // collide with a built-in. A stale/deactivated reference fails closed.
  const custom2 = (await runner.execute(sql`
    select id, formula, end_of_life from depreciation_methods
     where org_id = ${orgId} and id = ${depreciationMethodId} and is_active limit 1`)) as unknown as {
    rows: { id: string; formula: string; end_of_life: "fully_depreciate" | "retain_balance" }[];
  };
  if (depreciationMethodId && !custom2.rows[0]) throw new Error("configured depreciation formula is inactive or unavailable");
  const firstPeriodFraction = convention === "mid_month" || convention === "half_year" ? "0.5" : "1";

  let plan: ScheduleLinePlan[] = [];
  if (custom2.rows[0]) {
    const start = monthStart(asset.in_service_on);
    plan = computeScheduleByFormula({
      cost: asset.acquisition_cost,
      salvage: asset.salvage_value,
      lifePeriods: Math.max(1, Math.trunc(lifeMonths)),
      formula: custom2.rows[0].formula,
      endOfLife: custom2.rows[0].end_of_life,
      firstPeriodFraction,
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

  return await (async (tx: any) => {
    // find (or create) the primary-book schedule for this asset
    const existing = (await tx.execute(sql`
      select id, method, depreciation_method_id from depreciation_schedules
       where asset_id = ${assetId} and org_id = ${orgId} and book_id = ${bookId} limit 1`)) as unknown as {
      rows: { id: string; method: DepreciationMethod; depreciation_method_id: string | null }[];
    };
    let scheduleId: string;
    if (existing.rows[0]) {
      scheduleId = existing.rows[0].id;
      if (existing.rows[0].method !== method || existing.rows[0].depreciation_method_id !== depreciationMethodId) {
        const evidence = (await tx.execute(sql`
          select 1 from depreciation_schedule_lines
           where schedule_id = ${scheduleId} and source <> 'formula'
           limit 1 for update`)) as unknown as { rows: unknown[] };
        if (evidence.rows[0]) {
          throw new Error("depreciation method cannot change after manual or production evidence exists");
        }
      }
      await tx.execute(sql`
        update depreciation_schedules
           set method = ${method}, depreciation_method_id = ${depreciationMethodId}, life_months = ${lifeMonths || null},
               rate_percent = ${ratePercent}, units_total = ${unitsTotal}, updated_at = now(), updated_by = ${actorId}
         where id = ${scheduleId}`);
    } else {
      const ins = (await tx.execute(sql`
        insert into depreciation_schedules (org_id, asset_id, book_id, method, depreciation_method_id, life_months, rate_percent, units_total, created_by, updated_by)
        values (${orgId}, ${assetId}, ${bookId}, ${method}, ${depreciationMethodId}, ${lifeMonths || null}, ${ratePercent}, ${unitsTotal}, ${actorId}, ${actorId})
        returning id`)) as unknown as { rows: { id: string }[] };
      scheduleId = ins.rows[0].id;
    }

    // preserve posted lines; drop only the unposted plan and rewrite it
    const posted = (await tx.execute(sql`
      select period_id from depreciation_schedule_lines
       where schedule_id = ${scheduleId} and posted_amount is not null`)) as unknown as {
      rows: { period_id: string }[];
    };
    const postedPeriods = new Set(posted.rows.map((r) => r.period_id));

    if (depreciationMethodId || (method !== "manual" && method !== "units_of_production")) {
      await tx.execute(sql`
        delete from depreciation_schedule_lines
         where schedule_id = ${scheduleId} and posted_amount is null and source = 'formula'`);
    }

    const skippedMonths: string[] = [];
    let lineCount = 0;
    for (const p of plan) {
      const periodId = await periodForDate(tx, orgId, p.periodMonth);
      if (!periodId) {
        skippedMonths.push(p.periodMonth);
        continue;
      }
      if (postedPeriods.has(periodId)) continue; // already posted — keep as is
      await tx.execute(sql`
        insert into depreciation_schedule_lines
          (org_id, schedule_id, period_id, sequence, planned_amount, source, created_by, updated_by)
        values (${orgId}, ${scheduleId}, ${periodId}, ${p.sequence}, ${p.planned}, 'formula', ${actorId}, ${actorId})`);
      lineCount++;
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
  runner: any,
  assetId: string,
  orgId: string,
  actorId: string | null,
): Promise<BuildScheduleResult[]> {
  const books = (await runner.execute(sql`
    select id from accounting_books where org_id = ${orgId} and is_active
     order by is_primary desc, code`)) as unknown as { rows: { id: string }[] };
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.effectiveDate)) throw new Error("effective date is required");
  if (!memo) throw new Error("an accounting memo is required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.evidenceFileId)) {
    throw new Error("an attached evidence file is required");
  }
  const value = normalizeMoney(args.value);

  return db.transaction(async (tx) => {
    const schedule = (await tx.execute(sql`
      select s.id, s.method, s.units_total, s.book_id,
             a.acquisition_cost, a.salvage_value, a.status, a.in_service_on,
             p.id as period_id, p.name as period_name,
             (period_module_is_closed(${args.orgId}, p.id, s.book_id, a.subsidiary_id, 'assets')
               or period_module_is_closed(${args.orgId}, p.id, s.book_id, a.subsidiary_id, 'gl')) as period_closed
        from depreciation_schedules s
        join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
        join accounting_periods p on p.org_id = s.org_id and not p.is_adjustment
          and p.starts_on <= ${args.effectiveDate} and p.ends_on >= ${args.effectiveDate}
       where s.org_id = ${args.orgId} and s.asset_id = ${args.assetId}
         ${args.bookId ? sql`and s.book_id = ${args.bookId}` : sql`and s.book_id = (select id from accounting_books where org_id = ${args.orgId} and is_primary limit 1)`}
       limit 1
       for update of s, a, p`)) as unknown as {
      rows: {
        id: string;
        method: DepreciationMethod;
        units_total: string | null;
        book_id: string;
        acquisition_cost: string;
        salvage_value: string;
        status: string;
        in_service_on: string;
        period_id: string;
        period_name: string;
        period_closed: boolean;
      }[];
    };
    const row = schedule.rows[0];
    if (!row) throw new Error("no depreciation schedule or accounting period covers the effective date");
    if (row.status !== "in_service") throw new Error("depreciation inputs require an in-service asset");
    if (args.effectiveDate < row.in_service_on) throw new Error("depreciation cannot precede the in-service date");
    if (row.period_closed) throw new Error("the asset or GL period is closed");
    const expectedMethod = args.kind === "manual" ? "manual" : "units_of_production";
    if (row.method !== expectedMethod) throw new Error(`schedule method is ${row.method}, not ${expectedMethod}`);
    const evidence = (await tx.execute(sql`
      select 1
        from files f
        join file_attachments fa on fa.org_id = f.org_id and fa.file_id = f.id
       where f.id = ${args.evidenceFileId} and f.org_id = ${args.orgId} and not f.is_inactive
         and fa.target_table = 'fixed_assets' and fa.target_id = ${args.assetId}
       limit 1`)) as unknown as { rows: unknown[] };
    if (!evidence.rows[0]) throw new Error("evidence file must be attached to this asset");

    const source = args.kind === "manual" ? "manual" : "production_usage";
    const priorLine = (await tx.execute(sql`
      select id, posted_amount, input_id
        from depreciation_schedule_lines
       where org_id = ${args.orgId} and schedule_id = ${row.id} and period_id = ${row.period_id}
         and source = ${source} and posted_amount is null
       order by created_at desc
       limit 1
       for update`)) as unknown as { rows: { id: string; posted_amount: string | null; input_id: string | null }[] };
    const replacedInputId = priorLine.rows[0]?.input_id ?? null;

    const totals = (await tx.execute(sql`
      select coalesce(sum(l.planned_amount), 0)::text as planned,
             coalesce(sum(i.production_units) filter (where i.voided_at is null), 0)::text as used_units
        from depreciation_schedule_lines l
        left join depreciation_inputs i on i.id = l.input_id
       where l.org_id = ${args.orgId} and l.schedule_id = ${row.id}
         ${priorLine.rows[0] ? sql`and l.id <> ${priorLine.rows[0].id}` : sql``}`)) as unknown as {
      rows: { planned: string; used_units: string }[];
    };
    const basis = toUnits(row.acquisition_cost) - toUnits(row.salvage_value);
    if (basis < 0n) throw new Error("salvage value cannot exceed acquisition cost");
    const alreadyPlanned = totals.rows[0]?.planned ?? "0";
    let plannedAmount: string;
    if (args.kind === "manual") {
      if (cmp(value, "0") === 0) throw new Error("manual depreciation must be non-zero");
      const next = toUnits(alreadyPlanned) + toUnits(value);
      if (next < 0n || next > basis) {
        throw new Error("manual depreciation must keep accumulated depreciation between zero and the salvage floor");
      }
      plannedAmount = value;
    } else {
      if (cmp(value, "0") === 0) throw new Error("production units must be non-zero");
      if (!row.units_total || cmp(row.units_total, "0") <= 0) {
        throw new Error("expected lifetime production units are not configured");
      }
      const usedUnits = totals.rows[0]?.used_units ?? "0";
      const nextUnits = toUnits(usedUnits) + toUnits(value);
      if (nextUnits < 0n || nextUnits > toUnits(row.units_total)) {
        throw new Error("recorded production must remain between zero and expected lifetime units");
      }
      plannedAmount = computeUnitsOfProductionCharge({
        cost: row.acquisition_cost,
        salvage: row.salvage_value,
        lifetimeUnits: row.units_total,
        periodUnits: value,
        unitsAlreadyRecorded: usedUnits,
        depreciationAlreadyPlanned: alreadyPlanned,
      });
    }

    if (replacedInputId) {
      await tx.execute(sql`
        update depreciation_inputs
           set voided_at = now(), voided_by = ${args.actorId}, updated_at = now(), updated_by = ${args.actorId}
         where id = ${replacedInputId} and voided_at is null`);
    }
    const inserted = (await tx.execute(sql`
      insert into depreciation_inputs
        (org_id, schedule_id, period_id, kind, manual_amount, production_units,
         memo, evidence_file_id, supersedes_input_id, created_by, updated_by)
      values (${args.orgId}, ${row.id}, ${row.period_id}, ${args.kind},
              ${args.kind === "manual" ? value : null}, ${args.kind === "production_usage" ? value : null},
              ${memo}, ${args.evidenceFileId}, ${replacedInputId}, ${args.actorId}, ${args.actorId})
      returning id`)) as unknown as { rows: { id: string }[] };
    const inputId = inserted.rows[0]!.id;

    let scheduleLineId: string;
    if (priorLine.rows[0]) {
      scheduleLineId = priorLine.rows[0].id;
      await tx.execute(sql`
        update depreciation_schedule_lines
           set planned_amount = ${plannedAmount}, source = ${args.kind === "manual" ? "manual" : "production_usage"},
               input_id = ${inputId}, updated_at = now(), updated_by = ${args.actorId}
         where id = ${scheduleLineId} and posted_amount is null`);
    } else {
      const line = (await tx.execute(sql`
        insert into depreciation_schedule_lines
          (org_id, schedule_id, period_id, sequence, planned_amount, source, input_id, created_by, updated_by)
        values (${args.orgId}, ${row.id}, ${row.period_id},
                (select coalesce(max(sequence), -1) + 1 from depreciation_schedule_lines where schedule_id = ${row.id}),
                ${plannedAmount}, ${args.kind === "manual" ? "manual" : "production_usage"},
                ${inputId}, ${args.actorId}, ${args.actorId})
        returning id`)) as unknown as { rows: { id: string }[] };
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
// runDepreciation — post due periods through the kernel
// ---------------------------------------------------------------------------

export interface RunDepreciationResult {
  posted: number;
  skipped: number;
  totalAmount: string;
  entries: { assetNumber: string; period: string; amount: string; entryId: string }[];
  problems: string[];
}

/**
 * Post every due, unposted depreciation line whose period ends on or before
 * `asOfDate`. Each line becomes one balanced journal entry (DR expense / CR
 * accumulated) posted through the kernel draft→lines→posted, origin =
 * 'depreciation'. A closed GL period is skipped (not an error). Idempotent:
 * a line with a journal_entry_id is never reconsidered.
 */
export async function runDepreciation(
  orgId: string,
  asOfDate: string,
  actorId: string | null,
  assetId?: string,
  allowedSubsidiaryIds?: string[],
  bookId?: string,
): Promise<RunDepreciationResult> {
  const subsidiaryContext = await loadSubsidiaryContext(db, orgId);

  // Due, unposted lines with their asset + resolved accounts + period window.
  const due = (await db.execute(sql`
    select l.id            as line_id,
           l.planned_amount as planned,
           l.sequence      as sequence,
           l.period_id     as period_id,
           s.book_id       as book_id,
           p.name          as period_name,
           p.ends_on       as period_ends_on,
           (period_module_is_closed(${orgId}, p.id, s.book_id, a.subsidiary_id, 'assets')
             or period_module_is_closed(${orgId}, p.id, s.book_id, a.subsidiary_id, 'gl')) as period_closed,
           a.id            as asset_id,
           a.subsidiary_id as subsidiary_id,
           sub.base_currency as base_currency,
           a.asset_number  as asset_number,
           a.name          as asset_name,
           a.asset_account_id as asset_account,
           a.accumulated_depreciation_account_id as asset_accum,
           a.depreciation_expense_account_id as asset_expense,
           a.department_id as department_id,
           a.project_id    as project_id,
           a.location_id   as location_id,
           c.asset_account_id                    as cat_asset,
           c.accumulated_depreciation_account_id as cat_accum,
           c.depreciation_expense_account_id     as cat_expense
      from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id
      join accounting_books bk on bk.id = s.book_id and bk.posts_gl and bk.is_active
      join fixed_assets a on a.id = s.asset_id
      join subsidiaries sub on sub.id = a.subsidiary_id
      join asset_categories c on c.id = a.category_id
      join accounting_periods p on p.id = l.period_id
     where l.org_id = ${orgId}
       and l.posted_amount is null
       and a.status not in ('disposed', 'written_off')
       and p.ends_on <= ${asOfDate}
       ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
       ${assetId ? sql`and a.id = ${assetId}` : sql``}
       ${bookId ? sql`and s.book_id = ${bookId}` : sql``}
     order by a.asset_number, l.sequence`)) as unknown as {
    rows: any[];
  };

  const result: RunDepreciationResult = {
    posted: 0,
    skipped: 0,
    totalAmount: "0",
    entries: [],
    problems: [],
  };

  for (const row of due.rows) {
    if (row.period_closed) {
      result.skipped++;
      result.problems.push(`${row.asset_number} ${row.period_name}: GL period closed`);
      continue;
    }

    const accounts = resolveAssetAccounts(
      {
        assetAccountId: row.asset_account,
        accumulatedDepreciationAccountId: row.asset_accum,
        depreciationExpenseAccountId: row.asset_expense,
      },
      {
        assetAccountId: row.cat_asset,
        accumulatedDepreciationAccountId: row.cat_accum,
        depreciationExpenseAccountId: row.cat_expense,
      },
    );

    const preliminaryLines = [
      { accountId: accounts.depreciationExpenseAccountId, amount: String(row.planned) },
      { accountId: accounts.accumulatedDepreciationAccountId, amount: neg(String(row.planned)) },
    ];
    try {
      await validateSubsidiaryRestrictions(db, {
        orgId,
        ctx: subsidiaryContext,
        docSubsidiaryId: row.subsidiary_id,
        lines: preliminaryLines.map((line) => ({
          ...line,
          subsidiaryId: row.subsidiary_id,
          departmentId: row.department_id,
          projectId: row.project_id,
          locationId: row.location_id,
        })),
      });
    } catch (error) {
      result.problems.push(`${row.asset_number} ${row.period_name}: ${(error as Error).message}`);
      continue;
    }
    assertFinalKernelBalance(preliminaryLines.map((line) => ({ amount: line.amount, subsidiaryId: row.subsidiary_id })));

    const postingDate: string = row.period_ends_on;
    try {
      const posted = await db.transaction(async (tx) => {
        // Claim the schedule line inside the posting transaction. Concurrent
        // runners serialize here and the loser observes posted_amount.
        const claim = (await tx.execute(sql`
          select l.planned_amount,
                 (period_module_is_closed(${orgId}, l.period_id, s.book_id, a.subsidiary_id, 'assets')
                   or period_module_is_closed(${orgId}, l.period_id, s.book_id, a.subsidiary_id, 'gl')) as period_closed
            from depreciation_schedule_lines l
            join depreciation_schedules s on s.id = l.schedule_id
            join fixed_assets a on a.id = s.asset_id
           where l.id = ${row.line_id} and l.org_id = ${orgId} and l.posted_amount is null
           for update of l`)) as unknown as { rows: { planned_amount: string; period_closed: boolean }[] };
        const claimed = claim.rows[0];
        if (!claimed) return null;
        if (claimed.period_closed) throw new Error("GL period closed");
        const planned = String(claimed.planned_amount);
        if (isZero(planned)) {
          await tx.execute(sql`
            update depreciation_schedule_lines
               set posted_amount = '0', updated_at = now(), updated_by = ${actorId}
             where id = ${row.line_id} and posted_amount is null`);
          return { entryId: null, amount: planned };
        }

        const lines = [
          { accountId: accounts.depreciationExpenseAccountId, amount: planned },
          { accountId: accounts.accumulatedDepreciationAccountId, amount: neg(planned) },
        ];
        assertFinalKernelBalance(lines.map((line) => ({ amount: line.amount, subsidiaryId: row.subsidiary_id })));
        const entryRes = (await tx.execute(sql`
          insert into journal_entries
            (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
          values (${orgId}, ${row.book_id}, ${row.subsidiary_id},
                  ${`DEP-${row.asset_number}-${row.period_name}`},
                  ${postingDate}, ${row.period_id},
                  ${`Depreciation — ${row.asset_name} (${row.period_name})`},
                  'draft', 'depreciation', ${actorId}, ${actorId})
          returning id`)) as unknown as { rows: { id: string }[] };
        const eid = entryRes.rows[0].id;

        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          await tx.execute(sql`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
               department_id, project_id, location_id, memo)
            values (${orgId}, ${eid}, ${i + 1}, ${l.accountId}, ${row.subsidiary_id}, ${l.amount}, ${row.base_currency}, ${l.amount}, 1,
                    ${row.department_id}, ${row.project_id}, ${row.location_id},
                    ${`Depreciation ${row.period_name}`})`);
        }

        await tx.execute(sql`
          update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId}
           where id = ${eid}`);

        await tx.execute(sql`
          update depreciation_schedule_lines
             set posted_amount = ${planned}, journal_entry_id = ${eid}, updated_at = now(), updated_by = ${actorId}
           where id = ${row.line_id}`);

        return { entryId: eid, amount: planned };
      });

      if (!posted) {
        result.skipped++;
        continue;
      }
      if (!posted.entryId) {
        result.skipped++;
        continue;
      }
      result.posted++;
      result.totalAmount = add(result.totalAmount, posted.amount);
      result.entries.push({
        assetNumber: row.asset_number,
        period: row.period_name,
        amount: posted.amount,
        entryId: posted.entryId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.problems.push(`${row.asset_number} ${row.period_name}: ${msg.slice(0, 120)}`);
    }
  }

  // Flip fully-depreciated assets (NBV reached salvage — no unposted lines left
  // and accumulated == cost − salvage) to 'fully_depreciated'.
  await db.execute(sql`
    update fixed_assets a
       set status = 'fully_depreciated', updated_at = now()
     where a.org_id = ${orgId} and a.status = 'in_service'
       ${assetId ? sql`and a.id = ${assetId}` : sql``}
       and exists (
         select 1 from depreciation_schedules s
           join accounting_books b on b.id = s.book_id and b.posts_gl and b.is_active and b.is_primary
           join depreciation_schedule_lines l on l.schedule_id = s.id
          where s.asset_id = a.id
          group by s.id
          having coalesce(sum(l.posted_amount), 0) >= a.acquisition_cost - a.salvage_value)`);

  return result;
}

/** Sort helper re-export (kept local so callers don't import money directly). */
export { cmp as compareMoney };
