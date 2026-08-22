import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  add,
  cmp,
  fromUnits,
  isZero,
  neg,
  roundDiv,
  sum,
  toUnits,
} from "./money.ts";
import {
  consumeFifo,
  extendCost,
  issueMovingAverage,
  issueStandard,
  receiveStandard,
  type CostLayer,
} from "./inventory-costing.ts";
import {
  loadSubsidiaryContext,
  validateSubsidiaryRestrictions,
} from "./subsidiaries.ts";
import { businessToday } from "./business-date.ts";

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
 *
 * Every value ÷ quantity in here goes through `roundDiv`, never bare BigInt
 * division. BigInt `/` TRUNCATES, so a non-terminating average silently rounded
 * DOWN at four decimals and the subledger drifted below the GL: receiving 6
 * units for 10.0000 stored a unit cost of 1.6666, valuing the stock at 9.9996
 * against a ledger debited the full 10.0000. The shortfall was permanent and
 * grew with every such receipt, which is exactly the invariant stated above.
 */

/**
 * value ÷ quantity as a 4-decimal unit cost, half-up and sign-preserving.
 *
 * BigInt `/` truncates, which quietly rounded every non-terminating average
 * DOWN and drifted the subledger below the GL, so this rounds. `roundDiv`
 * refuses a non-positive denominator, and quantity is legitimately negative on
 * reversal and consumption paths, so the sign is taken out and put back rather
 * than handed to it. A zero quantity has no unit cost to state; callers choose
 * the fallback that fits their context.
 */
export function unitCostPerQuantity(value: string, quantity: string): string | null {
  const q = toUnits(quantity);
  if (q === 0n) return null;
  const v = toUnits(value) * 10_000n;
  return fromUnits(q < 0n ? roundDiv(-v, -q) : roundDiv(v, q));
}

export interface InventoryAccounts {
  assetAccountId: string;
  cogsAccountId: string;
  adjustmentAccountId: string | null;
  varianceAccountId: string | null;
}

export interface InventoryProfile extends InventoryAccounts {
  itemId: string;
  costingMethod: "fifo" | "moving_average" | "standard";
  tracking: "none" | "lot" | "serial";
  standardCost: string | null;
  baseUnit: string;
  allowNegativeInventory: boolean;
  negativeCostBasis: "last_receipt" | "standard" | "configured";
  provisionalUnitCost: string | null;
}

export class InventoryError extends Error {}

async function resolveProfile(
  orgId: string,
  itemId: string,
  runner: Runner = db,
): Promise<InventoryProfile> {
  const r = (await runner.execute<{
      item_id: string;
      costing_method: InventoryProfile["costingMethod"];
      tracking: InventoryProfile["tracking"];
      asset_account_id: string;
      cogs_account_id: string;
      adjustment_account_id: string | null;
      variance_account_id: string | null;
      standard_cost: string | null;
      base_unit: string;
      allow_negative_inventory: boolean;
      negative_cost_basis: InventoryProfile["negativeCostBasis"];
      provisional_unit_cost: string | null;
    }>(sql`
    select item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
           variance_account_id, standard_cost, base_unit, allow_negative_inventory,
           negative_cost_basis, provisional_unit_cost
      from item_inventory_profiles where org_id = ${orgId} and item_id = ${itemId}`));
  const p = r.rows[0];
  if (!p) throw new InventoryError(`item ${itemId} has no inventory profile`);
  if (p.tracking !== "none" && p.costing_method === "moving_average") {
    throw new InventoryError(
      "lot/serial tracking is incompatible with blended moving-average layers",
    );
  }
  return {
    itemId: p.item_id,
    costingMethod: p.costing_method,
    tracking: p.tracking,
    assetAccountId: p.asset_account_id,
    cogsAccountId: p.cogs_account_id,
    adjustmentAccountId: p.adjustment_account_id,
    varianceAccountId: p.variance_account_id,
    standardCost: p.standard_cost,
    baseUnit: p.base_unit,
    allowNegativeInventory: p.allow_negative_inventory,
    negativeCostBasis: p.negative_cost_basis,
    provisionalUnitCost: p.provisional_unit_cost,
  };
}

/** Primary accounting book id. */
async function primaryBookId(
  orgId: string,
  runner: Runner = db,
): Promise<string> {
  const r = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary = true limit 1`));
  if (!r.rows[0]) throw new InventoryError("no primary accounting book");
  return r.rows[0].id;
}

async function periodForDate(
  orgId: string,
  date: string,
  runner: Runner = db,
): Promise<string | null> {
  const r = (await runner.execute<{ id: string }>(sql`
    select id from accounting_periods
     where org_id = ${orgId} and is_adjustment = false and starts_on <= ${date} and ends_on >= ${date}
     limit 1`));
  return r.rows[0]?.id ?? null;
}

async function subsidiaryCurrency(
  orgId: string,
  subsidiaryId: string,
  runner: Runner = db,
): Promise<string> {
  const r = (await runner.execute<{ base_currency: string }>(sql`
    select base_currency from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}`));
  if (!r.rows[0]) throw new InventoryError("subsidiary not found");
  return r.rows[0].base_currency;
}

/** Current on-hand quantity and value for an item at a location (from layers). */
export async function getOnHand(
  orgId: string,
  itemId: string,
  stockLocationId: string,
): Promise<{ quantity: string; value: string; unitCost: string }> {
  return getOnHandWith(db, orgId, itemId, stockLocationId);
}

async function getOnHandWith(
  runner: Runner,
  orgId: string,
  itemId: string,
  stockLocationId: string,
  selection: { lotId?: string | null; serialId?: string | null } = {},
): Promise<{ quantity: string; value: string; unitCost: string }> {
  const lotId = selection.lotId ?? null;
  const serialId = selection.serialId ?? null;
  const r = (await runner.execute<{ quantity: string; value: string }>(sql`
    select (coalesce((select sum(remaining_quantity) from cost_layers
                       where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}
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
                           and ${lotId}::uuid is null and ${serialId}::uuid is null),0))::text as quantity,
           (coalesce((select sum(round(remaining_quantity * unit_cost,4)) from cost_layers
                       where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}
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
                           and ${lotId}::uuid is null and ${serialId}::uuid is null),0))::text as value`));
  const quantity = r.rows[0]?.quantity ?? "0";
  const value = r.rows[0]?.value ?? "0";
  const unitCost = isZero(quantity)
    ? "0"
    : unitCostPerQuantity(value, quantity)!;
  return {
    quantity: fromUnits(toUnits(quantity)),
    value: fromUnits(toUnits(value)),
    unitCost,
  };
}

async function lockInventoryPosition(
  tx: Runner,
  itemId: string,
  stockLocationId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`inventory:${itemId}:${stockLocationId}`},0))`,
  );
}

