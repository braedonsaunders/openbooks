import { saleableLocation, unheldTracking } from "./stock-eligibility.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { fromUnits, isZero, normalizeMoney, toUnits } from "../money/money.ts";
import { unitCostPerQuantity } from "./costing.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { assertPeriodModulesOpen, CloseError } from "../periods/period-policy.ts";

export function persistReceiptMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new InventoryError(`${label} must be an exact decimal`);
  let amount: string;
  try {
    amount = normalizeMoney(exact);
  } catch {
    throw new InventoryError(`${label} must be an exact decimal`);
  }
  // Every caller lands in numeric(19,4) columns (movements, order lines,
  // landed costs): fifteen whole digits. A pasted wider figure normalized
  // fine and died only at the insert with a storage error — fail closed
  // here, once, for receipts, issues, transfers, builds, and landed costs.
  if (amount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
    throw new InventoryError(`${label} is out of range — at most 15 whole digits fit the ledger`);
  }
  return amount;
}

/** Primary accounting book id. */
export async function primaryBookId(orgId: string, runner: Runner = db): Promise<string> {
  const r = await runner.execute<{ id: string }>(
    sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl limit 1 for share`,
    "objects",
  );
  if (!r[0]) throw new InventoryError("no active primary posting book");
  return r[0].id;
}

export async function periodForDate(
  orgId: string,
  date: string,
  runner: Runner = db,
): Promise<string | null> {
  // Through the shared covering-period resolver (default calendar,
  // deterministic under overlaps); signature kept for the receipt,
  // revaluation, landed-cost and vendor-credit callers.
  return (await resolveCoveringPeriod(runner, orgId, date))?.id ?? null;
}

export async function subsidiaryCurrency(
  orgId: string,
  subsidiaryId: string,
  runner: Runner = db,
): Promise<string> {
  const r = await runner.execute<{ base_currency: string }>(
    sql`
    select base_currency from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}`,
    "objects",
  );
  if (!r[0]) throw new InventoryError("subsidiary not found");
  return r[0].base_currency;
}

/** Current on-hand quantity and value for an item at a location (from layers). */
export async function getOnHand(
  orgId: string,
  itemId: string,
  stockLocationId: string,
): Promise<{ quantity: string; value: string; unitCost: string }> {
  return getOnHandWith(db, orgId, itemId, stockLocationId);
}

/**
 * On-hand quantity and value for ONE legal entity's layers at a position.
 * Revaluation measures each owner separately so a shared warehouse's other
 * entities never feed another's carrying-amount math.
 */
export async function getOnHandForEntity(
  runner: Runner,
  orgId: string,
  itemId: string,
  stockLocationId: string,
  subsidiaryId: string,
): Promise<{ quantity: string; value: string; unitCost: string }> {
  return getOnHandWith(runner, orgId, itemId, stockLocationId, { subsidiaryId });
}

export async function getOnHandWith(
  runner: Runner,
  orgId: string,
  itemId: string,
  stockLocationId: string,
  selection: {
    lotId?: string | null;
    serialId?: string | null;
    saleableOnly?: boolean;
    /** Restrict availability to layers created by one originating receipt. */
    sourceReceiptMovementId?: string | null;
    /** Count only layers owned by this entity; omit to span the position. */
    subsidiaryId?: string;
  } = {},
): Promise<{ quantity: string; value: string; unitCost: string }> {
  const lotId = selection.lotId ?? null;
  const serialId = selection.serialId ?? null;
  const sourceReceiptMovementId = selection.sourceReceiptMovementId ?? null;
  const subId = selection.subsidiaryId ?? null;
  // Layer sums are scoped per legal entity so one subsidiary's availability,
  // and the average cost a receipt inherits, can never be driven by another
  // entity's stock sharing the same warehouse.
  const layerScope = sql`${subId ? sql`and cost_layers.subsidiary_id = ${subId}` : sql``}
    ${
      selection.saleableOnly
        ? sql`and ${saleableLocation(sql`cost_layers.org_id`, sql`cost_layers.stock_location_id`)}
      and exists(select 1 from inventory_movements eligibility where eligibility.org_id=cost_layers.org_id
        and eligibility.id=cost_layers.source_movement_id
        and ${unheldTracking(sql`eligibility.org_id`, sql`eligibility.lot_id`, sql`eligibility.serial_id`)})`
        : sql``
    }`;
  const provisionalOwnerScope = subId
    ? sql`and exists (
            select 1 from inventory_movements owner_mv
             where owner_mv.id = inventory_provisional_costs.issue_movement_id
               and owner_mv.org_id = ${orgId}
               and owner_mv.subsidiary_id = ${subId})`
    : sql``;
  const provisionalScope = sql`${provisionalOwnerScope}
    ${selection.saleableOnly ? sql`and ${saleableLocation(sql`inventory_provisional_costs.org_id`, sql`inventory_provisional_costs.stock_location_id`)}` : sql``}`;
  const r = await runner.execute<{ quantity: string; value: string }>(
    sql`
    select (coalesce((select sum(remaining_quantity) from cost_layers
                       where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}
                         ${layerScope}
                         and (${sourceReceiptMovementId}::uuid is null or source_movement_id = ${sourceReceiptMovementId}::uuid)
                         and (${lotId}::uuid is null and ${serialId}::uuid is null
                              or exists (
                                select 1 from inventory_movements source
                                 where source.id = cost_layers.source_movement_id
                                   and source.org_id = ${orgId}
                                   and (${lotId}::uuid is null or source.lot_id = ${lotId}::uuid)
                                   and (${serialId}::uuid is null or source.serial_id = ${serialId}::uuid)
                              ))),0)
            - coalesce((select sum(remaining_quantity) from inventory_provisional_costs
                         where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}
                           ${provisionalScope}
                           and ${sourceReceiptMovementId}::uuid is null
                           and ${lotId}::uuid is null and ${serialId}::uuid is null),0))::text as quantity,
           (coalesce((select sum(round(remaining_quantity * unit_cost,4)) from cost_layers
                       where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}
                         ${layerScope}
                         and (${sourceReceiptMovementId}::uuid is null or source_movement_id = ${sourceReceiptMovementId}::uuid)
                         and (${lotId}::uuid is null and ${serialId}::uuid is null
                              or exists (
                                select 1 from inventory_movements source
                                 where source.id = cost_layers.source_movement_id
                                   and source.org_id = ${orgId}
                                   and (${lotId}::uuid is null or source.lot_id = ${lotId}::uuid)
                                   and (${serialId}::uuid is null or source.serial_id = ${serialId}::uuid)
                              ))),0)
            - coalesce((select sum(round(remaining_quantity * provisional_unit_cost,4)) from inventory_provisional_costs
                         where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}
                           ${provisionalScope}
                           and ${sourceReceiptMovementId}::uuid is null
                           and ${lotId}::uuid is null and ${serialId}::uuid is null),0))::text as value`,
    "objects",
  );
  const quantity = r[0]?.quantity ?? "0";
  const value = r[0]?.value ?? "0";
  const unitCost = isZero(quantity) ? "0" : unitCostPerQuantity(value, quantity)!;
  return {
    quantity: fromUnits(toUnits(quantity)),
    value: fromUnits(toUnits(value)),
    unitCost,
  };
}

/**
 * Canonical lock order for every inventory mutation: fence the position
 * BEFORE the transaction takes any row lock (feature share-locks, book
 * reads, layer locks). Ledger posting ends every mutation with an orgs
 * FOR UPDATE, so a transaction that takes row locks first and fences second
 * deadlocks against a peer that fenced first and posts second (40P01) —
 * each waits on a lock the other holds. Fence-first makes every waiter
 * hold nothing its peer's posting path needs, so contenders serialize.
 * Positions must therefore be known (or discovered lock-free) before this
 * call; multi-position operations fence the sorted key set.
 */
export async function lockInventoryPosition(
  tx: Runner,
  itemId: string,
  stockLocationId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`inventory:${itemId}:${stockLocationId}`},0)),
      set_config('openbooks.inventory_original_cost_writer','basis-v1',true)`,
  );
}

