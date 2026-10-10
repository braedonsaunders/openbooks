import { sql } from "drizzle-orm";

/**
 * Item kinds that are never stock-received, so their purchase-order lines
 * bill on a two-way match (ordered quantity + price). Every other kind —
 * including an unknown or missing kind — requires the receipt leg of the
 * match. Lives in records (below payables, ledger, and inventory) so every
 * matching, posting, and receiving reader classifies kinds identically.
 */
export const RECEIPT_EXEMPT_ITEM_KINDS: ReadonlySet<string> = new Set([
  "service",
  "non_inventory",
  "other_charge",
  "equipment_charge",
  "labor",
  "absence",
  "discount",
  // A gift card is a liability sale, never stocked goods.
  "gift_card",
]);

export const receiptExemptItemKindsSql = sql.join(
  [...RECEIPT_EXEMPT_ITEM_KINDS].map((kind) => sql`${kind}`),
  sql`, `,
);

export function lineRequiresReceipt(
  itemKind: string | null | undefined,
): boolean {
  return (
    typeof itemKind !== "string" || !RECEIPT_EXEMPT_ITEM_KINDS.has(itemKind)
  );
}
