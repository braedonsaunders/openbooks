import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { toBaseQuantity } from "./costing.ts";
import { InventoryError, InventoryOwnershipError, type InventoryProfile, type Runner } from "./contracts.ts";
import { assertStockLocationAdmitsSubsidiary, assertMovementOwner } from "./profile-policy.ts";

// ---------------------------------------------------------------------------
// Document integration — bill receipts & invoice/shipment issues
// ---------------------------------------------------------------------------

export interface DocumentInventoryLine {
  lineId: string;
  lineNumber: number;
  itemId: string;
  stockLocationId: string;
  /** base-unit quantity for the line. Always positive: negative-quantity
   * inventory lines are refused at load time (see below), never absorbed. */
  quantity: string;
  /** line extended amount (for unit-cost derivation on receipts). */
  amount: string;
  assetAccountId: string;
  clearingAccountId: string | null;
  adjustmentAccountId: string | null;
  varianceAccountId: string | null;
  costingMethod: InventoryProfile["costingMethod"];
  tracking: InventoryProfile["tracking"];
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  custom: unknown;
}

/** The one active stock location, when the org has exactly one (else null). */
async function defaultStockLocation(
  runner: Runner,
  orgId: string,
): Promise<string | null> {
  const r = (await runner.execute<{ id: string }>(sql`
    select id from stock_locations where org_id = ${orgId} and is_active`));
  return r.rows.length === 1 ? r.rows[0]!.id : null;
}

/**
 * The inventory lines of a document: item has a costing profile AND a stock
 * location resolves (line-level, else the single default). Shared by the
 * posting-rule account router and the receipt/issue hooks so they always agree
 * on which lines are inventory.
 *
 * A profiled item never becomes a non-inventory line merely because its
 * warehouse is missing, inactive, foreign, or restricted to another legal
 * entity. Refuse the document with the offending line named; movement code
 * re-checks the same location under its own transaction before changing stock.
 */
export async function loadDocumentInventoryLines(
  runner: Runner,
  orgId: string,
  documentId: string,
): Promise<DocumentInventoryLine[]> {
  const fallback = await defaultStockLocation(runner, orgId);
  const r = (await runner.execute<{
      line_id: string;
      line_number: number;
      item_id: string;
      quantity: string;
      unit: string | null;
      amount: string;
      stock_location_id: string | null;
      document_subsidiary_id: string | null;
      document_kind: string;
      base_unit: string;
      unit_conversions: unknown;
      asset_account_id: string;
      received_not_billed_account_id: string | null;
      adjustment_account_id: string | null;
      variance_account_id: string | null;
      costing_method: InventoryProfile["costingMethod"];
      tracking: InventoryProfile["tracking"];
      department_id: string | null;
      project_id: string | null;
      location_id: string | null;
      custom: unknown;
    }>(sql`
    select dl.id as line_id, dl.line_number, dl.item_id, dl.quantity, dl.unit, dl.amount,
           dl.stock_location_id, d.subsidiary_id as document_subsidiary_id,
           d.kind as document_kind,
           p.asset_account_id, p.received_not_billed_account_id,
           p.adjustment_account_id, p.variance_account_id, p.costing_method,
           p.tracking, p.base_unit, p.unit_conversions,
           coalesce(dl.department_id, d.department_id) as department_id,
           coalesce(dl.project_id, d.project_id) as project_id,
           coalesce(dl.location_id, d.location_id) as location_id,
           dl.custom
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
      join item_inventory_profiles p on p.item_id = dl.item_id and p.org_id = dl.org_id
     where dl.document_id = ${documentId} and dl.org_id = ${orgId}
       and dl.item_id is not null and dl.quantity <> 0
     order by dl.line_number`));
  if (r.rows.length === 0) return [];
  const ctx = await loadSubsidiaryContext(runner, orgId);
  const subsidiaryId = r.rows[0]!.document_subsidiary_id ?? ctx.rootId;
  assertMovementOwner(ctx, subsidiaryId);
  const out: DocumentInventoryLine[] = [];
  for (const row of r.rows) {
    const loc = row.stock_location_id ?? fallback;
    const lineLabel = `document line ${row.line_number} (item ${row.item_id})`;
    if (!loc) {
      throw new InventoryError(
        `${lineLabel}: inventory item requires a stock location and the ` +
          "organization does not have exactly one active stock location to " +
          "fall back to; assign a warehouse to the line and retry",
      );
    }
    try {
      await assertStockLocationAdmitsSubsidiary(
        runner,
        orgId,
        ctx,
        loc,
        subsidiaryId,
      );
    } catch (error) {
      if (error instanceof InventoryOwnershipError) {
        throw new InventoryOwnershipError(`${lineLabel}: ${error.message}`);
      }
      if (error instanceof InventoryError) {
        throw new InventoryError(`${lineLabel}: ${error.message}`);
      }
      throw error;
    }
    // A negative-quantity inventory line is never a return: sales returns
    // restore stock at original cost through a customer credit carrying
    // custom.inventoryReturn evidence, and purchase returns relieve it
    // through a vendor credit. Absorbing the sign here issued stock on a
    // "return" invoice line (revenue down, inventory down too) and priced
    // bill lines at a negative unit cost, so refuse with the flow that
    // actually exists for this document kind.
    const rawQuantity = toUnits(row.quantity);
    if (rawQuantity < 0n) {
      throw new InventoryError(
        `${lineLabel} has a negative quantity (${row.quantity}); ${negativeLineRemedy(row.document_kind)}`,
      );
    }
    // The line quantity is raised in the line's unit; stock moves in the
    // item's base unit. Convert here — once — so receipts, issues, returns,
    // and fulfillment/goods-receipt legs all agree, and refuse an
    // unconvertible unit instead of silently moving 1:1.
    const quantity = toBaseQuantity(
      fromUnits(rawQuantity),
      row.unit,
      parseUnitConversions(row.unit_conversions, lineLabel),
      row.base_unit,
      lineLabel,
    );
    out.push({
      lineId: row.line_id,
      lineNumber: row.line_number,
      itemId: row.item_id,
      stockLocationId: loc,
      quantity,
      amount: row.amount,
      assetAccountId: row.asset_account_id,
      clearingAccountId: row.received_not_billed_account_id,
      adjustmentAccountId: row.adjustment_account_id,
      varianceAccountId: row.variance_account_id,
      costingMethod: row.costing_method,
      tracking: row.tracking,
      departmentId: row.department_id,
      projectId: row.project_id,
      locationId: row.location_id,
      custom: row.custom,
    });
  }
  return out;
}