/** The position an issue draws from, as the on-hand read scopes it. */
export interface IssueDrawScope {
  itemId: string;
  stockLocationId: string;
  subsidiaryId: string;
  lotId?: string | null;
  serialId?: string | null;
  /** Restrict the draw to one receipt's layers. */
  sourceReceiptMovementId?: string | null;
}

/** A quantity already drawn by an earlier line of the same posting. */
export interface PriorIssueDraw {
  lotId: string | null;
  serialId: string | null;
  quantity: string;
}

/**
 * Stock-on-date coverage for a backdated outbound movement (issue or transfer
 * source). A movement dated before a posted movement at its position must be
 * covered by the stock that was on hand on its own date: a receipt dated later
 * cannot supply it, even when stock on hand today would. A movement dated on or
 * after every posted movement needs no such check, since the current on-hand
 * read already answers it.
 *
 * Quantities are the posted movements dated on or before `date` (reversals
 * are posted movements with signed quantities, so a reversed receipt nets to
 * zero from its reversal date onward). Scope matches the on-hand read: one
 * legal entity, and the lot or serial when the draw names one. `priorDraws`
 * carries quantities this posting has already drawn but not yet written, so
 * lines drawing overlapping stock within one posting are counted together.
 *
 * Returns the refusal message, or null when the issue is covered. The caller
 * holds the position fence (`lockInventoryPosition`).
 */
