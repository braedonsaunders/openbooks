import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, fromUnits, isZero, neg, sum, toUnits } from "./money.ts";
import {
  consumeFifo,
  extendCost,
  issueMovingAverage,
  issueStandard,
  receiveStandard,
  type CostLayer,
} from "./inventory-costing.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions } from "./subsidiaries.ts";

/**
 * Inventory subledger. Quantity and value move ONLY through this engine:
 * every valued movement creates/consumes cost layers and posts one balanced
 * journal entry through the kernel (origin = 'inventory'), so the inventory GL
 * balance always equals Σ (cost_layer.remaining × unit_cost) by construction.
 *
 * Costing follows the item's profile (engine/src/inventory-costing.ts):
 *   - fifo:            layered; issues consume oldest layers first.
 *   - moving_average:  one running layer per item+location, cost re-blended.
 *   - standard:        movements at standard cost; receipt delta is a PPV.
 *
 * Receipts DR inventory / CR an offset (GRNI / clearing / adjustment). Issues DR
 * COGS / CR inventory. Negative stock is blocked (an issue may not exceed
 * on-hand) — the safe default until a per-item "allow negative" preference lands.
 */

export interface InventoryAccounts {
  assetAccountId: string;
  cogsAccountId: string;
  adjustmentAccountId: string | null;
  varianceAccountId: string | null;
}

export interface InventoryProfile extends InventoryAccounts {
  itemId: string;
  costingMethod: "fifo" | "moving_average" | "standard";
  standardCost: string | null;
  baseUnit: string;
}

export class InventoryError extends Error {}

async function resolveProfile(orgId: string, itemId: string): Promise<InventoryProfile> {
  const r = (await db.execute(sql`
    select item_id, costing_method, asset_account_id, cogs_account_id, adjustment_account_id,
           variance_account_id, standard_cost, base_unit
      from item_inventory_profiles where org_id = ${orgId} and item_id = ${itemId}`)) as unknown as {
    rows: {
      item_id: string; costing_method: InventoryProfile["costingMethod"]; asset_account_id: string;
      cogs_account_id: string; adjustment_account_id: string | null; variance_account_id: string | null;
      standard_cost: string | null; base_unit: string;
    }[];
  };
  const p = r.rows[0];
  if (!p) throw new InventoryError(`item ${itemId} has no inventory profile`);
  return {
    itemId: p.item_id,
    costingMethod: p.costing_method,
    assetAccountId: p.asset_account_id,
    cogsAccountId: p.cogs_account_id,
    adjustmentAccountId: p.adjustment_account_id,
    varianceAccountId: p.variance_account_id,
    standardCost: p.standard_cost,
    baseUnit: p.base_unit,
  };
}

