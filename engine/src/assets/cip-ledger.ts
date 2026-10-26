import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { add, cmp } from "../money/money.ts";
import { cipOpenBalance } from "./cip-math.ts";
import { refuse } from "./asset-refusal.ts";

/**
 * The construction-in-progress subledger balance and the one writer that
 * keeps a CIP record's carried cost equal to it. The record's
 * acquisition_cost is the open balance (linked costs less posted
 * capitalizations), so the register and its reports show CIP at exactly the
 * amount sitting in the CIP account for that record.
 */

export interface CipBalance {
  linked: string;
  capitalized: string;
  expensed: string;
  open: string;
}

export async function cipBalance(
  tx: SqlExecutor,
  orgId: string,
  cipAssetId: string,
): Promise<CipBalance> {
  const [costs, capitalizations] = await Promise.all([
    tx.execute<{ amount: string; status: "linked" | "unlinked" }>(
      sql`
      select amount::text as amount, status from asset_cip_costs where org_id = ${orgId} and cip_asset_id = ${cipAssetId}`,
      "objects",
    ),
    tx.execute<{
      capitalized_amount: string;
      expensed_amount: string;
      status: "posted" | "reversed";
    }>(
      sql`
      select capitalized_amount::text as capitalized_amount, expensed_amount::text as expensed_amount, status
        from asset_cip_capitalizations where org_id = ${orgId} and cip_asset_id = ${cipAssetId}`,
      "objects",
    ),
  ]);
  return cipOpenBalance(
    costs,
    capitalizations.map((row) => ({
      capitalizedAmount: row.capitalized_amount,
      expensedAmount: row.expensed_amount,
      status: row.status,
    })),
  );
}

/**
 * Recompute the open balance and write it to the record, closing the record
 * as 'capitalized' when a capitalization emptied it (and reopening it when a
 * reversal refills it). A negative balance is refused: capitalization can
 * never take more than the linked costs, and unlinking a cost already
 * capitalized must wait for the capitalization's reversal.
 */
export async function syncCipCarriedCost(
  tx: SqlExecutor,
  args: { orgId: string; cipAssetId: string; actorId: string; closeWhenEmpty: boolean },
): Promise<CipBalance> {
  const before = (
    await tx.execute<{ status: string; acquisition_cost: string; asset_number: string }>(
      sql`
    select status, acquisition_cost::text as acquisition_cost, asset_number from fixed_assets
     where org_id = ${args.orgId} and id = ${args.cipAssetId} for update`,
      "objects",
    )
  )[0];
  if (!before)
    refuse("cip_not_found", "construction-in-progress record not found", { status: 404 });
  if (before.status !== "construction" && before.status !== "capitalized") {
    refuse("not_cip", `asset ${before.asset_number} is not a construction-in-progress record`);
  }
  const balance = await cipBalance(tx, args.orgId, args.cipAssetId);
  if (cmp(balance.open, "0") < 0) {
    refuse(
      "cip_balance_negative",
      `construction in progress ${before.asset_number} would carry a negative balance (${balance.open})`,
      {
        remedy:
          "Reverse the capitalization that consumed this cost before unlinking or reversing it.",
      },
    );
  }
  const status =
    cmp(balance.open, "0") === 0 && args.closeWhenEmpty && cmp(balance.linked, "0") > 0
      ? "capitalized"
      : cmp(balance.open, "0") > 0
        ? "construction"
        : before.status;
  if (status === before.status && cmp(balance.open, before.acquisition_cost) === 0) return balance;
  // The guard admits CIP cost changes only while this transaction-local
  // switch is on; a failure aborts the transaction and discards it with it.
  await tx.execute(sql`select set_config('openbooks.asset_cip_ledger', 'on', true)`);
  const updated = (
    await tx.execute<{ id: string }>(
      sql`
    update fixed_assets
       set acquisition_cost = ${add(balance.open, "0")}, status = ${status},
           updated_at = clock_timestamp(), updated_by = ${args.actorId}
     where org_id = ${args.orgId} and id = ${args.cipAssetId}
     returning id`,
      "objects",
    )
  )[0];
  await tx.execute(sql`select set_config('openbooks.asset_cip_ledger', 'off', true)`);
  if (!updated)
    throw new Error(
      `construction in progress ${before.asset_number} was not updated; no row changed`,
    );
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'fixed_assets', ${args.cipAssetId}, 'update',
            ${JSON.stringify({
              before: { status: before.status, acquisition_cost: before.acquisition_cost },
              after: { status, acquisition_cost: balance.open },
              subledger: balance,
            })}::jsonb, ${args.actorId})`);
  return balance;
}