export async function backdatedIssueShortage(
  runner: Runner,
  orgId: string,
  scope: IssueDrawScope,
  date: string,
  quantity: string,
  priorDraws: PriorIssueDraw[] = [],
  movement: "issue" | "transfer" = "issue",
): Promise<string | null> {
  const lotId = scope.lotId ?? null;
  const serialId = scope.serialId ?? null;
  const receiptId = scope.sourceReceiptMovementId ?? null;
  const r = await runner.execute<{
    backdated: boolean;
    on_hand: string;
    receipt_dated: boolean | null;
  }>(
    sql`
    select exists (
             select 1 from inventory_movements later
              where later.org_id = ${orgId} and later.item_id = ${scope.itemId}
                and later.stock_location_id = ${scope.stockLocationId}
                and later.status = 'posted' and later.moved_at::date > ${date}::date) as backdated,
           coalesce((select sum(m.quantity) from inventory_movements m
                      where m.org_id = ${orgId} and m.item_id = ${scope.itemId}
                        and m.stock_location_id = ${scope.stockLocationId}
                        and m.subsidiary_id = ${scope.subsidiaryId}
                        and m.status = 'posted' and m.moved_at::date <= ${date}::date
                        and (${lotId}::uuid is null or m.lot_id = ${lotId}::uuid)
                        and (${serialId}::uuid is null or m.serial_id = ${serialId}::uuid)), 0)::text as on_hand,
           (select r.moved_at::date <= ${date}::date from inventory_movements r
             where r.org_id = ${orgId} and r.id = ${receiptId}::uuid) as receipt_dated`,
    "objects",
  );
  const row = r[0];
  if (!row || !row.backdated) return null;

  let onHand = toUnits(row.on_hand);
  // A receipt dated after the issue had nothing on hand on the issue date.
  // An unresolved receipt identity also counts as nothing: fail closed.
  if (receiptId !== null && row.receipt_dated !== true) onHand = 0n;
  let requested = toUnits(quantity);
  const overlaps = (a: string | null, b: string | null) => a === null || b === null || a === b;
  for (const draw of priorDraws) {
    if (overlaps(lotId, draw.lotId) && overlaps(serialId, draw.serialId))
      requested += toUnits(draw.quantity);
  }
  if (onHand >= requested) return null;

  const labels = (
    await runner.execute<{ item: string; location: string | null }>(
      sql`
    select coalesce(nullif(btrim(i.code), ''), i.name) as item, l.code as location
      from items i left join stock_locations l on l.org_id = i.org_id and l.id = ${scope.stockLocationId}
     where i.org_id = ${orgId} and i.id = ${scope.itemId}`,
      "objects",
    )
  )[0];
  const item = labels?.item ?? scope.itemId;
  const location = labels?.location ? ` at ${labels.location}` : "";
  return `Item ${item}${location} had ${fromUnits(onHand)} on hand on ${date} but the ${movement} needs ${fromUnits(requested)} — date the ${movement} on or after the receipt that brings the stock in, or receive it first.`;
}

/**
 * The message an inventory posting into this covering period would be refused
 * with, or null when the GL accepts it. Same fence as postInventoryEntry; callers
 * that need a remedy name the period instead of relaying the raw closure text.
 */
export async function inventoryPeriodClosure(
  runner: Runner,
  orgId: string,
  periodId: string,
  bookId: string,
  subsidiaryIds: string[],
): Promise<string | null> {
  try {
    await assertPeriodModulesOpen(runner, { orgId, periodId, bookId, subsidiaryIds, modules: [] });
    return null;
  } catch (error) {
    if (error instanceof CloseError) return error.message;
    throw error;
  }
}

export function assertInventoryDate(value: string, label: string): void {
  if (!isIsoCalendarDate(value)) {
    throw new InventoryError(`${label} must be a valid YYYY-MM-DD date`);
  }
}