async function validateTrackingSelection(
  tx: Runner,
  orgId: string,
  itemId: string,
  stockLocationId: string,
  profile: InventoryProfile,
  selection: { quantity: string; lotId?: string | null; serialId?: string | null },
  operation: "receipt" | "issue" | "transfer",
): Promise<void> {
  assertTracking(profile, selection, operation);
  if (profile.tracking === "lot") {
    const lot = (await tx.execute<{ id: string }>(sql`
      select id
        from lots
       where id = ${selection.lotId} and org_id = ${orgId} and item_id = ${itemId}
       for update
    `));
    if (!lot.rows[0]) {
      throw new InventoryError(
        "lot must belong to the item and organization",
      );
    }
    return;
  }
  if (profile.tracking !== "serial") return;

  const serial = (await tx.execute<{
      id: string;
      status: string;
      current_stock_location_id: string | null;
    }>(sql`
    select id, status, current_stock_location_id
      from serials
     where id = ${selection.serialId} and org_id = ${orgId} and item_id = ${itemId}
     for update
  `));
  const row = serial.rows[0];
  if (!row) {
    throw new InventoryError(
      "serial must belong to the item and organization",
    );
  }
  if (operation === "receipt") {
    const prior = (await tx.execute(sql`
      select 1
        from inventory_movements
       where org_id = ${orgId} and serial_id = ${selection.serialId}
         and status = 'posted'
       limit 1
    `));
    if (prior.rows.length) {
      throw new InventoryError(
        "serial already has posted inventory movement history; use a controlled return workflow",
      );
    }
    if (
      row.current_stock_location_id &&
      row.current_stock_location_id !== stockLocationId
    ) {
      throw new InventoryError(
        "serial is registered at a different stock location",
      );
    }
    return;
  }
  if (
    row.status !== "in_stock" ||
    row.current_stock_location_id !== stockLocationId
  ) {
    throw new InventoryError(
      `serial is not in stock at the ${operation === "issue" ? "issue" : "source"} location`,
    );
  }
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

/** Post one balanced inventory journal (draft→lines→posted, origin 'inventory').
 *  Exported for the NRV remeasurement module, which shares this GL path. */
export async function postInventoryEntry(
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
  if (!isZero(bal))
    throw new InventoryError(`inventory entry does not balance (sum=${bal})`);
  const entryRes = (await tx.execute<{ id: string }>(sql`
    insert into journal_entries
      (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
    values (${p.orgId}, ${p.bookId}, ${p.subsidiaryId}, ${p.entryNumber}, ${p.date}, ${p.periodId}, ${p.memo},
            'draft', 'inventory', null, null)
    returning id`));
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
  await tx.execute(
    sql`update journal_entries set status = 'posted', posted_at = now() where id = ${eid} and org_id = ${p.orgId}`,
  );
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
  /** GL account the receipt credits (GRNI / clearing). Required unless
   *  postJournal is false (the source document already moved the GL). */
  offsetAccountId?: string;
  date: string;
  documentLineId?: string | null;
  lotId?: string | null;
  serialId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  memo?: string | null;
  /** When false, do NOT post a journal — the caller's document already DR'd
   *  inventory; we only record the cost layer + movement (linked to linkEntryId). */
  postJournal?: boolean;
  linkEntryId?: string | null;
}

export interface MovementResult {
  movementId: string;
  /** null when the movement recorded a layer without its own entry (bill receipt). */
  entryId: string | null;
  value: string;
}

/**
 * Receive stock: create a cost layer (or blend the moving-average layer) and
 * post DR inventory / CR offset (+ a PPV leg under standard costing).
 */
export async function receiveInventory(
  orgId: string,
  actorId: string | null,
  input: ReceiveInput,
): Promise<MovementResult> {
  if (cmp(input.quantity, "0") <= 0)
    throw new InventoryError("receipt quantity must be positive");
  const profile = await resolveProfile(orgId, input.itemId);
  assertTracking(
    profile,
    { quantity: input.quantity, lotId: input.lotId, serialId: input.serialId },
    "receipt",
  );
  const period = await periodForDate(orgId, input.date);
  if (!period)
    throw new InventoryError(`no accounting period for ${input.date}`);
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

  // When the source document already DR'd inventory (postJournal === false), we
  // skip the entry and only record the layer. Standard costing needs its own
  // entry to book the variance, so it requires a real offset (a clearing acct).
  const postJournal = input.postJournal !== false;
  if (!postJournal && !isZero(variance)) {
    throw new InventoryError(
      "standard-cost receipts require a received-not-billed account to book purchase variance",
    );
  }
  if (!postJournal && !input.linkEntryId) {
    throw new InventoryError(
      "a non-posting receipt requires its source journal entry",
    );
  }
  if (postJournal && !input.offsetAccountId) {
    throw new InventoryError("receipt requires an offset account");
  }

  return await db.transaction(async (tx) => {
    await lockInventoryPosition(tx, input.itemId, input.stockLocationId);
    await validateTrackingSelection(
      tx,
      orgId,
      input.itemId,
      input.stockLocationId,
      profile,
      {
        quantity: input.quantity,
        lotId: input.lotId,
        serialId: input.serialId,
      },
      "receipt",
    );
    const deficits = (await tx.execute<{
        id: string;
        remaining_quantity: string;
        provisional_unit_cost: string;
      }>(sql`
      select id,remaining_quantity,provisional_unit_cost
        from inventory_provisional_costs
       where org_id=${orgId} and item_id=${input.itemId} and stock_location_id=${input.stockLocationId}
         and remaining_quantity>0 order by created_at,id for update
    `));
    let receiptUnits = toUnits(input.quantity);
    let provisionalValueUnits = 0n;
    const settlements: {
      id: string;
      quantity: string;
      provisionalUnitCost: string;
      correction: string;
    }[] = [];
    for (const deficit of deficits.rows) {
      if (receiptUnits === 0n) break;
      const available = toUnits(deficit.remaining_quantity);
      const take = available < receiptUnits ? available : receiptUnits;
      const quantity = fromUnits(take);
      const provisionalValue = extendCost(
        quantity,
        deficit.provisional_unit_cost,
      );
      const receiptValue = extendCost(quantity, layerUnitCost);
      settlements.push({
        id: deficit.id,
        quantity,
        provisionalUnitCost: deficit.provisional_unit_cost,
        correction: fromUnits(
          toUnits(receiptValue) - toUnits(provisionalValue),
        ),
      });
      provisionalValueUnits += toUnits(provisionalValue);
      receiptUnits -= take;
    }
    const excessQuantity = fromUnits(receiptUnits);
    const assetDelta = fromUnits(
      provisionalValueUnits +
        toUnits(extendCost(excessQuantity, layerUnitCost)),
    );
    const correction = fromUnits(toUnits(inventoryValue) - toUnits(assetDelta));
    const lines: JournalLineInput[] = postJournal
      ? [
          {
            accountId: profile.assetAccountId,
            amount: assetDelta,
            ...dims,
            memo: input.memo,
          },
          ...(!isZero(correction)
            ? [
                {
                  accountId: profile.cogsAccountId,
                  amount: correction,
                  ...dims,
                  memo: "Negative inventory receipt cost true-up",
                },
              ]
            : []),
          ...(!isZero(variance)
            ? [
                {
                  accountId:
                    profile.varianceAccountId ?? profile.assetAccountId,
                  amount: variance,
                  ...dims,
                  memo: "PPV",
                },
              ]
            : []),
          {
            accountId: input.offsetAccountId!,
            amount: neg(offsetTotal),
            ...dims,
            memo: input.memo,
          },
        ]
      : !isZero(correction)
        ? [
            {
              accountId: profile.cogsAccountId,
              amount: correction,
              ...dims,
              memo: "Negative inventory receipt cost true-up",
            },
            {
              accountId: profile.assetAccountId,
              amount: neg(correction),
              ...dims,
              memo: "Negative inventory receipt cost true-up",
            },
          ]
        : [];
    if (lines.length) {
      await validateSubsidiaryRestrictions(tx, {
        orgId,
        ctx,
        docSubsidiaryId: input.subsidiaryId,
        lines: lines.map((line) => ({
          ...line,
          subsidiaryId: input.subsidiaryId,
        })),
      });
    }
    const entryId = lines.length
      ? await postInventoryEntry(tx, {
          orgId,
          bookId,
          subsidiaryId: input.subsidiaryId,
          currency,
          periodId: period,
          date: input.date,
          entryNumber: `INV-RCPT-${input.date}-${input.stockLocationId.slice(0, 8)}`,
          memo: input.memo ?? "Inventory receipt",
          lines,
        })
      : (input.linkEntryId ?? null);

    const mv = (await tx.execute<{ id: string }>(sql`
      insert into inventory_movements
        (org_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id, quantity, unit_cost, total_value,
         document_line_id, journal_entry_id, status, memo, created_by, updated_by)
      values (${orgId}, ${input.itemId}, 'receipt', ${input.date}, ${input.stockLocationId}, ${input.lotId ?? null},
              ${input.serialId ?? null}, ${input.quantity}, ${layerUnitCost}, ${assetDelta},
              ${input.documentLineId ?? null}, ${entryId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`));
    const movementId = mv.rows[0].id;

    for (const settlement of settlements) {
      await tx.execute(sql`
        update inventory_provisional_costs
           set remaining_quantity=remaining_quantity-${settlement.quantity},updated_at=now(),updated_by=${actorId}
         where id=${settlement.id}
      `);
      await tx.execute(sql`
        insert into inventory_provisional_settlements
          (org_id,provisional_cost_id,receipt_movement_id,quantity,provisional_unit_cost,receipt_unit_cost,
           correction_amount,correction_journal_entry_id,created_by,updated_by)
        values (${orgId},${settlement.id},${movementId},${settlement.quantity},${settlement.provisionalUnitCost},
                ${layerUnitCost},${settlement.correction},${entryId ?? input.linkEntryId},${actorId},${actorId})
      `);
    }

    if (receiptUnits > 0n && profile.costingMethod === "moving_average") {
      // Blend into the single running layer for this item+location.
      const existing = (await tx.execute<{ id: string; remaining_quantity: string; unit_cost: string }>(sql`
        select id, remaining_quantity, unit_cost from cost_layers
         where org_id = ${orgId} and item_id = ${input.itemId} and stock_location_id = ${input.stockLocationId}
         order by received_at limit 1`));
      if (existing.rows[0]) {
        const cur = existing.rows[0];
        const newQty = add(cur.remaining_quantity, excessQuantity);
        const newValue = add(
          extendCost(cur.remaining_quantity, cur.unit_cost),
          extendCost(excessQuantity, layerUnitCost),
        );
        const newCost = isZero(newQty)
          ? layerUnitCost
          : unitCostPerQuantity(newValue, newQty)!;
        await tx.execute(sql`
          update cost_layers set remaining_quantity = ${newQty}, original_quantity = original_quantity + ${excessQuantity},
             unit_cost = ${newCost}, updated_at = now() where id = ${cur.id} and org_id = ${orgId}`);
      } else {
        await insertLayer(
          tx,
          orgId,
          input,
          movementId,
          layerUnitCost,
          excessQuantity,
        );
      }
    } else if (receiptUnits > 0n) {
      await insertLayer(
        tx,
        orgId,
        input,
        movementId,
        layerUnitCost,
        excessQuantity,
      );
    }

    if (profile.tracking === "serial") {
      await tx.execute(sql`
        update serials
           set status = 'in_stock',
               current_stock_location_id = ${input.stockLocationId},
               updated_at = now(),
               updated_by = ${actorId}
         where id = ${input.serialId} and org_id = ${orgId}
      `);
    }

    return { movementId, entryId, value: assetDelta };
  });
}

async function insertLayer(
  tx: Runner,
  orgId: string,
  input: ReceiveInput,
  movementId: string,
  unitCost: string,
  quantity = input.quantity,
): Promise<void> {
  await tx.execute(sql`
    insert into cost_layers
      (org_id, item_id, stock_location_id, source_movement_id, received_at, original_quantity, remaining_quantity, unit_cost, created_by, updated_by)
    values (${orgId}, ${input.itemId}, ${input.stockLocationId}, ${movementId}, ${input.date},
            ${quantity}, ${quantity}, ${unitCost}, null, null)`);
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
  lotId?: string | null;
  serialId?: string | null;
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
export async function issueInventory(
  orgId: string,
  actorId: string | null,
  input: IssueInput,
): Promise<MovementResult> {
  if (cmp(input.quantity, "0") <= 0)
    throw new InventoryError("issue quantity must be positive");
  const profile = await resolveProfile(orgId, input.itemId);
  assertTracking(
    profile,
    { quantity: input.quantity, lotId: input.lotId, serialId: input.serialId },
    "issue",
  );
  const period = await periodForDate(orgId, input.date);
  if (!period)
    throw new InventoryError(`no accounting period for ${input.date}`);
  const bookId = await primaryBookId(orgId);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);
  const ctx = await loadSubsidiaryContext(db, orgId);
  const offset = input.offsetAccountId ?? profile.cogsAccountId;
  const dims = {
    departmentId: input.departmentId ?? null,
    projectId: input.projectId ?? null,
    locationId: input.locationId ?? null,
  };

  return await db.transaction(async (tx) => {
    await lockInventoryPosition(tx, input.itemId, input.stockLocationId);
    await validateTrackingSelection(
      tx,
      orgId,
      input.itemId,
      input.stockLocationId,
      profile,
      {
        quantity: input.quantity,
        lotId: input.lotId,
        serialId: input.serialId,
      },
      "issue",
    );
    const onHand = await getOnHandWith(
      tx,
      orgId,
      input.itemId,
      input.stockLocationId,
      { lotId: input.lotId, serialId: input.serialId },
    );
    const shortage =
      toUnits(input.quantity) -
      (toUnits(onHand.quantity) > 0n ? toUnits(onHand.quantity) : 0n);
    if (
      shortage > 0n &&
      (!profile.allowNegativeInventory || profile.tracking !== "none")
    ) {
      throw new InventoryError(
        `insufficient stock: need ${input.quantity}, on hand ${onHand.quantity} (negative inventory is disabled for this tracking configuration)`,
      );
    }
    const provisionalUnitCost =
      shortage > 0n
        ? await resolveProvisionalUnitCost(tx, orgId, profile, input.itemId)
        : onHand.unitCost;
    const { cost, unitCost, consumptions, shortfallQuantity } =
      await consumeLayers(
        tx,
        orgId,
        profile,
        input.itemId,
        input.stockLocationId,
        input.quantity,
        onHand,
        provisionalUnitCost,
        { lotId: input.lotId, serialId: input.serialId },
      );

    const lines: JournalLineInput[] = [
      { accountId: offset, amount: cost, ...dims, memo: input.memo },
      {
        accountId: profile.assetAccountId,
        amount: neg(cost),
        ...dims,
        memo: input.memo,
      },
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

    const mv = (await tx.execute<{ id: string }>(sql`
      insert into inventory_movements
        (org_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id,
         quantity, unit_cost, total_value,
         document_line_id, journal_entry_id, status, memo, created_by, updated_by)
      values (${orgId}, ${input.itemId}, 'issue', ${input.date}, ${input.stockLocationId},
              ${input.lotId ?? null}, ${input.serialId ?? null},
              ${neg(input.quantity)}, ${unitCost}, ${neg(cost)}, ${input.documentLineId ?? null}, ${entryId},
              'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`));
    const movementId = mv.rows[0].id;
    await recordConsumptions(tx, orgId, consumptions, movementId, actorId);
    if (!isZero(shortfallQuantity)) {
      await tx.execute(sql`
        insert into inventory_provisional_costs
          (org_id,item_id,stock_location_id,issue_movement_id,original_quantity,remaining_quantity,
           provisional_unit_cost,cost_basis,created_by,updated_by)
        values (${orgId},${input.itemId},${input.stockLocationId},${movementId},${shortfallQuantity},
                ${shortfallQuantity},${provisionalUnitCost},${profile.negativeCostBasis},${actorId},${actorId})
      `);
    }
    if (profile.tracking === "serial") {
      await tx.execute(sql`
        update serials
           set status = 'shipped',
               current_stock_location_id = null,
               updated_at = now(),
               updated_by = ${actorId}
         where id = ${input.serialId} and org_id = ${orgId}
      `);
    }
    return { movementId, entryId, value: neg(cost) };
  });
}

async function resolveProvisionalUnitCost(
  tx: Runner,
  orgId: string,
  profile: InventoryProfile,
  itemId: string,
): Promise<string> {
  if (profile.negativeCostBasis === "configured") {
    if (profile.provisionalUnitCost == null)
      throw new InventoryError(
        "configured negative costing requires a provisional unit cost",
      );
    return profile.provisionalUnitCost;
  }
  if (profile.negativeCostBasis === "standard") {
    if (profile.standardCost == null)
      throw new InventoryError(
        "standard negative costing requires a standard cost",
      );
    return profile.standardCost;
  }
  const last = (await tx.execute<{ unit_cost: string }>(sql`
    select unit_cost from inventory_movements
     where org_id=${orgId} and item_id=${itemId} and kind in ('receipt','return','assembly_build','transfer_in')
       and status='posted' and unit_cost is not null
     order by moved_at desc,created_at desc,id desc limit 1
  `));
  if (!last.rows[0])
    throw new InventoryError(
      "negative inventory has no prior receipt cost; configure a provisional or standard cost",
    );
  return last.rows[0].unit_cost;
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
    out.push({
      layerId: l.id,
      quantity: fromUnits(take),
      unitCost: l.unit_cost,
    });
    need -= take;
  }
  return out;
}

interface Consumption {
  layerId: string;
  quantity: string;
  unitCost: string;
}

/**
 * Consume `quantity` of an item from a location's cost layers by the item's
 * costing method. Returns the total cost, the per-unit cost, and the layer
 * consumptions to record. Shared by issue, transfer, and assembly build.
 */
async function consumeLayers(
  tx: Runner,
  orgId: string,
  profile: InventoryProfile,
  itemId: string,
  stockLocationId: string,
  quantity: string,
  onHand: { quantity: string; value: string; unitCost: string },
  provisionalUnitCost = onHand.unitCost,
  selection: { lotId?: string | null; serialId?: string | null } = {},
): Promise<{
  cost: string;
  unitCost: string;
  consumptions: Consumption[];
  shortfallQuantity: string;
}> {
  const lotId = selection.lotId ?? null;
  const serialId = selection.serialId ?? null;
  const layersRes = (await tx.execute<{ id: string; remaining: string; unit_cost: string }>(sql`
    select layer.id, layer.remaining_quantity as remaining, layer.unit_cost
      from cost_layers layer
      join inventory_movements source
        on source.id = layer.source_movement_id
       and source.org_id = layer.org_id
     where layer.org_id = ${orgId} and layer.item_id = ${itemId}
       and layer.stock_location_id = ${stockLocationId}
       and layer.remaining_quantity > 0
       and (${lotId}::uuid is null or source.lot_id = ${lotId}::uuid)
       and (${serialId}::uuid is null or source.serial_id = ${serialId}::uuid)
     order by layer.received_at, layer.id`));
  const layers = layersRes.rows;

  let cost: string;
  let consumptions: Consumption[] = [];
  const requestedUnits = toUnits(quantity);
  const availableUnits = layers.reduce(
    (total, layer) => total + toUnits(layer.remaining),
    0n,
  );
  const coveredUnits =
    availableUnits < requestedUnits ? availableUnits : requestedUnits;
  const shortfallQuantity = fromUnits(requestedUnits - coveredUnits);
  if (profile.costingMethod === "standard") {
    cost = issueStandard(quantity, profile.standardCost ?? onHand.unitCost);
    consumptions = planQuantityConsumption(layers, fromUnits(coveredUnits));
  } else if (profile.costingMethod === "moving_average") {
    const positiveValue = toUnits(onHand.value) > 0n ? onHand.value : "0";
    const coveredCost = issueMovingAverage(
      { quantity: fromUnits(availableUnits), value: positiveValue },
      fromUnits(coveredUnits),
    ).cost;
    cost = add(coveredCost, extendCost(shortfallQuantity, provisionalUnitCost));
    if (layers[0] && coveredUnits > 0n)
      consumptions = [
        {
          layerId: layers[0].id,
          quantity: fromUnits(coveredUnits),
          unitCost: layers[0].unit_cost,
        },
      ];
  } else {
    const r = consumeFifo(
      layers.map((l) => ({
        id: l.id,
        remaining: l.remaining,
        unitCost: l.unit_cost,
      })) as CostLayer[],
      quantity,
      provisionalUnitCost,
    );
    cost = r.totalCost;
    consumptions = r.consumptions.map((c) => ({
      layerId: c.layerId,
      quantity: c.quantity,
      unitCost: c.unitCost,
    }));
  }
  const unitCost = isZero(quantity)
    ? "0"
    : unitCostPerQuantity(cost, quantity)!;
  return { cost, unitCost, consumptions, shortfallQuantity };
}

/** Draw down consumed layers and record the consumptions against a movement. */
async function recordConsumptions(
  tx: Runner,
  orgId: string,
  consumptions: Consumption[],
  movementId: string,
  actorId: string | null,
): Promise<void> {
  for (const c of consumptions) {
    await tx.execute(sql`
      update cost_layers set remaining_quantity = remaining_quantity - ${c.quantity}, updated_at = now()
       where id = ${c.layerId} and org_id = ${orgId}`);
    await tx.execute(sql`
      insert into cost_layer_consumptions (org_id, cost_layer_id, issue_movement_id, quantity, unit_cost, created_by, updated_by)
      values (${orgId}, ${c.layerId}, ${movementId}, ${c.quantity}, ${c.unitCost}, ${actorId}, ${actorId})`);
  }
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
  lotId?: string | null;
  serialId?: string | null;
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
export async function adjustInventory(
  orgId: string,
  actorId: string | null,
  input: AdjustInput,
): Promise<MovementResult> {
  const profile = await resolveProfile(orgId, input.itemId);
  const offset = profile.adjustmentAccountId ?? profile.cogsAccountId;
  const onHand = await getOnHand(orgId, input.itemId, input.stockLocationId);
  const sign = cmp(input.quantityDelta, "0");
  if (sign === 0)
    throw new InventoryError("adjustment quantity cannot be zero");

  if (sign > 0) {
    const unitCost =
      input.unitCost ?? (isZero(onHand.unitCost) ? "0" : onHand.unitCost);
    return receiveInventory(orgId, actorId, {
      itemId: input.itemId,
      stockLocationId: input.stockLocationId,
      quantity: input.quantityDelta,
      unitCost,
      subsidiaryId: input.subsidiaryId,
      offsetAccountId: offset,
      date: input.date,
      lotId: input.lotId,
      serialId: input.serialId,
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
    lotId: input.lotId,
    serialId: input.serialId,
    memo: input.memo ?? "Inventory adjustment",
    departmentId: input.departmentId,
    projectId: input.projectId,
    locationId: input.locationId,
  });
}

// ---------------------------------------------------------------------------
// Transfer between stock locations (carried at cost)
// ---------------------------------------------------------------------------

/** Add quantity to a location's layers at a carried cost (blend for moving-avg). */
async function addLayerAtCost(
  tx: Runner,
  orgId: string,
  itemId: string,
  stockLocationId: string,
  quantity: string,
  unitCost: string,
  method: InventoryProfile["costingMethod"],
  movementId: string,
  date: string,
): Promise<void> {
  if (method === "moving_average") {
    const existing = (await tx.execute<{ id: string; remaining_quantity: string; unit_cost: string }>(sql`
      select id, remaining_quantity, unit_cost from cost_layers
       where org_id = ${orgId} and item_id = ${itemId} and stock_location_id = ${stockLocationId}
       order by received_at limit 1`));
    if (existing.rows[0]) {
      const cur = existing.rows[0];
      const newQty = add(cur.remaining_quantity, quantity);
      const newValue = add(
        extendCost(cur.remaining_quantity, cur.unit_cost),
        extendCost(quantity, unitCost),
      );
      const newCost = isZero(newQty)
        ? unitCost
        : unitCostPerQuantity(newValue, newQty)!;
      await tx.execute(sql`
        update cost_layers set remaining_quantity = ${newQty}, original_quantity = original_quantity + ${quantity},
           unit_cost = ${newCost}, updated_at = now() where id = ${cur.id} and org_id = ${orgId}`);
      return;
    }
  }
  await tx.execute(sql`
    insert into cost_layers
      (org_id, item_id, stock_location_id, source_movement_id, received_at, original_quantity, remaining_quantity, unit_cost, created_by, updated_by)
    values (${orgId}, ${itemId}, ${stockLocationId}, ${movementId}, ${date}, ${quantity}, ${quantity}, ${unitCost}, null, null)`);
}

export interface TransferInput {
  itemId: string;
  fromStockLocationId: string;
  toStockLocationId: string;
  quantity: string;
  lotId?: string | null;
  serialId?: string | null;
  subsidiaryId: string;
  date: string;
  memo?: string | null;
}

/**
 * Move stock between two locations at its carried cost. Source layers are
 * consumed (by the item's method), the destination gains the value, and a
 * location-reclass entry posts only when the two locations map to different
 * `locations` dimensions (else it's a pure subledger move). Value is unchanged.
 */
export async function transferInventory(
  orgId: string,
  actorId: string | null,
  input: TransferInput,
): Promise<{
  fromMovementId: string;
  toMovementId: string;
  entryId: string | null;
  value: string;
}> {
  return db.transaction((tx) =>
    transferInventoryTx(tx, orgId, actorId, input),
  );
}

async function transferInventoryTx(
  tx: Runner,
  orgId: string,
  actorId: string | null,
  input: TransferInput,
): Promise<{
  fromMovementId: string;
  toMovementId: string;
  entryId: string | null;
  value: string;
}> {
  if (cmp(input.quantity, "0") <= 0)
    throw new InventoryError("transfer quantity must be positive");
  if (input.fromStockLocationId === input.toStockLocationId)
    throw new InventoryError("transfer needs two different locations");
  const profile = await resolveProfile(orgId, input.itemId, tx);
  assertTracking(
    profile,
    { quantity: input.quantity, lotId: input.lotId, serialId: input.serialId },
    "transfer",
  );
  const period = await periodForDate(orgId, input.date, tx);
  if (!period)
    throw new InventoryError(`no accounting period for ${input.date}`);
  const bookId = await primaryBookId(orgId, tx);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId, tx);

  // Serialize every transfer touching either position. Sorting the lock keys
  // prevents two opposite-direction transfers from deadlocking.
  for (const locationId of [
    input.fromStockLocationId,
    input.toStockLocationId,
  ].sort()) {
    await lockInventoryPosition(tx, input.itemId, locationId);
  }
  await validateTrackingSelection(
    tx,
    orgId,
    input.itemId,
    input.fromStockLocationId,
    profile,
    {
      quantity: input.quantity,
      lotId: input.lotId,
      serialId: input.serialId,
    },
    "transfer",
  );
  const onHand = await getOnHandWith(
    tx,
    orgId,
    input.itemId,
    input.fromStockLocationId,
    { lotId: input.lotId, serialId: input.serialId },
  );
  if (cmp(input.quantity, onHand.quantity) > 0) {
    throw new InventoryError(
      `insufficient stock at source: need ${input.quantity}, on hand ${onHand.quantity}`,
    );
  }

  const locDims = (await tx.execute<{ id: string; location_id: string }>(sql`
    select id, location_id from stock_locations where org_id = ${orgId} and id in (${input.fromStockLocationId}, ${input.toStockLocationId})`));
  if (locDims.rows.length !== 2) {
    throw new InventoryError(
      "both transfer locations must belong to the organization",
    );
  }
  const fromDim =
    locDims.rows.find((r) => r.id === input.fromStockLocationId)?.location_id ??
    null;
  const toDim =
    locDims.rows.find((r) => r.id === input.toStockLocationId)?.location_id ??
    null;

  const { cost, unitCost, consumptions } = await consumeLayers(
    tx,
    orgId,
    profile,
    input.itemId,
    input.fromStockLocationId,
    input.quantity,
    onHand,
    onHand.unitCost,
    { lotId: input.lotId, serialId: input.serialId },
  );

  // Optional location-reclass entry (value nets to zero, dimensions differ).
  let entryId: string | null = null;
  if (fromDim && toDim && fromDim !== toDim && !isZero(cost)) {
    entryId = await postInventoryEntry(tx, {
      orgId,
      bookId,
      subsidiaryId: input.subsidiaryId,
      currency,
      periodId: period,
      date: input.date,
      entryNumber: `INV-XFER-${input.date}-${input.itemId.slice(0, 8)}`,
      memo: input.memo ?? "Inventory transfer",
      lines: [
        {
          accountId: profile.assetAccountId,
          amount: cost,
          locationId: toDim,
          memo: input.memo,
        },
        {
          accountId: profile.assetAccountId,
          amount: neg(cost),
          locationId: fromDim,
          memo: input.memo,
        },
      ],
    });
  }

  // A posted movement is immutable (no post-insert UPDATE), so the id is
  // generated up front and only the transfer_in leg carries the pairing
  // link back to the transfer_out (one direction is enough to relate them).
  const fromMovementId = randomUUID();
  await tx.execute(sql`
      insert into inventory_movements
        (id, org_id, item_id, kind, moved_at, stock_location_id, lot_id,
         serial_id, quantity, unit_cost, total_value, journal_entry_id, status,
         memo, created_by, updated_by)
      values (${fromMovementId}, ${orgId}, ${input.itemId}, 'transfer_out',
              ${input.date}, ${input.fromStockLocationId}, ${input.lotId ?? null},
              ${input.serialId ?? null}, ${neg(input.quantity)}, ${unitCost},
              ${neg(cost)}, ${entryId}, 'posted', ${input.memo ?? null},
              ${actorId}, ${actorId})`);
  const toMovementId = randomUUID();
  await tx.execute(sql`
      insert into inventory_movements
        (id, org_id, item_id, kind, moved_at, stock_location_id, lot_id,
         serial_id, quantity, unit_cost, total_value, journal_entry_id,
         paired_movement_id, status, memo, created_by, updated_by)
      values (${toMovementId}, ${orgId}, ${input.itemId}, 'transfer_in',
              ${input.date}, ${input.toStockLocationId}, ${input.lotId ?? null},
              ${input.serialId ?? null}, ${input.quantity}, ${unitCost}, ${cost},
              ${entryId}, ${fromMovementId}, 'posted', ${input.memo ?? null},
              ${actorId}, ${actorId})`);

  await recordConsumptions(tx, orgId, consumptions, fromMovementId, actorId);
  await addLayerAtCost(
    tx,
    orgId,
    input.itemId,
    input.toStockLocationId,
    input.quantity,
    unitCost,
    profile.costingMethod,
    toMovementId,
    input.date,
  );
  if (profile.tracking === "serial") {
    await tx.execute(sql`
      update serials
         set status = 'in_stock',
             current_stock_location_id = ${input.toStockLocationId},
             updated_at = now(),
             updated_by = ${actorId}
       where id = ${input.serialId} and org_id = ${orgId}
    `);
  }

  return { fromMovementId, toMovementId, entryId, value: cost };
}

// ---------------------------------------------------------------------------
// Controlled reversal
// ---------------------------------------------------------------------------

export interface ReverseInventoryInput {
  movementId: string;
  reversalDate: string;
  /** Immutable business reason retained on the reversal movement and audit log. */
  reason: string;
}

export interface ReverseInventoryResult {
  movementIds: string[];
  entryId: string | null;
  alreadyReversed: boolean;
}
type ReversibleMovement = {
  id: string;
  item_id: string;
  kind: string;
  moved_at: string;
  stock_location_id: string;
  lot_id: string | null;
  serial_id: string | null;
  quantity: string;
  unit_cost: string | null;
  total_value: string | null;
  journal_entry_id: string | null;
  paired_movement_id: string | null;
  status: string;
};

async function restoreIssueLayers(
  tx: Runner,
  orgId: string,
  movement: ReversibleMovement,
): Promise<void> {
  const provisional = (await tx.execute(sql`
    select 1
      from inventory_provisional_costs
     where org_id = ${orgId} and issue_movement_id = ${movement.id}
     limit 1
  `));
  if (provisional.rows.length) {
    throw new InventoryError(
      "a negative-stock issue must have its provisional-cost chain reversed before the issue",
    );
  }

  const consumed = (await tx.execute<{
      cost_layer_id: string;
      quantity: string;
      unit_cost: string;
      remaining_quantity: string;
      original_quantity: string;
      current_unit_cost: string;
    }>(sql`
    select c.cost_layer_id, c.quantity, c.unit_cost,
           l.remaining_quantity, l.original_quantity, l.unit_cost as current_unit_cost
      from cost_layer_consumptions c
      join cost_layers l
        on l.id = c.cost_layer_id
       and l.org_id = c.org_id
     where c.org_id = ${orgId} and c.issue_movement_id = ${movement.id}
     order by c.created_at, c.id
     for update of l
  `));
  const restoredQuantity = sum(consumed.rows.map((row) => row.quantity));
  if (cmp(restoredQuantity, fromUnits(-toUnits(movement.quantity))) !== 0) {
    throw new InventoryError(
      "the issue's exact layer provenance is incomplete; controlled reversal is unavailable",
    );
  }
  for (const row of consumed.rows) {
    if (cmp(row.current_unit_cost, row.unit_cost) !== 0) {
      throw new InventoryError(
        "a consumed cost layer was revalued after this issue; reverse the downstream landed-cost/revaluation first",
      );
    }
    if (
      cmp(add(row.remaining_quantity, row.quantity), row.original_quantity) > 0
    ) {
      throw new InventoryError(
        "restoring the issue would exceed its source layer's original quantity",
      );
    }
    await tx.execute(sql`
      update cost_layers
         set remaining_quantity = remaining_quantity + ${row.quantity},
             updated_at = now()
       where id = ${row.cost_layer_id} and org_id = ${orgId}
    `);
  }
}

async function removeInboundLayer(
  tx: Runner,
  orgId: string,
  movement: ReversibleMovement,
): Promise<void> {
  const settlements = (await tx.execute(sql`
    select 1
      from inventory_provisional_settlements
     where org_id = ${orgId} and receipt_movement_id = ${movement.id}
     limit 1
  `));
  if (settlements.rows.length) {
    throw new InventoryError(
      "a receipt that settled negative stock must be reversed through its full provisional-cost chain",
    );
  }

  const layers = (await tx.execute<{
      id: string;
      original_quantity: string;
      remaining_quantity: string;
    }>(sql`
    select id, original_quantity, remaining_quantity
      from cost_layers
     where org_id = ${orgId} and source_movement_id = ${movement.id}
     order by id
     for update
  `));
  if (layers.rows.length !== 1) {
    throw new InventoryError(
      "the inbound movement was blended into another cost layer; exact reversal requires reversing later inventory activity first",
    );
  }
  const layer = layers.rows[0]!;
  const consumed = (await tx.execute(sql`
    select 1 from cost_layer_consumptions
     where org_id = ${orgId} and cost_layer_id = ${layer.id}
       and not exists (
         select 1
           from inventory_movements reversal
          where reversal.org_id = ${orgId}
            and reversal.reverses_movement_id = cost_layer_consumptions.issue_movement_id
       )
     limit 1
  `));
  if (consumed.rows.length) {
    throw new InventoryError(
      "inventory from this movement has downstream consumption; reverse those issues/transfers first",
    );
  }
  const landed = (await tx.execute(sql`
    select 1
      from landed_cost_allocations allocation
     where allocation.org_id = ${orgId}
       and allocation.target_cost_layer_id = ${layer.id}
       and allocation.reverses_allocation_id is null
       and not exists (
         select 1
           from landed_cost_allocations reversal
          where reversal.org_id = allocation.org_id
            and reversal.reverses_allocation_id = allocation.id
       )
     limit 1
  `));
  if (landed.rows.length) {
    throw new InventoryError(
      "this movement has downstream landed-cost allocations; reverse them before the inventory movement",
    );
  }
  const inboundQuantity = movement.quantity;
  if (
    cmp(inboundQuantity, "0") <= 0 ||
    cmp(layer.original_quantity, inboundQuantity) < 0 ||
    cmp(layer.remaining_quantity, inboundQuantity) < 0
  ) {
    throw new InventoryError(
      "the inbound movement cannot be removed from its cost layer exactly",
    );
  }
  await tx.execute(sql`
    update cost_layers
       set original_quantity = original_quantity - ${inboundQuantity},
           remaining_quantity = remaining_quantity - ${inboundQuantity},
           updated_at = now()
     where id = ${layer.id} and org_id = ${orgId}
  `);
}

async function reverseInventoryJournal(
  tx: Runner,
  orgId: string,
  actorId: string,
  sourceEntryId: string,
  reversalDate: string,
  reason: string,
): Promise<string> {
  const head = (await tx.execute<{
      id: string;
      book_id: string;
      subsidiary_id: string;
      entry_number: string;
      origin: string;
      status: string;
    }>(sql`
    select id, book_id, subsidiary_id, entry_number, origin, status
      from journal_entries
     where id = ${sourceEntryId} and org_id = ${orgId}
     for update
  `));
  const source = head.rows[0];
  if (!source || source.origin !== "inventory" || source.status !== "posted") {
    throw new InventoryError(
      "the movement is not backed by a reversible posted inventory journal",
    );
  }
  const period = (await tx.execute<{ id: string }>(sql`
    select id
      from accounting_periods
     where org_id = ${orgId}
       and is_adjustment = false
       and starts_on <= ${reversalDate}
       and ends_on >= ${reversalDate}
     limit 1
  `));
  if (!period.rows[0])
    throw new InventoryError(`no accounting period for ${reversalDate}`);

  const lines = (await tx.execute<Record<string, any>>(sql`
    select line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
           memo, party_id, department_id, project_id, location_id, class_id,
           equipment_unit_id, payment_card_id, extra_dims, quantity, unit,
           tax_code_id, custom
      from journal_lines
     where org_id = ${orgId} and entry_id = ${sourceEntryId}
     order by line_number
  `));
  if (!lines.rows.length)
    throw new InventoryError("the source inventory journal has no lines");

  const reversal = (await tx.execute<{ id: string }>(sql`
    insert into journal_entries
      (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
       memo, status, origin, reverses_entry_id, created_by, updated_by)
    values
      (${orgId}, ${source.book_id}, ${source.subsidiary_id},
       ${`${source.entry_number}-REV`}, ${reversalDate}, ${period.rows[0].id},
       ${`Inventory reversal: ${reason}`}, 'draft', 'inventory', ${sourceEntryId},
       ${actorId}, ${actorId})
    returning id
  `));
  const reversalEntryId = reversal.rows[0]!.id;
  for (const line of lines.rows) {
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
         currency, txn_amount, fx_rate, memo, party_id, department_id,
         project_id, location_id, class_id, equipment_unit_id, payment_card_id,
         extra_dims, quantity, unit, tax_code_id, custom)
      values
        (${orgId}, ${reversalEntryId}, ${line.line_number}, ${line.account_id},
         ${line.subsidiary_id}, ${neg(String(line.amount))}, ${line.currency},
         ${neg(String(line.txn_amount))}, ${String(line.fx_rate)}, ${line.memo},
         ${line.party_id}, ${line.department_id}, ${line.project_id},
         ${line.location_id}, ${line.class_id}, ${line.equipment_unit_id},
         ${line.payment_card_id}, ${JSON.stringify(line.extra_dims ?? {})}::jsonb,
         ${line.quantity == null ? null : neg(String(line.quantity))}, ${line.unit},
         ${line.tax_code_id}, ${JSON.stringify(line.custom ?? {})}::jsonb)
    `);
  }
  await tx.execute(sql`
    update journal_entries
       set status = 'posted', posted_at = now(), posted_by = ${actorId},
           updated_at = now(), updated_by = ${actorId}
     where id = ${reversalEntryId} and org_id = ${orgId}
  `);
  await tx.execute(sql`
    update journal_entries
       set status = 'reversed', updated_at = now(), updated_by = ${actorId}
     where id = ${sourceEntryId} and org_id = ${orgId}
  `);
  return reversalEntryId;
}

/**
 * Append an exact, linked correction for a receipt, issue, or transfer.
 *
 * The source movement remains posted and immutable. The operation locks the
 * source, restores the precise cost-layer state, mirrors the original journal
 * in the requested open period, and appends one reversal movement per source
 * leg. It fails closed when later consumption, landed cost, negative-stock
 * settlement, blended moving-average provenance, or a compound operation means
 * the original state cannot be reconstructed exactly.
 */
export async function reverseInventoryMovement(
  orgId: string,
  actorId: string,
  input: ReverseInventoryInput,
): Promise<ReverseInventoryResult> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new InventoryError(
      "reversal reason must be between 5 and 500 characters",
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reversalDate)) {
    throw new InventoryError("reversal date must be YYYY-MM-DD");
  }

  return db.transaction(async (tx) => {
    const sourceResult = (await tx.execute<ReversibleMovement>(sql`
      select id, item_id, kind, moved_at::text, stock_location_id, lot_id,
             serial_id, quantity, unit_cost, total_value, journal_entry_id,
             paired_movement_id, status
        from inventory_movements
       where org_id = ${orgId} and id = ${input.movementId}
       for update
    `));
    const requested = sourceResult.rows[0];
    if (!requested) throw new InventoryError("inventory movement not found");
    if (requested.status !== "posted") {
      throw new InventoryError(
        "only posted inventory movements can be reversed",
      );
    }
    const existing = (await tx.execute<{
        id: string;
        journal_entry_id: string | null;
        paired_movement_id: string | null;
      }>(sql`
      select id, journal_entry_id, paired_movement_id
        from inventory_movements
       where org_id = ${orgId} and reverses_movement_id = ${requested.id}
       order by created_at, id
    `));
    if (existing.rows.length) {
      const first = existing.rows[0]!;
      const group = (await tx.execute<{ id: string }>(sql`
        select id
          from inventory_movements
         where org_id = ${orgId}
           and (
             id = ${first.id}
             or paired_movement_id = ${first.id}
             or id = ${first.paired_movement_id}
             or paired_movement_id = ${first.paired_movement_id}
           )
         order by id
      `));
      return {
        movementIds: group.rows.map((row) => row.id),
        entryId: first.journal_entry_id,
        alreadyReversed: true,
      };
    }

    let sources: ReversibleMovement[];
    if (requested.kind === "transfer_out" || requested.kind === "transfer_in") {
      const outId =
        requested.kind === "transfer_out"
          ? requested.id
          : requested.paired_movement_id;
      if (!outId)
        throw new InventoryError(
          "transfer movement is missing its paired source leg",
        );
      const pair = (await tx.execute<ReversibleMovement>(sql`
        select id, item_id, kind, moved_at::text, stock_location_id, lot_id,
               serial_id, quantity, unit_cost, total_value, journal_entry_id,
               paired_movement_id, status
          from inventory_movements
         where org_id = ${orgId}
           and (id = ${outId} or paired_movement_id = ${outId})
         order by case when kind = 'transfer_out' then 0 else 1 end
         for update
      `));
      if (
        pair.rows.length !== 2 ||
        pair.rows[0]!.kind !== "transfer_out" ||
        pair.rows[1]!.kind !== "transfer_in"
      ) {
        throw new InventoryError("transfer movement pair is incomplete");
      }
      sources = pair.rows;
    } else if (requested.kind === "receipt" || requested.kind === "issue") {
      sources = [requested];
    } else {
      throw new InventoryError(
        `${requested.kind} requires its operation-specific controlled reversal`,
      );
    }

    const sourceIds = sources.map((source) => source.id);
    const prior = (await tx.execute<{ reverses_movement_id: string }>(sql`
      select reverses_movement_id
        from inventory_movements
       where org_id = ${orgId}
         and reverses_movement_id in (${sql.join(
           sourceIds.map((id) => sql`${id}`),
           sql`, `,
         )})
       limit 1
    `));
    if (prior.rows.length) {
      throw new InventoryError(
        "one leg of this inventory operation is already reversed",
      );
    }

    const entryIds = [
      ...new Set(
        sources.map((source) => source.journal_entry_id).filter(Boolean),
      ),
    ] as string[];
    if (entryIds.length > 1)
      throw new InventoryError(
        "inventory operation spans multiple source journals",
      );
    const sourceEntryId = entryIds[0] ?? null;
    if (sourceEntryId) {
      const attached = (await tx.execute(sql`
        select id
          from inventory_movements
         where org_id = ${orgId} and journal_entry_id = ${sourceEntryId}
           and id not in (${sql.join(
             sourceIds.map((id) => sql`${id}`),
             sql`, `,
           )})
         limit 1
      `));
      if (attached.rows.length) {
        throw new InventoryError(
          "the source journal contains a compound inventory operation; use its operation-specific reversal",
        );
      }
    }

    for (const source of sources) {
      await lockInventoryPosition(tx, source.item_id, source.stock_location_id);
    }
    const serialId =
      sources.find((source) => source.serial_id)?.serial_id ?? null;
    if (serialId) {
      const serial = (await tx.execute<{
          status: string;
          current_stock_location_id: string | null;
        }>(sql`
        select status, current_stock_location_id
          from serials
         where id = ${serialId} and org_id = ${orgId}
         for update
      `));
      const current = serial.rows[0];
      if (!current) {
        throw new InventoryError(
          "serial evidence is missing for the inventory movement",
        );
      }
      const expectedLocation =
        sources.length === 2
          ? sources.find((source) => source.kind === "transfer_in")!
              .stock_location_id
          : sources[0]!.kind === "receipt"
            ? sources[0]!.stock_location_id
            : null;
      const expectedStatus =
        sources.length === 1 && sources[0]!.kind === "issue"
          ? "shipped"
          : "in_stock";
      if (
        current.status !== expectedStatus ||
        current.current_stock_location_id !== expectedLocation
      ) {
        throw new InventoryError(
          "serial lifecycle has downstream activity; reverse that activity first",
        );
      }
    }
    if (sources.length === 1) {
      if (sources[0]!.kind === "issue") {
        await restoreIssueLayers(tx, orgId, sources[0]!);
      } else {
        await removeInboundLayer(tx, orgId, sources[0]!);
      }
    } else {
      await restoreIssueLayers(tx, orgId, sources[0]!);
      await removeInboundLayer(tx, orgId, sources[1]!);
    }

    const reversalEntryId = sourceEntryId
      ? await reverseInventoryJournal(
          tx,
          orgId,
          actorId,
          sourceEntryId,
          input.reversalDate,
          reason,
        )
      : null;

    const reversalIds: string[] = [];
    let firstReversalId: string | null = null;
    for (const source of sources) {
      const reversalId = randomUUID();
      const pairedReversalId =
        sources.length === 2 && source === sources[1] ? firstReversalId : null;
      await tx.execute(sql`
        insert into inventory_movements
          (id, org_id, item_id, kind, moved_at, stock_location_id, lot_id,
           serial_id, quantity, unit_cost, total_value, journal_entry_id,
           paired_movement_id, reverses_movement_id, reversal_reason, status,
           memo, created_by, updated_by)
        values
          (${reversalId}, ${orgId}, ${source.item_id}, 'return',
           ${input.reversalDate}, ${source.stock_location_id}, ${source.lot_id},
           ${source.serial_id}, ${neg(source.quantity)}, ${source.unit_cost},
           ${source.total_value == null ? null : neg(source.total_value)},
           ${reversalEntryId}, ${pairedReversalId}, ${source.id}, ${reason},
           'posted', ${`Reversal of inventory movement ${source.id}: ${reason}`},
           ${actorId}, ${actorId})
      `);
      firstReversalId ??= reversalId;
      reversalIds.push(reversalId);
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${orgId}, 'inventory_movements', ${source.id}, 'void',
           ${JSON.stringify({
             reason,
             reversalDate: input.reversalDate,
             reversalMovementId: reversalId,
             reversalEntryId,
           })}::jsonb,
           ${actorId})
      `);
    }

    if (serialId) {
      const reversedIssue =
        sources.length === 1 && sources[0]!.kind === "issue";
      const reversedReceipt =
        sources.length === 1 && sources[0]!.kind === "receipt";
      const restoredLocation = reversedIssue
        ? sources[0]!.stock_location_id
        : sources.length === 2
          ? sources.find((source) => source.kind === "transfer_out")!
              .stock_location_id
          : null;
      await tx.execute(sql`
        update serials
           set status = ${reversedReceipt ? "returned" : "in_stock"},
               current_stock_location_id = ${restoredLocation},
               updated_at = now(),
               updated_by = ${actorId}
         where id = ${serialId} and org_id = ${orgId}
      `);
    }

    return {
      // IDs are an unordered operation set. Canonicalize the public result so
      // the creator and an idempotent concurrent retry return byte-identical
      // evidence even when both reversal rows share the same created_at value.
      movementIds: reversalIds.sort(),
      entryId: reversalEntryId,
      alreadyReversed: false,
    };
  });
}

