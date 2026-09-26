/** Schedule persistence: plan loading, carrying value, build paths. Split from assets/depreciation.ts (pure moves only). */
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { assetBasisDelta } from "./asset-basis.ts";
import { computeScheduleByFormula } from "./depreciation-formula.ts";
import { add, cmp, isZero, mulRatio, neg, toUnits } from "../money/money.ts";
import { DepreciationRefusalError, assertPostableDepreciationStatus } from "./depreciation-errors.ts";
import { computeSchedule, computeUnitsOfProductionCharge, conventionFraction, addMonths, monthStart, type DepreciationMethod, type ScheduleInput, type ScheduleLinePlan } from "./depreciation-schedule-math.ts";

// ---------------------------------------------------------------------------
// Persist a schedule (plan → depreciation_schedules + lines)
// ---------------------------------------------------------------------------

/** Primary accounting book id (schedules are book-aware): the shared active
 * posting primary, so planning reads the same book the run posts to — never
 * a deactivated primary. */
export async function primaryBookId(runner: SqlExecutor, orgId: string): Promise<string> {
  const id = await activePostingPrimaryBookId(orgId, runner);
  if (!id) throw new DepreciationRefusalError("no primary accounting book");
  return id;
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
    throw new DepreciationRefusalError(
      "asset depreciation schedule spans multiple fiscal calendars",
    );
  if (retained[0]) return retained[0].id;
  const defaults = (
    await runner.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${orgId} and is_default and is_active for share
  `)
  ).rows;
  if (defaults.length !== 1)
    throw new DepreciationRefusalError(
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
  allowedSubsidiaryIds?: readonly string[] | null,
) {
  const assetRes = await runner.execute<{
    id: string;
    category_id: string;
    asset_number: string;
    status: string;
    subsidiary_id: string;
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
    select id, org_id, category_id, asset_number, status, subsidiary_id, in_service_on, acquisition_cost, salvage_value,
           depreciation_method, depreciation_method_id, useful_life_months, depreciation_rate_percent,
           depreciation_convention, depreciation_units_total,
           opening_accumulated_depreciation::text as opening_accumulated_depreciation,
           opening_accumulated_as_of::text as opening_accumulated_as_of
      from fixed_assets where id = ${assetId} and org_id = ${orgId} for update`);
  const asset = assetRes.rows[0];
  if (!asset) throw new DepreciationRefusalError("asset not found");
  // The subsidiary scope is enforced inside the lock, not by the route's
  // precheck: a concurrent PATCH could move the asset into a restricted
  // subsidiary between the precheck and this write.
  if (allowedSubsidiaryIds && !allowedSubsidiaryIds.includes(asset.subsidiary_id)) {
    throw new DepreciationRefusalError("asset is outside your subsidiary scope");
  }
  assertPostableDepreciationStatus(asset.status, asset.asset_number);
  if (!asset.in_service_on) throw new DepreciationRefusalError("asset has no in-service date");

  const catRes = await runner.execute<{
    default_method: DepreciationMethod;
    default_depreciation_method_id: string | null;
    default_life_months: number | null;
    default_convention: string | null;
  }>(sql`
    select default_method, default_depreciation_method_id, default_life_months, default_convention
      from asset_categories where id = ${asset.category_id} and org_id = ${orgId} for update`);
  const category = catRes.rows[0];
  if (!category) throw new DepreciationRefusalError("asset category not found");

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
  // Convention is captured on the schedule header (0339 backfilled legacy
  // headers from the effective policy, provenance-recorded; builders stamp
  // every new and rebuilt header below), so the comparison holds it like
  // every other policy field. A header that still records no convention has
  // no resolvable policy behind it: IS DISTINCT FROM treats that as drift
  // and fails closed, and the refusal below names the remedy.
  const drift = (
    await runner.execute(sql`
    select 1 from depreciation_schedules schedule
     where schedule.org_id = ${orgId} and schedule.asset_id = ${assetId} and schedule.book_id = ${bookId}
       and row(schedule.method, schedule.depreciation_method_id, schedule.life_months, schedule.rate_percent, schedule.units_total, schedule.convention)
           is distinct from row(${method}::text, ${depreciationMethodId}::uuid, ${lifeMonths || null}::integer, ${ratePercent}::numeric, ${unitsTotal}::numeric, ${convention}::text)
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
    throw new DepreciationRefusalError(
      "historical depreciation policy differs from the retained schedule; reconcile the policy before rebuilding or restoring impairment",
    );
  if (
    (depreciationMethodId ||
      (method !== "manual" && method !== "units_of_production")) &&
    (!lifeMonths || lifeMonths <= 0)
  ) {
    throw new DepreciationRefusalError("asset has no useful life (months)");
  }
  if (
    method === "units_of_production" &&
    (unitsTotal == null || cmp(unitsTotal, "0") <= 0)
  ) {
    throw new DepreciationRefusalError(
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
    throw new DepreciationRefusalError(
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
    throw new DepreciationRefusalError(
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
    convention,
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
        throw new DepreciationRefusalError(
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
          throw new DepreciationRefusalError(
            "manual depreciation evidence is unavailable for the restoration ceiling",
          );
        depreciation = add(
          depreciation,
          originalEquivalent(input.manual_amount),
        );
      } else {
        if (input.production_units === null || unitsTotal === null) {
          throw new DepreciationRefusalError(
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
        throw new DepreciationRefusalError(
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
  allowedSubsidiaryIds?: readonly string[] | null,
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
    convention,
    plan,
    opening,
    basisChange,
  } = await loadUnremeasuredAssetPlan(runner, assetId, orgId, forBookId, allowedSubsidiaryIds);
  // Continue-from-accumulated pre-validation (migration 0156). Pre-as-of
  // native months are covered by the opening figure and must never be
  // scheduled — but a zero opening covers nothing, so dropping months for it
  // would silently strand basis. That combination is a writer bug: full-life
  // catch-up (no opening fields at all) is the way to recognise those months.
  const openingAmount = opening ? opening.amount : "0";
  if (opening && cmp(openingAmount, "0") > 0) {
    if (!asset.in_service_on) throw new DepreciationRefusalError("asset has no in-service date");
    if (monthStart(opening.asOf) < monthStart(asset.in_service_on)) {
      throw new DepreciationRefusalError(
        `opening accumulated as-of ${opening.asOf} precedes the in-service month ${monthStart(asset.in_service_on)}`,
      );
    }
  }
  if (
    opening &&
    cmp(openingAmount, "0") === 0 &&
    plan.some((p) => p.periodMonth <= opening.asOf)
  ) {
    throw new DepreciationRefusalError(
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
          throw new DepreciationRefusalError(
            "depreciation method cannot change after manual or production evidence exists",
          );
        }
      }
      await tx.execute(sql`
        update depreciation_schedules
           set method = ${method}, depreciation_method_id = ${depreciationMethodId}, life_months = ${lifeMonths || null},
               rate_percent = ${ratePercent}, units_total = ${unitsTotal}, convention = ${convention},
               updated_at = now(), updated_by = ${actorId}
         where id = ${scheduleId} and org_id = ${orgId}`);
    } else {
      const ins = await tx.execute<{ id: string }>(sql`
        insert into depreciation_schedules (org_id, asset_id, book_id, method, depreciation_method_id, life_months, rate_percent, units_total, convention, created_by, updated_by)
        values (${orgId}, ${assetId}, ${bookId}, ${method}, ${depreciationMethodId}, ${lifeMonths || null}, ${ratePercent}, ${unitsTotal}, ${convention}, ${actorId}, ${actorId})
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
      throw new DepreciationRefusalError(
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
      throw new DepreciationRefusalError(
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
          throw new DepreciationRefusalError(
            `posted depreciation for period ending ${line.ends_on} overlaps the opening accumulated as-of ${opening.asOf} — clear the opening fields or reverse the overlapping posting before rebuilding`,
          );
        }
        const native = nativeByPeriod.get(line.period_id);
        if (native !== undefined && toUnits(line.planned_amount) > native) {
          throw new DepreciationRefusalError(
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
          throw new DepreciationRefusalError(
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
        throw new DepreciationRefusalError(
          `historical depreciation projection missing (${p.periodMonth}); reconcile retained evidence before rebuilding`,
        );
      }
      if (period && preservedPeriods.has(period.id)) continue;
      if (prior && prior.source !== "formula")
        throw new DepreciationRefusalError(
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
      throw new DepreciationRefusalError(
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
      throw new DepreciationRefusalError(
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
  allowedSubsidiaryIds?: readonly string[] | null,
): Promise<BuildScheduleResult> {
  return db.transaction((tx) => buildScheduleWithRunner(tx, assetId, orgId, actorId, forBookId, allowedSubsidiaryIds));
}

/**
 * Build the depreciation schedule for every active book (multi-book). Each book
 * gets its own plan from its per-book policy, else the category/asset defaults.
 */
export async function buildAllSchedules(
  assetId: string,
  orgId: string,
  actorId: string | null,
  allowedSubsidiaryIds?: readonly string[] | null,
): Promise<BuildScheduleResult[]> {
  return db.transaction((tx) => buildAllSchedulesWithRunner(tx, assetId, orgId, actorId, allowedSubsidiaryIds));
}

export async function buildAllSchedulesWithRunner(
  runner: SqlExecutor,
  assetId: string,
  orgId: string,
  actorId: string | null,
  allowedSubsidiaryIds?: readonly string[] | null,
): Promise<BuildScheduleResult[]> {
  const books = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_active
     order by is_primary desc, code`));
  const results: BuildScheduleResult[] = [];
  for (const b of books.rows) results.push(await buildScheduleWithRunner(runner, assetId, orgId, actorId, b.id, allowedSubsidiaryIds));
  return results;
}
