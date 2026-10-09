import { sql } from "drizzle-orm";
import { abs, add, cmp, neg } from "../money/money.ts";
import { InventoryError, type Runner } from "./contracts.ts";

/** Tolerance is an absolute quantity in the item's base unit, snapshotted per line. */
export function requiresSecondCount(
  expected: string,
  first: string | null,
  tolerance: string | null,
): boolean {
  return (
    first !== null &&
    tolerance !== null &&
    cmp(abs(add(first, neg(expected))), tolerance) > 0
  );
}
export async function countTolerance(
  runner: Runner,
  orgId: string,
  itemId: string,
  subsidiaryId: string,
  date: string,
): Promise<string> {
  const row = (
    await runner.execute<{
      abc_class: string | null;
      variance_tolerance: string | null;
    }>(sql`
    select profile.abc_class,policy.variance_tolerance::text from item_inventory_profiles profile
    left join inventory_count_policies policy on policy.org_id=profile.org_id and policy.abc_class=profile.abc_class
      and policy.subsidiary_id=${subsidiaryId} and policy.effective_from<=${date}::date
      and (policy.effective_to is null or policy.effective_to>${date}::date)
    where profile.org_id=${orgId} and profile.item_id=${itemId}`)
  ).rows[0];
  if (!row) throw new InventoryError("Item has no inventory profile");
  if (row.abc_class && row.variance_tolerance === null)
    throw new InventoryError(
      `Configure an effective ${row.abc_class} cycle-count policy for this legal entity in Setup before creating the count`,
    );
  // Unclassified stock requires a second observation for every variance.
  return row.variance_tolerance ?? "0.0000";
}
export async function assertSecondCounts(
  runner: Runner,
  orgId: string,
  countId: string,
): Promise<void> {
  const firstMissing = (
    await runner.execute(sql`select id from stock_count_lines where org_id=${orgId} and stock_count_id=${countId}
    and variance_tolerance is not null and counted_quantity is not null and first_counted_quantity is null limit 1`)
  ).rows;
  if (firstMissing.length)
    throw new InventoryError(
      "First count observation is missing — record the first quantity before submitting or posting",
    );
  const missing = (
    await runner.execute(sql`select id from stock_count_lines where org_id=${orgId} and stock_count_id=${countId}
    and variance_tolerance is not null and abs(first_counted_quantity-expected_quantity)>variance_tolerance
    and (second_counted_quantity is null or second_counted_quantity<>counted_quantity or second_counted_at is null)`)
  ).rows;
  if (missing.length)
    throw new InventoryError(
      `${missing.length} count lines exceed their tolerance — record a second blind count before submitting or posting`,
    );
}