// ---------------------------------------------------------------------------
// Assembly build (light manufacturing / kits)
// ---------------------------------------------------------------------------

export interface BuildInput {
  assemblyItemId: string;
  /** number of assemblies to build (> 0). */
  quantity: string;
  stockLocationId: string;
  subsidiaryId: string;
  date: string;
  memo?: string | null;
}

/**
 * Build assemblies from their bill of materials: consume each component (by its
 * costing method) and produce the finished good at the summed component cost.
 * Posts DR finished-good inventory / CR each component's inventory account.
 * Requires a BOM (bom_components) and inventory profiles on the assembly and
 * every component; blocks a build short of any component.
 */
export async function buildAssembly(
  orgId: string,
  actorId: string | null,
  input: BuildInput,
): Promise<MovementResult> {
  if (cmp(input.quantity, "0") <= 0)
    throw new InventoryError("build quantity must be positive");
  const assembly = await resolveProfile(orgId, input.assemblyItemId);
  if (assembly.tracking !== "none") {
    throw new InventoryError(
      "tracked assemblies require serial/lot build allocation evidence, which this operation does not accept",
    );
  }
  const period = await periodForDate(orgId, input.date);
  if (!period)
    throw new InventoryError(`no accounting period for ${input.date}`);
  const bookId = await primaryBookId(orgId);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);

  const bom = (await db.execute<{ component_item_id: string; quantity_per: string }>(sql`
    select component_item_id, quantity_per from bom_components
     where org_id = ${orgId} and assembly_item_id = ${input.assemblyItemId} order by sort_order`));
  if (bom.rows.length === 0)
    throw new InventoryError("assembly has no bill of materials");

  // Resolve each component: profile, required qty, cost.
  const components: {
    itemId: string;
    profile: InventoryProfile;
    reqQty: string;
    onHand?: { quantity: string; value: string; unitCost: string };
  }[] = [];
  for (const c of bom.rows) {
    const profile = await resolveProfile(orgId, c.component_item_id);
    if (profile.tracking !== "none") {
      throw new InventoryError(
        `tracked component ${c.component_item_id} requires explicit serial/lot consumption evidence`,
      );
    }
    const reqQty = extendCost(input.quantity, c.quantity_per); // quantity × quantity_per
    components.push({ itemId: c.component_item_id, profile, reqQty });
  }

  return await db.transaction(async (tx) => {
    // A build touches every component plus the finished-good position.
    // Deterministic advisory locks make the availability check and all layer
    // updates one serializable operation without deadlocks between BOMs.
    const positionItemIds = [
      input.assemblyItemId,
      ...components.map((component) => component.itemId),
    ]
      .filter((itemId, index, all) => all.indexOf(itemId) === index)
      .sort();
    for (const itemId of positionItemIds) {
      await lockInventoryPosition(tx, itemId, input.stockLocationId);
    }
    for (const component of components) {
      component.onHand = await getOnHandWith(
        tx,
        orgId,
        component.itemId,
        input.stockLocationId,
      );
      if (cmp(component.reqQty, component.onHand.quantity) > 0) {
        throw new InventoryError(
          `insufficient component ${component.itemId}: need ${component.reqQty}, on hand ${component.onHand.quantity}`,
        );
      }
    }

    const consumeLines: JournalLineInput[] = [];
    const perComponent: {
      itemId: string;
      cost: string;
      consumptions: Consumption[];
    }[] = [];
    let totalCost = "0";
    for (const c of components) {
      const { cost, consumptions } = await consumeLayers(
        tx,
        orgId,
        c.profile,
        c.itemId,
        input.stockLocationId,
        c.reqQty,
        c.onHand!,
      );
      totalCost = add(totalCost, cost);
      consumeLines.push({
        accountId: c.profile.assetAccountId,
        amount: neg(cost),
        memo: "Assembly component",
      });
      perComponent.push({ itemId: c.itemId, cost, consumptions });
    }

    const lines: JournalLineInput[] = [
      {
        accountId: assembly.assetAccountId,
        amount: totalCost,
        memo: input.memo ?? "Assembly build",
      },
      ...consumeLines,
    ];
    const entryId = await postInventoryEntry(tx, {
      orgId,
      bookId,
      subsidiaryId: input.subsidiaryId,
      currency,
      periodId: period,
      date: input.date,
      entryNumber: `INV-BUILD-${input.date}-${input.assemblyItemId.slice(0, 8)}`,
      memo: input.memo ?? "Assembly build",
      lines,
    });

    // Component consume movements + layer draw-downs.
    for (let i = 0; i < components.length; i++) {
      const c = components[i];
      const pc = perComponent[i];
      const mv = (await tx.execute<{ id: string }>(sql`
        insert into inventory_movements
          (org_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value, journal_entry_id, status, memo, created_by, updated_by)
        values (${orgId}, ${c.itemId}, 'assembly_consume', ${input.date}, ${input.stockLocationId},
                ${neg(c.reqQty)}, ${isZero(c.reqQty) ? "0" : unitCostPerQuantity(pc.cost, c.reqQty)!},
                ${neg(pc.cost)}, ${entryId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
        returning id`));
      await recordConsumptions(
        tx,
        orgId,
        pc.consumptions,
        mv.rows[0].id,
        actorId,
      );
    }

    // Finished-good build movement + layer.
    const unitCost = isZero(input.quantity)
      ? "0"
      : unitCostPerQuantity(totalCost, input.quantity)!;
    const buildMv = (await tx.execute<{ id: string }>(sql`
      insert into inventory_movements
        (org_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value, journal_entry_id, status, memo, created_by, updated_by)
      values (${orgId}, ${input.assemblyItemId}, 'assembly_build', ${input.date}, ${input.stockLocationId},
              ${input.quantity}, ${unitCost}, ${totalCost}, ${entryId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`));
    await addLayerAtCost(
      tx,
      orgId,
      input.assemblyItemId,
      input.stockLocationId,
      input.quantity,
      unitCost,
      assembly.costingMethod,
      buildMv.rows[0].id,
      input.date,
    );

    return { movementId: buildMv.rows[0].id, entryId, value: totalCost };
  });
}

