import { lockSubcontractCustodyAuthority } from "./subcontract-custody.ts";
import { assertInspectionScrapIssue } from "./inspections.ts";
import { applySerialIssue } from "./count-movement-evidence.ts";
import { assertSaleableStock, assertOwnedLocation } from "./stock-eligibility.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { cmp, isZero, neg, toUnits } from "../money/money.ts";
import {
  loadSubsidiaryContext,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { emitAvailabilityChanged } from "../webhooks/emit.ts";
import { normalizeMovementIdempotencyKey } from "./action-idempotency.ts";
import { assertTracking, validateTrackingSelection } from "./tracking.ts";
import {
  assertStockLocationAdmitsSubsidiary,
  assertNoForeignOnHand,
  resolveProfile,
  assertMovementOwner,
  assertInventoryFeature,
} from "./profile-policy.ts";
import { assertItemsActive } from "./item-active.ts";
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
  backdatedIssueShortage,
} from "./position.ts";
import { consumeLayers, recordConsumptions, resolveProvisionalUnitCost } from "./cost-layers.ts";
import { type MovementResult } from "./movement-receive.ts";
// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssueInput {
  /** Native proof for disposing exactly a failed receipt; never an unrestricted hold bypass. */
  inspectionScrapId?: string;
  /** Restrict a disposition to the originating receipt's still-available layers. */
  sourceReceiptMovementId?: string;
  /** Exact reviewed count line whose shortage this issue recognizes. */
  stockCountLineId?: string;
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
  /** Set only when the issue books a stock count's shortfall: the enclosing
   *  warehouse then admits it as a count. */
  admission?: "count";
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
  if (cmp(quantity, "0") <= 0) throw new InventoryError("issue quantity must be positive");
  const period = await periodForDate(orgId, input.date, runner);
  if (!period) throw new InventoryError(`no accounting period for ${input.date}`);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId, runner);
  const ctx = await loadSubsidiaryContext(runner, orgId);
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
    // Same location default as receipts: the issuing stock location's
    // business location, so location-sliced statements tie to the subledger.
    const locDims = {
      ...dims,
      locationId: await stockLocationDim(tx, orgId, input.stockLocationId, input.locationId),
    };
    // Re-read the policy under the movement transaction's lock boundary so a
    // concurrent costing-policy revision cannot price this issue from stale
    // standard-cost or tracking settings.
    await lockSubcontractCustodyAuthority(
      tx,
      orgId,
      actorId,
      input.subsidiaryId,
      input.stockLocationId,
    );
    const profile = await resolveProfile(orgId, input.itemId, tx, true);
    await assertOwnedLocation(tx, orgId, input.stockLocationId);
    // INV-ACTIVE fence: an issue moves stock out, so an inactive item
    // refuses by name here — before any consumption, movement, or journal
    // write. Shared helper holds the items row FOR SHARE through posting so
    // a racing deactivation serializes (see item-active.ts). Adjustments
    // inherit this fence by delegating to receive/issue in the same
    // transaction, as do purchase receipts, sales fulfilment, and
    // stock-count posts.
    await assertItemsActive(tx, orgId, [input.itemId], {
      inactiveRemedy: "reactivate it before posting stock movements",
      outsideOrganization: "issue references an item outside this organization",
    });
    assertTracking(
      profile,
      { quantity: input.quantity, lotId: input.lotId, serialId: input.serialId },
      "issue",
    );
    if (input.inspectionScrapId)
      await assertInspectionScrapIssue(tx, orgId, actorId, {
        ...input,
        inspectionId: input.inspectionScrapId,
      });
    else if (input.admission !== "count")
      await assertSaleableStock(tx, orgId, input.stockLocationId, input);
    const offset = input.offsetAccountId ?? profile.cogsAccountId;
    const accountProblem = inventoryOffsetAccountProblem(
      profile.assetAccountId,
      offset,
      "issue offset",
    );
    if (accountProblem) throw new InventoryError(accountProblem);
    await assertStockLocationAdmitsSubsidiary(
      tx,
      orgId,
      ctx,
      input.stockLocationId,
      input.subsidiaryId,
      input.admission === "count" ? "count" : "outbound",
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
      actorId,
    );
    const onHand = await getOnHandWith(tx, orgId, input.itemId, input.stockLocationId, {
      lotId: input.lotId,
      serialId: input.serialId,
      subsidiaryId: input.subsidiaryId,
      sourceReceiptMovementId: input.sourceReceiptMovementId,
    });
    const shortage =
      toUnits(input.quantity) - (toUnits(onHand.quantity) > 0n ? toUnits(onHand.quantity) : 0n);
    if (shortage > 0n) {
      if (input.inspectionScrapId || input.sourceReceiptMovementId)
        throw new InventoryError(
          "The originating receipt no longer has the full disposition quantity; reconcile its consumption or transfer before disposing it.",
        );
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
        const where = (
          await tx.execute<{ item: string; location: string | null }>(
            sql`
          select coalesce(nullif(btrim(i.code), ''), i.name) as item, l.code as location
            from items i left join stock_locations l on l.org_id = i.org_id and l.id = ${input.stockLocationId}
           where i.org_id = ${orgId} and i.id = ${input.itemId}`,
            "objects",
          )
        )[0];
        const item = where?.item ?? input.itemId;
        const location = where?.location ? ` at ${where.location}` : "";
        throw new InventoryError(
          `insufficient stock of ${item}${location}: need ${input.quantity}, on hand ${onHand.quantity} (negative inventory is disabled for this tracking configuration) — receive or adjust stock into this location, or issue from a location that holds it`,
        );
      }
    }
    // Explicitly permitted negative stock is priced provisionally and is not
    // date-gated. Every other issue, including a disposition of one receipt's
    // layers, must be covered by stock on its own date.
    if (
      input.sourceReceiptMovementId ||
      !profile.allowNegativeInventory ||
      profile.tracking !== "none"
    ) {
      const backdated = await backdatedIssueShortage(
        tx,
        orgId,
        {
          itemId: input.itemId,
          stockLocationId: input.stockLocationId,
          subsidiaryId: input.subsidiaryId,
          lotId: input.lotId,
          serialId: input.serialId,
          sourceReceiptMovementId: input.sourceReceiptMovementId,
        },
        input.date,
        quantity,
      );
      if (backdated) throw new InventoryError(backdated);
    }
    const provisionalUnitCost =
      shortage > 0n
        ? await resolveProvisionalUnitCost(tx, orgId, profile, input.itemId, input.subsidiaryId)
        : onHand.unitCost;
    const { cost, unitCost, consumptions, shortfallQuantity } = await consumeLayers(
      tx,
      orgId,
      profile,
      input.itemId,
      input.stockLocationId,
      input.quantity,
      onHand,
      provisionalUnitCost,
      {
        lotId: input.lotId,
        serialId: input.serialId,
        sourceReceiptMovementId: input.sourceReceiptMovementId,
      },
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
    const mv = await tx.execute<{ id: string }>(
      sql`
      insert into inventory_movements
        (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id, serial_id,
         quantity, unit_cost, total_value,
         document_line_id, journal_entry_id, idempotency_key, status, memo, created_by, updated_by)
      values (${orgId}, ${input.subsidiaryId}, ${input.itemId}, 'issue', ${input.date}, ${input.stockLocationId},
              ${input.lotId ?? null}, ${input.serialId ?? null},
              ${neg(issueQuantity)}, ${unitCost}, ${neg(cost)}, ${input.documentLineId ?? null}, ${entryId},
              ${idempotencyKey},
              'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`,
      "objects",
    );
    const movementId = mv[0]!.id;
    await recordConsumptions(tx, orgId, input.subsidiaryId, consumptions, movementId, actorId);
    if (input.inspectionScrapId) {
      const stamped = await tx.execute(
        sql`update inventory_inspections set scrap_movement_id=${movementId},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${input.inspectionScrapId} and status='fail' and disposition is null and scrap_movement_id is null returning id`,
        "objects",
      );
      if (stamped.length !== 1)
        throw new InventoryError("The inspection scrap effect was not recorded.");
    }
    if (!isZero(shortfallQuantity)) {
      await tx.execute(sql`
        insert into inventory_provisional_costs
          (org_id,subsidiary_id,item_id,stock_location_id,issue_movement_id,original_quantity,remaining_quantity,
           provisional_unit_cost,cost_basis,offset_account_id,created_by,updated_by)
        values (${orgId},${input.subsidiaryId},${input.itemId},${input.stockLocationId},${movementId},${shortfallQuantity},
                ${shortfallQuantity},${provisionalUnitCost},${profile.negativeCostBasis},${offset},${actorId},${actorId})
      `);
    }
    if (profile.tracking === "serial" || profile.tracking === "lot_serial") {
      await applySerialIssue(tx, orgId, actorId, input, movementId);
    }
    return { movementId, entryId, value: neg(cost) };
  };
  const result = input.tx ? await apply(input.tx) : await db.transaction(apply);
  // Same availability contract as receipts: join the open transaction when
  // there is one, so a rolled-back issue announces nothing.
  await emitAvailabilityChanged(input.tx ?? db, orgId, input.itemId, input.stockLocationId);
  return result;
}
