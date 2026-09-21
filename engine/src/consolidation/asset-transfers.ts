import { assetGroupHistory } from "../organization/asset-group-history.ts";
import {
  groupAssetPlan,
  type GroupAssetValuation,
  type GroupAssetCounterfactual,
} from "../money/asset-group-plan.ts";
import {
  accruedDepreciation,
  nextCalendarDay,
  splitDepreciationPlan,
  type DatedDepreciation,
} from "../money/depreciation-plan.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import {
  add,
  divRate,
  isZero,
  mulPercent,
  mulRate,
  mulRatio,
  neg,
  toUnits,
} from "../money/money.ts";
import { assertFinalKernelBalance } from "../ledger/posting-invariants.ts";
import { assertPeriodModulesOpen } from "../close/period-policy.ts";
import {
  loadSubsidiaryContext,
  validateSubsidiaryRestrictions,
  uuidArray,
} from "../organization/subsidiaries.ts";

type NciAllocation = {
  percent: string;
  ownershipPath?: string[];
  equityAccountId: string;
  incomeAccountId: string;
};
const nciAllocations = (basis: AssetTransferBasis): NciAllocation[] =>
  basis.nci ? (Array.isArray(basis.nci) ? basis.nci : [basis.nci]) : [];
export interface AssetTransferBasis {
  groupCost: string;
  groupAccumulated: string;
  groupSalvage: string;
  groupPlan: DatedDepreciation[];
  groupUnimpaired?: GroupAssetCounterfactual;
  nci?: NciAllocation | NciAllocation[];
  buyerCost: string;
  buyerToGroupRate: string;
  ctaAccountId: string;
  groupAssetAccountId: string;
  groupAccumulatedAccountId: string;
  groupDepreciationAccountId: string;
  groupGainLossAccountId: string;
  taxRatePercent: string;
  deferredTaxAccountId: string;
  taxExpenseAccountId: string;
}
/** Signed consolidation balances, not journals to accumulate again each run.
 * Fixed acquisition translation is the approved historical basis; no current
 * spot-rate guess can change the group's retained acquisition evidence. */