/**
 * Reverse one complete assembly operation. Component consumptions and the
 * finished-good layer share one journal entry, so they must be restored as a
 * single locked unit; reversing only one movement would corrupt both quantity
 * and valuation provenance.
 */
export async function reverseAssemblyBuild(
  orgId: string,
  actorId: string,
  input: ReverseInventoryInput,
): Promise<ReverseInventoryResult> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new InventoryError(
      "reversal reason must be between 5 and 500 characters",
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reversalDate)) {
    throw new InventoryError("reversal date must be YYYY-MM-DD");
  }

  return db.transaction(async (tx) => {
    const requested = (await tx.execute<ReversibleMovement>(sql`
      select id, item_id, kind, moved_at::text, stock_location_id, lot_id,
             serial_id, quantity, unit_cost, total_value, journal_entry_id,
             paired_movement_id, status
        from inventory_movements
       where org_id = ${orgId} and id = ${input.movementId}
       for update
    `));
    const build = requested.rows[0];
    if (!build || build.kind !== "assembly_build") {
      throw new InventoryError("assembly build movement not found");
    }
    if (!build.journal_entry_id) {
      throw new InventoryError("assembly build is missing its source journal");
    }

    const sources = (await tx.execute<ReversibleMovement>(sql`
      select id, item_id, kind, moved_at::text, stock_location_id, lot_id,
             serial_id, quantity, unit_cost, total_value, journal_entry_id,
             paired_movement_id, status
        from inventory_movements
       where org_id = ${orgId}
         and journal_entry_id = ${build.journal_entry_id}
       order by case when kind = 'assembly_build' then 0 else 1 end, id
       for update
    `));
    if (
      sources.rows.filter((row) => row.kind === "assembly_build").length !== 1 ||
      sources.rows.filter((row) => row.kind === "assembly_consume").length === 0 ||
      sources.rows.some(
        (row) =>
          !["assembly_build", "assembly_consume"].includes(row.kind) ||
          row.status !== "posted",
      )
    ) {
      throw new InventoryError(
        "the assembly journal does not contain one complete posted build operation",
      );
    }

    const sourceIds = sources.rows.map((row) => row.id);
    const prior = (await tx.execute<{ id: string; journal_entry_id: string | null }>(sql`
      select id, journal_entry_id
        from inventory_movements
       where org_id = ${orgId}
         and reverses_movement_id in (${sql.join(
           sourceIds.map((id) => sql`${id}`),
           sql`, `,
         )})
       order by id
    `));
    if (prior.rows.length) {
      if (prior.rows.length !== sources.rows.length) {
        throw new InventoryError(
          "assembly reversal evidence is incomplete",
        );
      }
      return {
        movementIds: prior.rows.map((row) => row.id).sort(),
        entryId: prior.rows[0]!.journal_entry_id,
        alreadyReversed: true,
      };
    }

    for (const key of [
      ...new Set(
        sources.rows.map(
          (row) => `${row.item_id}:${row.stock_location_id}`,
        ),
      ),
    ].sort()) {
      const separator = key.indexOf(":");
      await lockInventoryPosition(
        tx,
        key.slice(0, separator),
        key.slice(separator + 1),
      );
    }

    const finished = sources.rows.find(
      (row) => row.kind === "assembly_build",
    )!;
    await removeInboundLayer(tx, orgId, finished);
    for (const component of sources.rows.filter(
      (row) => row.kind === "assembly_consume",
    )) {
      await restoreIssueLayers(tx, orgId, component);
    }

    const reversalEntryId = await reverseInventoryJournal(
      tx,
      orgId,
      actorId,
      build.journal_entry_id,
      input.reversalDate,
      reason,
    );
    const reversalIds: string[] = [];
    for (const source of sources.rows) {
      const reversalId = randomUUID();
      reversalIds.push(reversalId);
      await tx.execute(sql`
        insert into inventory_movements
          (id, org_id, item_id, kind, moved_at, stock_location_id, lot_id,
           serial_id, quantity, unit_cost, total_value, journal_entry_id,
           reverses_movement_id, reversal_reason, status, memo,
           created_by, updated_by)
        values
          (${reversalId}, ${orgId}, ${source.item_id}, 'return',
           ${input.reversalDate}, ${source.stock_location_id}, ${source.lot_id},
           ${source.serial_id}, ${neg(source.quantity)}, ${source.unit_cost},
           ${source.total_value == null ? null : neg(source.total_value)},
           ${reversalEntryId}, ${source.id}, ${reason}, 'posted',
           ${`Reversal of assembly movement ${source.id}: ${reason}`},
           ${actorId}, ${actorId})
      `);
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${orgId}, 'inventory_movements', ${source.id}, 'void',
           ${JSON.stringify({
             reason,
             reversalDate: input.reversalDate,
             reversalMovementId: reversalId,
             reversalEntryId,
             operation: "assembly_build",
           })}::jsonb,
           ${actorId})
      `);
    }
    return {
      movementIds: reversalIds.sort(),
      entryId: reversalEntryId,
      alreadyReversed: false,
    };
  });
}

// ---------------------------------------------------------------------------
// Landed cost (allocate freight/duty onto receipt layers)
// ---------------------------------------------------------------------------
type RevaluableLayer = {
  id: string;
  source_movement_id: string;
  received_at: string;
  original_quantity: string;
  remaining_quantity: string;
  unit_cost: string;
};

/**
 * Increase one layer's remaining value by exactly `shareUnits`.
 *
 * Unit costs are stored at four decimals. A naïve average-cost bump therefore
 * loses pennies whenever quantity does not divide the allocation exactly
 * (three units + $0.01 used to add only $0.0099 to the subledger while the GL
 * added $0.0100). For quantities above one unit, keep an average bump on the
 * main layer and split one whole unit into a deterministic rounding layer.
 * One unit has a 1:1 mapping between rate units and value units, so the
 * residual is always representable without floating point or an off-ledger
 * plug. The split preserves the pre-allocation value exactly.
 */
async function revalueLayerExactly(
  tx: Runner,
  orgId: string,
  layer: RevaluableLayer,
  shareUnits: bigint,
  actorId: string | null,
  allowLayerSplit = true,
): Promise<{ layerId: string; amount: string }[]> {
  if (shareUnits <= 0n) return [];
  const scale = 10_000n;
  const quantityUnits = toUnits(layer.remaining_quantity);
  const oldRateUnits = toUnits(layer.unit_cost);
  if (quantityUnits <= 0n) {
    throw new InventoryError("cannot revalue an empty inventory layer");
  }
  const valueAt = (quantity: bigint, rate: bigint) =>
    roundDiv(quantity * rate, scale);

  const targetValue = valueAt(quantityUnits, oldRateUnits) + shareUnits;
  const findExactRate = (): bigint | null => {
    let low = oldRateUnits;
    let high =
      (targetValue * scale + quantityUnits - 1n) / quantityUnits + 2n;
    if (high < low) high = low;
    while (valueAt(quantityUnits, high) < targetValue) {
      high = high * 2n + 1n;
    }
    while (low < high) {
      const mid = (low + high) / 2n;
      if (valueAt(quantityUnits, mid) < targetValue) low = mid + 1n;
      else high = mid;
    }
    return valueAt(quantityUnits, low) === targetValue ? low : null;
  };
  const exactRate = findExactRate();
  if (exactRate != null) {
    await tx.execute(sql`
      update cost_layers
         set unit_cost = ${fromUnits(exactRate)}, updated_at = now(), updated_by = ${actorId}
       where id = ${layer.id} and org_id = ${orgId}
    `);
    return [{ layerId: layer.id, amount: fromUnits(shareUnits) }];
  }
  if (!allowLayerSplit) {
    throw new InventoryError(
      "landed cost is not exactly representable on a moving-average layer at current precision",
    );
  }

  const roundingQuantityUnits = scale; // exactly one base unit
  const mainQuantityUnits = quantityUnits - roundingQuantityUnits;
  const mainOldValue = valueAt(mainQuantityUnits, oldRateUnits);
  let mainRateUnits =
    oldRateUnits + (shareUnits * scale) / quantityUnits;
  let mainDelta =
    valueAt(mainQuantityUnits, mainRateUnits) - mainOldValue;
  while (mainDelta > shareUnits && mainRateUnits > oldRateUnits) {
    mainRateUnits -= 1n;
    mainDelta = valueAt(mainQuantityUnits, mainRateUnits) - mainOldValue;
  }
  if (mainDelta < 0n || mainDelta > shareUnits) {
    throw new InventoryError(
      "landed-cost allocation produced an invalid layer delta",
    );
  }
  const roundingDelta = shareUnits - mainDelta;
  const roundingRateUnits = oldRateUnits + roundingDelta;
  const splitLayerId = randomUUID();

  await tx.execute(sql`
    update cost_layers
       set original_quantity = original_quantity - '1.0000',
           remaining_quantity = remaining_quantity - '1.0000',
           unit_cost = ${fromUnits(mainRateUnits)},
           updated_at = now(),
           updated_by = ${actorId}
     where id = ${layer.id} and org_id = ${orgId}
  `);
  await tx.execute(sql`
    insert into cost_layers
      (id, org_id, item_id, stock_location_id, source_movement_id, received_at,
       original_quantity, remaining_quantity, unit_cost, created_by, updated_by)
    select ${splitLayerId}, org_id, item_id, stock_location_id,
           ${layer.source_movement_id}, ${layer.received_at},
           '1.0000', '1.0000', ${fromUnits(roundingRateUnits)},
           ${actorId}, ${actorId}
      from cost_layers
     where id = ${layer.id} and org_id = ${orgId}
  `);

  const fragments: { layerId: string; amount: string }[] = [];
  if (mainDelta > 0n) {
    fragments.push({ layerId: layer.id, amount: fromUnits(mainDelta) });
  }
  if (roundingDelta > 0n) {
    fragments.push({
      layerId: splitLayerId,
      amount: fromUnits(roundingDelta),
    });
  }
  return fragments;
}

/** Remove an exact landed-cost fragment from an untouched layer. */
async function devalueLayerExactly(
  tx: Runner,
  orgId: string,
  layer: RevaluableLayer,
  amountUnits: bigint,
  actorId: string,
): Promise<void> {
  if (amountUnits <= 0n) {
    throw new InventoryError("landed-cost reversal amount must be positive");
  }
  const scale = 10_000n;
  const quantityUnits = toUnits(layer.remaining_quantity);
  const currentRateUnits = toUnits(layer.unit_cost);
  if (
    quantityUnits <= 0n ||
    cmp(layer.remaining_quantity, layer.original_quantity) !== 0
  ) {
    throw new InventoryError(
      "landed cost cannot be reversed after its layer has been consumed",
    );
  }
  const valueAt = (quantity: bigint, rate: bigint) =>
    roundDiv(quantity * rate, scale);
  const currentValue = valueAt(quantityUnits, currentRateUnits);
  const targetValue = currentValue - amountUnits;
  if (targetValue < 0n) {
    throw new InventoryError(
      "landed-cost reversal would make the layer value negative",
    );
  }
  let low = 0n;
  let high = currentRateUnits;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (valueAt(quantityUnits, mid) < targetValue) low = mid + 1n;
    else high = mid;
  }
  if (valueAt(quantityUnits, low) !== targetValue) {
    throw new InventoryError(
      "landed-cost reversal is not exactly representable at ledger precision",
    );
  }
  await tx.execute(sql`
    update cost_layers
       set unit_cost = ${fromUnits(low)}, updated_at = now(), updated_by = ${actorId}
     where id = ${layer.id} and org_id = ${orgId}
  `);
}

/** Largest-remainder apportionment of money units across numeric weights. */
function apportionUnits(totalUnits: bigint, weights: string[]): bigint[] {
  const iw = weights.map((weight) => {
    const units = toUnits(weight);
    return units > 0n ? units : 0n;
  });
  const iwsum = iw.reduce((a, b) => a + b, 0n);
  if (iwsum === 0n || totalUnits === 0n) return weights.map(() => 0n);
  const base = iw.map((w) => (totalUnits * w) / iwsum);
  let remainder = totalUnits - base.reduce((a, b) => a + b, 0n);
  const order = iw
    .map((w, i) => ({ i, frac: (totalUnits * w) % iwsum }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  let k = 0;
  while (remainder > 0n) {
    base[order[k % order.length].i] += 1n;
    remainder -= 1n;
    k++;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Document integration — bill receipts & invoice/shipment issues
// ---------------------------------------------------------------------------

export interface DocumentInventoryLine {
  lineId: string;
  itemId: string;
  stockLocationId: string;
  /** base-unit quantity for the line (absolute). */
  quantity: string;
  /** line extended amount (for unit-cost derivation on receipts). */
  amount: string;
  assetAccountId: string;
  clearingAccountId: string | null;
  costingMethod: InventoryProfile["costingMethod"];
}

/** The one active stock location, when the org has exactly one (else null). */
async function defaultStockLocation(
  runner: Runner,
  orgId: string,
): Promise<string | null> {
  const r = (await runner.execute<{ id: string }>(sql`
    select id from stock_locations where org_id = ${orgId} and is_active`));
  return r.rows.length === 1 ? r.rows[0].id : null;
}

/**
 * The inventory lines of a document: item has a costing profile AND a stock
 * location resolves (line-level, else the single default). Shared by the
 * posting-rule account router and the receipt/issue hooks so they always agree
 * on which lines are inventory.
 */
export async function loadDocumentInventoryLines(
  runner: Runner,
  orgId: string,
  documentId: string,
): Promise<DocumentInventoryLine[]> {
  const fallback = await defaultStockLocation(runner, orgId);
  const r = (await runner.execute<{
      line_id: string;
      item_id: string;
      quantity: string;
      amount: string;
      stock_location_id: string | null;
      asset_account_id: string;
      received_not_billed_account_id: string | null;
      costing_method: InventoryProfile["costingMethod"];
    }>(sql`
    select dl.id as line_id, dl.item_id, dl.quantity, dl.amount, dl.stock_location_id,
           p.asset_account_id, p.received_not_billed_account_id, p.costing_method
      from document_lines dl
      join item_inventory_profiles p on p.item_id = dl.item_id
     where dl.document_id = ${documentId} and dl.org_id = ${orgId}
       and dl.item_id is not null and dl.quantity <> 0
     order by dl.line_number`));
  const out: DocumentInventoryLine[] = [];
  for (const row of r.rows) {
    const loc = row.stock_location_id ?? fallback;
    if (!loc) continue; // no location resolvable → treat as non-inventory
    out.push({
      lineId: row.line_id,
      itemId: row.item_id,
      stockLocationId: loc,
      quantity: fromUnits(
        toUnits(row.quantity) < 0n
          ? -toUnits(row.quantity)
          : toUnits(row.quantity),
      ),
      amount: row.amount,
      assetAccountId: row.asset_account_id,
      clearingAccountId: row.received_not_billed_account_id,
      costingMethod: row.costing_method,
    });
  }
  return out;
}

/**
 * lineId → the GL account a vendor bill's inventory line should DEBIT: the
 * received-not-billed clearing account when configured, else the inventory
 * asset account directly. Consumed by the posting engine (posting.ts).
 */
export async function resolveBillInventoryAccounts(
  runner: Runner,
  orgId: string,
  documentId: string,
): Promise<Map<string, string>> {
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  const map = new Map<string, string>();
  for (const l of lines)
    map.set(l.lineId, l.clearingAccountId ?? l.assetAccountId);
  return map;
}

/**
 * After a vendor bill posts, receive each inventory line into stock. If the item
 * has a clearing account the bill DR'd it, so the receipt posts DR inventory /
 * CR clearing (draining it, + PPV under standard costing). Otherwise the bill
 * DR'd inventory directly and we record the layer with no separate entry.
 * Idempotent: a line that already produced a receipt movement is skipped.
 */
export async function applyInventoryReceiptsForBill(
  orgId: string,
  actorId: string | null,
  documentId: string,
  billEntryId: string,
  date: string,
  subsidiaryId: string,
): Promise<number> {
  const lines = await loadDocumentInventoryLines(db, orgId, documentId);
  let count = 0;
  for (const l of lines) {
    const seen = (await db.execute(sql`
      select 1 from inventory_movements where org_id = ${orgId} and document_line_id = ${l.lineId} and kind = 'receipt' limit 1`));
    if (seen.rows[0]) continue;
    const unitCost = isZero(l.quantity)
      ? "0"
      : unitCostPerQuantity(l.amount, l.quantity)!;
    await receiveInventory(orgId, actorId, {
      itemId: l.itemId,
      stockLocationId: l.stockLocationId,
      quantity: l.quantity,
      unitCost,
      subsidiaryId,
      offsetAccountId: l.clearingAccountId ?? undefined,
      postJournal: l.clearingAccountId != null,
      linkEntryId: billEntryId,
      date,
      documentLineId: l.lineId,
      memo: "Inventory receipt (bill)",
    });
    count++;
  }
  return count;
}

/**
 * After a customer invoice posts (revenue booked), issue each inventory line to
 * COGS: DR COGS / CR inventory at the item's costed value. Independent of the
 * revenue entry. Idempotent per line.
 */
export async function applyInventoryIssuesForInvoice(
  orgId: string,
  actorId: string | null,
  documentId: string,
  date: string,
  subsidiaryId: string,
): Promise<number> {
  const lines = await loadDocumentInventoryLines(db, orgId, documentId);
  let count = 0;
  for (const l of lines) {
    const seen = (await db.execute(sql`
      select 1 from inventory_movements where org_id = ${orgId} and document_line_id = ${l.lineId} and kind = 'issue' limit 1`));
    if (seen.rows[0]) continue;
    await issueInventory(orgId, actorId, {
      itemId: l.itemId,
      stockLocationId: l.stockLocationId,
      quantity: l.quantity,
      subsidiaryId,
      date,
      documentLineId: l.lineId,
      memo: "COGS (invoice)",
    });
    count++;
  }
  return count;
}

export { cmp as compareMoney };

// ---------------------------------------------------------------------------
// Lot / serial tracking
// ---------------------------------------------------------------------------

/**
 * Enforce an item's tracking discipline on a movement. Lot-tracked items must
 * name a lot on receipt; serial-tracked items always move exactly one unit and
 * must name the serial. (Issues pick lots/serials via their own inputs; the
 * receipt-side rule is what guarantees downstream traceability.)
 */
export function assertTracking(
  profile: { tracking: string },
  input: { quantity: string; lotId?: string | null; serialId?: string | null },
  kind: string,
): void {
  if (profile.tracking === "lot") {
    if (!input.lotId) {
      throw new InventoryError(`lot-tracked item requires a lot on ${kind}`);
    }
    if (input.serialId) {
      throw new InventoryError("lot-tracked item cannot carry a serial");
    }
  } else if (profile.tracking === "serial") {
    if (!input.serialId)
      throw new InventoryError(
        `serial-tracked item requires a serial on ${kind}`,
      );
    if (cmp(input.quantity, "1") !== 0 && cmp(input.quantity, "-1") !== 0) {
      throw new InventoryError(
        "serial-tracked movements must be exactly one unit per serial",
      );
    }
    if (input.lotId) {
      throw new InventoryError("serial-tracked item cannot carry a lot");
    }
  } else if (input.lotId || input.serialId) {
    throw new InventoryError(
      "untracked item movement cannot carry lot or serial evidence",
    );
  }
}

/** Find-or-create a lot for an item; a later expiry date is never lost. */
export async function ensureLot(
  orgId: string,
  itemId: string,
  lotNumber: string,
  expiresOn: string | null,
  actorId: string | null,
): Promise<string> {
  if (!lotNumber?.trim()) throw new InventoryError("lot number is required");
  return db.transaction(async (tx) => {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into lots
        (org_id, item_id, lot_number, expires_on, created_by, updated_by)
      values
        (${orgId}, ${itemId}, ${lotNumber.trim()}, ${expiresOn ?? null},
         ${actorId}, ${actorId})
      on conflict (item_id, lot_number) do nothing
      returning id
    `));
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = (await tx.execute<{ id: string; org_id: string; expires_on: string | null }>(sql`
      select id, org_id, expires_on::text
        from lots
       where item_id = ${itemId} and lot_number = ${lotNumber.trim()}
       for update
    `));
    const row = existing.rows[0];
    if (!row || row.org_id !== orgId) {
      throw new InventoryError("lot identity belongs to another organization");
    }
    if (
      expiresOn != null &&
      row.expires_on != null &&
      expiresOn !== row.expires_on
    ) {
      throw new InventoryError(
        "lot expiry is already established; use a controlled correction with audit evidence",
      );
    }
    if (expiresOn != null && row.expires_on == null) {
      await tx.execute(sql`
        update lots
           set expires_on = ${expiresOn}, updated_at = now(), updated_by = ${actorId}
         where id = ${row.id} and org_id = ${orgId}
      `);
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${orgId}, 'lots', ${row.id}, 'update',
           ${JSON.stringify({
             expiresOn: { before: null, after: expiresOn },
             reason: "complete previously missing lot expiry evidence",
           })}::jsonb,
           ${actorId})
      `);
    }
    return row.id;
  });
}

/** Find-or-create a serial for an item, placing it in stock at a location. */
export async function ensureSerial(
  orgId: string,
  itemId: string,
  serialNumber: string,
  stockLocationId: string | null,
  actorId: string | null,
): Promise<string> {
  if (!serialNumber?.trim())
    throw new InventoryError("serial number is required");
  return db.transaction(async (tx) => {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into serials
        (org_id, item_id, serial_number, status, current_stock_location_id,
         created_by, updated_by)
      values
        (${orgId}, ${itemId}, ${serialNumber.trim()}, 'registered', null,
         ${actorId}, ${actorId})
      on conflict (item_id, serial_number) do nothing
      returning id
    `));
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = (await tx.execute<{
        id: string;
        org_id: string;
        current_stock_location_id: string | null;
      }>(sql`
      select id, org_id, current_stock_location_id
        from serials
       where item_id = ${itemId} and serial_number = ${serialNumber.trim()}
       for update
    `));
    const row = existing.rows[0];
    if (!row || row.org_id !== orgId) {
      throw new InventoryError(
        "serial identity belongs to another organization",
      );
    }
    if (
      stockLocationId &&
      row.current_stock_location_id &&
      row.current_stock_location_id !== stockLocationId
    ) {
      throw new InventoryError(
        "serial is already registered at a different stock location",
      );
    }
    return row.id;
  });
}

