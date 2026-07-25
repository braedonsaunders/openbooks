import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, fromUnits, isZero, neg, roundDiv, sum, toUnits } from "./money.ts";
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
  tracking: "none" | "lot" | "serial";
  standardCost: string | null;
  baseUnit: string;
  allowNegativeInventory: boolean;
  negativeCostBasis: "last_receipt" | "standard" | "configured";
  provisionalUnitCost: string | null;
}

export class InventoryError extends Error {}

async function resolveProfile(orgId: string, itemId: string): Promise<InventoryProfile> {
  const r = (await db.execute(sql`
    select item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
           variance_account_id, standard_cost, base_unit, allow_negative_inventory,
           negative_cost_basis, provisional_unit_cost
      from item_inventory_profiles where org_id = ${orgId} and item_id = ${itemId}`)) as unknown as {
    rows: {
      item_id: string; costing_method: InventoryProfile["costingMethod"]; tracking: InventoryProfile["tracking"];
      asset_account_id: string;
      cogs_account_id: string; adjustment_account_id: string | null; variance_account_id: string | null;
      standard_cost: string | null; base_unit: string; allow_negative_inventory: boolean;
      negative_cost_basis: InventoryProfile["negativeCostBasis"]; provisional_unit_cost: string | null;
    }[];
  };
  const p = r.rows[0];
  if (!p) throw new InventoryError(`item ${itemId} has no inventory profile`);
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
  return getOnHandWith(db, orgId, itemId, stockLocationId);
}

async function getOnHandWith(
  runner: Runner,
  orgId: string,
  itemId: string,
  stockLocationId: string,
): Promise<{ quantity: string; value: string; unitCost: string }> {
  const r = (await runner.execute(sql`
    select (coalesce((select sum(remaining_quantity) from cost_layers
                       where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}),0)
            - coalesce((select sum(remaining_quantity) from inventory_provisional_costs
                         where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}),0))::text as quantity,
           (coalesce((select sum(round(remaining_quantity * unit_cost,4)) from cost_layers
                       where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}),0)
            - coalesce((select sum(round(remaining_quantity * provisional_unit_cost,4)) from inventory_provisional_costs
                         where org_id=${orgId} and item_id=${itemId} and stock_location_id=${stockLocationId}),0))::text as value`)) as unknown as {
    rows: { quantity: string; value: string }[];
  };
  const quantity = r.rows[0]?.quantity ?? "0";
  const value = r.rows[0]?.value ?? "0";
  const unitCost = isZero(quantity) ? "0" : fromUnits((toUnits(value) * 10_000n) / toUnits(quantity));
  return { quantity: fromUnits(toUnits(quantity)), value: fromUnits(toUnits(value)), unitCost };
}