export function measureAssetTransferElimination(
  basis: AssetTransferBasis,
  args: {
    asOf: string;
    buyerCost: string;
    buyerAccumulated: string;
    remainingFraction: { numerator: bigint; denominator: bigint };
    disposed: boolean;
    currentBuyerRate?: string;
    depreciationAdjustment?: string;
    realizedMargin?: string;
    valuationAdjustment?: string;
    groupAccumulatedDelta?: string;
    groupCostDelta?: string;
    groupPlan?: DatedDepreciation[];
    reversed?: boolean;
  },
): Record<string, string> {
  const target: Record<string, string> = {};
  if (args.reversed) return target;
  const addTo = (id: string, amount: string) => {
    target[id] = add(target[id] ?? "0", amount);
  };
  const originalGroupCarrying = add(
    basis.groupCost,
    neg(basis.groupAccumulated),
  );
  const initialMargin = add(basis.buyerCost, neg(originalGroupCarrying));
  const fraction = args.disposed
    ? { numerator: 0n, denominator: 1n }
    : args.remainingFraction;
  if (
    fraction.denominator <= 0n ||
    fraction.numerator < 0n ||
    fraction.numerator > fraction.denominator
  )
    throw new Error("invalid retained physical asset fraction");
  const currentRate = args.currentBuyerRate ?? basis.buyerToGroupRate;
  const translate = (value: string) =>
    mulRate(divRate(value, basis.buyerToGroupRate), currentRate);
  const groupCost = translate(
    mulRatio(
      add(basis.groupCost, args.groupCostDelta ?? "0"),
      fraction.numerator,
      fraction.denominator,
    ),
  );
  const depreciation = splitDepreciationPlan(
    args.groupPlan ?? basis.groupPlan,
    nextCalendarDay(args.asOf),
  ).accrued;
  const groupAccumulated = translate(
    mulRatio(
      add(
        add(basis.groupAccumulated, args.groupAccumulatedDelta ?? "0"),
        depreciation,
      ),
      fraction.numerator,
      fraction.denominator,
    ),
  );
  const buyerCost = args.disposed ? "0" : mulRate(args.buyerCost, currentRate),
    buyerAccumulated = args.disposed
      ? "0"
      : mulRate(args.buyerAccumulated, currentRate);
  const costAdjustment = add(groupCost, neg(buyerCost)),
    accumAdjustment = add(buyerAccumulated, neg(groupAccumulated));
  const retainedMargin = neg(add(costAdjustment, accumAdjustment));
  if (
    fraction.numerator !== fraction.denominator &&
    (args.realizedMargin === undefined ||
      args.depreciationAdjustment === undefined)
  )
    throw new Error(
      "disposed portions require the realized margin and retained historical depreciation evidence",
    );
  const retainedInitialMargin = add(
    initialMargin,
    neg(args.realizedMargin ?? "0"),
  );
  addTo(basis.groupAssetAccountId, costAdjustment);
  addTo(basis.groupAccumulatedAccountId, accumAdjustment);
  addTo(
    basis.groupGainLossAccountId,
    add(retainedInitialMargin, args.valuationAdjustment ?? "0"),
  );
  const expenseAdjustment =
    args.depreciationAdjustment ??
    add(
      add(retainedMargin, neg(retainedInitialMargin)),
      neg(args.valuationAdjustment ?? "0"),
    );
  addTo(basis.groupDepreciationAccountId, expenseAdjustment);
  const tax = mulPercent(retainedMargin, basis.taxRatePercent);
  addTo(basis.deferredTaxAccountId, tax);
  addTo(
    basis.taxExpenseAccountId,
    neg(
      mulPercent(
        add(
          add(retainedInitialMargin, expenseAdjustment),
          args.valuationAdjustment ?? "0",
        ),
        basis.taxRatePercent,
      ),
    ),
  );
  for (const nci of nciAllocations(basis)) {
    const afterTax = add(
      add(
        add(retainedInitialMargin, expenseAdjustment),
        args.valuationAdjustment ?? "0",
      ),
      neg(
        mulPercent(
          add(
            add(retainedInitialMargin, expenseAdjustment),
            args.valuationAdjustment ?? "0",
          ),
          basis.taxRatePercent,
        ),
      ),
    );
    const path = nci.ownershipPath ?? [];
    const share = mulRatio(
      afterTax,
      path.reduce((value, p) => value * toUnits(p), toUnits(nci.percent)),
      path.reduce((value) => value * toUnits("100"), toUnits("100")),
    );
    addTo(nci.equityAccountId, share);
    addTo(nci.incomeAccountId, neg(share));
  }
  const residual = Object.values(target).reduce((a, b) => add(a, b), "0");
  addTo(basis.ctaAccountId, neg(residual));
  return target;
}
/** Cumulative target minus the journals already retained through this date.
 * Reruns append only the difference. Earlier periods cannot overwrite a later
 * generation; complete periods in order or explicitly correct the later close. */