export interface LotRecallFilter {
  lotNumber?: string;
  lotId?: string;
  itemId?: string;
  expiresOnOrBefore?: string;
  includeExpiryOnly?: boolean;
}

export type LotRecallRow = {
  movementId: string;
  lotId: string;
  lotNumber: string;
  expiresOn: string | null;
  itemId: string;
  itemCode: string | null;
  itemName: string | null;
  kind: string;
  movedAt: string;
  quantity: string;
  locationCode: string | null;
  documentId: string | null;
  documentNumber: string | null;
  partyName: string | null;
};

/**
 * Lot traceability: every movement that touched a lot, with the source
 * document and party where the movement came from a bill/invoice line. This
 * is the recall report — "which customers received lot X" runs the same query
 * filtered to issues.
 */
export async function queryLotRecall(
  orgId: string,
  filter: LotRecallFilter,
): Promise<LotRecallRow[]> {
  const r = (await db.execute<LotRecallRow>(sql`
    select im.id as "movementId", l.id as "lotId", l.lot_number as "lotNumber", l.expires_on::text as "expiresOn",
           i.id as "itemId", i.code as "itemCode", i.name as "itemName", im.kind, im.moved_at::text as "movedAt",
           im.quantity::text as "quantity", sl.code as "locationCode",
           d.id as "documentId", d.document_number as "documentNumber", p.display_name as "partyName"
      from inventory_movements im
      join lots l on l.id = im.lot_id and l.org_id = im.org_id
      join items i on i.id = im.item_id and i.org_id = im.org_id
      left join stock_locations sl on sl.id = im.stock_location_id and sl.org_id = im.org_id
      left join document_lines dl on dl.id = im.document_line_id and dl.org_id = im.org_id
      left join documents d on d.id = dl.document_id and d.org_id = im.org_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where im.org_id = ${orgId}
       and (${filter.lotId ?? null}::uuid is null or l.id = ${filter.lotId ?? null}::uuid)
       and (${filter.itemId ?? null}::uuid is null or l.item_id = ${filter.itemId ?? null}::uuid)
       and (${filter.lotNumber ?? null}::text is null or l.lot_number ilike '%' || ${filter.lotNumber ?? ""} || '%')
       and (${filter.expiresOnOrBefore ?? null}::date is null or l.expires_on <= ${filter.expiresOnOrBefore ?? null}::date)
       and (${filter.includeExpiryOnly !== true} or l.expires_on is not null)
     order by im.moved_at desc
     limit 500`));
  return r.rows;
}