async function lockInventoryPosition(tx: Runner, itemId: string, stockLocationId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`inventory:${itemId}:${stockLocationId}`},0))`);
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
export async function receiveInventory(orgId: string, actorId: string | null, input: ReceiveInput): Promise<MovementResult> {
  if (cmp(input.quantity, "0") <= 0) throw new InventoryError("receipt quantity must be positive");
  const profile = await resolveProfile(orgId, input.itemId);
  assertTracking(profile, { quantity: input.quantity, lotId: input.lotId, serialId: input.serialId }, "receipt");
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

  // When the source document already DR'd inventory (postJournal === false), we
  // skip the entry and only record the layer. Standard costing needs its own
  // entry to book the variance, so it requires a real offset (a clearing acct).
  const postJournal = input.postJournal !== false;
  if (!postJournal && !isZero(variance)) {
    throw new InventoryError("standard-cost receipts require a received-not-billed account to book purchase variance");
  }
  if (!postJournal && !input.linkEntryId) {
    throw new InventoryError("a non-posting receipt requires its source journal entry");
  }
  if (postJournal && !input.offsetAccountId) {
    throw new InventoryError("receipt requires an offset account");
  }

  return await db.transaction(async (tx) => {
    await lockInventoryPosition(tx, input.itemId, input.stockLocationId);
    const deficits = (await tx.execute(sql`
      select id,remaining_quantity,provisional_unit_cost
        from inventory_provisional_costs
       where org_id=${orgId} and item_id=${input.itemId} and stock_location_id=${input.stockLocationId}
         and remaining_quantity>0 order by created_at,id for update
    `)) as unknown as { rows: { id: string; remaining_quantity: string; provisional_unit_cost: string }[] };
    let receiptUnits = toUnits(input.quantity);
    let provisionalValueUnits = 0n;
    const settlements: { id: string; quantity: string; provisionalUnitCost: string; correction: string }[] = [];
    for (const deficit of deficits.rows) {
      if (receiptUnits === 0n) break;
      const available = toUnits(deficit.remaining_quantity);
      const take = available < receiptUnits ? available : receiptUnits;
      const quantity = fromUnits(take);
      const provisionalValue = extendCost(quantity, deficit.provisional_unit_cost);
      const receiptValue = extendCost(quantity, layerUnitCost);
      settlements.push({
        id: deficit.id,
        quantity,
        provisionalUnitCost: deficit.provisional_unit_cost,
        correction: fromUnits(toUnits(receiptValue) - toUnits(provisionalValue)),
      });
      provisionalValueUnits += toUnits(provisionalValue);
      receiptUnits -= take;
    }
    const excessQuantity = fromUnits(receiptUnits);
    const assetDelta = fromUnits(provisionalValueUnits + toUnits(extendCost(excessQuantity, layerUnitCost)));
    const correction = fromUnits(toUnits(inventoryValue) - toUnits(assetDelta));
    const lines: JournalLineInput[] = postJournal
      ? [
          { accountId: profile.assetAccountId, amount: assetDelta, ...dims, memo: input.memo },
          ...(!isZero(correction) ? [{ accountId: profile.cogsAccountId, amount: correction, ...dims, memo: "Negative inventory receipt cost true-up" }] : []),
          ...(!isZero(variance) ? [{ accountId: profile.varianceAccountId ?? profile.assetAccountId, amount: variance, ...dims, memo: "PPV" }] : []),
          { accountId: input.offsetAccountId!, amount: neg(offsetTotal), ...dims, memo: input.memo },
        ]
      : !isZero(correction)
        ? [
            { accountId: profile.cogsAccountId, amount: correction, ...dims, memo: "Negative inventory receipt cost true-up" },
            { accountId: profile.assetAccountId, amount: neg(correction), ...dims, memo: "Negative inventory receipt cost true-up" },
          ]
        : [];
    if (lines.length) {
      await validateSubsidiaryRestrictions(tx, {
        orgId, ctx, docSubsidiaryId: input.subsidiaryId,
        lines: lines.map((line) => ({ ...line, subsidiaryId: input.subsidiaryId })),
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

    const mv = (await tx.execute(sql`
      insert into inventory_movements
        (org_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id, quantity, unit_cost, total_value,
         document_line_id, journal_entry_id, status, memo, created_by, updated_by)
      values (${orgId}, ${input.itemId}, 'receipt', ${input.date}, ${input.stockLocationId}, ${input.lotId ?? null},
              ${input.serialId ?? null}, ${input.quantity}, ${layerUnitCost}, ${assetDelta},
              ${input.documentLineId ?? null}, ${entryId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`)) as unknown as { rows: { id: string }[] };
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
      const existing = (await tx.execute(sql`
        select id, remaining_quantity, unit_cost from cost_layers
         where org_id = ${orgId} and item_id = ${input.itemId} and stock_location_id = ${input.stockLocationId}
         order by received_at limit 1`)) as unknown as {
        rows: { id: string; remaining_quantity: string; unit_cost: string }[];
      };
      if (existing.rows[0]) {
        const cur = existing.rows[0];
        const newQty = add(cur.remaining_quantity, excessQuantity);
        const newValue = add(extendCost(cur.remaining_quantity, cur.unit_cost), extendCost(excessQuantity, layerUnitCost));
        const newCost = isZero(newQty) ? layerUnitCost : fromUnits((toUnits(newValue) * 10_000n) / toUnits(newQty));
        await tx.execute(sql`
          update cost_layers set remaining_quantity = ${newQty}, original_quantity = original_quantity + ${excessQuantity},
             unit_cost = ${newCost}, updated_at = now() where id = ${cur.id}`);
      } else {
        await insertLayer(tx, orgId, input, movementId, layerUnitCost, excessQuantity);
      }
    } else if (receiptUnits > 0n) {
      await insertLayer(tx, orgId, input, movementId, layerUnitCost, excessQuantity);
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
  const offset = input.offsetAccountId ?? profile.cogsAccountId;
  const dims = {
    departmentId: input.departmentId ?? null,
    projectId: input.projectId ?? null,
    locationId: input.locationId ?? null,
  };

  return await db.transaction(async (tx) => {
    await lockInventoryPosition(tx, input.itemId, input.stockLocationId);
    const onHand = await getOnHandWith(tx, orgId, input.itemId, input.stockLocationId);
    const shortage = toUnits(input.quantity) - (toUnits(onHand.quantity) > 0n ? toUnits(onHand.quantity) : 0n);
    if (shortage > 0n && !profile.allowNegativeInventory) {
      throw new InventoryError(
        `insufficient stock: need ${input.quantity}, on hand ${onHand.quantity} (negative inventory is disabled for this item)`,
      );
    }
    const provisionalUnitCost = shortage > 0n
      ? await resolveProvisionalUnitCost(tx, orgId, profile, input.itemId)
      : onHand.unitCost;
    const { cost, unitCost, consumptions, shortfallQuantity } = await consumeLayers(
      tx, orgId, profile, input.itemId, input.stockLocationId, input.quantity, onHand, provisionalUnitCost,
    );

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
    if (profile.provisionalUnitCost == null) throw new InventoryError("configured negative costing requires a provisional unit cost");
    return profile.provisionalUnitCost;
  }
  if (profile.negativeCostBasis === "standard") {
    if (profile.standardCost == null) throw new InventoryError("standard negative costing requires a standard cost");
    return profile.standardCost;
  }
  const last = (await tx.execute(sql`
    select unit_cost from inventory_movements
     where org_id=${orgId} and item_id=${itemId} and kind in ('receipt','return','assembly_build','transfer_in')
       and status='posted' and unit_cost is not null
     order by moved_at desc,created_at desc,id desc limit 1
  `)) as unknown as { rows: { unit_cost: string }[] };
  if (!last.rows[0]) throw new InventoryError("negative inventory has no prior receipt cost; configure a provisional or standard cost");
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
    out.push({ layerId: l.id, quantity: fromUnits(take), unitCost: l.unit_cost });
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
): Promise<{ cost: string; unitCost: string; consumptions: Consumption[]; shortfallQuantity: string }> {
  const layersRes = (await tx.execute(sql`
    select id, remaining_quantity as remaining, unit_cost from cost_layers
     where org_id = ${orgId} and item_id = ${itemId} and stock_location_id = ${stockLocationId}
       and remaining_quantity > 0
     order by received_at, id`)) as unknown as { rows: { id: string; remaining: string; unit_cost: string }[] };
  const layers = layersRes.rows;

  let cost: string;
  let consumptions: Consumption[] = [];
  const requestedUnits = toUnits(quantity);
  const availableUnits = layers.reduce((total, layer) => total + toUnits(layer.remaining), 0n);
  const coveredUnits = availableUnits < requestedUnits ? availableUnits : requestedUnits;
  const shortfallQuantity = fromUnits(requestedUnits - coveredUnits);
  if (profile.costingMethod === "standard") {
    cost = issueStandard(quantity, profile.standardCost ?? onHand.unitCost);
    consumptions = planQuantityConsumption(layers, fromUnits(coveredUnits));
  } else if (profile.costingMethod === "moving_average") {
    const positiveValue = toUnits(onHand.value) > 0n ? onHand.value : "0";
    const coveredCost = issueMovingAverage({ quantity: fromUnits(availableUnits), value: positiveValue }, fromUnits(coveredUnits)).cost;
    cost = add(coveredCost, extendCost(shortfallQuantity, provisionalUnitCost));
    if (layers[0] && coveredUnits > 0n) consumptions = [{ layerId: layers[0].id, quantity: fromUnits(coveredUnits), unitCost: layers[0].unit_cost }];
  } else {
    const r = consumeFifo(
      layers.map((l) => ({ id: l.id, remaining: l.remaining, unitCost: l.unit_cost })) as CostLayer[],
      quantity,
      provisionalUnitCost,
    );
    cost = r.totalCost;
    consumptions = r.consumptions.map((c) => ({ layerId: c.layerId, quantity: c.quantity, unitCost: c.unitCost }));
  }
  const unitCost = isZero(quantity) ? "0" : fromUnits((toUnits(cost) * 10_000n) / toUnits(quantity));
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
       where id = ${c.layerId}`);
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
    const existing = (await tx.execute(sql`
      select id, remaining_quantity, unit_cost from cost_layers
       where org_id = ${orgId} and item_id = ${itemId} and stock_location_id = ${stockLocationId}
       order by received_at limit 1`)) as unknown as { rows: { id: string; remaining_quantity: string; unit_cost: string }[] };
    if (existing.rows[0]) {
      const cur = existing.rows[0];
      const newQty = add(cur.remaining_quantity, quantity);
      const newValue = add(extendCost(cur.remaining_quantity, cur.unit_cost), extendCost(quantity, unitCost));
      const newCost = isZero(newQty) ? unitCost : fromUnits((toUnits(newValue) * 10_000n) / toUnits(newQty));
      await tx.execute(sql`
        update cost_layers set remaining_quantity = ${newQty}, original_quantity = original_quantity + ${quantity},
           unit_cost = ${newCost}, updated_at = now() where id = ${cur.id}`);
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
export async function transferInventory(orgId: string, actorId: string | null, input: TransferInput): Promise<{ fromMovementId: string; toMovementId: string; entryId: string | null; value: string }> {
  if (cmp(input.quantity, "0") <= 0) throw new InventoryError("transfer quantity must be positive");
  if (input.fromStockLocationId === input.toStockLocationId) throw new InventoryError("transfer needs two different locations");
  const profile = await resolveProfile(orgId, input.itemId);
  const period = await periodForDate(orgId, input.date);
  if (!period) throw new InventoryError(`no accounting period for ${input.date}`);
  const bookId = await primaryBookId(orgId);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);
  const onHand = await getOnHand(orgId, input.itemId, input.fromStockLocationId);
  if (cmp(input.quantity, onHand.quantity) > 0) {
    throw new InventoryError(`insufficient stock at source: need ${input.quantity}, on hand ${onHand.quantity}`);
  }

  const locDims = (await db.execute(sql`
    select id, location_id from stock_locations where org_id = ${orgId} and id in (${input.fromStockLocationId}, ${input.toStockLocationId})`)) as unknown as {
    rows: { id: string; location_id: string }[];
  };
  const fromDim = locDims.rows.find((r) => r.id === input.fromStockLocationId)?.location_id ?? null;
  const toDim = locDims.rows.find((r) => r.id === input.toStockLocationId)?.location_id ?? null;

  return await db.transaction(async (tx) => {
    const { cost, unitCost, consumptions } = await consumeLayers(
      tx, orgId, profile, input.itemId, input.fromStockLocationId, input.quantity, onHand,
    );

    // Optional location-reclass entry (value nets to zero, dimensions differ).
    let entryId: string | null = null;
    if (fromDim && toDim && fromDim !== toDim && !isZero(cost)) {
      entryId = await postInventoryEntry(tx, {
        orgId, bookId, subsidiaryId: input.subsidiaryId, currency, periodId: period, date: input.date,
        entryNumber: `INV-XFER-${input.date}-${input.itemId.slice(0, 8)}`,
        memo: input.memo ?? "Inventory transfer",
        lines: [
          { accountId: profile.assetAccountId, amount: cost, locationId: toDim, memo: input.memo },
          { accountId: profile.assetAccountId, amount: neg(cost), locationId: fromDim, memo: input.memo },
        ],
      });
    }

    // A posted movement is immutable (no post-insert UPDATE), so the id is
    // generated up front and only the transfer_in leg carries the pairing
    // link back to the transfer_out (one direction is enough to relate them).
    const fromMovementId = randomUUID();
    await tx.execute(sql`
      insert into inventory_movements
        (id, org_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value, journal_entry_id, status, memo, created_by, updated_by)
      values (${fromMovementId}, ${orgId}, ${input.itemId}, 'transfer_out', ${input.date}, ${input.fromStockLocationId}, ${neg(input.quantity)}, ${unitCost}, ${neg(cost)}, ${entryId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})`);
    const toMovementId = randomUUID();
    await tx.execute(sql`
      insert into inventory_movements
        (id, org_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value, journal_entry_id, paired_movement_id, status, memo, created_by, updated_by)
      values (${toMovementId}, ${orgId}, ${input.itemId}, 'transfer_in', ${input.date}, ${input.toStockLocationId}, ${input.quantity}, ${unitCost}, ${cost}, ${entryId}, ${fromMovementId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})`);

    await recordConsumptions(tx, orgId, consumptions, fromMovementId, actorId);
    await addLayerAtCost(tx, orgId, input.itemId, input.toStockLocationId, input.quantity, unitCost, profile.costingMethod, toMovementId, input.date);

    return { fromMovementId, toMovementId, entryId, value: cost };
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
export async function buildAssembly(orgId: string, actorId: string | null, input: BuildInput): Promise<MovementResult> {
  if (cmp(input.quantity, "0") <= 0) throw new InventoryError("build quantity must be positive");
  const assembly = await resolveProfile(orgId, input.assemblyItemId);
  const period = await periodForDate(orgId, input.date);
  if (!period) throw new InventoryError(`no accounting period for ${input.date}`);
  const bookId = await primaryBookId(orgId);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);

  const bom = (await db.execute(sql`
    select component_item_id, quantity_per from bom_components
     where org_id = ${orgId} and assembly_item_id = ${input.assemblyItemId} order by sort_order`)) as unknown as {
    rows: { component_item_id: string; quantity_per: string }[];
  };
  if (bom.rows.length === 0) throw new InventoryError("assembly has no bill of materials");

  // Resolve each component: profile, required qty, cost.
  const components: { itemId: string; profile: InventoryProfile; reqQty: string; onHand: { quantity: string; value: string; unitCost: string } }[] = [];
  for (const c of bom.rows) {
    const profile = await resolveProfile(orgId, c.component_item_id);
    const reqQty = extendCost(input.quantity, c.quantity_per); // quantity × quantity_per
    const onHand = await getOnHand(orgId, c.component_item_id, input.stockLocationId);
    if (cmp(reqQty, onHand.quantity) > 0) {
      throw new InventoryError(`insufficient component ${c.component_item_id}: need ${reqQty}, on hand ${onHand.quantity}`);
    }
    components.push({ itemId: c.component_item_id, profile, reqQty, onHand });
  }

  return await db.transaction(async (tx) => {
    const consumeLines: JournalLineInput[] = [];
    const perComponent: { itemId: string; cost: string; consumptions: Consumption[] }[] = [];
    let totalCost = "0";
    for (const c of components) {
      const { cost, consumptions } = await consumeLayers(tx, orgId, c.profile, c.itemId, input.stockLocationId, c.reqQty, c.onHand);
      totalCost = add(totalCost, cost);
      consumeLines.push({ accountId: c.profile.assetAccountId, amount: neg(cost), memo: "Assembly component" });
      perComponent.push({ itemId: c.itemId, cost, consumptions });
    }

    const lines: JournalLineInput[] = [
      { accountId: assembly.assetAccountId, amount: totalCost, memo: input.memo ?? "Assembly build" },
      ...consumeLines,
    ];
    const entryId = await postInventoryEntry(tx, {
      orgId, bookId, subsidiaryId: input.subsidiaryId, currency, periodId: period, date: input.date,
      entryNumber: `INV-BUILD-${input.date}-${input.assemblyItemId.slice(0, 8)}`,
      memo: input.memo ?? "Assembly build",
      lines,
    });

    // Component consume movements + layer draw-downs.
    for (let i = 0; i < components.length; i++) {
      const c = components[i];
      const pc = perComponent[i];
      const mv = (await tx.execute(sql`
        insert into inventory_movements
          (org_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value, journal_entry_id, status, memo, created_by, updated_by)
        values (${orgId}, ${c.itemId}, 'assembly_consume', ${input.date}, ${input.stockLocationId},
                ${neg(c.reqQty)}, ${isZero(c.reqQty) ? "0" : fromUnits((toUnits(pc.cost) * 10_000n) / toUnits(c.reqQty))},
                ${neg(pc.cost)}, ${entryId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
        returning id`)) as unknown as { rows: { id: string }[] };
      await recordConsumptions(tx, orgId, pc.consumptions, mv.rows[0].id, actorId);
    }

    // Finished-good build movement + layer.
    const unitCost = isZero(input.quantity) ? "0" : fromUnits((toUnits(totalCost) * 10_000n) / toUnits(input.quantity));
    const buildMv = (await tx.execute(sql`
      insert into inventory_movements
        (org_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value, journal_entry_id, status, memo, created_by, updated_by)
      values (${orgId}, ${input.assemblyItemId}, 'assembly_build', ${input.date}, ${input.stockLocationId},
              ${input.quantity}, ${unitCost}, ${totalCost}, ${entryId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`)) as unknown as { rows: { id: string }[] };
    await addLayerAtCost(tx, orgId, input.assemblyItemId, input.stockLocationId, input.quantity, unitCost, assembly.costingMethod, buildMv.rows[0].id, input.date);

    return { movementId: buildMv.rows[0].id, entryId, value: totalCost };
  });
}

// ---------------------------------------------------------------------------
// Landed cost (allocate freight/duty onto receipt layers)
// ---------------------------------------------------------------------------

export interface LandedCostInput {
  itemId: string;
  stockLocationId: string;
  /** total landed cost to capitalize into inventory (> 0). */
  amount: string;
  basis: "value" | "quantity";
  /** the account the freight/duty currently sits in (credited as it moves to stock). */
  freightAccountId: string;
  subsidiaryId: string;
  date: string;
  /** provenance: the freight/duty bill line. */
  sourceDocumentLineId?: string | null;
  memo?: string | null;
}

/**
 * Capitalize a landed cost (freight, duty) onto an item's current cost layers at
 * a location, spread by value or quantity. Each layer's unit cost is bumped so
 * future issues carry the true landed cost, and DR inventory / CR the freight
 * account posts the capitalization. Value and quantity of stock are unchanged.
 */
export async function allocateLandedCost(orgId: string, actorId: string | null, input: LandedCostInput): Promise<{ entryId: string; layersAffected: number }> {
  if (cmp(input.amount, "0") <= 0) throw new InventoryError("landed cost amount must be positive");
  const profile = await resolveProfile(orgId, input.itemId);
  const period = await periodForDate(orgId, input.date);
  if (!period) throw new InventoryError(`no accounting period for ${input.date}`);
  const bookId = await primaryBookId(orgId);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);

  const layersRes = (await db.execute(sql`
    select id, remaining_quantity, unit_cost from cost_layers
     where org_id = ${orgId} and item_id = ${input.itemId} and stock_location_id = ${input.stockLocationId} and remaining_quantity > 0
     order by received_at, id`)) as unknown as { rows: { id: string; remaining_quantity: string; unit_cost: string }[] };
  const layers = layersRes.rows;
  if (layers.length === 0) throw new InventoryError("no on-hand layers to capitalize onto");

  // Weight each layer by remaining quantity, or remaining value.
  const weights = layers.map((l) =>
    input.basis === "quantity"
      ? l.remaining_quantity
      : extendCost(l.remaining_quantity, l.unit_cost),
  );
  const shares = apportionUnits(toUnits(input.amount), weights);

  return await db.transaction(async (tx) => {
    let affected = 0;
    for (let i = 0; i < layers.length; i++) {
      const shareUnits = shares[i];
      if (shareUnits === 0n) continue;
      const l = layers[i];
      const qtyUnits = toUnits(l.remaining_quantity);
      // new unit cost = old + share / remaining qty
      const bumpPerUnit = qtyUnits === 0n ? 0n : roundDiv(shareUnits * 10_000n, qtyUnits);
      const newUnitCost = fromUnits(toUnits(l.unit_cost) + bumpPerUnit);
      await tx.execute(sql`update cost_layers set unit_cost = ${newUnitCost}, updated_at = now() where id = ${l.id}`);
      await tx.execute(sql`
        insert into landed_cost_allocations (org_id, source_document_line_id, target_cost_layer_id, basis, amount, journal_entry_id, created_by, updated_by)
        values (${orgId}, ${input.sourceDocumentLineId ?? null}, ${l.id}, ${input.basis}, ${fromUnits(shareUnits)}, null, ${actorId}, ${actorId})`);
      affected++;
    }

    const lines: JournalLineInput[] = [
      { accountId: profile.assetAccountId, amount: input.amount, locationId: null, memo: input.memo ?? "Landed cost" },
      { accountId: input.freightAccountId, amount: neg(input.amount), memo: input.memo ?? "Landed cost" },
    ];
    const entryId = await postInventoryEntry(tx, {
      orgId, bookId, subsidiaryId: input.subsidiaryId, currency, periodId: period, date: input.date,
      entryNumber: `INV-LAND-${input.date}-${input.itemId.slice(0, 8)}`,
      memo: input.memo ?? "Landed cost",
      lines,
    });
    await tx.execute(sql`update landed_cost_allocations set journal_entry_id = ${entryId} where journal_entry_id is null and org_id = ${orgId} and target_cost_layer_id = any(${`{${layers.map((l) => l.id).join(",")}}`}::uuid[])`);
    return { entryId, layersAffected: affected };
  });
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
async function defaultStockLocation(runner: Runner, orgId: string): Promise<string | null> {
  const r = (await runner.execute(sql`
    select id from stock_locations where org_id = ${orgId} and is_active`)) as unknown as { rows: { id: string }[] };
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
  const r = (await runner.execute(sql`
    select dl.id as line_id, dl.item_id, dl.quantity, dl.amount, dl.stock_location_id,
           p.asset_account_id, p.received_not_billed_account_id, p.costing_method
      from document_lines dl
      join item_inventory_profiles p on p.item_id = dl.item_id
     where dl.document_id = ${documentId} and dl.org_id = ${orgId}
       and dl.item_id is not null and dl.quantity <> 0
     order by dl.line_number`)) as unknown as {
    rows: {
      line_id: string; item_id: string; quantity: string; amount: string; stock_location_id: string | null;
      asset_account_id: string; received_not_billed_account_id: string | null; costing_method: InventoryProfile["costingMethod"];
    }[];
  };
  const out: DocumentInventoryLine[] = [];
  for (const row of r.rows) {
    const loc = row.stock_location_id ?? fallback;
    if (!loc) continue; // no location resolvable → treat as non-inventory
    out.push({
      lineId: row.line_id,
      itemId: row.item_id,
      stockLocationId: loc,
      quantity: fromUnits(toUnits(row.quantity) < 0n ? -toUnits(row.quantity) : toUnits(row.quantity)),
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
export async function resolveBillInventoryAccounts(runner: Runner, orgId: string, documentId: string): Promise<Map<string, string>> {
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  const map = new Map<string, string>();
  for (const l of lines) map.set(l.lineId, l.clearingAccountId ?? l.assetAccountId);
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
      select 1 from inventory_movements where org_id = ${orgId} and document_line_id = ${l.lineId} and kind = 'receipt' limit 1`)) as unknown as {
      rows: unknown[];
    };
    if (seen.rows[0]) continue;
    const unitCost = isZero(l.quantity) ? "0" : fromUnits((toUnits(l.amount) * 10_000n) / toUnits(l.quantity));
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
      select 1 from inventory_movements where org_id = ${orgId} and document_line_id = ${l.lineId} and kind = 'issue' limit 1`)) as unknown as {
      rows: unknown[];
    };
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
    if (kind === "receipt" && !input.lotId) {
      throw new InventoryError("lot-tracked item requires a lot on receipt");
    }
  } else if (profile.tracking === "serial") {
    if (!input.serialId) throw new InventoryError(`serial-tracked item requires a serial on ${kind}`);
    if (cmp(input.quantity, "1") !== 0 && cmp(input.quantity, "-1") !== 0) {
      throw new InventoryError("serial-tracked movements must be exactly one unit per serial");
    }
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
  const r = (await db.execute(sql`
    insert into lots (org_id, item_id, lot_number, expires_on, created_by, updated_by)
    values (${orgId}, ${itemId}, ${lotNumber.trim()}, ${expiresOn ?? null}, ${actorId}, ${actorId})
    on conflict (item_id, lot_number) do update
      set expires_on = coalesce(excluded.expires_on, lots.expires_on),
          updated_at = now(), updated_by = ${actorId}
    returning id`)) as unknown as { rows: { id: string }[] };
  return r.rows[0].id;
}

/** Find-or-create a serial for an item, placing it in stock at a location. */
export async function ensureSerial(
  orgId: string,
  itemId: string,
  serialNumber: string,
  stockLocationId: string | null,
  actorId: string | null,
): Promise<string> {
  if (!serialNumber?.trim()) throw new InventoryError("serial number is required");
  const r = (await db.execute(sql`
    insert into serials (org_id, item_id, serial_number, status, current_stock_location_id, created_by, updated_by)
    values (${orgId}, ${itemId}, ${serialNumber.trim()}, 'in_stock', ${stockLocationId ?? null}, ${actorId}, ${actorId})
    on conflict (item_id, serial_number) do update
      set current_stock_location_id = coalesce(excluded.current_stock_location_id, serials.current_stock_location_id),
          updated_at = now(), updated_by = ${actorId}
    returning id`)) as unknown as { rows: { id: string }[] };
  return r.rows[0].id;
}

export interface LotRecallFilter {
  lotNumber?: string;
  lotId?: string;
  itemId?: string;
  expiresOnOrBefore?: string;
  includeExpiryOnly?: boolean;
}

export interface LotRecallRow {
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
}

/**
 * Lot traceability: every movement that touched a lot, with the source
 * document and party where the movement came from a bill/invoice line. This
 * is the recall report — "which customers received lot X" runs the same query
 * filtered to issues.
 */
export async function queryLotRecall(orgId: string, filter: LotRecallFilter): Promise<LotRecallRow[]> {
  const r = (await db.execute(sql`
    select im.id as "movementId", l.id as "lotId", l.lot_number as "lotNumber", l.expires_on::text as "expiresOn",
           i.id as "itemId", i.code as "itemCode", i.name as "itemName", im.kind, im.moved_at::text as "movedAt",
           im.quantity::text as "quantity", sl.code as "locationCode",
           d.id as "documentId", d.document_number as "documentNumber", p.name as "partyName"
      from inventory_movements im
      join lots l on l.id = im.lot_id and l.org_id = im.org_id
      join items i on i.id = im.item_id and i.org_id = im.org_id
      left join stock_locations sl on sl.id = im.stock_location_id
      left join document_lines dl on dl.id = im.document_line_id
      left join documents d on d.id = dl.document_id
      left join parties p on p.id = d.party_id
     where im.org_id = ${orgId}
       and (${filter.lotId ?? null}::uuid is null or l.id = ${filter.lotId ?? null}::uuid)
       and (${filter.itemId ?? null}::uuid is null or l.item_id = ${filter.itemId ?? null}::uuid)
       and (${filter.lotNumber ?? null}::text is null or l.lot_number ilike '%' || ${filter.lotNumber ?? ""} || '%')
       and (${filter.expiresOnOrBefore ?? null}::date is null or l.expires_on <= ${filter.expiresOnOrBefore ?? null}::date)
       and (${filter.includeExpiryOnly !== true} or l.expires_on is not null)
     order by im.moved_at desc
     limit 500`)) as unknown as { rows: LotRecallRow[] };
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
): Promise<string> {
  const configured = subsidiaryId
    ? ((await db.execute(sql`
        select 1 from number_sequences where org_id = ${orgId} and document_kind = ${kind}
          and subsidiary_id = ${subsidiaryId} limit 1`)) as unknown as { rows: unknown[] }).rows.length > 0
    : false;
  const seq = (await db.execute(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${configured ? subsidiaryId : null}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding`)) as unknown as {
    rows: { prefix: string; next_number: number; padding: number }[];
  };
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

interface TransferOrderRow {
  id: string;
  status: string;
  from_stock_location_id: string;
  to_stock_location_id: string;
  transit_stock_location_id: string | null;
  in_transit_account_id: string | null;
  subsidiary_id: string;
  document_number: string;
}

export async function createTransferOrder(
  orgId: string,
  actorId: string | null,
  input: CreateTransferOrderInput,
): Promise<{ id: string; documentNumber: string }> {
  if (input.fromStockLocationId === input.toStockLocationId) {
    throw new InventoryError("transfer order needs two different locations");
  }
  if (!input.lines?.length) throw new InventoryError("transfer order needs at least one line");
  for (const line of input.lines) {
    if (cmp(line.quantity, "0") <= 0) throw new InventoryError("transfer order line quantity must be positive");
  }
  const documentNumber = await nextSequenceNumber(orgId, "transfer_order", "TO-", input.subsidiaryId);
  return await db.transaction(async (tx) => {
    const order = (await tx.execute(sql`
      insert into transfer_orders
        (org_id, document_number, status, from_stock_location_id, to_stock_location_id,
         transit_stock_location_id, in_transit_account_id, subsidiary_id, ordered_on, memo, created_by, updated_by)
      values (${orgId}, ${documentNumber}, 'draft', ${input.fromStockLocationId}, ${input.toStockLocationId},
              ${input.transitStockLocationId ?? null}, ${input.inTransitAccountId ?? null}, ${input.subsidiaryId},
              ${input.orderedOn}, ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`)) as unknown as { rows: { id: string }[] };
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

async function loadTransferOrderForUpdate(tx: Runner, orgId: string, orderId: string): Promise<TransferOrderRow> {
  const r = (await tx.execute(sql`
    select id, status, from_stock_location_id, to_stock_location_id, transit_stock_location_id,
           in_transit_account_id, subsidiary_id, document_number
      from transfer_orders where org_id = ${orgId} and id = ${orderId} for update`)) as unknown as {
    rows: TransferOrderRow[];
  };
  if (!r.rows[0]) throw new InventoryError("transfer order not found");
  return r.rows[0];
}

async function resolveTransitLocation(tx: Runner, orgId: string, order: TransferOrderRow): Promise<string> {
  if (order.transit_stock_location_id) return order.transit_stock_location_id;
  const r = (await tx.execute(sql`
    select id from stock_locations where org_id = ${orgId} and kind = 'transit' and is_active
     order by created_at limit 1`)) as unknown as { rows: { id: string }[] };
  if (!r.rows[0]) {
    throw new InventoryError(`transfer order ${order.document_number} has no transit stock location and none exists`);
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
  const periodId = await periodForDate(p.orgId, p.date);
  if (!periodId) throw new InventoryError(`no accounting period for ${p.date}`);
  const bookId = await primaryBookId(p.orgId);
  const currency = await subsidiaryCurrency(p.orgId, p.order.subsidiary_id);
  const inTransit = p.order.in_transit_account_id;
  const lines: JournalLineInput[] = p.direction === "ship"
    ? [
        { accountId: inTransit, amount: total, memo: "Goods in transit" },
        ...amounts.map((a) => ({ accountId: a.assetAccountId, amount: neg(a.value), memo: a.memo })),
      ]
    : [
        ...amounts.map((a) => ({ accountId: a.assetAccountId, amount: a.value, memo: a.memo })),
        { accountId: inTransit, amount: neg(total), memo: "Goods received from transit" },
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
  const shipDate = date ?? new Date().toISOString().slice(0, 10);
  return await db.transaction(async (tx) => {
    const order = await loadTransferOrderForUpdate(tx, orgId, orderId);
    if (order.status !== "draft") throw new InventoryError(`transfer order ${order.document_number} is ${order.status}`);
    const transitId = await resolveTransitLocation(tx, orgId, order);
    const lines = (await tx.execute(sql`
      select id, item_id, quantity from transfer_order_lines
       where org_id = ${orgId} and transfer_order_id = ${orderId} order by line_number for update`)) as unknown as {
      rows: { id: string; item_id: string; quantity: string }[];
    };
    const amounts: { assetAccountId: string; value: string; memo: string }[] = [];
    for (const line of lines.rows) {
      const profile = await resolveProfile(orgId, line.item_id);
      const moved = await transferInventory(orgId, actorId, {
        itemId: line.item_id,
        fromStockLocationId: order.from_stock_location_id,
        toStockLocationId: transitId,
        quantity: line.quantity,
        subsidiaryId: order.subsidiary_id,
        date: shipDate,
        memo: `Transfer ${order.document_number} shipped`,
      });
      await tx.execute(sql`
        update transfer_order_lines
           set quantity_shipped = ${line.quantity}, ship_movement_id = ${moved.fromMovementId}, updated_at = now(), updated_by = ${actorId}
         where id = ${line.id}`);
      amounts.push({ assetAccountId: profile.assetAccountId, value: moved.value, memo: `Transfer ${order.document_number}` });
    }
    const entryId = await postInTransitReclass(tx, { orgId, order, date: shipDate, direction: "ship", amounts });
    await tx.execute(sql`
      update transfer_orders
         set status = 'in_transit', shipped_on = ${shipDate}, ship_journal_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
       where id = ${orderId}`);
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
  const receiveDate = date ?? new Date().toISOString().slice(0, 10);
  return await db.transaction(async (tx) => {
    const order = await loadTransferOrderForUpdate(tx, orgId, orderId);
    if (order.status !== "in_transit") throw new InventoryError(`transfer order ${order.document_number} is ${order.status}`);
    const transitId = await resolveTransitLocation(tx, orgId, order);
    const lines = (await tx.execute(sql`
      select id, item_id, quantity_shipped from transfer_order_lines
       where org_id = ${orgId} and transfer_order_id = ${orderId} order by line_number for update`)) as unknown as {
      rows: { id: string; item_id: string; quantity_shipped: string }[];
    };
    const amounts: { assetAccountId: string; value: string; memo: string }[] = [];
    for (const line of lines.rows) {
      if (isZero(line.quantity_shipped)) continue;
      const profile = await resolveProfile(orgId, line.item_id);
      const moved = await transferInventory(orgId, actorId, {
        itemId: line.item_id,
        fromStockLocationId: transitId,
        toStockLocationId: order.to_stock_location_id,
        quantity: line.quantity_shipped,
        subsidiaryId: order.subsidiary_id,
        date: receiveDate,
        memo: `Transfer ${order.document_number} received`,
      });
      await tx.execute(sql`
        update transfer_order_lines
           set quantity_received = ${line.quantity_shipped}, receive_movement_id = ${moved.toMovementId}, updated_at = now(), updated_by = ${actorId}
         where id = ${line.id}`);
      amounts.push({ assetAccountId: profile.assetAccountId, value: moved.value, memo: `Transfer ${order.document_number}` });
    }
    const entryId = await postInTransitReclass(tx, { orgId, order, date: receiveDate, direction: "receive", amounts });
    await tx.execute(sql`
      update transfer_orders
         set status = 'received', received_on = ${receiveDate}, receive_journal_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
       where id = ${orderId}`);
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

interface OpenLayer {
  id: string;
  remaining_quantity: string;
  unit_cost: string;
}

/** The apportionment weight of one target's on-hand layers under a basis. */
function layerWeights(
  layers: OpenLayer[],
  basis: "value" | "quantity" | "weight",
  weightsByLayer?: Map<string, string>,
): string[] {
  return layers.map((l) => {
    if (basis === "quantity") return l.remaining_quantity;
    if (basis === "weight") return extendCost(l.remaining_quantity, weightsByLayer?.get(l.id) ?? "0");
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
  if (cmp(input.amount, "0") <= 0) throw new InventoryError("landed cost amount must be positive");
  if (!input.targets?.length) throw new InventoryError("landed cost voucher needs at least one target");
  const periodId = await periodForDate(orgId, input.voucherDate);
  if (!periodId) throw new InventoryError(`no accounting period for ${input.voucherDate}`);

  // Resolve layers + weights per target before touching anything.
  const resolved: {
    target: LandedCostVoucherTargetInput;
    profile: InventoryProfile;
    layers: OpenLayer[];
    shareWeight: string;
    manualAmount: string | null;
  }[] = [];
  for (const target of input.targets) {
    const profile = await resolveProfile(orgId, target.itemId);
    const layers = ((await db.execute(sql`
      select id, remaining_quantity, unit_cost from cost_layers
       where org_id = ${orgId} and item_id = ${target.itemId} and stock_location_id = ${target.stockLocationId}
         and remaining_quantity > 0 order by received_at, id`)) as unknown as { rows: OpenLayer[] }).rows;
    if (layers.length === 0) {
      throw new InventoryError(`no on-hand layers for item ${target.itemId} at location ${target.stockLocationId}`);
    }
    const manualAmount = target.manualAmount ?? null;
    let shareWeight = "0";
    if (input.basis === "manual") {
      if (!manualAmount || cmp(manualAmount, "0") <= 0) {
        throw new InventoryError("manual-basis vouchers require a positive manual amount per target");
      }
    } else {
      let weightsByLayer: Map<string, string> | undefined;
      if (input.basis === "weight") {
        weightsByLayer = new Map();
        const w = (await db.execute(sql`
          select cost_layer_id, weight from cost_layer_weights
           where org_id = ${orgId} and cost_layer_id in (${joinIds(layers.map((l) => l.id))})`)) as unknown as {
          rows: { cost_layer_id: string; weight: string }[];
        };
        for (const row of w.rows) weightsByLayer.set(row.cost_layer_id, row.weight);
      }
      const apportionBasis: "value" | "quantity" = input.basis === "quantity" ? "quantity" : "value";
      const weights = layerWeights(layers, apportionBasis, weightsByLayer);
      shareWeight = sum(weights);
      if (isZero(shareWeight)) {
        throw new InventoryError(`target item ${target.itemId} has no ${input.basis} basis to apportion on`);
      }
    }
    resolved.push({ target, profile, layers, shareWeight, manualAmount });
  }

  const shares = input.basis === "manual"
    ? resolved.map((r) => toUnits(r.manualAmount!))
    : apportionUnits(toUnits(input.amount), resolved.map((r) => r.shareWeight));
  const shareTotal = fromUnits(shares.reduce((a, b) => a + b, 0n));
  if (cmp(shareTotal, input.amount) !== 0) {
    throw new InventoryError(
      input.basis === "manual"
        ? `manual target amounts (${shareTotal}) must sum to the voucher amount (${input.amount})`
        : "apportionment failed",
    );
  }

  const documentNumber = await nextSequenceNumber(orgId, "landed_cost_voucher", "LCV-", input.subsidiaryId);
  const bookId = await primaryBookId(orgId);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);

  return await db.transaction(async (tx) => {
    const voucher = (await tx.execute(sql`
      insert into landed_cost_vouchers
        (org_id, document_number, status, amount, basis, freight_account_id, source_document_line_id,
         subsidiary_id, voucher_date, memo, created_by, updated_by)
      values (${orgId}, ${documentNumber}, 'draft', ${input.amount}, ${input.basis}, ${input.freightAccountId},
              ${input.sourceDocumentLineId ?? null}, ${input.subsidiaryId}, ${input.voucherDate},
              ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`)) as unknown as { rows: { id: string }[] };
    const voucherId = voucher.rows[0].id;

    const entryLines: JournalLineInput[] = [];
    const layerIds: string[] = [];
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
        const w = (await tx.execute(sql`
          select cost_layer_id, weight from cost_layer_weights
           where org_id = ${orgId} and cost_layer_id in (${joinIds(r.layers.map((l) => l.id))})`)) as unknown as {
          rows: { cost_layer_id: string; weight: string }[];
        };
        for (const row of w.rows) weightsByLayer.set(row.cost_layer_id, row.weight);
      }
      const layerApportionBasis: "value" | "quantity" = input.basis === "quantity" ? "quantity" : "value";
      const subShares = apportionUnits(
        share,
        layerWeights(r.layers, layerApportionBasis, weightsByLayer),
      );
      for (let j = 0; j < r.layers.length; j++) {
        const layerShare = subShares[j];
        if (layerShare === 0n) continue;
        const layer = r.layers[j];
        const qtyUnits = toUnits(layer.remaining_quantity);
        const bump = qtyUnits === 0n ? 0n : roundDiv(layerShare * 10_000n, qtyUnits);
        await tx.execute(sql`
          update cost_layers set unit_cost = ${fromUnits(toUnits(layer.unit_cost) + bump)}, updated_at = now()
           where id = ${layer.id}`);
        await tx.execute(sql`
          insert into landed_cost_allocations
            (org_id, source_document_line_id, target_cost_layer_id, basis, amount, journal_entry_id, created_by, updated_by)
          values (${orgId}, ${input.sourceDocumentLineId ?? null}, ${layer.id}, ${input.basis},
                  ${fromUnits(layerShare)}, null, ${actorId}, ${actorId})`);
        layerIds.push(layer.id);
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
       where org_id = ${orgId} and journal_entry_id is null
         and target_cost_layer_id in (${joinIds(layerIds)})`);
    await tx.execute(sql`
      update landed_cost_vouchers set status = 'posted', journal_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
       where id = ${voucherId}`);
    return { id: voucherId, documentNumber, entryId };
  });
}

/** SQL list literal for a non-empty uuid array. */
function joinIds(ids: string[]) {
  if (ids.length === 0) throw new InventoryError("internal: empty id list");
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
}

