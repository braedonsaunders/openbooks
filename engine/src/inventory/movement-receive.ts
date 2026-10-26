import { lockSubcontractCustodyAuthority } from "./subcontract-custody.ts";
import { assertCustodyReceiptEvidence } from "./custody-receipt-evidence.ts";
import { createReceiptInspection } from "./inspections.ts";
import { applySerialReceipt } from "./count-movement-evidence.ts";
import { assertOwnedLocation } from "./stock-eligibility.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, apportion, cmp, fromUnits, isZero, neg, toUnits } from "../money/money.ts";
import { extendCost, receiveStandard, unitCostPerQuantity } from "./costing.ts";
import {
  loadSubsidiaryContext,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import { InventoryCostBasisError, InventoryError, type Runner } from "./contracts.ts";
import { emitAvailabilityChanged } from "../webhooks/emit.ts";
import { normalizeMovementIdempotencyKey } from "./action-idempotency.ts";
import { assertTracking, validateTrackingSelection } from "./tracking.ts";
import {
  assertStockLocationAdmitsSubsidiary,
  resolveProfile,
  assertMovementOwner,
  assertInventoryFeature,
} from "./profile-policy.ts";
import { assertItemsActive } from "./item-active.ts";
import { assertNotKitItem } from "./kits.ts";
import {
  stockLocationDim,
  postInventoryEntry,
  inventoryOffsetAccountProblem,
  type JournalLineInput,
} from "./journal.ts";
import {
  primaryBookId,
  periodForDate,
  subsidiaryCurrency,
  getOnHandWith,
  lockInventoryPosition,
  persistReceiptMoney,
} from "./position.ts";
import { addLayerAtCost, requireStandardCost } from "./cost-layers.ts";
// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------
export interface ReceiveInput {
  /** Exact reviewed count line whose surplus this receipt recognizes. */
  stockCountLineId?: string;
  /** Custody decrease that this atomic ownership receipt recognizes. */
  ownershipSourceStockId?: string;
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
  /** Set only when the receipt books a stock count's surplus: the enclosing
   *  warehouse then admits it as a count, which a suspended warehouse allows. */
  admission?: "count";
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
  if (cmp(quantity, "0") <= 0) throw new InventoryError("receipt quantity must be positive");
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
  if (!period) throw new InventoryError(`no accounting period for ${input.date}`);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);
  const ctx = await loadSubsidiaryContext(db, orgId);
  assertMovementOwner(ctx, input.subsidiaryId);
  const dims = {
    departmentId: input.departmentId ?? null,
    projectId: input.projectId ?? null,
  };
  const apply = async (tx: Runner): Promise<MovementResult> => {
    // Canonical lock order: fence the position before any row lock, or a
    // peer holding the fence deadlocks against this transaction at posting.
    await lockInventoryPosition(tx, input.itemId, input.stockLocationId);
    await assertInventoryFeature(tx, orgId);
    const bookId = await primaryBookId(orgId, tx);
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
    await lockSubcontractCustodyAuthority(
      tx,
      orgId,
      actorId,
      input.subsidiaryId,
      input.stockLocationId,
    );
    const profile = await resolveProfile(orgId, input.itemId, tx, true);
    await assertOwnedLocation(tx, orgId, input.stockLocationId);
    // INV-ACTIVE fence: a receipt mints stock, so an inactive item refuses
    // by name here — before any layer, settlement, movement, or journal
    // write. Shared helper holds the items row FOR SHARE through posting so
    // a racing deactivation serializes (see item-active.ts).
    await assertItemsActive(tx, orgId, [input.itemId], {
      inactiveRemedy: "reactivate it before posting stock movements",
      outsideOrganization: "receipt references an item outside this organization",
    });
    // Kits hold no stock of their own: a receipt would mint a position that
    // can never be valued or shipped. Refuse before any layer, movement or
    // journal write, naming the components as the stocked side.
    await assertNotKitItem(tx, orgId, input.itemId, "receive");
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
      input.admission === "count" ? "count" : "inbound",
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
      layerUnitCost = unitCostPerQuantity(authoritativeTotal, input.quantity)!;
    } else if (input.unitCost !== undefined) {
      layerUnitCost = input.unitCost;
    } else if (profile.costingMethod === "standard") {
      // A standard-cost item carries every unit at its configured standard.
      layerUnitCost = await requireStandardCost(tx, orgId, input.itemId, profile);
    } else {
      const onHand = await getOnHandWith(tx, orgId, input.itemId, input.stockLocationId, {
        subsidiaryId: input.subsidiaryId,
      });
      // With nothing valued on hand there is no average: a zero-cost receipt
      // would book found stock for nothing and its later sale at zero COGS.
      if (isZero(onHand.unitCost)) {
        const label =
          (
            await tx.execute<{ label: string }>(
              sql`select coalesce(nullif(btrim(code), ''), name) as label
          from items where org_id = ${orgId} and id = ${input.itemId}`,
              "objects",
            )
          )[0]?.label ?? input.itemId;
        throw new InventoryCostBasisError(
          `item ${label} has no cost basis at this stock location — nothing valued is on hand to average — so the ${input.quantity} received needs a unit cost; enter the unit cost of the received quantity`,
          label,
        );
      }
      layerUnitCost = onHand.unitCost;
    }
    let inventoryValue: string;
    let variance = "0";
    if (authoritativeTotal !== null) {
      // The document already booked the extended amount: carry exactly it.
      if (profile.costingMethod === "standard") {
        // Inventory carries at standard; the document's extended amount
        // less the standard value is the purchase price variance.
        const std = await requireStandardCost(tx, orgId, input.itemId, profile);
        inventoryValue = extendCost(input.quantity, std);
        variance = fromUnits(toUnits(authoritativeTotal) - toUnits(inventoryValue));
        layerUnitCost = std;
      } else {
        inventoryValue = authoritativeTotal;
      }
    } else {
      inventoryValue = extendCost(input.quantity, layerUnitCost);
      if (profile.costingMethod === "standard") {
        const std = await requireStandardCost(tx, orgId, input.itemId, profile);
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
      const accountProblem =
        inventoryOffsetAccountProblem(
          profile.assetAccountId,
          input.offsetAccountId,
          "receipt offset",
        ) ??
        (profile.costingMethod === "standard"
          ? inventoryOffsetAccountProblem(
              profile.assetAccountId,
              profile.varianceAccountId,
              "variance",
            )
          : null);
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
      throw new InventoryError("a non-posting receipt requires its source journal entry");
    }
    if (postJournal && !input.offsetAccountId) {
      throw new InventoryError("receipt requires an offset account");
    }
    await assertCustodyReceiptEvidence(tx, orgId, actorId, input);
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
      input.ownershipSourceStockId
        ? "ownership_receipt"
        : input.admission === "count"
          ? "count_receipt"
          : "receipt",
      actorId,
    );
    // Deficits settle only within the receiving legal entity: one
    // subsidiary's receipt must never consume another's shortfall (its
    // layers, GL, and on-hand reader are all per-entity).
    const deficits = await tx.execute<{
      id: string;
      remaining_quantity: string;
      provisional_unit_cost: string;
      offset_account_id: string | null;
      issued_on: string;
    }>(
      sql`
      select deficit.id,deficit.remaining_quantity,deficit.provisional_unit_cost,deficit.offset_account_id,
             issue.moved_at::text as issued_on
        from inventory_provisional_costs deficit
        join inventory_movements issue on issue.org_id=deficit.org_id and issue.id=deficit.issue_movement_id
       where deficit.org_id=${orgId} and deficit.item_id=${input.itemId} and deficit.stock_location_id=${input.stockLocationId}
         and deficit.subsidiary_id=${input.subsidiaryId}
         and deficit.remaining_quantity>0 order by deficit.created_at,deficit.id for update of deficit
    `,
      "objects",
    );
    let receiptUnits = toUnits(input.quantity);
    let provisionalValueUnits = 0n;
    let settledReceiptValueUnits = 0n;
    const settlements: {
      id: string;
      quantity: string;
      provisionalUnitCost: string;
      offsetAccountId: string;
      correction: string;
    }[] = [];
    for (const deficit of deficits) {
      if (receiptUnits === 0n) break;
      const available = toUnits(deficit.remaining_quantity);
      const take = available < receiptUnits ? available : receiptUnits;
      const quantity = fromUnits(take);
      const provisionalValue = extendCost(quantity, deficit.provisional_unit_cost);
      const receiptValue = extendCost(quantity, layerUnitCost);
      // The true-up corrects the account the shortfall was charged to; a
      // deficit without that record has no truthful destination.
      if (!deficit.offset_account_id) {
        const label =
          (
            await tx.execute<{ label: string }>(
              sql`select coalesce(nullif(btrim(code), ''), name) as label
          from items where org_id = ${orgId} and id = ${input.itemId}`,
              "objects",
            )
          )[0]?.label ?? input.itemId;
        throw new InventoryError(
          `item ${label} has negative stock issued on ${deficit.issued_on} without a recorded charge account, so this receipt cannot correct that issue's provisional cost; record the account under the item's Inventory tab (Shortfalls awaiting a charge account), then receive again`,
        );
      }
      settlements.push({
        id: deficit.id,
        quantity,
        provisionalUnitCost: deficit.provisional_unit_cost,
        offsetAccountId: deficit.offset_account_id,
        correction: fromUnits(toUnits(receiptValue) - toUnits(provisionalValue)),
      });
      provisionalValueUnits += toUnits(provisionalValue);
      settledReceiptValueUnits += toUnits(receiptValue);
      receiptUnits -= take;
    }
    const excessQuantity = fromUnits(receiptUnits);
    // Allocate authoritative value by exact quantities, not a rounded unit
    // price. Zero remaining stock receives no value, and settlements cannot
    // consume more value than the receipt contains.
    if (authoritativeTotal !== null && profile.costingMethod !== "standard") {
      const allocated = apportion(toUnits(authoritativeTotal), [
        ...settlements.map((settlement) => toUnits(settlement.quantity)),
        receiptUnits,
      ]);
      settledReceiptValueUnits = 0n;
      settlements.forEach((settlement, index) => {
        const value = allocated[index]!;
        settlement.correction = fromUnits(
          value - toUnits(extendCost(settlement.quantity, settlement.provisionalUnitCost)),
        );
        settledReceiptValueUnits += value;
      });
    }
    const excessLayerValue =
      authoritativeTotal !== null && profile.costingMethod !== "standard"
        ? fromUnits(toUnits(authoritativeTotal) - settledReceiptValueUnits)
        : extendCost(excessQuantity, layerUnitCost);
    const assetDelta = fromUnits(provisionalValueUnits + toUnits(excessLayerValue));
    const correction = fromUnits(toUnits(inventoryValue) - toUnits(assetDelta));
    // Each settlement's true-up returns to the account its issue charged.
    // Extending the whole receipt can differ from the per-settlement
    // extensions by rounding; that remainder joins the oldest settlement's
    // account so the corrections sum exactly to the receipt's.
    const correctionByAccount = new Map<string, bigint>();
    for (const settlement of settlements) {
      correctionByAccount.set(
        settlement.offsetAccountId,
        (correctionByAccount.get(settlement.offsetAccountId) ?? 0n) +
          toUnits(settlement.correction),
      );
    }
    if (!isZero(correction)) {
      const first = settlements[0];
      if (!first)
        throw new InventoryError(
          "a receipt cost true-up has no negative-stock settlement to correct",
        );
      const allocated = [...correctionByAccount.values()].reduce(
        (total, amount) => total + amount,
        0n,
      );
      correctionByAccount.set(
        first.offsetAccountId,
        correctionByAccount.get(first.offsetAccountId)! + toUnits(correction) - allocated,
      );
    }
    const correctionLines = [...correctionByAccount]
      .filter(([, amount]) => amount !== 0n)
      .map(([accountId, amount]) => ({
        accountId,
        amount: fromUnits(amount),
        ...locDims,
        memo: "Negative inventory receipt cost true-up",
      }));
    const lines: JournalLineInput[] = postJournal
      ? [
          {
            accountId: profile.assetAccountId,
            amount: assetDelta,
            ...locDims,
            memo: input.memo,
          },
          ...correctionLines,
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
            ...correctionLines,
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
    const mv = await tx.execute<{ id: string }>(
      sql`
      insert into inventory_movements
        (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id, quantity, unit_cost, total_value,
         document_line_id, journal_entry_id, idempotency_key, status, memo, created_by, updated_by)
      values (${orgId}, ${input.subsidiaryId}, ${input.itemId}, 'receipt', ${input.date}, ${input.stockLocationId}, ${input.lotId ?? null},
              ${input.serialId ?? null}, ${receiptQuantity}, ${receiptUnitCost}, ${assetDelta},
              ${input.documentLineId ?? null}, ${entryId}, ${idempotencyKey},
              'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`,
      "objects",
    );
    const movementId = mv[0]!.id;

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
      await addLayerAtCost(
        tx,
        orgId,
        input.subsidiaryId,
        input.itemId,
        input.stockLocationId,
        excessQuantity,
        excessLayerValue,
        profile.costingMethod,
        movementId,
        input.date,
        actorId,
        layerUnitCost,
      );
    }

    if (profile.tracking === "serial" || profile.tracking === "lot_serial") {
      await applySerialReceipt(tx, orgId, actorId, input, movementId);
    }

    if (input.admission !== "count") await createReceiptInspection(tx, orgId, actorId, movementId);

    return { movementId, entryId, value: assetDelta };
  };
  const result = input.tx ? await apply(input.tx) : await db.transaction(apply);
  // Availability signal joins the caller's transaction when one is open:
  // a rolled-back movement announces nothing, and repeats in one
  // transaction coalesce onto one event per item and location.
  await emitAvailabilityChanged(input.tx ?? db, orgId, input.itemId, input.stockLocationId);
  return result;
}
