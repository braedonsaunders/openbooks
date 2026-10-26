import { sql } from "drizzle-orm";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { fromQuantityUnits, toQuantityUnits } from "../money/quantity.ts";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Purchase over-receipt tolerance (migration 0657): how much a goods receipt
 * may exceed a purchase-order line's remaining quantity. Both tolerances
 * default to zero, preserving exact remaining-quantity enforcement until a
 * policy is configured in Setup.
 */

export interface OverReceiptTolerance {
  /** Percent of the ordered quantity, decimal text with at most four places. */
  percent: string;
  /** Absolute quantity, decimal text with at most eight places. */
  quantity: string;
}

type Runner = Pick<SqlExecutor, "execute">;

/**
 * Resolve the tolerance for an item category on a receipt date. A row naming
 * the item's exact stored category wins; otherwise the org-wide default
 * (NULL category) applies. Only the row effective on the receipt date
 * answers — never "current". Absent policy means exact enforcement.
 */
export async function resolveOverReceiptTolerance(
  runner: Runner,
  orgId: string,
  itemCategory: string | null,
  receiptDate: string,
): Promise<OverReceiptTolerance | null> {
  const rows = await runner.execute<{ percent: string; quantity: string }>(
    sql`
    select tolerance_percent::text as percent, tolerance_quantity::text as quantity
      from purchase_over_receipt_tolerances
     where org_id = ${orgId}
       and daterange(effective_from, effective_to, '[)') @> ${receiptDate}::date
       -- The org-wide default (NULL category) answers every item; a row
       -- naming the item's exact stored category wins by the ordering below.
       and (item_category is null or item_category = ${itemCategory})
     order by (item_category is null)
     limit 1
  `,
    "objects",
  );
  const row = rows[0];
  if (!row) return null;
  return { percent: row.percent, quantity: row.quantity };
}

/**
 * Allowed excess over the remaining quantity, in quantity units: ordered ×
 * percent / 100 plus the absolute quantity. Integer division floors, so the
 * allowance never grants more than configured. Default 0/0 allows nothing.
 */
export function overReceiptAllowanceUnits(
  orderedUnits: bigint,
  tolerance: OverReceiptTolerance | null,
): bigint {
  if (!tolerance) return 0n;
  const percent = canonicalDecimal(tolerance.percent, 4);
  if (percent === null) return 0n;
  const [whole = "0", fraction = ""] = percent.split(".");
  const percentUnits = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  if (percentUnits < 0n) return 0n;
  let quantityUnits = 0n;
  try {
    quantityUnits = toQuantityUnits(tolerance.quantity);
  } catch {
    return 0n;
  }
  if (quantityUnits < 0n) return 0n;
  return (orderedUnits * percentUnits) / (100n * 10_000n) + quantityUnits;
}

/** Maximum receivable for a line: remaining plus the tolerated excess. */
export function maxReceivableUnits(
  ordered: string,
  fulfilled: string,
  tolerance: OverReceiptTolerance | null,
): bigint {
  const remaining = toQuantityUnits(ordered) - toQuantityUnits(fulfilled);
  return remaining + overReceiptAllowanceUnits(toQuantityUnits(ordered), tolerance);
}

export function formatMaxReceivable(
  ordered: string,
  fulfilled: string,
  tolerance: OverReceiptTolerance | null,
): string {
  return fromQuantityUnits(maxReceivableUnits(ordered, fulfilled, tolerance));
}
