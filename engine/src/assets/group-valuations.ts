import { assetGroupHistory } from "../organization/asset-group-history.ts";
import { sql } from "drizzle-orm";
import {
  db,
  withOrg,
  withTransactionSavepoint,
  type SqlExecutor,
} from "../platform/db.ts";
import {
  assertFinancialChangeApproved,
  completeFinancialChange,
  existingFinancialChange,
  loadFinancialChange,
  proposeFinancialChange,
} from "../platform/financial-changes.ts";
import { assertFinancialChangeAccess } from "../organization/financial-change-access.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { orgReportingFramework } from "../platform/reporting-framework.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import {
  add,
  cmp,
  divRate,
  mulRate,
  mulRatio,
  neg,
  toUnits,
} from "../money/money.ts";
import {
  groupAssetPlan,
  type GroupAssetValuation,
  type GroupAssetCounterfactual,
} from "../money/asset-group-plan.ts";
import {
  splitDepreciationPlan,
  type DatedDepreciation,
} from "../money/depreciation-plan.ts";
import { assetDepreciationCalendar } from "./depreciation.ts";
import { lockAssetRow, assertAssetPeriodOpen } from "./asset-lifecycle.ts";
export interface AssetGroupValuationInput {
  sourceEventId: string;
  effectiveOn: string;
  carryingValue: string;
  buyerToGroupRate: string;
  assessment: string;
  reason: string;
  idempotencyKey: string;
  remainingPlan: { date: string; amount: string }[];
}
type Transfer = {
  id: string;
  book_id: string;
  buyer_subsidiary_id: string;
  elimination_subsidiary_id: string;
  group_currency: string;
  basis: {
    groupCost: string;
    groupAccumulated: string;
    groupSalvage: string;
    buyerToGroupRate: string;
    groupPlan: DatedDepreciation[];
    groupUnimpaired?: GroupAssetCounterfactual;
  };
};
function exact(value: string, label: string) {
  const result = canonicalDecimal(value, 4);
  if (
    result === null ||
    toUnits(result) < 0n ||
    result.split(".")[0]!.replace(/^0+/, "").length > 15
  )
    throw new Error(`${label} must be a non-negative exact amount`);
  return add(result, "0");
}
async function subject(
  tx: SqlExecutor,
  orgId: string,
  assetId: string,
  actorId: string,
  input: AssetGroupValuationInput,
) {
  await lockAssetRow(tx, orgId, assetId);
  const row = (
    await tx.execute<{
      id: string;
      book_id: string;
      amount: string;
      subsidiary_id: string;
      acquisition_cost: string;
      currency: string;
      occurred_on: string;
      kind: string;
    }>(
      sql`select v.id,e.book_id,v.amount::text,a.subsidiary_id,a.acquisition_cost::text,s.base_currency as currency,v.occurred_on::text,v.kind from asset_events v join fixed_assets a on a.org_id=v.org_id and a.id=v.asset_id join subsidiaries s on s.org_id=a.org_id and s.id=a.subsidiary_id join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id where v.org_id=${orgId} and v.asset_id=${assetId} and v.id=${input.sourceEventId} and v.kind in('impaired','revalued') and e.status='posted' and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id) for share of v,e,s`,
    )
  ).rows[0];
  if (!row)
    throw new Error("select an unreversed posted valuation of this asset");
  const transfer = (
    await tx.execute<Transfer>(
      sql`select * from asset_transfer_bases where org_id=${orgId} and receiving_asset_id=${assetId} and book_id=${row.book_id} and reversed_by_change_id is null for share`,
    )
  ).rows[0];
  if (!transfer)
    throw new Error(
      "the asset has no active group transfer basis in this book",
    );
  const required = [row.subsidiary_id, transfer.elimination_subsidiary_id];
  await assertFinancialChangeAccess(tx, {
    orgId,
    actorId,
    subsidiaryIds: required,
    permission: "assets.manage",
    feature: "fixedAssets",
  });
  await assertFinancialChangeAccess(tx, {
    orgId,
    actorId,
    subsidiaryIds: required,
    permission: "assets.manage",
    feature: "multiSubsidiary",
  });
  return { row, transfer, required };
}
async function snapshot(
  tx: SqlExecutor,
  orgId: string,
  assetId: string,
  actorId: string,
  input: AssetGroupValuationInput,
) {
  if (!isIsoCalendarDate(input.effectiveOn))
    throw new Error("enter the source valuation date");
  if (input.assessment.trim().length < 8)
    throw new Error(
      "document the group recoverability and remaining-service assessment",
    );
  const carrying = exact(input.carryingValue, "group carrying value");
  if (
    canonicalDecimal(input.buyerToGroupRate, 10) === null ||
    BigInt(input.buyerToGroupRate.replace(".", "")) <= 0n
  )
    throw new Error("supply a positive exact buyer-to-group rate");
  const s = await subject(tx, orgId, assetId, actorId, input);
  if (input.effectiveOn !== s.row.occurred_on)
    throw new Error(
      "the group valuation must use the legal-book valuation date",
    );
  if (
    s.row.currency === s.transfer.group_currency &&
    cmp(input.buyerToGroupRate, "1") !== 0
  )
    throw new Error("same-currency group valuation rate must be one");
  const calendar = await assetDepreciationCalendar(
    tx,
    orgId,
    assetId,
    s.row.book_id,
  );
  const periods = (
    await tx.execute<{ id: string; starts_on: string; ends_on: string }>(
      sql`select id,starts_on::text,ends_on::text from accounting_periods where org_id=${orgId} and fiscal_calendar_id=${calendar} and not is_adjustment order by starts_on for share`,
    )
  ).rows;
  const period = periods.find(
    (p) => p.starts_on <= input.effectiveOn && p.ends_on >= input.effectiveOn,
  );
  if (!period)
    throw new Error(
      "create the accounting period covering the source valuation date",
    );
  await assertAssetPeriodOpen(tx, {
    orgId,
    bookId: s.row.book_id,
    periodId: period.id,
    subsidiaryIds: s.required,
  });
  const later = (
    await tx.execute(
      sql`select 1 from asset_basis_changes where org_id=${orgId} and asset_id=${assetId} and book_id=${s.row.book_id} and effective_on>${input.effectiveOn} union all select 1 from asset_events v join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id where v.org_id=${orgId} and v.asset_id=${assetId} and e.book_id=${s.row.book_id} and v.occurred_on>${input.effectiveOn} and v.kind in('impaired','revalued','disposed','written_off') and e.status='posted' union all select 1 from asset_transfer_consolidation_entries c join journal_entries e on e.org_id=c.org_id and e.id=c.journal_entry_id where c.org_id=${orgId} and c.transfer_id=${s.transfer.id} and e.posting_date>${input.effectiveOn} and e.status='posted' and not exists(select 1 from journal_entries r where r.org_id=e.org_id and r.reverses_entry_id=e.id and r.status in('posted','reversed')) limit 1`,
    )
  ).rows;
  if (later.length)
    throw new Error(
      "correct later asset or consolidation postings before changing this earlier group valuation",
    );
  const changes = (
    await tx.execute<{ cost: string }>(
      sql`select coalesce(sum(cost_delta),0)::text as cost from asset_basis_changes where org_id=${orgId} and asset_id=${assetId} and book_id=${s.row.book_id} and effective_on<=${input.effectiveOn}`,
    )
  ).rows[0]!;
  const held = add(s.row.acquisition_cost, changes.cost);
  if (cmp(held, "0") <= 0)
    throw new Error("a disposed asset has no remaining group valuation");
  const earlierMissing = (
    await tx.execute(
      sql`select 1 from asset_events v join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id where v.org_id=${orgId} and v.asset_id=${assetId} and e.book_id=${s.row.book_id} and e.status='posted' and v.kind in('impaired','revalued') and v.occurred_on<${input.effectiveOn} and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id) and not exists(select 1 from asset_transfer_measurements m where m.org_id=v.org_id and m.source_event_id=v.id) limit 1`,
    )
  ).rows;
  if (earlierMissing.length)
    throw new Error(
      "approve the earlier source valuation group assessment first; group service history must be measured in order",
    );
  const valuations = await assetGroupHistory(
    tx,
    orgId,
    s.transfer.id,
    input.effectiveOn,
  );
  const current = groupAssetPlan(
    s.transfer.basis.groupPlan,
    valuations,
    s.transfer.basis.groupUnimpaired,
  );
  const postedThrough = (
    await tx.execute<{ date: string | null }>(
      sql`select max(p.ends_on)::text as date from depreciation_schedules schedule join depreciation_schedule_lines l on l.org_id=schedule.org_id and l.schedule_id=schedule.id join accounting_periods p on p.org_id=l.org_id and p.id=l.period_id where schedule.org_id=${orgId} and schedule.asset_id=${assetId} and schedule.book_id=${s.row.book_id} and l.posted_amount is not null and p.ends_on<=${input.effectiveOn}`,
    )
  ).rows[0]!.date;
  const serviceFrom =
    postedThrough === input.effectiveOn
      ? new Date(Date.parse(input.effectiveOn + "T00:00:00Z") + 86400000)
          .toISOString()
          .slice(0, 10)
      : input.effectiveOn;
  const accrued = splitDepreciationPlan(current.plan, serviceFrom).accrued;
  const heldOriginal = (amount: string) =>
    mulRatio(amount, toUnits(held), toUnits(s.row.acquisition_cost));
  const cost = heldOriginal(add(s.transfer.basis.groupCost, current.costDelta)),
    salvage = heldOriginal(
      add(s.transfer.basis.groupSalvage, current.salvageDelta),
    );
  const before = heldOriginal(
    add(
      add(s.transfer.basis.groupCost, current.costDelta),
      neg(
        add(
          add(s.transfer.basis.groupAccumulated, current.accumulatedDelta),
          accrued,
        ),
      ),
    ),
  );
  // Normalize the controller's current group amount into the frozen basis's
  // denomination; future closing FX remains the report/consolidation policy.
  const normalized = mulRate(
    divRate(carrying, input.buyerToGroupRate),
    s.transfer.basis.buyerToGroupRate,
  );
  if (cmp(normalized, salvage) < 0 || cmp(normalized, cost) > 0)
    throw new Error(
      "group carrying value must lie between the retained residual value and historical group cost",
    );
  const delta = add(normalized, neg(before));
  const framework = await orgReportingFramework(orgId);
  const ceiling = heldOriginal(
    add(
      add(s.transfer.basis.groupCost, current.costDelta),
      neg(
        add(
          add(
            s.transfer.basis.groupAccumulated,
            current.unimpairedAccumulatedDelta,
          ),
          splitDepreciationPlan(current.unimpairedPlan, serviceFrom).accrued,
        ),
      ),
    ),
  );
  const netImpairment = cmp(before, ceiling) < 0;
  if (cmp(delta, "0") > 0 && netImpairment) {
    if (framework === "us_gaap")
      throw new Error(
        "US GAAP prohibits restoring a held-and-used group impairment",
      );
    if (cmp(normalized, ceiling) > 0)
      throw new Error(
        `group impairment reversal exceeds the unimpaired carrying amount ${mulRate(divRate(ceiling, s.transfer.basis.buyerToGroupRate), input.buyerToGroupRate)}`,
      );
  }
  let previous = serviceFrom,
    total = "0";
  const fullPlan = input.remainingPlan.map((line) => {
    const p = periods.find((p) => p.ends_on === line.date);
    if (!p || line.date < serviceFrom || line.date < previous)
      throw new Error(
        "group service plan must list distinct accounting period ends after the valuation",
      );
    const amount = exact(line.amount, "group remaining depreciation");
    total = add(total, amount);
    const startsOn = p.starts_on < serviceFrom ? serviceFrom : p.starts_on;
    if (startsOn < previous)
      throw new Error("group depreciation intervals overlap");
    previous = new Date(Date.parse(line.date + "T00:00:00Z") + 86400000)
      .toISOString()
      .slice(0, 10);
    return {
      startsOn,
      date: line.date,
      amount: mulRatio(
        mulRate(
          divRate(amount, input.buyerToGroupRate),
          s.transfer.basis.buyerToGroupRate,
        ),
        toUnits(s.row.acquisition_cost),
        toUnits(held),
      ),
    };
  });
  const residualCurrent = mulRate(
    divRate(salvage, s.transfer.basis.buyerToGroupRate),
    input.buyerToGroupRate,
  );
  if (cmp(total, add(carrying, neg(residualCurrent))) !== 0)
    throw new Error(
      "remaining group depreciation must exactly allocate carrying value less residual value",
    );
  // Last line carries normalization residue so the plan conserves the approved basis.
  if (fullPlan.length) {
    const target = mulRatio(
      add(normalized, neg(salvage)),
      toUnits(s.row.acquisition_cost),
      toUnits(held),
    );
    const assigned = fullPlan
      .slice(0, -1)
      .reduce((sum, l) => add(sum, l.amount), "0");
    fullPlan.at(-1)!.amount = add(target, neg(assigned));
  }
  const measurement: GroupAssetValuation = {
    effectiveOn: input.effectiveOn,
    serviceFrom,
    fullDelta: mulRatio(delta, toUnits(s.row.acquisition_cost), toUnits(held)),
    fullPlan,
    buyerDelta: s.row.amount,
    heldNumerator: held,
    heldDenominator: s.row.acquisition_cost,
  };
  return {
    ...s,
    valuations,
    changes,
    framework,
    preview: {
      groupCarryingBefore: mulRate(
        divRate(before, s.transfer.basis.buyerToGroupRate),
        input.buyerToGroupRate,
      ),
      groupCarryingAfter: carrying,
      groupValuationDelta: mulRate(
        divRate(delta, s.transfer.basis.buyerToGroupRate),
        input.buyerToGroupRate,
      ),
    },
    measurement,
  };
}
export async function proposeAssetGroupValuation(
  orgId: string,
  assetId: string,
  actorId: string,
  input: AssetGroupValuationInput,
) {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      // An identical retry still resolves after the source valuation has been
      // corrected. Authorize against the frozen workpaper first; only a NEW
      // proposal needs the source event to remain active.
      const replay = (
        await db.execute<{
          subsidiary_id: string;
          payload: Record<string, unknown>;
        }>(
          sql`select subsidiary_id,payload from financial_changes where org_id=${orgId} and idempotency_key=${input.idempotencyKey}`,
        )
      ).rows[0];
      if (replay) {
        const required = (replay.payload.requiredSubsidiaryIds ?? [
          replay.subsidiary_id,
        ]) as string[];
        await assertFinancialChangeAccess(db, {
          orgId,
          actorId,
          subsidiaryIds: required,
          permission: "assets.manage",
          feature: "fixedAssets",
        });
        const id = await existingFinancialChange(db, {
          orgId,
          subsidiaryId: replay.subsidiary_id,
          domain: "asset",
          subjectId: assetId,
          operation: "group_valuation",
          effectiveOn: input.effectiveOn,
          reason: input.reason,
          actorId,
          idempotencyKey: input.idempotencyKey,
          payload: { ...input, requiredSubsidiaryIds: required },
        });
        if (id) return id;
      }
      const s = await subject(db, orgId, assetId, actorId, input);
      const args = {
        orgId,
        subsidiaryId: s.row.subsidiary_id,
        domain: "asset" as const,
        subjectId: assetId,
        operation: "group_valuation",
        effectiveOn: input.effectiveOn,
        reason: input.reason,
        actorId,
        idempotencyKey: input.idempotencyKey,
        payload: { ...input, requiredSubsidiaryIds: s.required },
      };
      const previous = await existingFinancialChange(db, args);
      if (previous) return previous;
      return proposeFinancialChange(db, {
        ...args,
        beforeState: await snapshot(db, orgId, assetId, actorId, input),
      });
    }),
  );
}
export async function applyAssetGroupValuation(
  orgId: string,
  changeId: string,
  actorId: string,
) {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const change = await loadFinancialChange(db, orgId, changeId);
      if (change.domain !== "asset" || change.operation !== "group_valuation")
        throw new Error("not an asset group valuation");
      await assertFinancialChangeAccess(db, {
        orgId,
        actorId,
        subsidiaryIds: change.payload.requiredSubsidiaryIds as string[],
        permission: "assets.manage",
        feature: "fixedAssets",
      });
      if (change.status === "applied") return change.result!;
      const input = change.payload as unknown as AssetGroupValuationInput;
      const state = await snapshot(
        db,
        orgId,
        change.subject_id,
        actorId,
        input,
      );
      assertFinancialChangeApproved(change, {
        domain: "asset",
        subjectId: change.subject_id,
        beforeState: state,
      });
      const allowed = await actorAllowedSubsidiaryIds(
        db,
        orgId,
        change.approved_by!,
      );
      if (allowed && state.required.some((id) => !allowed.has(id)))
        throw new Error(
          "the independent approver no longer covers the asset and elimination company; obtain a new approval",
        );
      const result = await db.execute<{ id: string }>(
        sql`insert into asset_transfer_measurements(org_id,transfer_id,source_event_id,change_id,effective_on,measurement,created_by) values(${orgId},${state.transfer.id},${input.sourceEventId},${changeId},${input.effectiveOn},${JSON.stringify(state.measurement)}::jsonb,${actorId}) returning id`,
      );
      if (result.rows.length !== 1)
        throw new Error("group asset valuation was not recorded");
      const outcome = { measurementId: result.rows[0]!.id, ...state.preview };
      await completeFinancialChange(db, orgId, changeId, actorId, outcome);
      return outcome;
    }),
  );
}