// ---------------------------------------------------------------------------
// Transfer orders — two-step (ship → in-transit → receive) location moves
// ---------------------------------------------------------------------------

async function nextSequenceNumber(
  orgId: string,
  kind: string,
  prefix: string,
  subsidiaryId: string | null,
  runner: Runner = db,
): Promise<string> {
  const configured = subsidiaryId
    ? (
        (await runner.execute(sql`
        select 1 from number_sequences where org_id = ${orgId} and document_kind = ${kind}
          and subsidiary_id = ${subsidiaryId} limit 1`))
      ).rows.length > 0
    : false;
  const seq = (await runner.execute<{ prefix: string; next_number: number; padding: number }>(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${configured ? subsidiaryId : null}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding`));
  const s = seq.rows[0];
  return `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
}

export interface TransferOrderLineInput {
  itemId: string;
  quantity: string;
  lotId?: string | null;
  serialId?: string | null;
}

export interface CreateTransferOrderInput {
  fromStockLocationId: string;
  toStockLocationId: string;
  subsidiaryId: string;
  orderedOn: string;
  /** GL account holding value while goods are in transit (optional; when set,
   *  ship/receive post value reclasses against each item's asset account). */
  inTransitAccountId?: string | null;
  transitStockLocationId?: string | null;
  memo?: string | null;
  lines: TransferOrderLineInput[];
}
type TransferOrderRow = {
  id: string;
  status: string;
  from_stock_location_id: string;
  to_stock_location_id: string;
  transit_stock_location_id: string | null;
  in_transit_account_id: string | null;
  subsidiary_id: string;
  document_number: string;
};

export async function createTransferOrder(
  orgId: string,
  actorId: string | null,
  input: CreateTransferOrderInput,
): Promise<{ id: string; documentNumber: string }> {
  if (input.fromStockLocationId === input.toStockLocationId) {
    throw new InventoryError("transfer order needs two different locations");
  }
  if (!input.lines?.length)
    throw new InventoryError("transfer order needs at least one line");
  for (const line of input.lines) {
    if (cmp(line.quantity, "0") <= 0)
      throw new InventoryError("transfer order line quantity must be positive");
  }
  const documentNumber = await nextSequenceNumber(
    orgId,
    "transfer_order",
    "TO-",
    input.subsidiaryId,
  );
  return await db.transaction(async (tx) => {
    const order = (await tx.execute<{ id: string }>(sql`
      insert into transfer_orders
        (org_id, document_number, status, from_stock_location_id, to_stock_location_id,
         transit_stock_location_id, in_transit_account_id, subsidiary_id, ordered_on, memo, created_by, updated_by)
      values (${orgId}, ${documentNumber}, 'draft', ${input.fromStockLocationId}, ${input.toStockLocationId},
              ${input.transitStockLocationId ?? null}, ${input.inTransitAccountId ?? null}, ${input.subsidiaryId},
              ${input.orderedOn}, ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`));
    const id = order.rows[0].id;
    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i];
      await tx.execute(sql`
        insert into transfer_order_lines
          (org_id, transfer_order_id, line_number, item_id, quantity, lot_id, serial_id, created_by, updated_by)
        values (${orgId}, ${id}, ${i + 1}, ${line.itemId}, ${line.quantity},
                ${line.lotId ?? null}, ${line.serialId ?? null}, ${actorId}, ${actorId})`);
    }
    return { id, documentNumber };
  });
}

