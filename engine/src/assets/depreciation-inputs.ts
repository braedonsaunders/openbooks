/** Manual/usage depreciation input recording. Split from assets/depreciation.ts (ARCH-FILE-SPLIT; pure moves only). */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { add, cmp, neg, normalizeMoney, toUnits } from "../money/money.ts";
import { assetBasisDelta } from "./asset-basis.ts";
import { CloseError, assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { DepreciationRefusalError } from "./depreciation-errors.ts";
import { computeUnitsOfProductionCharge, type DepreciationMethod } from "./depreciation-schedule-math.ts";
import { assetDepreciationCalendar, primaryBookId } from "./depreciation-schedule-build.ts";

/** Persist a manual/usage depreciation fact through exact decimal then ledger money. Fail closed. */
function persistDepreciationInputValue(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new DepreciationRefusalError("depreciation value must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new DepreciationRefusalError("depreciation value must be an exact decimal");
  }
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
  /** Enforced against the locked asset row (the route precheck alone races). */
  allowedSubsidiaryIds?: readonly string[] | null;
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
    throw new DepreciationRefusalError("effective date is required");
  if (!memo) throw new DepreciationRefusalError("an accounting memo is required");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      args.evidenceFileId,
    )
  ) {
    throw new DepreciationRefusalError("an attached evidence file is required");
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
      throw new DepreciationRefusalError(
        "no depreciation schedule or accounting period covers the effective date",
      );
    // The subsidiary scope is enforced against this locked row, not the
    // route's precheck: a concurrent PATCH could move the asset into a
    // restricted subsidiary between the precheck and this write.
    if (args.allowedSubsidiaryIds && !args.allowedSubsidiaryIds.includes(row.subsidiary_id)) {
      throw new DepreciationRefusalError("asset is outside your subsidiary scope");
    }
    if (row.status !== "in_service")
      throw new DepreciationRefusalError("depreciation inputs require an in-service asset");
    if (args.effectiveDate < row.in_service_on)
      throw new DepreciationRefusalError("depreciation cannot precede the in-service date");
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
        throw new DepreciationRefusalError("the asset or GL period is closed");
      throw error;
    }
    const expectedMethod =
      args.kind === "manual" ? "manual" : "units_of_production";
    if (row.method !== expectedMethod)
      throw new DepreciationRefusalError(
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
      throw new DepreciationRefusalError("evidence file must be attached to this asset");

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
      throw new DepreciationRefusalError(
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
      throw new DepreciationRefusalError(
        "depreciation input cannot precede the retained asset valuation; correct that valuation before changing its historical inputs",
      );
    const basis =
      toUnits(add(currentCost, valuation.delta)) - toUnits(currentSalvage);
    if (basis < 0n)
      throw new DepreciationRefusalError("salvage value cannot exceed acquisition cost");
    // Continue-from-accumulated (migration 0156): evidence caps run against
    // the REMAINING basis — the opening figure already consumed part of it.
    const alreadyPlanned = add(
      totals.rows[0]?.planned ?? "0",
      add(row.opening_accumulated_depreciation ?? "0", basisChange.accumulated),
    );
    let plannedAmount: string;
    if (args.kind === "manual") {
      if (cmp(value, "0") === 0)
        throw new DepreciationRefusalError("manual depreciation must be non-zero");
      const next = toUnits(alreadyPlanned) + toUnits(value);
      if (next < 0n || next > basis) {
        throw new DepreciationRefusalError(
          "manual depreciation must keep accumulated depreciation between zero and the salvage floor",
        );
      }
      plannedAmount = value;
    } else {
      if (cmp(value, "0") === 0)
        throw new DepreciationRefusalError("production units must be non-zero");
      if (!row.units_total || cmp(row.units_total, "0") <= 0) {
        throw new DepreciationRefusalError(
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
        throw new DepreciationRefusalError(
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
