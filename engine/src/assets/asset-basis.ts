import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { add, fromUnits, mulRatio, neg, toUnits } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";

export interface AssetBasisDelta {
  unitsRemaining: string | null;
  depreciableAfter: string | null;
  cost: string;
  accumulated: string;
  salvage: string;
  impairmentReleased: string;
  cutoff: string | null;
}
/** Acquisition and posted depreciation are never rewritten by a partial disposal. */
export async function assetBasisDelta(
  tx: SqlExecutor,
  orgId: string,
  assetId: string,
  bookId: string,
  asOf?: string,
): Promise<AssetBasisDelta> {
  return (
    await tx.execute<AssetBasisDelta>(sql`
    select coalesce(sum(cost_delta),0)::text as cost,
           coalesce(sum(accumulated_delta),0)::text as accumulated,
           coalesce(sum(salvage_delta),0)::text as salvage,
           coalesce(sum(impairment_released),0)::text as "impairmentReleased",
           max(effective_on)::text as cutoff,
           (select latest.units_remaining::text from asset_basis_changes latest where latest.org_id=${orgId} and latest.asset_id=${assetId} and latest.book_id=${bookId} ${asOf ? sql`and latest.effective_on<=${asOf}` : sql``} order by latest.effective_on desc,latest.ordinal desc limit 1) as "unitsRemaining",
           (select latest.depreciable_after::text from asset_basis_changes latest where latest.org_id=${orgId} and latest.asset_id=${assetId} and latest.book_id=${bookId} ${asOf ? sql`and latest.effective_on<=${asOf}` : sql``} order by latest.effective_on desc,latest.ordinal desc limit 1) as "depreciableAfter"
      from asset_basis_changes where org_id=${orgId} and asset_id=${assetId} and book_id=${bookId}
        ${asOf ? sql`and effective_on<=${asOf}` : sql``}
  `)
  ).rows[0]!;
}
function money(value: string, name: string): string {
  const result = canonicalDecimal(value, 4);
  if (
    result === null ||
    result.replace(/^-/, "").split(".")[0]!.replace(/^0+/, "").length > 15
  )
    throw new Error(`${name} must be an exact ledger amount`);
  return fromUnits(toUnits(result));
}
/** IAS 16.67–72: remove the identified component's cost AND accumulated
 * depreciation. A homogeneous fraction is optional; a separately measured
 * component supplies its own carrying amounts, never a guessed average. */
export function measurePartialDisposal(args: {
  cost: string;
  accumulated: string;
  salvage: string;
  proceeds: string;
  portion:
    | { percent: string }
    | { cost: string; accumulated: string; salvage: string };
}) {
  const cost = money(args.cost, "cost"),
    accumulated = money(args.accumulated, "accumulated depreciation"),
    salvage = money(args.salvage, "residual value"),
    proceeds = money(args.proceeds, "proceeds");
  if (
    toUnits(cost) <= 0n ||
    toUnits(accumulated) < 0n ||
    toUnits(accumulated) > toUnits(cost) ||
    toUnits(salvage) < 0n ||
    toUnits(proceeds) < 0n
  )
    throw new Error(
      "disposal requires a positive cost and non-negative carrying amounts and proceeds",
    );
  let removedCost: string, removedAccumulated: string, removedSalvage: string;
  if ("percent" in args.portion) {
    const pct = toUnits(money(args.portion.percent, "disposed percentage"));
    if (pct <= 0n || pct > toUnits("100"))
      throw new Error(
        "disposed percentage must be greater than zero and at most 100",
      );
    removedCost = mulRatio(cost, pct, toUnits("100"));
    removedAccumulated = mulRatio(accumulated, pct, toUnits("100"));
    removedSalvage = mulRatio(salvage, pct, toUnits("100"));
  } else {
    removedCost = money(args.portion.cost, "component cost");
    removedAccumulated = money(
      args.portion.accumulated,
      "component accumulated depreciation",
    );
    removedSalvage = money(args.portion.salvage, "component residual value");
  }
  const remainingCost = add(cost, neg(removedCost)),
    remainingAccumulated = add(accumulated, neg(removedAccumulated)),
    remainingSalvage = add(salvage, neg(removedSalvage));
  if (
    toUnits(removedCost) <= 0n ||
    toUnits(removedCost) > toUnits(cost) ||
    toUnits(removedAccumulated) < 0n ||
    toUnits(removedAccumulated) > toUnits(accumulated) ||
    toUnits(removedAccumulated) > toUnits(removedCost) ||
    toUnits(removedSalvage) < 0n ||
    toUnits(removedSalvage) > toUnits(salvage) ||
    toUnits(removedSalvage) >
      toUnits(removedCost) - toUnits(removedAccumulated) ||
    toUnits(remainingAccumulated) < 0n ||
    toUnits(remainingAccumulated) > toUnits(remainingCost) ||
    toUnits(remainingSalvage) >
      toUnits(remainingCost) - toUnits(remainingAccumulated)
  )
    throw new Error(
      "component amounts must leave valid cost, accumulated depreciation and residual value on both portions",
    );
  const removedCarrying = add(removedCost, neg(removedAccumulated));
  return {
    removedCost,
    removedAccumulated,
    removedSalvage,
    removedCarrying,
    remainingCost,
    remainingAccumulated,
    remainingSalvage,
    proceeds,
    gainLoss: add(proceeds, neg(removedCarrying)),
    full: toUnits(remainingCost) === 0n,
  };
}
