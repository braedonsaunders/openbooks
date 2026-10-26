import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { isFeatureEnabled } from "./features";
import { remainingOrderLine } from "./order-cycle-math";
import { INVENTORY_ITEM_KINDS } from "./order-cycle-shared";

/**
 * Source-row shapes and the inventory-kind probe for order conversion.
 *
 * Split from the convert module so each module stays within the line bound.
 */
export type OrderSourceRow = Record<string, unknown> & {
  work_completed_on?: string | null;
  id: string;
  kind: string;
  status: string;
  party_id: string | null;
  currency: string;
  fx_rate: string;
  document_date: string;
  due_date: string | null;
  subsidiary_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  extra_dims: unknown;
  memo: string | null;
  billing_method: string | null;
};

export type OrderConvertLineRow = Record<string, unknown> & {
  work_from?: string | null;
  work_to?: string | null;
  id: string;
  line_number: number;
  item_id: string | null;
  account_id: string | null;
  description: string | null;
  quantity: string;
  unit: string | null;
  unit_price: string;
  amount: string;
  tax_code_id: string | null;
  tax_group_id: string | null;
  tax_amount: string;
  marketplace_facilitator: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  extra_dims: unknown;
  stock_location_id: string | null;
  is_billable: boolean;
  quantity_billed: string;
  quantity_fulfilled: string;
  quantity_cancelled: string;
  /** Pricing provenance (0336): copied verbatim so lineage survives conversion. */
  price_basis: unknown;
  item_kind: string | null;
  item_income_account_id: string | null;
  item_name: string | null;
  has_inventory_profile: boolean;
};

/** True when converting `sourceId` would copy an inventory / assembly / kit line. */
export async function conversionWouldCopyInventoryKinds(
  orgId: string,
  sourceId: string,
): Promise<boolean> {
  if (await isFeatureEnabled(orgId, "inventory")) return false;
  const lines = await db.execute<{
    item_id: string | null;
    kind: string | null;
    quantity: string;
    quantity_billed: string;
    quantity_cancelled: string;
    unit_price: string;
    tax_amount: string;
  }>(
    sql`
    select line.item_id, i.kind, line.quantity, line.quantity_billed, line.quantity_cancelled,
           line.unit_price, line.tax_amount
      from document_lines line
      left join items i on i.id = line.item_id and i.org_id = line.org_id
     where line.org_id = ${orgId} and line.document_id = ${sourceId}`,
    "objects",
  );
  return lines.some((line) => {
    if (!line.item_id || !line.kind || !INVENTORY_ITEM_KINDS.has(line.kind)) return false;
    return (
      remainingOrderLine({
        quantity: String(line.quantity),
        quantityBilled: String(line.quantity_billed),
        quantityCancelled: String(line.quantity_cancelled),
        unitPrice: String(line.unit_price),
        taxAmount: String(line.tax_amount),
      }) !== null
    );
  });
}