async function loadTransferOrderForUpdate(
  tx: Runner,
  orgId: string,
  orderId: string,
): Promise<TransferOrderRow> {
  const r = (await tx.execute<TransferOrderRow>(sql`
    select id, status, from_stock_location_id, to_stock_location_id, transit_stock_location_id,
           in_transit_account_id, subsidiary_id, document_number
      from transfer_orders where org_id = ${orgId} and id = ${orderId} for update`));
  if (!r.rows[0]) throw new InventoryError("transfer order not found");
  return r.rows[0];
}

async function resolveTransitLocation(
  tx: Runner,
  orgId: string,
  order: TransferOrderRow,
): Promise<string> {
  if (order.transit_stock_location_id) return order.transit_stock_location_id;
  const r = (await tx.execute<{ id: string }>(sql`
    select id from stock_locations where org_id = ${orgId} and kind = 'transit' and is_active
     order by created_at limit 1`));
  if (!r.rows[0]) {
    throw new InventoryError(
      `transfer order ${order.document_number} has no transit stock location and none exists`,
    );
  }
  return r.rows[0].id;
}

/** Post the in-transit value reclass for a ship/receive leg, when the order
 *  carries an in-transit GL account. `direction` = 'ship' moves value into the
 *  in-transit account, 'receive' moves it back out. */
async function postInTransitReclass(
  tx: Runner,
  p: {
    orgId: string;
    order: TransferOrderRow;
    date: string;
    direction: "ship" | "receive";
    amounts: { assetAccountId: string; value: string; memo: string }[];
  },
): Promise<string | null> {
  if (!p.order.in_transit_account_id) return null;
  const amounts = p.amounts.filter((a) => !isZero(a.value));
  if (amounts.length === 0) return null;
  const total = sum(amounts.map((a) => a.value));
  const periodId = await periodForDate(p.orgId, p.date, tx);
  if (!periodId) throw new InventoryError(`no accounting period for ${p.date}`);
  const bookId = await primaryBookId(p.orgId, tx);
  const currency = await subsidiaryCurrency(
    p.orgId,
    p.order.subsidiary_id,
    tx,
  );
  const inTransit = p.order.in_transit_account_id;
  const lines: JournalLineInput[] =
    p.direction === "ship"
      ? [
          { accountId: inTransit, amount: total, memo: "Goods in transit" },
          ...amounts.map((a) => ({
            accountId: a.assetAccountId,
            amount: neg(a.value),
            memo: a.memo,
          })),
        ]
      : [
          ...amounts.map((a) => ({
            accountId: a.assetAccountId,
            amount: a.value,
            memo: a.memo,
          })),
          {
            accountId: inTransit,
            amount: neg(total),
            memo: "Goods received from transit",
          },
        ];
  return postInventoryEntry(tx, {
    orgId: p.orgId,
    bookId,
    subsidiaryId: p.order.subsidiary_id,
    currency,
    periodId,
    date: p.date,
    entryNumber: `INV-XFER-${p.direction.toUpperCase()}-${p.order.document_number}`,
    memo: `Transfer ${p.order.document_number} ${p.direction === "ship" ? "shipped" : "received"}`,
    lines,
  });
}

/**
 * Ship a draft transfer order: every line's full quantity moves source →
 * transit location at carried cost (subledger), and — when the order names an
 * in-transit account — value reclasses into it. One-shot by design; partial
 * shipments ride additional transfer orders.
 */
export async function shipTransferOrder(
  orgId: string,
  actorId: string | null,
  orderId: string,
  date?: string,
): Promise<{ id: string; status: string; entryId: string | null }> {
  const shipDate = date ?? await businessToday(orgId);
  return await db.transaction(async (tx) => {
    const order = await loadTransferOrderForUpdate(tx, orgId, orderId);
    if (order.status !== "draft")
      throw new InventoryError(
        `transfer order ${order.document_number} is ${order.status}`,
      );
    const transitId = await resolveTransitLocation(tx, orgId, order);
    const lines = (await tx.execute<{
        id: string;
        item_id: string;
        quantity: string;
        lot_id: string | null;
        serial_id: string | null;
      }>(sql`
      select id, item_id, quantity, lot_id, serial_id from transfer_order_lines
       where org_id = ${orgId} and transfer_order_id = ${orderId} order by line_number for update`));
    const amounts: { assetAccountId: string; value: string; memo: string }[] =
      [];
    for (const line of lines.rows) {
      const profile = await resolveProfile(orgId, line.item_id, tx);
      const moved = await transferInventoryTx(tx, orgId, actorId, {
        itemId: line.item_id,
        fromStockLocationId: order.from_stock_location_id,
        toStockLocationId: transitId,
        quantity: line.quantity,
        lotId: line.lot_id,
        serialId: line.serial_id,
        subsidiaryId: order.subsidiary_id,
        date: shipDate,
        memo: `Transfer ${order.document_number} shipped`,
      });
      await tx.execute(sql`
        update transfer_order_lines
           set quantity_shipped = ${line.quantity}, ship_movement_id = ${moved.fromMovementId}, updated_at = now(), updated_by = ${actorId}
         where id = ${line.id} and org_id = ${orgId}`);
      amounts.push({
        assetAccountId: profile.assetAccountId,
        value: moved.value,
        memo: `Transfer ${order.document_number}`,
      });
    }
    const entryId = await postInTransitReclass(tx, {
      orgId,
      order,
      date: shipDate,
      direction: "ship",
      amounts,
    });
    await tx.execute(sql`
      update transfer_orders
         set status = 'in_transit', shipped_on = ${shipDate}, ship_journal_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
       where id = ${orderId} and org_id = ${orgId}`);
    return { id: orderId, status: "in_transit", entryId };
  });
}

/** Receive an in-transit transfer order at its destination location. */
export async function receiveTransferOrder(
  orgId: string,
  actorId: string | null,
  orderId: string,
  date?: string,
): Promise<{ id: string; status: string; entryId: string | null }> {
  const receiveDate = date ?? await businessToday(orgId);
  return await db.transaction(async (tx) => {
    const order = await loadTransferOrderForUpdate(tx, orgId, orderId);
    if (order.status !== "in_transit")
      throw new InventoryError(
        `transfer order ${order.document_number} is ${order.status}`,
      );
    const transitId = await resolveTransitLocation(tx, orgId, order);
    const lines = (await tx.execute<{
        id: string;
        item_id: string;
        quantity_shipped: string;
        lot_id: string | null;
        serial_id: string | null;
      }>(sql`
      select id, item_id, quantity_shipped, lot_id, serial_id from transfer_order_lines
       where org_id = ${orgId} and transfer_order_id = ${orderId} order by line_number for update`));
    const amounts: { assetAccountId: string; value: string; memo: string }[] =
      [];
    for (const line of lines.rows) {
      if (isZero(line.quantity_shipped)) continue;
      const profile = await resolveProfile(orgId, line.item_id, tx);
      const moved = await transferInventoryTx(tx, orgId, actorId, {
        itemId: line.item_id,
        fromStockLocationId: transitId,
        toStockLocationId: order.to_stock_location_id,
        quantity: line.quantity_shipped,
        lotId: line.lot_id,
        serialId: line.serial_id,
        subsidiaryId: order.subsidiary_id,
        date: receiveDate,
        memo: `Transfer ${order.document_number} received`,
      });
      await tx.execute(sql`
        update transfer_order_lines
           set quantity_received = ${line.quantity_shipped}, receive_movement_id = ${moved.toMovementId}, updated_at = now(), updated_by = ${actorId}
         where id = ${line.id} and org_id = ${orgId}`);
      amounts.push({
        assetAccountId: profile.assetAccountId,
        value: moved.value,
        memo: `Transfer ${order.document_number}`,
      });
    }
    const entryId = await postInTransitReclass(tx, {
      orgId,
      order,
      date: receiveDate,
      direction: "receive",
      amounts,
    });
    await tx.execute(sql`
      update transfer_orders
         set status = 'received', received_on = ${receiveDate}, receive_journal_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
       where id = ${orderId} and org_id = ${orgId}`);
    return { id: orderId, status: "received", entryId };
  });
}

// ---------------------------------------------------------------------------
// Landed cost vouchers — one freight/duty amount spread across many targets
// ---------------------------------------------------------------------------

export interface LandedCostVoucherTargetInput {
  itemId: string;
  stockLocationId: string;
  /** basis 'manual': the exact amount this target receives. */
  manualAmount?: string | null;
}

export interface PostLandedCostVoucherInput {
  amount: string;
  basis: "value" | "quantity" | "weight" | "manual";
  freightAccountId: string;
  subsidiaryId: string;
  voucherDate: string;
  sourceDocumentLineId?: string | null;
  memo?: string | null;
  targets: LandedCostVoucherTargetInput[];
}
type OpenLayer = RevaluableLayer;

/** The apportionment weight of one target's on-hand layers under a basis. */
function layerWeights(
  layers: OpenLayer[],
  basis: "value" | "quantity" | "weight",
  weightsByLayer?: Map<string, string>,
): string[] {
  return layers.map((l) => {
    if (basis === "quantity") return l.remaining_quantity;
    if (basis === "weight")
      return extendCost(l.remaining_quantity, weightsByLayer?.get(l.id) ?? "0");
    return extendCost(l.remaining_quantity, l.unit_cost);
  });
}

/**
 * Capitalize one freight/duty amount across several item+location targets.
 * Shares are apportioned by the basis (value, quantity, layer weight, or
 * explicit manual amounts that must sum to the total), each target's share
 * bumps its open cost layers, and ONE balanced entry posts DR each target's
 * inventory asset / CR the freight account.
 */