export async function consolidateAssetTransfers(
  tx: SqlExecutor,
  orgId: string,
  periodId: string,
  actorId: string,
  asOf?: string,
  buyerSubsidiaryIds?: string[],
  bookId?: string,
): Promise<string[]> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`asset-transfer-consolidation:${orgId}`},0))`,
  );
  const period = (
    await tx.execute<{ starts_on: string; ends_on: string; name: string }>(
      sql`select starts_on::text,ends_on::text,name from accounting_periods where org_id=${orgId} and id=${periodId}`,
    )
  ).rows[0];
  if (!period) throw new Error("consolidation period not found");
  const cutoff = asOf ?? period.ends_on;
  if (cutoff < period.starts_on || cutoff > period.ends_on)
    throw new Error(
      "asset transfer cutoff must lie inside the accounting period",
    );
  const transfers = (
    await tx.execute<{
      id: string;
      book_id: string;
      receiving_asset_id: string;
      elimination_subsidiary_id: string;
      group_currency: string;
      basis: AssetTransferBasis;
      reversed_on: string | null;
    }>(
      sql`select t.*,t.reversed_on::text as reversed_on from asset_transfer_bases t join accounting_books b on b.org_id=t.org_id and b.id=t.book_id and b.posts_gl and b.is_active where t.org_id=${orgId} ${bookId ? sql`and t.book_id=${bookId}` : sql``} and t.effective_on<=${cutoff} ${buyerSubsidiaryIds ? sql`and t.buyer_subsidiary_id=any(${uuidArray(buyerSubsidiaryIds)}::uuid[])` : sql``} and not exists(select 1 from consolidation_control_losses loss where loss.org_id=t.org_id and loss.reversed_by_change_id is null and loss.excluded_subsidiary_ids ? t.buyer_subsidiary_id::text) order by t.receiving_asset_id,t.book_id,t.id`,
    )
  ).rows;
  const entries: string[] = [];
  for (let transfer of transfers) {
    const asset = (
      await tx.execute<{
        acquisition_cost: string;
        status: string;
        base_currency: string;
      }>(
        sql`select a.acquisition_cost::text,a.status,s.base_currency from fixed_assets a join subsidiaries s on s.id=a.subsidiary_id and s.org_id=a.org_id where a.org_id=${orgId} and a.id=${transfer.receiving_asset_id} for share of a,s`,
      )
    ).rows[0];
    if (!asset) throw new Error("receiving asset evidence is unavailable");
    // Asset edits and controlled corrections lock the asset before the frozen
    // transfer row. Use that same order: holding t FOR SHARE while waiting on
    // the asset would deadlock a correction upgrading its transfer-row lock.
    const current = (
      await tx.execute<(typeof transfers)[number]>(
        sql`select t.*,t.reversed_on::text as reversed_on from asset_transfer_bases t join accounting_books b on b.org_id=t.org_id and b.id=t.book_id where t.org_id=${orgId} and t.id=${transfer.id} and b.is_active and b.posts_gl for share of t,b`,
      )
    ).rows[0];
    if (!current)
      throw new Error(
        "the asset transfer accounting book changed during consolidation; restore the active book before retrying",
      );
    transfer = current;
    if (
      (
        await tx.execute(
          sql`select 1 from consolidation_control_losses loss join asset_transfer_bases t on t.org_id=loss.org_id and t.id=${transfer.id} where loss.org_id=${orgId} and loss.reversed_by_change_id is null and loss.excluded_subsidiary_ids ? t.buyer_subsidiary_id::text limit 1`,
        )
      ).rows.length
    )
      continue;

    const later = (
      await tx.execute(
        sql`select 1 from asset_transfer_consolidation_entries c join journal_entries e on e.org_id=c.org_id and e.id=c.journal_entry_id where c.org_id=${orgId} and c.transfer_id=${transfer.id} and e.posting_date>${cutoff} and e.status='posted' and not exists(select 1 from journal_entries r where r.org_id=e.org_id and r.reverses_entry_id=e.id and r.status in('posted','reversed')) limit 1`,
      )
    ).rows[0];
    if (later)
      throw new Error(
        "a later asset transfer consolidation exists; correct that close before recalculating an earlier period",
      );
    // Historical carrying values use effective-dated basis changes and posted
    // depreciation only through the requested close, not today's asset status.
    const value = (
      await tx.execute<{
        cost: string;
        accumulated: string;
        disposed: boolean;
      }>(sql`
   select a.acquisition_cost+coalesce((select sum(x.cost_delta) from asset_basis_changes x where x.org_id=a.org_id and x.asset_id=a.id and x.book_id=${transfer.book_id} and x.effective_on<=${cutoff}),0) as cost,
    coalesce(a.opening_accumulated_depreciation,0)+coalesce((select sum(l.posted_amount) from depreciation_schedules s join depreciation_schedule_lines l on l.schedule_id=s.id and l.org_id=s.org_id join accounting_periods p on p.org_id=l.org_id and p.id=l.period_id where s.org_id=a.org_id and s.asset_id=a.id and s.book_id=${transfer.book_id} and p.ends_on<=${cutoff}),0)+coalesce((select sum(x.accumulated_delta) from asset_basis_changes x where x.org_id=a.org_id and x.asset_id=a.id and x.book_id=${transfer.book_id} and x.effective_on<=${cutoff}),0)-coalesce((select sum(v.amount) from asset_events v join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id where v.org_id=a.org_id and v.asset_id=a.id and e.book_id=${transfer.book_id} and e.status in('posted','reversed') and v.kind in('impaired','revalued') and v.occurred_on<=${cutoff} and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id and r.occurred_on<=${cutoff})),0) as accumulated,
    exists(select 1 from asset_events v join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id where v.org_id=a.org_id and v.asset_id=a.id and v.kind in('disposed','written_off') and v.financial_change_id is null and e.book_id=${transfer.book_id} and v.occurred_on<=${cutoff} and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id and r.occurred_on<=${cutoff})) as disposed
    from fixed_assets a where a.org_id=${orgId} and a.id=${transfer.receiving_asset_id}
  `)
    ).rows[0]!;
    const rateRows = (
      await tx.execute<{
        starts_on: string;
        ends_on: string;
        current_rate: string | null;
        average_rate: string | null;
      }>(
        sql`select p.starts_on::text,p.ends_on::text,r.current_rate::text,r.average_rate::text from accounting_periods p left join consolidated_fx_rates r on r.org_id=p.org_id and r.period_id=p.id and r.from_currency=${asset.base_currency} and r.to_currency=${transfer.group_currency} where p.org_id=${orgId} and p.fiscal_calendar_id=(select fiscal_calendar_id from accounting_periods where org_id=${orgId} and id=${periodId}) and not p.is_adjustment order by p.starts_on`,
      )
    ).rows;
    const rate = (date: string, kind: "current_rate" | "average_rate") => {
      if (asset.base_currency === transfer.group_currency) return "1";
      const rows = rateRows.filter(
        (r) => r.starts_on <= date && r.ends_on >= date,
      );
      if (rows.length !== 1 || !rows[0]![kind])
        throw new Error(
          `derive consolidated ${kind.replace("_rate", "")} rates for ${asset.base_currency} to ${transfer.group_currency} on ${date} before consolidating the transfer`,
        );
      return rows[0]![kind]!;
    };
    const currentBuyerRate = rate(cutoff, "current_rate");
    const buyerDepreciation = (
      await tx.execute<{ amount: string; date: string; cost_at: string }>(
        sql`select l.posted_amount::text as amount,e.posting_date::text as date,(${asset.acquisition_cost}::numeric+coalesce((select sum(x.cost_delta) from asset_basis_changes x where x.org_id=s.org_id and x.asset_id=s.asset_id and x.book_id=s.book_id and (x.effective_on<e.posting_date or (x.effective_on=e.posting_date and x.created_at<e.created_at))),0))::text as cost_at from depreciation_schedules s join depreciation_schedule_lines l on l.org_id=s.org_id and l.schedule_id=s.id join journal_entries e on e.org_id=l.org_id and e.id=l.journal_entry_id where s.org_id=${orgId} and s.asset_id=${transfer.receiving_asset_id} and s.book_id=${transfer.book_id} and e.posting_date<=${cutoff} and e.status in('posted','reversed') and not exists(select 1 from journal_entries r where r.org_id=e.org_id and r.reverses_entry_id=e.id and r.status in('posted','reversed') and r.posting_date<=${cutoff}) union all select l.amount::text,e.posting_date::text,(${asset.acquisition_cost}::numeric+coalesce((select sum(prior.cost_delta) from asset_basis_changes prior where prior.org_id=x.org_id and prior.asset_id=x.asset_id and prior.book_id=x.book_id and prior.id<>x.id and (prior.effective_on<x.effective_on or (prior.effective_on=x.effective_on and prior.created_at<x.created_at))),0))::text from asset_basis_changes x join journal_entries e on e.id=x.stub_journal_entry_id and e.org_id=x.org_id join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id where x.org_id=${orgId} and x.asset_id=${transfer.receiving_asset_id} and x.book_id=${transfer.book_id} and e.posting_date<=${cutoff} and l.amount>0 and not exists(select 1 from journal_entries r where r.org_id=e.org_id and r.reverses_entry_id=e.id and r.status in('posted','reversed') and r.posting_date<=${cutoff})`,
      )
    ).rows;
    const movements = (
      await tx.execute<{
        date: string;
        removed_cost: string;
        removed_accumulated: string;
        group_component: GroupAssetValuation | null;
      }>(sql`
      select x.effective_on::text as date,(-x.cost_delta)::text as removed_cost,
       (coalesce((select (case when f.operation='reversal' then -1 else 1 end)*(p->>'stub')::numeric from jsonb_array_elements(coalesce(case when f.operation='reversal' then f.before_state->'source'->'before_state'->'previews' else f.before_state->'previews' end,'[]'::jsonb)) p where p->>'bookId'=x.book_id::text),0)-x.accumulated_delta)::text as removed_accumulated,x.group_component
       from asset_basis_changes x join financial_changes f on f.org_id=x.org_id and f.id=x.change_id
       where x.org_id=${orgId} and x.asset_id=${transfer.receiving_asset_id} and x.book_id=${transfer.book_id} and x.effective_on<=${cutoff} and f.operation<>'reversal' and not exists(select 1 from financial_changes correction where correction.org_id=x.org_id and correction.domain='asset' and correction.operation='reversal' and correction.status='applied' and correction.payload->>'sourceChangeId'=x.change_id::text and correction.effective_on<=${cutoff})
      union all
      select v.occurred_on::text,(-sum(case when l.account_id=coalesce(a.asset_account_id,c.asset_account_id) then l.amount else 0 end))::text,
       sum(case when l.account_id=coalesce(a.accumulated_depreciation_account_id,c.accumulated_depreciation_account_id) then l.amount else 0 end)::text,null::jsonb
       from asset_events v join fixed_assets a on a.id=v.asset_id and a.org_id=v.org_id join asset_categories c on c.id=a.category_id and c.org_id=a.org_id
       join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id
       where v.org_id=${orgId} and v.asset_id=${transfer.receiving_asset_id} and e.book_id=${transfer.book_id} and v.kind in('disposed','written_off') and v.financial_change_id is null and v.occurred_on<=${cutoff}
       and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id and r.occurred_on<=${cutoff}) group by v.id,v.occurred_on
      order by date
    `)
    ).rows;
    const valuationRows = (
      await tx.execute<{ amount: string; date: string; id: string }>(
        sql`select v.id,v.amount::text,v.occurred_on::text as date from asset_events v join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id where v.org_id=${orgId} and v.asset_id=${transfer.receiving_asset_id} and e.book_id=${transfer.book_id} and v.kind in('impaired','revalued') and v.occurred_on<=${cutoff} and e.status in('posted','reversed') and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id and r.occurred_on<=${cutoff}) order by v.occurred_on,v.created_at,v.id`,
      )
    ).rows;
    const groupRows = (
      await tx.execute<{
        source_event_id: string;
        measurement: GroupAssetValuation;
      }>(
        sql`select m.source_event_id,m.measurement from asset_transfer_measurements m join asset_events v on v.org_id=m.org_id and v.id=m.source_event_id join journal_entries e on e.org_id=v.org_id and e.id=v.journal_entry_id where m.org_id=${orgId} and m.transfer_id=${transfer.id} and m.effective_on<=${cutoff} and e.status in('posted','reversed') and not exists(select 1 from asset_events r where r.org_id=v.org_id and r.reverses_event_id=v.id and r.occurred_on<=${cutoff}) order by m.effective_on,m.ordinal`,
      )
    ).rows;
    if (
      valuationRows.some(
        (v) => !groupRows.some((g) => g.source_event_id === v.id),
      )
    )
      throw new Error(
        "the transferred asset has a legal-book valuation without an approved group measurement; open the receiving asset and propose its Group valuation before consolidation",
      );
    const valuations = await assetGroupHistory(tx, orgId, transfer.id, cutoff);
    const group = groupAssetPlan(
      transfer.basis.groupPlan,
      valuations,
      transfer.basis.groupUnimpaired,
    );
    const valuationAdjustment = add(
      valuationRows.reduce(
        (sum, v) => add(sum, mulRate(v.amount, rate(v.date, "average_rate"))),
        "0",
      ),
      neg(
        valuations
          .filter((v) => v.kind !== "component")
          .reduce(
            (sum, v) =>
              add(
                sum,
                mulRate(
                  divRate(
                    mulRatio(
                      v.fullDelta,
                      toUnits(v.heldNumerator),
                      toUnits(v.heldDenominator),
                    ),
                    transfer.basis.buyerToGroupRate,
                  ),
                  rate(v.effectiveOn, "average_rate"),
                ),
              ),
            "0",
          ),
      ),
    );
    const originalCost = toUnits(asset.acquisition_cost);
    // Income effects already earned are not rescaled by a later disposal.
    // Each group service interval is weighted by the physical portion held
    // during that interval; the disposal releases only the remaining margin.
    const translatedBuyerDep = buyerDepreciation.reduce(
      (a, l) => add(a, mulRate(l.amount, rate(l.date, "average_rate"))),
      "0",
    );
    let translatedGroupDep = "0",
      realizedMargin = "0";
    for (const line of group.plan) {
      let previous = line.startsOn,
        held = originalCost;
      for (const m of movements.filter((m) => m.date <= line.startsOn))
        held -= toUnits(m.removed_cost);
      const boundaries = movements.filter(
        (m) =>
          m.date > line.startsOn && m.date <= line.date && m.date <= cutoff,
      );
      for (const boundary of [
        ...boundaries,
        {
          date: nextCalendarDay(line.date < cutoff ? line.date : cutoff),
          removed_cost: "0",
          removed_accumulated: "0",
        },
      ]) {
        if (boundary.date > previous && previous <= cutoff) {
          const charge = add(
            accruedDepreciation(line, boundary.date),
            neg(accruedDepreciation(line, previous)),
          );
          translatedGroupDep = add(
            translatedGroupDep,
            mulRate(
              divRate(
                mulRatio(charge, held, originalCost),
                transfer.basis.buyerToGroupRate,
              ),
              rate(previous, "average_rate"),
            ),
          );
        }
        held -= toUnits(boundary.removed_cost);
        previous = boundary.date;
      }
    }
    for (const m of movements) {
      const atMovement = groupAssetPlan(
        transfer.basis.groupPlan,
        valuations.filter((v) => v.effectiveOn <= m.date),
        transfer.basis.groupUnimpaired,
      );
      const groupAt = add(
        add(transfer.basis.groupCost, atMovement.costDelta),
        neg(
          add(
            add(transfer.basis.groupAccumulated, atMovement.accumulatedDelta),
            splitDepreciationPlan(atMovement.plan, m.date).accrued,
          ),
        ),
      );
      const groupRemoved = mulRate(
        divRate(
          m.group_component
            ? add(
                m.group_component.removedCost!,
                neg(m.group_component.removedAccumulated!),
              )
            : mulRatio(groupAt, toUnits(m.removed_cost), originalCost),
          transfer.basis.buyerToGroupRate,
        ),
        rate(m.date, "current_rate"),
      );
      realizedMargin = add(
        realizedMargin,
        add(
          mulRate(
            add(m.removed_cost, neg(m.removed_accumulated)),
            rate(m.date, "current_rate"),
          ),
          neg(groupRemoved),
        ),
      );
    }
    const depreciationAdjustment = add(
      translatedGroupDep,
      neg(translatedBuyerDep),
    );
    const target = measureAssetTransferElimination(transfer.basis, {
      asOf: cutoff,
      currentBuyerRate,
      depreciationAdjustment,
      realizedMargin,
      valuationAdjustment,
      groupAccumulatedDelta: group.accumulatedDelta,
      groupCostDelta: group.costDelta,
      groupPlan: group.plan,
      reversed: transfer.reversed_on !== null && transfer.reversed_on <= cutoff,
      buyerCost: String(value.cost),
      buyerAccumulated: String(value.accumulated),
      disposed:
        value.disposed ||
        (transfer.reversed_on !== null && transfer.reversed_on <= cutoff),
      remainingFraction: {
        numerator: toUnits(String(value.cost)),
        denominator: toUnits(asset.acquisition_cost),
      },
    });
    const prior = (
      await tx.execute<{ account_id: string; amount: string }>(
        sql`with recursive history(id) as (select journal_entry_id from asset_transfer_consolidation_entries where org_id=${orgId} and transfer_id=${transfer.id} union select e.id from journal_entries e join history h on e.reverses_entry_id=h.id where e.org_id=${orgId}) select l.account_id,sum(l.amount)::text as amount from history h join journal_entries e on e.id=h.id and e.org_id=${orgId} join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id where e.status in('posted','reversed') and e.posting_date<=${cutoff} group by l.account_id`,
      )
    ).rows;
    if (transfer.basis.nci) {
      const sellerLoss = (
        await tx.execute<{ effective_on: string }>(
          sql`select loss.effective_on::text from consolidation_control_losses loss join asset_transfer_bases b on b.org_id=loss.org_id and b.id=${transfer.id} where loss.org_id=${orgId} and loss.reversed_by_change_id is null and loss.excluded_subsidiary_ids ? b.seller_subsidiary_id::text order by loss.effective_on limit 1`,
        )
      ).rows[0];
      if (sellerLoss) {
        const nciIds = [
          ...new Set(
            nciAllocations(transfer.basis).flatMap((nci) => [
              nci.equityAccountId,
              nci.incomeAccountId,
            ]),
          ),
        ];
        const pinned = (
          await tx.execute<{ account_id: string; amount: string }>(
            sql`select l.account_id,sum(l.amount)::text as amount from asset_transfer_consolidation_entries c join journal_entries e on e.id=c.journal_entry_id and e.org_id=c.org_id join journal_lines l on l.entry_id=e.id and l.org_id=e.org_id where c.org_id=${orgId} and c.transfer_id=${transfer.id} and e.status in('posted','reversed') and e.posting_date<=${sellerLoss.effective_on} and l.account_id=any(${uuidArray(nciIds)}::uuid[]) group by l.account_id`,
          )
        ).rows;
        for (const id of nciIds)
          target[id] = pinned.find((l) => l.account_id === id)?.amount ?? "0";
      }
    }
    const ids = new Set([
      ...Object.keys(target),
      ...prior.map((p) => p.account_id),
    ]);
    const lines = [...ids]
      .map((accountId) => ({
        accountId,
        subsidiaryId: transfer.elimination_subsidiary_id,
        amount: add(
          target[accountId] ?? "0",
          neg(prior.find((p) => p.account_id === accountId)?.amount ?? "0"),
        ),
      }))
      .filter((l) => !isZero(l.amount));
    if (!lines.length) continue;
    const context = await loadSubsidiaryContext(tx, orgId),
      entity = context.byId.get(transfer.elimination_subsidiary_id);
    if (
      !entity?.isActive ||
      !entity.isElimination ||
      entity.baseCurrency !== transfer.group_currency
    )
      throw new Error(
        "restore the transfer's active elimination entity and currency before consolidating",
      );
    await assertPeriodModulesOpen(tx, {
      orgId,
      periodId,
      bookId: transfer.book_id,
      subsidiaryIds: [entity.id],
      modules: ["assets"],
    });
    const accounts = (
      await tx.execute<{ id: string }>(
        sql`select id from accounts where org_id=${orgId} and id=any(${uuidArray(lines.map((l) => l.accountId))}::uuid[]) and is_active and not is_summary for share`,
      )
    ).rows;
    if (accounts.length !== new Set(lines.map((l) => l.accountId)).size)
      throw new Error(
        "asset transfer consolidation requires active posting accounts",
      );
    await validateSubsidiaryRestrictions(tx, {
      orgId,
      ctx: context,
      docSubsidiaryId: entity.id,
      lines,
    });
    assertFinalKernelBalance(lines);
    const id = randomUUID();
    await tx.execute(
      sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin,created_by,updated_by) values(${id},${orgId},${transfer.book_id},${entity.id},${`AST-ELIM-${id}`},${cutoff},${periodId},${`Asset transfer consolidation ${period.name}`},'draft','translation',${actorId},${actorId})`,
    );
    for (const [i, line] of lines.entries())
      await tx.execute(
        sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,memo) values(${orgId},${id},${i + 1},${line.accountId},${entity.id},${line.amount},${entity.baseCurrency},${line.amount},1,'Asset transfer group basis')`,
      );
    const posted = await tx.execute(
      sql`update journal_entries set status='posted',posted_at=now(),posted_by=${actorId} where org_id=${orgId} and id=${id} and status='draft' returning id`,
    );
    if (posted.rows.length !== 1)
      throw new Error("asset transfer consolidation was not posted");
    await tx.execute(
      sql`insert into asset_transfer_consolidation_entries(org_id,transfer_id,period_id,journal_entry_id,target_balances,created_by) values(${orgId},${transfer.id},${periodId},${id},${JSON.stringify(target)}::jsonb,${actorId})`,
    );
    entries.push(id);
  }
  return entries;
}