/** Primary accounting book id. */
async function primaryBookId(orgId: string): Promise<string> {
  const r = (await db.execute(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary = true limit 1`)) as unknown as {
    rows: { id: string }[];
  };
  if (!r.rows[0]) throw new InventoryError("no primary accounting book");
  return r.rows[0].id;
}

async function periodForDate(orgId: string, date: string): Promise<string | null> {
  const r = (await db.execute(sql`
    select id from accounting_periods
     where org_id = ${orgId} and is_adjustment = false and starts_on <= ${date} and ends_on >= ${date}
     limit 1`)) as unknown as { rows: { id: string }[] };
  return r.rows[0]?.id ?? null;
}

async function subsidiaryCurrency(orgId: string, subsidiaryId: string): Promise<string> {
  const r = (await db.execute(sql`
    select base_currency from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}`)) as unknown as {
    rows: { base_currency: string }[];
  };
  if (!r.rows[0]) throw new InventoryError("subsidiary not found");
  return r.rows[0].base_currency;
}

/** Current on-hand quantity and value for an item at a location (from layers). */
export async function getOnHand(
  orgId: string,
  itemId: string,
  stockLocationId: string,
): Promise<{ quantity: string; value: string; unitCost: string }> {
  const r = (await db.execute(sql`
    select coalesce(sum(remaining_quantity), 0) as quantity,
           coalesce(sum(round(remaining_quantity * unit_cost, 4)), 0) as value
      from cost_layers where org_id = ${orgId} and item_id = ${itemId} and stock_location_id = ${stockLocationId}`)) as unknown as {
    rows: { quantity: string; value: string }[];
  };
  const quantity = r.rows[0]?.quantity ?? "0";
  const value = r.rows[0]?.value ?? "0";
  const unitCost = isZero(quantity) ? "0" : fromUnits((toUnits(value) * 10_000n) / toUnits(quantity));
  return { quantity: fromUnits(toUnits(quantity)), value: fromUnits(toUnits(value)), unitCost };
}

// ---------------------------------------------------------------------------
// Shared kernel poster
// ---------------------------------------------------------------------------

interface JournalLineInput {
  accountId: string;
  amount: string;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  memo?: string | null;
}

type Runner = Pick<typeof db, "execute">;

async function postInventoryEntry(
  tx: Runner,
  p: {
    orgId: string;
    bookId: string;
    subsidiaryId: string;
    currency: string;
    periodId: string;
    date: string;
    entryNumber: string;
    memo: string;
    lines: JournalLineInput[];
  },
): Promise<string> {
  const bal = sum(p.lines.map((l) => l.amount));
  if (!isZero(bal)) throw new InventoryError(`inventory entry does not balance (sum=${bal})`);
  const entryRes = (await tx.execute(sql`
    insert into journal_entries
      (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
    values (${p.orgId}, ${p.bookId}, ${p.subsidiaryId}, ${p.entryNumber}, ${p.date}, ${p.periodId}, ${p.memo},
            'draft', 'inventory', null, null)
    returning id`)) as unknown as { rows: { id: string }[] };
  const eid = entryRes.rows[0].id;
  for (let i = 0; i < p.lines.length; i++) {
    const l = p.lines[i];
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
         department_id, project_id, location_id, memo)
      values (${p.orgId}, ${eid}, ${i + 1}, ${l.accountId}, ${p.subsidiaryId}, ${l.amount}, ${p.currency}, ${l.amount}, 1,
              ${l.departmentId ?? null}, ${l.projectId ?? null}, ${l.locationId ?? null}, ${l.memo ?? p.memo})`);
  }
  await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${eid}`);
  return eid;
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

export interface ReceiveInput {
  itemId: string;
  stockLocationId: string;
  /** base-unit quantity (> 0). */
  quantity: string;
  /** actual unit cost paid. */
  unitCost: string;
  subsidiaryId: string;
  /** GL account the receipt credits (GRNI / clearing / AP). */
  offsetAccountId: string;
  date: string;
  documentLineId?: string | null;
  lotId?: string | null;
  serialId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  memo?: string | null;
}

export interface MovementResult {
  movementId: string;
  entryId: string;
  value: string;
}

/**
 * Receive stock: create a cost layer (or blend the moving-average layer) and
 * post DR inventory / CR offset (+ a PPV leg under standard costing).
 */
export async function receiveInventory(orgId: string, actorId: string | null, input: ReceiveInput): Promise<MovementResult> {
  if (cmp(input.quantity, "0") <= 0) throw new InventoryError("receipt quantity must be positive");
  const profile = await resolveProfile(orgId, input.itemId);
  const period = await periodForDate(orgId, input.date);
  if (!period) throw new InventoryError(`no accounting period for ${input.date}`);
  const bookId = await primaryBookId(orgId);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);
  const ctx = await loadSubsidiaryContext(db, orgId);

  const dims = {
    departmentId: input.departmentId ?? null,
    projectId: input.projectId ?? null,
    locationId: input.locationId ?? null,
  };

  // Costing.
  let layerUnitCost = input.unitCost;
  let inventoryValue = extendCost(input.quantity, input.unitCost);
  let variance = "0";
  if (profile.costingMethod === "standard") {
    const std = profile.standardCost ?? input.unitCost;
    const rs = receiveStandard(input.quantity, input.unitCost, std);
    inventoryValue = rs.inventoryValue;
    variance = rs.variance;
    layerUnitCost = std;
  }
  const offsetTotal = add(inventoryValue, variance); // = qty × actual

  const lines: JournalLineInput[] = [
    { accountId: profile.assetAccountId, amount: inventoryValue, ...dims, memo: input.memo },
    ...(!isZero(variance)
      ? [{ accountId: profile.varianceAccountId ?? profile.assetAccountId, amount: variance, ...dims, memo: "PPV" }]
      : []),
    { accountId: input.offsetAccountId, amount: neg(offsetTotal), ...dims, memo: input.memo },
  ];

  await validateSubsidiaryRestrictions(db, {
    orgId,
    ctx,
    docSubsidiaryId: input.subsidiaryId,
    lines: lines.map((l) => ({ ...l, subsidiaryId: input.subsidiaryId })),
  });

  return await db.transaction(async (tx) => {
    const entryId = await postInventoryEntry(tx, {
      orgId,
      bookId,
      subsidiaryId: input.subsidiaryId,
      currency,
      periodId: period,
      date: input.date,
      entryNumber: `INV-RCPT-${input.date}-${input.stockLocationId.slice(0, 8)}`,
      memo: input.memo ?? "Inventory receipt",
      lines,
    });

    const mv = (await tx.execute(sql`
      insert into inventory_movements
        (org_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id, quantity, unit_cost, total_value,
         document_line_id, journal_entry_id, status, memo, created_by, updated_by)
      values (${orgId}, ${input.itemId}, 'receipt', ${input.date}, ${input.stockLocationId}, ${input.lotId ?? null},
              ${input.serialId ?? null}, ${input.quantity}, ${layerUnitCost}, ${inventoryValue},
              ${input.documentLineId ?? null}, ${entryId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`)) as unknown as { rows: { id: string }[] };
    const movementId = mv.rows[0].id;

    if (profile.costingMethod === "moving_average") {
      // Blend into the single running layer for this item+location.
      const existing = (await tx.execute(sql`
        select id, remaining_quantity, unit_cost from cost_layers
         where org_id = ${orgId} and item_id = ${input.itemId} and stock_location_id = ${input.stockLocationId}
         order by received_at limit 1`)) as unknown as {
        rows: { id: string; remaining_quantity: string; unit_cost: string }[];
      };
      if (existing.rows[0]) {
        const cur = existing.rows[0];
        const newQty = add(cur.remaining_quantity, input.quantity);
        const newValue = add(extendCost(cur.remaining_quantity, cur.unit_cost), inventoryValue);
        const newCost = isZero(newQty) ? layerUnitCost : fromUnits((toUnits(newValue) * 10_000n) / toUnits(newQty));
        await tx.execute(sql`
          update cost_layers set remaining_quantity = ${newQty}, original_quantity = original_quantity + ${input.quantity},
             unit_cost = ${newCost}, updated_at = now() where id = ${cur.id}`);
      } else {
        await insertLayer(tx, orgId, input, movementId, layerUnitCost);
      }
    } else {
      await insertLayer(tx, orgId, input, movementId, layerUnitCost);
    }

    return { movementId, entryId, value: inventoryValue };
  });
}

async function insertLayer(
  tx: Runner,
  orgId: string,
  input: ReceiveInput,
  movementId: string,
  unitCost: string,
): Promise<void> {
  await tx.execute(sql`
    insert into cost_layers
      (org_id, item_id, stock_location_id, source_movement_id, received_at, original_quantity, remaining_quantity, unit_cost, created_by, updated_by)
    values (${orgId}, ${input.itemId}, ${input.stockLocationId}, ${movementId}, ${input.date},
            ${input.quantity}, ${input.quantity}, ${unitCost}, null, null)`);
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssueInput {
  itemId: string;
  stockLocationId: string;
  /** base-unit quantity (> 0). */
  quantity: string;
  subsidiaryId: string;
  /** GL account the issue debits (defaults to the item's COGS account). */
  offsetAccountId?: string;
  date: string;
  documentLineId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  memo?: string | null;
}

/**
 * Issue stock (shipment / consumption): consume cost layers by the item's
 * method and post DR COGS (or a caller offset) / CR inventory. Blocks issues
 * that exceed on-hand quantity.
 */
export async function issueInventory(orgId: string, actorId: string | null, input: IssueInput): Promise<MovementResult> {
  if (cmp(input.quantity, "0") <= 0) throw new InventoryError("issue quantity must be positive");
  const profile = await resolveProfile(orgId, input.itemId);
  const period = await periodForDate(orgId, input.date);
  if (!period) throw new InventoryError(`no accounting period for ${input.date}`);
  const bookId = await primaryBookId(orgId);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);
  const ctx = await loadSubsidiaryContext(db, orgId);
  const onHand = await getOnHand(orgId, input.itemId, input.stockLocationId);
  if (cmp(input.quantity, onHand.quantity) > 0) {
    throw new InventoryError(
      `insufficient stock: need ${input.quantity}, on hand ${onHand.quantity} (negative inventory is disabled)`,
    );
  }

  const offset = input.offsetAccountId ?? profile.cogsAccountId;
  const dims = {
    departmentId: input.departmentId ?? null,
    projectId: input.projectId ?? null,
    locationId: input.locationId ?? null,
  };

  return await db.transaction(async (tx) => {
    // Consume layers + compute cost.
    const layersRes = (await tx.execute(sql`
      select id, remaining_quantity as remaining, unit_cost from cost_layers
       where org_id = ${orgId} and item_id = ${input.itemId} and stock_location_id = ${input.stockLocationId}
         and remaining_quantity > 0
       order by received_at, id`)) as unknown as { rows: { id: string; remaining: string; unit_cost: string }[] };
    const layers = layersRes.rows;

    let cost: string;
    let consumptions: { layerId: string; quantity: string; unitCost: string }[] = [];

    if (profile.costingMethod === "standard") {
      const std = profile.standardCost ?? onHand.unitCost;
      cost = issueStandard(input.quantity, std);
      consumptions = planQuantityConsumption(layers, input.quantity);
    } else if (profile.costingMethod === "moving_average") {
      const single = layers[0];
      const iss = issueMovingAverage(
        { quantity: onHand.quantity, value: onHand.value },
        input.quantity,
      );
      cost = iss.cost;
      if (single) consumptions = [{ layerId: single.id, quantity: input.quantity, unitCost: single.unit_cost }];
    } else {
      const r = consumeFifo(
        layers.map((l) => ({ id: l.id, remaining: l.remaining, unitCost: l.unit_cost })) as CostLayer[],
        input.quantity,
        onHand.unitCost,
      );
      cost = r.totalCost;
      consumptions = r.consumptions.map((c) => ({ layerId: c.layerId, quantity: c.quantity, unitCost: c.unitCost }));
    }

    const unitCost = isZero(input.quantity) ? "0" : fromUnits((toUnits(cost) * 10_000n) / toUnits(input.quantity));

    const lines: JournalLineInput[] = [
      { accountId: offset, amount: cost, ...dims, memo: input.memo },
      { accountId: profile.assetAccountId, amount: neg(cost), ...dims, memo: input.memo },
    ];
    await validateSubsidiaryRestrictions(tx, {
      orgId,
      ctx,
      docSubsidiaryId: input.subsidiaryId,
      lines: lines.map((l) => ({ ...l, subsidiaryId: input.subsidiaryId })),
    });

    const entryId = await postInventoryEntry(tx, {
      orgId,
      bookId,
      subsidiaryId: input.subsidiaryId,
      currency,
      periodId: period,
      date: input.date,
      entryNumber: `INV-ISSUE-${input.date}-${input.stockLocationId.slice(0, 8)}`,
      memo: input.memo ?? "Inventory issue",
      lines,
    });

    const mv = (await tx.execute(sql`
      insert into inventory_movements
        (org_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value,
         document_line_id, journal_entry_id, status, memo, created_by, updated_by)
      values (${orgId}, ${input.itemId}, 'issue', ${input.date}, ${input.stockLocationId},
              ${neg(input.quantity)}, ${unitCost}, ${neg(cost)}, ${input.documentLineId ?? null}, ${entryId},
              'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`)) as unknown as { rows: { id: string }[] };
    const movementId = mv.rows[0].id;

    // Draw down layers + record consumptions.
    for (const c of consumptions) {
      await tx.execute(sql`
        update cost_layers set remaining_quantity = remaining_quantity - ${c.quantity}, updated_at = now()
         where id = ${c.layerId}`);
      await tx.execute(sql`
        insert into cost_layer_consumptions (org_id, cost_layer_id, issue_movement_id, quantity, unit_cost, created_by, updated_by)
        values (${orgId}, ${c.layerId}, ${movementId}, ${c.quantity}, ${c.unitCost}, ${actorId}, ${actorId})`);
    }

    return { movementId, entryId, value: neg(cost) };
  });
}

/** Draw `quantity` off layers oldest-first for QUANTITY bookkeeping (standard cost). */
function planQuantityConsumption(
  layers: { id: string; remaining: string; unit_cost: string }[],
  quantity: string,
): { layerId: string; quantity: string; unitCost: string }[] {
  let need = toUnits(quantity);
  const out: { layerId: string; quantity: string; unitCost: string }[] = [];
  for (const l of layers) {
    if (need <= 0n) break;
    const avail = toUnits(l.remaining);
    if (avail <= 0n) continue;
    const take = avail < need ? avail : need;
    out.push({ layerId: l.id, quantity: fromUnits(take), unitCost: l.unit_cost });
    need -= take;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Adjust (write-up / write-down / count correction)
// ---------------------------------------------------------------------------

export interface AdjustInput {
  itemId: string;
  stockLocationId: string;
  /** signed base-unit quantity delta (+ increases stock, − decreases). */
  quantityDelta: string;
  subsidiaryId: string;
  date: string;
  /** unit cost for a positive adjustment (defaults to current on-hand cost). */
  unitCost?: string;
  memo?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
}

/**
 * Adjust on-hand quantity against the item's adjustment account. A positive
 * delta receives at `unitCost` (else current cost); a negative delta issues at
 * current cost. Used by stock counts and manual write-ups/downs.
 */
export async function adjustInventory(orgId: string, actorId: string | null, input: AdjustInput): Promise<MovementResult> {
  const profile = await resolveProfile(orgId, input.itemId);
  const offset = profile.adjustmentAccountId ?? profile.cogsAccountId;
  const onHand = await getOnHand(orgId, input.itemId, input.stockLocationId);
  const sign = cmp(input.quantityDelta, "0");
  if (sign === 0) throw new InventoryError("adjustment quantity cannot be zero");

  if (sign > 0) {
    const unitCost = input.unitCost ?? (isZero(onHand.unitCost) ? "0" : onHand.unitCost);
    return receiveInventory(orgId, actorId, {
      itemId: input.itemId,
      stockLocationId: input.stockLocationId,
      quantity: input.quantityDelta,
      unitCost,
      subsidiaryId: input.subsidiaryId,
      offsetAccountId: offset,
      date: input.date,
      memo: input.memo ?? "Inventory adjustment",
      departmentId: input.departmentId,
      projectId: input.projectId,
      locationId: input.locationId,
    });
  }
  // negative: issue the absolute quantity against the adjustment account.
  const absQty = fromUnits(-toUnits(input.quantityDelta));
  return issueInventory(orgId, actorId, {
    itemId: input.itemId,
    stockLocationId: input.stockLocationId,
    quantity: absQty,
    subsidiaryId: input.subsidiaryId,
    offsetAccountId: offset,
    date: input.date,
    memo: input.memo ?? "Inventory adjustment",
    departmentId: input.departmentId,
    projectId: input.projectId,
    locationId: input.locationId,
  });
}

export { cmp as compareMoney };