export async function postLandedCostVoucher(
  orgId: string,
  actorId: string | null,
  input: PostLandedCostVoucherInput,
): Promise<{ id: string; documentNumber: string; entryId: string }> {
  if (cmp(input.amount, "0") <= 0)
    throw new InventoryError("landed cost amount must be positive");
  if (!input.targets?.length)
    throw new InventoryError("landed cost voucher needs at least one target");
  const periodId = await periodForDate(orgId, input.voucherDate);
  if (!periodId)
    throw new InventoryError(`no accounting period for ${input.voucherDate}`);

  const targetKeys = input.targets.map(
    (target) => `${target.itemId}:${target.stockLocationId}`,
  );
  if (new Set(targetKeys).size !== targetKeys.length) {
    throw new InventoryError(
      "landed cost voucher targets must be unique by item and stock location",
    );
  }

  return db.transaction(async (tx) => {
    for (const key of [...targetKeys].sort()) {
      const separator = key.indexOf(":");
      await lockInventoryPosition(
        tx,
        key.slice(0, separator),
        key.slice(separator + 1),
      );
    }

    // Resolve and lock layers only after every target position is serialized,
    // so allocation weights and the revaluation commit from one snapshot.
    const resolved: {
      target: LandedCostVoucherTargetInput;
      profile: InventoryProfile;
      layers: OpenLayer[];
      shareWeight: string;
      manualAmount: string | null;
    }[] = [];
    for (const target of input.targets) {
      const profile = await resolveProfile(orgId, target.itemId, tx);
      const layers = (
        (await tx.execute<OpenLayer>(sql`
        select id, source_movement_id, received_at::text, original_quantity,
               remaining_quantity, unit_cost
          from cost_layers
         where org_id = ${orgId} and item_id = ${target.itemId}
           and stock_location_id = ${target.stockLocationId}
           and remaining_quantity > 0
         order by received_at, id
         for update`))
      ).rows;
    if (layers.length === 0) {
      throw new InventoryError(
        `no on-hand layers for item ${target.itemId} at location ${target.stockLocationId}`,
      );
    }
    const manualAmount = target.manualAmount ?? null;
    let shareWeight = "0";
    if (input.basis === "manual") {
      if (!manualAmount || cmp(manualAmount, "0") <= 0) {
        throw new InventoryError(
          "manual-basis vouchers require a positive manual amount per target",
        );
      }
    } else {
      let weightsByLayer: Map<string, string> | undefined;
      if (input.basis === "weight") {
        weightsByLayer = new Map();
        const w = (await tx.execute<{ cost_layer_id: string; weight: string }>(sql`
          select cost_layer_id, weight from cost_layer_weights
           where org_id = ${orgId} and cost_layer_id in (${joinIds(layers.map((l) => l.id))})`));
        for (const row of w.rows)
          weightsByLayer.set(row.cost_layer_id, row.weight);
      }
      const weights = layerWeights(layers, input.basis, weightsByLayer);
      shareWeight = sum(weights);
      if (isZero(shareWeight)) {
        throw new InventoryError(
          `target item ${target.itemId} has no ${input.basis} basis to apportion on`,
        );
      }
    }
    resolved.push({ target, profile, layers, shareWeight, manualAmount });
    }

    const shares =
      input.basis === "manual"
        ? resolved.map((r) => toUnits(r.manualAmount!))
        : apportionUnits(
            toUnits(input.amount),
            resolved.map((r) => r.shareWeight),
          );
    const shareTotal = fromUnits(shares.reduce((a, b) => a + b, 0n));
    if (cmp(shareTotal, input.amount) !== 0) {
      throw new InventoryError(
        input.basis === "manual"
          ? `manual target amounts (${shareTotal}) must sum to the voucher amount (${input.amount})`
          : "apportionment failed",
      );
    }

    const documentNumber = await nextSequenceNumber(
      orgId,
      "landed_cost_voucher",
      "LCV-",
      input.subsidiaryId,
      tx,
    );
    const bookId = await primaryBookId(orgId, tx);
    const currency = await subsidiaryCurrency(
      orgId,
      input.subsidiaryId,
      tx,
    );
    const voucher = (await tx.execute<{ id: string }>(sql`
      insert into landed_cost_vouchers
        (org_id, document_number, status, amount, basis, freight_account_id, source_document_line_id,
         subsidiary_id, voucher_date, memo, created_by, updated_by)
      values (${orgId}, ${documentNumber}, 'draft', ${input.amount}, ${input.basis}, ${input.freightAccountId},
              ${input.sourceDocumentLineId ?? null}, ${input.subsidiaryId}, ${input.voucherDate},
              ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`));
    const voucherId = voucher.rows[0].id;

    const entryLines: JournalLineInput[] = [];
    const allocationIds: string[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const share = shares[i];
      const shareAmount = fromUnits(share);
      await tx.execute(sql`
        insert into landed_cost_voucher_targets
          (org_id, voucher_id, item_id, stock_location_id, manual_amount, allocated_amount, created_by, updated_by)
        values (${orgId}, ${voucherId}, ${r.target.itemId}, ${r.target.stockLocationId},
                ${r.manualAmount}, ${shareAmount}, ${actorId}, ${actorId})`);
      if (share === 0n) continue;

      // Sub-apportion the share across the target's own layers on the same basis.
      let weightsByLayer: Map<string, string> | undefined;
      if (input.basis === "weight") {
        weightsByLayer = new Map();
        const w = (await tx.execute<{ cost_layer_id: string; weight: string }>(sql`
          select cost_layer_id, weight from cost_layer_weights
           where org_id = ${orgId} and cost_layer_id in (${joinIds(r.layers.map((l) => l.id))})`));
        for (const row of w.rows)
          weightsByLayer.set(row.cost_layer_id, row.weight);
      }
      const subShares = apportionUnits(
        share,
        layerWeights(
          r.layers,
          input.basis === "manual" ? "value" : input.basis,
          weightsByLayer,
        ),
      );
      for (let j = 0; j < r.layers.length; j++) {
        const layerShare = subShares[j];
        if (layerShare === 0n) continue;
        const fragments = await revalueLayerExactly(
          tx,
          orgId,
          r.layers[j]!,
          layerShare,
          actorId,
          r.profile.costingMethod !== "moving_average",
        );
        for (const fragment of fragments) {
          const allocationId = randomUUID();
          allocationIds.push(allocationId);
          await tx.execute(sql`
            insert into landed_cost_allocations
              (id, org_id, voucher_id, source_document_line_id, target_cost_layer_id,
               basis, amount, journal_entry_id, created_by, updated_by)
            values
              (${allocationId}, ${orgId}, ${voucherId}, ${input.sourceDocumentLineId ?? null},
               ${fragment.layerId}, ${input.basis}, ${fragment.amount}, null,
               ${actorId}, ${actorId})`);
        }
      }
      entryLines.push({
        accountId: r.profile.assetAccountId,
        amount: shareAmount,
        memo: input.memo ?? `Landed cost ${documentNumber}`,
      });
    }
    entryLines.push({
      accountId: input.freightAccountId,
      amount: neg(input.amount),
      memo: input.memo ?? `Landed cost ${documentNumber}`,
    });

    const entryId = await postInventoryEntry(tx, {
      orgId,
      bookId,
      subsidiaryId: input.subsidiaryId,
      currency,
      periodId,
      date: input.voucherDate,
      entryNumber: `INV-LCV-${documentNumber}`,
      memo: input.memo ?? `Landed cost voucher ${documentNumber}`,
      lines: entryLines,
    });
    await tx.execute(sql`
      update landed_cost_allocations set journal_entry_id = ${entryId}
       where org_id = ${orgId}
         and id in (${joinIds(allocationIds)})`);
    await tx.execute(sql`
      update landed_cost_vouchers set status = 'posted', journal_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
       where id = ${voucherId} and org_id = ${orgId}`);
    return { id: voucherId, documentNumber, entryId };
  });
}

export interface ReverseLandedCostVoucherInput {
  voucherId: string;
  reversalDate: string;
  reason: string;
}

export interface ReverseLandedCostVoucherResult {
  voucherId: string;
  entryId: string;
  alreadyReversed: boolean;
  reversedAllocations: number;
}

/**
 * Cancel a posted landed-cost voucher by removing each exact allocation from
 * untouched layers, appending negative allocation evidence, and mirroring the
 * source journal. The original voucher, allocations, and journal stay intact.
 */
export async function reverseLandedCostVoucher(
  orgId: string,
  actorId: string,
  input: ReverseLandedCostVoucherInput,
): Promise<ReverseLandedCostVoucherResult> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new InventoryError(
      "reversal reason must be between 5 and 500 characters",
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reversalDate)) {
    throw new InventoryError("reversal date must be YYYY-MM-DD");
  }

  return db.transaction(async (tx) => {
    const voucherResult = (await tx.execute<{
        id: string;
        status: string;
        amount: string;
        journal_entry_id: string | null;
        reversal_journal_entry_id: string | null;
      }>(sql`
      select id, status, amount, journal_entry_id, reversal_journal_entry_id
        from landed_cost_vouchers
       where id = ${input.voucherId} and org_id = ${orgId}
       for update
    `));
    const voucher = voucherResult.rows[0];
    if (!voucher) throw new InventoryError("landed-cost voucher not found");
    if (voucher.status === "void") {
      if (!voucher.reversal_journal_entry_id) {
        throw new InventoryError(
          "void landed-cost voucher is missing reversal evidence",
        );
      }
      const count = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count
          from landed_cost_allocations
         where org_id = ${orgId} and voucher_id = ${voucher.id}
           and reverses_allocation_id is not null
      `));
      return {
        voucherId: voucher.id,
        entryId: voucher.reversal_journal_entry_id,
        alreadyReversed: true,
        reversedAllocations: count.rows[0]!.count,
      };
    }
    if (voucher.status !== "posted" || !voucher.journal_entry_id) {
      throw new InventoryError(
        "only a posted landed-cost voucher can be reversed",
      );
    }

    const targets = (await tx.execute<{ item_id: string; stock_location_id: string }>(sql`
      select item_id, stock_location_id
        from landed_cost_voucher_targets
       where voucher_id = ${voucher.id} and org_id = ${orgId}
       order by item_id, stock_location_id
    `));
    if (!targets.rows.length) {
      throw new InventoryError("landed-cost voucher has no target evidence");
    }
    for (const target of targets.rows) {
      await lockInventoryPosition(
        tx,
        target.item_id,
        target.stock_location_id,
      );
    }

    const allocations = (await tx.execute<{
        id: string;
        target_cost_layer_id: string;
        basis: "value" | "quantity" | "weight" | "manual";
        amount: string;
        source_document_line_id: string | null;
        source_movement_id: string;
        received_at: string;
        original_quantity: string;
        remaining_quantity: string;
        unit_cost: string;
      }>(sql`
      select allocation.id, allocation.target_cost_layer_id, allocation.basis,
             allocation.amount::text, allocation.source_document_line_id,
             layer.source_movement_id, layer.received_at::text,
             layer.original_quantity::text, layer.remaining_quantity::text,
             layer.unit_cost::text
        from landed_cost_allocations allocation
        join cost_layers layer
          on layer.id = allocation.target_cost_layer_id
         and layer.org_id = allocation.org_id
       where allocation.org_id = ${orgId}
         and allocation.voucher_id = ${voucher.id}
         and allocation.reverses_allocation_id is null
       order by allocation.created_at desc, allocation.id desc
       for update of layer
    `));
    if (!allocations.rows.length) {
      throw new InventoryError(
        "landed-cost voucher has no linked allocation evidence",
      );
    }
    const allocated = sum(allocations.rows.map((row) => row.amount));
    if (cmp(allocated, voucher.amount) !== 0) {
      throw new InventoryError(
        "landed-cost voucher allocation evidence does not equal its amount",
      );
    }
    const prior = (await tx.execute(sql`
      select reverses_allocation_id
        from landed_cost_allocations
       where org_id = ${orgId}
         and reverses_allocation_id in (${joinIds(
           allocations.rows.map((row) => row.id),
         )})
       limit 1
    `));
    if (prior.rows.length) {
      throw new InventoryError(
        "landed-cost voucher has partial reversal evidence",
      );
    }

    for (const allocation of allocations.rows) {
      await devalueLayerExactly(
        tx,
        orgId,
        {
          id: allocation.target_cost_layer_id,
          source_movement_id: allocation.source_movement_id,
          received_at: allocation.received_at,
          original_quantity: allocation.original_quantity,
          remaining_quantity: allocation.remaining_quantity,
          unit_cost: allocation.unit_cost,
        },
        toUnits(allocation.amount),
        actorId,
      );
    }

    const reversalEntryId = await reverseInventoryJournal(
      tx,
      orgId,
      actorId,
      voucher.journal_entry_id,
      input.reversalDate,
      reason,
    );
    for (const allocation of allocations.rows) {
      await tx.execute(sql`
        insert into landed_cost_allocations
          (org_id, voucher_id, source_document_line_id, target_cost_layer_id,
           basis, amount, journal_entry_id, reverses_allocation_id,
           reversal_reason, created_by, updated_by)
        values
          (${orgId}, ${voucher.id}, ${allocation.source_document_line_id},
           ${allocation.target_cost_layer_id}, ${allocation.basis},
           ${neg(allocation.amount)}, ${reversalEntryId}, ${allocation.id},
           ${reason}, ${actorId}, ${actorId})
      `);
    }
    await tx.execute(sql`
      update landed_cost_vouchers
         set status = 'void',
             reversal_journal_entry_id = ${reversalEntryId},
             voided_at = now(),
             voided_by = ${actorId},
             void_reason = ${reason},
             updated_at = now(),
             updated_by = ${actorId}
       where id = ${voucher.id} and org_id = ${orgId}
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${orgId}, 'landed_cost_vouchers', ${voucher.id}, 'void',
         ${JSON.stringify({
           reason,
           reversalDate: input.reversalDate,
           reversalEntryId,
           reversedAllocations: allocations.rows.length,
         })}::jsonb,
         ${actorId})
    `);
    return {
      voucherId: voucher.id,
      entryId: reversalEntryId,
      alreadyReversed: false,
      reversedAllocations: allocations.rows.length,
    };
  });
}

/** SQL list literal for a non-empty uuid array. */
function joinIds(ids: string[]) {
  if (ids.length === 0) throw new InventoryError("internal: empty id list");
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}
