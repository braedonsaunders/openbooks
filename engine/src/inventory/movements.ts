import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, cmp, fromUnits, isZero, neg, toUnits } from "../money/money.ts";
import { extendCost, receiveStandard, unitCostPerQuantity } from "./costing.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { normalizeMovementIdempotencyKey } from "./action-idempotency.ts";
import { assertTracking, validateTrackingSelection } from "./tracking.ts";
import { assertStockLocationAdmitsSubsidiary, assertNoForeignOnHand, resolveProfile, assertMovementOwner, assertInventoryFeature } from "./profile-policy.ts";
import { stockLocationDim, postInventoryEntry, inventoryOffsetAccountProblem, type JournalLineInput } from "./journal.ts";
import { primaryBookId, periodForDate, subsidiaryCurrency, getOnHandWith, lockInventoryPosition, persistReceiptMoney } from "./position.ts";
import { consumeLayers, recordConsumptions, resolveProvisionalUnitCost, addLayerAtCost } from "./cost-layers.ts";

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

export interface ReceiveInput {
  itemId: string;
  stockLocationId: string;
  /** base-unit quantity (> 0). */
  quantity: string;
  /** Actual unit cost paid. Omit only for write-ups without a source price:
   *  the receipt then carries at the position's prevailing average, re-read
   *  under the position lock so a concurrent movement cannot strand it on a
   *  stale pre-lock snapshot. Must be omitted when totalValue is given: the
   *  rate is derived from the authoritative total instead, so two sources
   *  can never disagree by a rounding unit. */
  unitCost?: string;
  /** Authoritative extended value the source document already booked to the
   *  GL (bill and goods-receipt lines). The cost layer carries exactly this
   *  — never quantity × a rounded rate, which strands a penny on non-
   *  terminating amounts ($100.00 / 3 → 99.9999 vs 100.00 debited). */
  totalValue?: string;
  subsidiaryId: string;
  /** GL account the receipt credits (GRNI / clearing). Required unless
   *  postJournal is false (the source document already moved the GL). */
  offsetAccountId?: string;
  date: string;
  documentLineId?: string | null;
  /** Stable source-effect identity; storage rejects duplicate non-null keys. */
  idempotencyKey?: string | null;
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
  /** Join the caller's transaction instead of opening one. Required when the
   * receipt belongs to a larger accounting unit such as vendor-bill posting. */
  tx?: SqlExecutor;
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
  const idempotencyKey = normalizeMovementIdempotencyKey(input.idempotencyKey);
  // Fail closed on shape AND range before any journal math or layer write:
  // every downstream consumer lands in numeric(19,4) columns, so junk used
  // to escape as a bare Error and oversized figures as a storage failure.
  const quantity = persistReceiptMoney(input.quantity, "receipt quantity");
  if (cmp(quantity, "0") <= 0)
    throw new InventoryError("receipt quantity must be positive");
  // unitCost may be omitted (average fallback); when supplied it prices the
  // same journal math, so it takes the same early gate.
  if (input.unitCost !== undefined) persistReceiptMoney(input.unitCost, "receipt unit cost");
  // totalValue is the GL-authoritative extended amount: one source of truth,
  // so it must arrive alone and non-negative. A negative extended value on a
  // positive quantity used to escape as a bare Error from the layer writer.
  const authoritativeTotal =
    input.totalValue !== undefined
      ? persistReceiptMoney(input.totalValue, "receipt total value")
      : null;
  if (authoritativeTotal !== null && input.unitCost !== undefined)
    throw new InventoryError("receipt takes a unit cost or a total value, not both");
  if (authoritativeTotal !== null && cmp(authoritativeTotal, "0") < 0)
    throw new InventoryError("receipt total value must not be negative");
  const period = await periodForDate(orgId, input.date);
  if (!period)
    throw new InventoryError(`no accounting period for ${input.date}`);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);
  const ctx = await loadSubsidiaryContext(db, orgId);
  assertMovementOwner(ctx, input.subsidiaryId);

  const dims = {
    departmentId: input.departmentId ?? null,
    projectId: input.projectId ?? null,
  };

  const apply = async (tx: Runner): Promise<MovementResult> => {
    await assertInventoryFeature(tx, orgId);
    const bookId = await primaryBookId(orgId, tx);
    await lockInventoryPosition(tx, input.itemId, input.stockLocationId);
    // The GL location dimension defaults to the receiving stock location's
    // business location (transferInventoryTx resolves the same mapping), so
    // location-sliced statements tie to the subledger. Explicit dims win.
    const locDims = {
      ...dims,
      locationId: await stockLocationDim(tx, orgId, input.stockLocationId, input.locationId),
    };
    // Costing policy is locked and re-read after the position lock. The
    // costing-policy writer takes the same profile lock before revaluing
    // layers, so a receipt cannot carry a stale pre-transaction policy.
    const profile = await resolveProfile(orgId, input.itemId, tx, true);
    assertTracking(
      profile,
      { quantity: input.quantity, lotId: input.lotId, serialId: input.serialId },
      "receipt",
    );
    await assertStockLocationAdmitsSubsidiary(
      tx,
      orgId,
      ctx,
      input.stockLocationId,
      input.subsidiaryId,
    );

    // Costing lives under the position lock: a receipt without an explicit
    // cost carries at the average prevailing at commit time — a pre-lock
    // snapshot would let a concurrent movement strand it on a stale value.
    // Only the receiving entity's layers feed that average.
    // The pricing rate: derived from the authoritative total when the
    // document booked one (never supplied beside it), else the caller's unit
    // cost, else the average prevailing under the position lock.
    let layerUnitCost: string;
    if (authoritativeTotal !== null) {
      layerUnitCost = unitCostPerQuantity(
        authoritativeTotal,
        input.quantity,
      )!;
    } else if (input.unitCost !== undefined) {
      layerUnitCost = input.unitCost;
    } else {
      const onHand = await getOnHandWith(
        tx,
        orgId,
        input.itemId,
        input.stockLocationId,
        { subsidiaryId: input.subsidiaryId },
      );
      layerUnitCost = isZero(onHand.unitCost) ? "0" : onHand.unitCost;
    }
    let inventoryValue: string;
    let variance = "0";
    if (authoritativeTotal !== null) {
      // The document already booked the extended amount: carry exactly it.
      if (profile.costingMethod === "standard") {
        // Inventory carries at standard; the document's extended amount
        // less the standard value is the purchase price variance.
        const std = profile.standardCost ?? layerUnitCost;
        inventoryValue = extendCost(input.quantity, std);
        variance = fromUnits(
          toUnits(authoritativeTotal) - toUnits(inventoryValue),
        );
        layerUnitCost = std;
      } else {
        inventoryValue = authoritativeTotal;
      }
    } else {
      inventoryValue = extendCost(input.quantity, layerUnitCost);
      if (profile.costingMethod === "standard") {
        const std = profile.standardCost ?? layerUnitCost;
        const rs = receiveStandard(input.quantity, layerUnitCost, std);
        inventoryValue = rs.inventoryValue;
        variance = rs.variance;
        layerUnitCost = std;
      }
    }
    const offsetTotal = add(inventoryValue, variance); // = qty × actual

    // When the source document already DR'd inventory (postJournal === false),
    // we skip the entry and only record the layer. Standard costing needs its
    // own entry to book the variance, so it requires a real offset (a clearing
    // acct).
    const postJournal = input.postJournal !== false;
    if (postJournal) {
      const accountProblem = inventoryOffsetAccountProblem(profile.assetAccountId, input.offsetAccountId, "receipt offset")
        ?? (profile.costingMethod === "standard"
          ? inventoryOffsetAccountProblem(profile.assetAccountId, profile.varianceAccountId, "variance") : null);
      if (accountProblem) throw new InventoryError(accountProblem);
    }
    if (!postJournal && !isZero(variance)) {
      throw new InventoryError(
        "standard-cost receipts require a received-not-billed account to book purchase variance",
      );
    }
    if (postJournal && !isZero(variance) && !profile.varianceAccountId) {
      throw new InventoryError(
        "this receipt carries a purchase price variance under standard costing but the item has no variance account — configure one; booking the variance on the asset account itself would post a self-cancelling entry and break GL = cost layers",
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
    // Deficits settle only within the receiving legal entity: one
    // subsidiary's receipt must never consume another's shortfall (its
    // layers, GL, and on-hand reader are all per-entity).
    const deficits = (await tx.execute<{
        id: string;
        remaining_quantity: string;
        provisional_unit_cost: string;
      }>(sql`
      select id,remaining_quantity,provisional_unit_cost
        from inventory_provisional_costs
       where org_id=${orgId} and item_id=${input.itemId} and stock_location_id=${input.stockLocationId}
         and subsidiary_id=${input.subsidiaryId}
         and remaining_quantity>0 order by created_at,id for update
    `));
    let receiptUnits = toUnits(input.quantity);
    let provisionalValueUnits = 0n;
    let settledReceiptValueUnits = 0n;
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
      settledReceiptValueUnits += toUnits(receiptValue);
      receiptUnits -= take;
    }
    const excessQuantity = fromUnits(receiptUnits);
    // The excess layer carries the exact residual: with an authoritative
    // total that is the total less what the settlements already priced, so
    // no rounding penny lands in COGS or goes missing from the layer.
    const excessLayerValue =
      authoritativeTotal !== null && profile.costingMethod !== "standard"
        ? fromUnits(toUnits(authoritativeTotal) - settledReceiptValueUnits)
        : extendCost(excessQuantity, layerUnitCost);
    const assetDelta = fromUnits(
      provisionalValueUnits + toUnits(excessLayerValue),
    );
    const correction = fromUnits(toUnits(inventoryValue) - toUnits(assetDelta));
    const lines: JournalLineInput[] = postJournal
      ? [
          {
            accountId: profile.assetAccountId,
            amount: assetDelta,
            ...locDims,
            memo: input.memo,
          },
          ...(!isZero(correction)
            ? [
                {
                  accountId: profile.cogsAccountId,
                  amount: correction,
                  ...locDims,
                  memo: "Negative inventory receipt cost true-up",
                },
              ]
            : []),
          ...(!isZero(variance)
            ? [
                {
                  accountId: profile.varianceAccountId!,
                  amount: variance,
                  ...locDims,
                  memo: "PPV",
                },
              ]
            : []),
          {
            accountId: input.offsetAccountId!,
            amount: neg(offsetTotal),
            ...locDims,
            memo: input.memo,
          },
        ]
      : !isZero(correction)
        ? [
            {
              accountId: profile.cogsAccountId,
              amount: correction,
              ...locDims,
              memo: "Negative inventory receipt cost true-up",
            },
            {
              accountId: profile.assetAccountId,
              amount: neg(correction),
              ...locDims,
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
          actorId,
          currency,
          periodId: period,
          date: input.date,
          // A location receives many movements per day; the entry number must
          // be unique per physical journal under journal_entries_org_number.
          entryNumber: `INV-RCPT-${input.date}-${input.stockLocationId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
          memo: input.memo ?? "Inventory receipt",
          lines,
        })
      : (input.linkEntryId ?? null);

    const receiptQuantity = persistReceiptMoney(input.quantity, "receipt quantity");
    const receiptUnitCost = persistReceiptMoney(layerUnitCost, "receipt unit cost");
    const mv = (await tx.execute<{ id: string }>(sql`
      insert into inventory_movements
        (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id, quantity, unit_cost, total_value,
         document_line_id, journal_entry_id, idempotency_key, status, memo, created_by, updated_by)
      values (${orgId}, ${input.subsidiaryId}, ${input.itemId}, 'receipt', ${input.date}, ${input.stockLocationId}, ${input.lotId ?? null},
              ${input.serialId ?? null}, ${receiptQuantity}, ${receiptUnitCost}, ${assetDelta},
              ${input.documentLineId ?? null}, ${entryId}, ${idempotencyKey},
              'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`));
    const movementId = mv.rows[0]!.id;

    for (const settlement of settlements) {
      await tx.execute(sql`
        update inventory_provisional_costs
           set remaining_quantity=remaining_quantity-${settlement.quantity},updated_at=now(),updated_by=${actorId}
         where id=${settlement.id} and org_id=${orgId} and subsidiary_id=${input.subsidiaryId}
      `);
      await tx.execute(sql`
        insert into inventory_provisional_settlements
          (org_id,provisional_cost_id,receipt_movement_id,quantity,provisional_unit_cost,receipt_unit_cost,
           correction_amount,correction_journal_entry_id,created_by,updated_by)
        values (${orgId},${settlement.id},${movementId},${settlement.quantity},${settlement.provisionalUnitCost},
                ${layerUnitCost},${settlement.correction},${entryId ?? input.linkEntryId},${actorId},${actorId})
      `);
    }

    if (receiptUnits > 0n) {
      await addLayerAtCost(tx, orgId, input.subsidiaryId, input.itemId,
        input.stockLocationId, excessQuantity, excessLayerValue,
        profile.costingMethod, movementId, input.date, actorId, layerUnitCost);
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
  };
  return input.tx ? apply(input.tx) : db.transaction(apply);
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
  /** Stable source-effect identity; storage rejects duplicate non-null keys. */
  idempotencyKey?: string | null;
  lotId?: string | null;
  serialId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  memo?: string | null;
  /** Join the caller's transaction instead of opening one. Fulfillment is a
   * single accounting unit: its document, source-line advance, inventory
   * movement and COGS journal either all commit or all roll back. */
  tx?: SqlExecutor;
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
  const runner = input.tx ?? db;
  const idempotencyKey = normalizeMovementIdempotencyKey(input.idempotencyKey);
  // Same early gate as receipts: junk must name InventoryError (not a bare
  // Error) and oversized figures must refuse before any journal math.
  const quantity = persistReceiptMoney(input.quantity, "issue quantity");
  if (cmp(quantity, "0") <= 0)
    throw new InventoryError("issue quantity must be positive");
  const period = await periodForDate(orgId, input.date, runner);
  if (!period)
    throw new InventoryError(`no accounting period for ${input.date}`);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId, runner);
  const ctx = await loadSubsidiaryContext(runner, orgId);
  assertMovementOwner(ctx, input.subsidiaryId);
  const dims = {
    departmentId: input.departmentId ?? null,
    projectId: input.projectId ?? null,
  };

  const apply = async (tx: Runner): Promise<MovementResult> => {
    await assertInventoryFeature(tx, orgId);
    const bookId = await primaryBookId(orgId, tx);
    await lockInventoryPosition(tx, input.itemId, input.stockLocationId);
    // Same location default as receipts: the issuing stock location's
    // business location, so location-sliced statements tie to the subledger.
    const locDims = {
      ...dims,
      locationId: await stockLocationDim(tx, orgId, input.stockLocationId, input.locationId),
    };
    // Re-read the policy under the movement transaction's lock boundary so a
    // concurrent costing-policy revision cannot price this issue from stale
    // standard-cost or tracking settings.
    const profile = await resolveProfile(orgId, input.itemId, tx, true);
    assertTracking(
      profile,
      { quantity: input.quantity, lotId: input.lotId, serialId: input.serialId },
      "issue",
    );
    const offset = input.offsetAccountId ?? profile.cogsAccountId;
    const accountProblem = inventoryOffsetAccountProblem(profile.assetAccountId, offset, "issue offset");
    if (accountProblem) throw new InventoryError(accountProblem);
    await assertStockLocationAdmitsSubsidiary(
      tx,
      orgId,
      ctx,
      input.stockLocationId,
      input.subsidiaryId,
    );
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
      { lotId: input.lotId, serialId: input.serialId, subsidiaryId: input.subsidiaryId },
    );
    const shortage =
      toUnits(input.quantity) -
      (toUnits(onHand.quantity) > 0n ? toUnits(onHand.quantity) : 0n);
    if (shortage > 0n) {
      // A shortfall while another legal entity's layers sit in the same
      // position is a cross-entity attempt, not a stockout — refuse it as
      // one instead of leaking their holdings through availability errors.
      await assertNoForeignOnHand(
        tx,
        orgId,
        input.itemId,
        input.stockLocationId,
        input.subsidiaryId,
      );
      if (!profile.allowNegativeInventory || profile.tracking !== "none") {
        throw new InventoryError(
          `insufficient stock: need ${input.quantity}, on hand ${onHand.quantity} (negative inventory is disabled for this tracking configuration)`,
        );
      }
    }
    const provisionalUnitCost =
      shortage > 0n
        ? await resolveProvisionalUnitCost(
            tx,
            orgId,
            profile,
            input.itemId,
            input.subsidiaryId,
          )
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
        input.subsidiaryId,
        actorId,
      );

    const lines: JournalLineInput[] = [
      { accountId: offset, amount: cost, ...locDims, memo: input.memo },
      {
        accountId: profile.assetAccountId,
        amount: neg(cost),
        ...locDims,
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
      actorId,
      currency,
      periodId: period,
      date: input.date,
      entryNumber: `INV-ISSUE-${input.date}-${input.stockLocationId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
      memo: input.memo ?? "Inventory issue",
      lines,
    });

    const issueQuantity = persistReceiptMoney(input.quantity, "issue quantity");
    const mv = (await tx.execute<{ id: string }>(sql`
      insert into inventory_movements
        (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id,
         quantity, unit_cost, total_value,
         document_line_id, journal_entry_id, idempotency_key, status, memo, created_by, updated_by)
      values (${orgId}, ${input.subsidiaryId}, ${input.itemId}, 'issue', ${input.date}, ${input.stockLocationId},
              ${input.lotId ?? null}, ${input.serialId ?? null},
              ${neg(issueQuantity)}, ${unitCost}, ${neg(cost)}, ${input.documentLineId ?? null}, ${entryId},
              ${idempotencyKey},
              'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`));
    const movementId = mv.rows[0]!.id;
    await recordConsumptions(
      tx,
      orgId,
      input.subsidiaryId,
      consumptions,
      movementId,
      actorId,
    );
    if (!isZero(shortfallQuantity)) {
      await tx.execute(sql`
        insert into inventory_provisional_costs
          (org_id,subsidiary_id,item_id,stock_location_id,issue_movement_id,original_quantity,remaining_quantity,
           provisional_unit_cost,cost_basis,created_by,updated_by)
        values (${orgId},${input.subsidiaryId},${input.itemId},${input.stockLocationId},${movementId},${shortfallQuantity},
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
  };
  return input.tx ? apply(input.tx) : db.transaction(apply);
}

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
 * delta receives at `unitCost` (else the average prevailing under the position
 * lock); a negative delta issues at current cost. Used by stock counts and
 * manual write-ups/downs.
 */
export async function adjustInventory(
  orgId: string,
  actorId: string | null,
  input: AdjustInput,
): Promise<MovementResult> {
  // Deltas are signed, so the range gate runs before the sign is read: junk
  // must name InventoryError (not the bare Error cmp throws) and oversized
  // figures must refuse before delegation or any journal math.
  const quantityDelta = persistReceiptMoney(input.quantityDelta, "adjustment quantity");
  const sign = cmp(quantityDelta, "0");
  if (sign === 0)
    throw new InventoryError("adjustment quantity cannot be zero");
  // Keep the adjustment-account lookup in the same lock boundary as the
  // delegated movement. Lock the position first to preserve the canonical
  // position → profile ordering used by receive/issue and avoid deadlocks.
  return db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    await lockInventoryPosition(tx, input.itemId, input.stockLocationId);
    const profile = await resolveProfile(orgId, input.itemId, tx, true);
    const offset = profile.adjustmentAccountId ?? profile.cogsAccountId;
    if (sign > 0) {
      return receiveInventory(orgId, actorId, {
        itemId: input.itemId,
        stockLocationId: input.stockLocationId,
        quantity: input.quantityDelta,
        unitCost: input.unitCost,
        subsidiaryId: input.subsidiaryId,
        offsetAccountId: offset,
        date: input.date,
        serialId: input.serialId,
        lotId: input.lotId,
        memo: input.memo ?? "Inventory adjustment",
        departmentId: input.departmentId,
        projectId: input.projectId,
        locationId: input.locationId,
        tx,
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
      serialId: input.serialId,
      lotId: input.lotId,
      memo: input.memo ?? "Inventory adjustment",
      departmentId: input.departmentId,
      projectId: input.projectId,
      locationId: input.locationId,
      tx,
    });
  });
}

// ---------------------------------------------------------------------------
// Transfer between stock locations (carried at cost)
// ---------------------------------------------------------------------------