/**
 * The return flow that actually exists for a document kind, named so a
 * negative-quantity refusal tells the operator what to do instead. Both
 * remedies are live engine paths (customer/vendor credit inventory returns
 * with custom.inventoryReturn evidence), not aspirations.
 */
export function negativeLineRemedy(documentKind: string): string {
  if (documentKind === "customer_invoice") {
    return (
      "a negative invoice line is not a return — record the return on a " +
      "customer credit with custom.inventoryReturn evidence naming the " +
      "source shipment instead"
    );
  }
  if (documentKind === "vendor_bill") {
    return (
      "a negative bill line is not a return — record the return on a " +
      "vendor credit with custom.inventoryReturn evidence naming the " +
      "source receipt instead"
    );
  }
  return (
    "negative-quantity inventory lines are refused — record the return " +
    "through the customer-credit / vendor-credit return flow with " +
    "custom.inventoryReturn evidence instead"
  );
}

/**
 * The item's unit-conversion map (base units per unit) as a plain record.
 * The profile writer stores a JSON object; anything else on the row is
 * corrupt configuration, not an empty map — refuse rather than convert 1:1.
 */
function parseUnitConversions(value: unknown, lineLabel: string): Record<string, number> {
  if (value === null || value === undefined) return {};
  if (!isJsonRecord(value)) {
    throw new InventoryError(
      `${lineLabel} item's unit conversions are malformed; fix the costing profile before posting stock`,
    );
  }
  return value as Record<string, number>;
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Inventory-kind lines (inventory / assembly / kit) move stock only through
 * a costing profile. The governed paths (purchase-order receipt, sales
 * fulfillment) refuse profile-less lines outright; the profile join below
 * would otherwise skip them silently on the legacy bill/invoice paths.
 */
export async function unprofiledInventoryLines(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<{ line_number: number; item_id: string }[]> {
  return ((await runner.execute<{ line_number: number; item_id: string }>(sql`
    select dl.line_number, dl.item_id
      from document_lines dl
      join items i on i.id = dl.item_id and i.org_id = dl.org_id
     where dl.document_id = ${documentId} and dl.org_id = ${orgId}
       and dl.item_id is not null and dl.quantity <> 0
       and i.kind in ('inventory', 'assembly', 'kit')
       and not exists (
         select 1 from item_inventory_profiles p
          where p.item_id = dl.item_id and p.org_id = dl.org_id
       )
     order by dl.line_number`))).rows;
}

/** Fail before the document transaction when an inventory line has no costing
 * profile to receive it. Without this, the legacy bill-is-the-receipt path
 * posts the line as pure expense and the stock is never recorded. */
export function assertNoUnprofiledInventoryLines(
  rows: { line_number: number; item_id: string }[],
): void {
  const first = rows[0];
  if (first) {
    throw new InventoryError(
      `document line ${first.line_number} (item ${first.item_id}) is an inventory item without a costing profile`,
    );
  }
}

export function inventoryPostingEffectKey(
  documentLineId: string,
  kind: "receipt" | "issue" | "return",
): string {
  return `posting-effect:inventory:${kind}:document-line:${documentLineId}`;
}
