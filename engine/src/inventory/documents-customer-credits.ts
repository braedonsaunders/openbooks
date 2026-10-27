import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, cmp, fromUnits, isZero, neg, roundDiv, toUnits } from "../money/money.ts";
import {
  loadSubsidiaryContext,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import { SYSTEM_ACTOR_ID } from "../banking/banking.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { assertTracking, validateTrackingSelection } from "./tracking.ts";
import {
  assertStockLocationAdmitsSubsidiary,
  assertMovementOwner,
  resolveProfile,
  inventoryFeatureEnabled,
} from "./profile-policy.ts";
import {
  lockInventoryPosition,
  persistReceiptMoney,
  periodForDate,
  primaryBookId,
  subsidiaryCurrency,
} from "./position.ts";
import { addLayerAtCost } from "./cost-layers.ts";
import { crossSubsidiaryFulfillmentHandler, crossSubsidiaryShipment } from "./cross-subsidiary.ts";
import { extendCost } from "./costing.ts";
import { stockLocationDim, postInventoryEntry, type JournalLineInput } from "./journal.ts";
import { inventoryPostingEffectKey } from "./document-lines.ts";
import { postedReturnQuantity } from "./return-quantities.ts";
import { inventoryKitComponentReturnKey } from "./kits.ts";
import {
  expandKitCustomerCreditReturnLines,
  loadCustomerCreditInventoryReturnLines,
  type CustomerCreditInventoryReturnLine,
} from "./customer-credit-return-lines.ts";

/**
 * Immutable operational document created when stock physically leaves on a
 * sales order. Mirrors PURCHASE_RECEIPT_DOCUMENT_KIND on the buy side; the
 * client-side spelling lives in web/lib/order-kinds.ts.
 */
export const SALES_FULFILLMENT_DOCUMENT_KIND = "sales_fulfillment";

type SourceIssueEvidence = Record<string, unknown> & {
  id: string;
  subsidiary_id: string;
  item_id: string;
  stock_location_id: string;
  lot_id: string | null;
  serial_id: string | null;
  quantity: string;
  total_value: string | null;
  kind: string;
  status: string;
  source_document_kind: string | null;
  source_customer_id: string | null;
  is_reversed: boolean;
};

async function validateCustomerReturnSource(
  runner: Runner,
  orgId: string,
  customerId: string | null,
  subsidiaryId: string,
  line: CustomerCreditInventoryReturnLine,
  lock: boolean,
): Promise<{ source: SourceIssueEvidence; alreadyReturned: string }> {
  const source = (
    await runner.execute<SourceIssueEvidence>(
      sql`
    select movement.id, movement.subsidiary_id, movement.item_id,
           movement.stock_location_id, movement.lot_id, movement.serial_id,
           movement.quantity, movement.total_value, movement.kind, movement.status,
           source_document.kind as source_document_kind,
           source_document.party_id as source_customer_id,
           exists (
             select 1 from inventory_movements reversal
              where reversal.org_id = movement.org_id
                and reversal.reverses_movement_id = movement.id
           ) as is_reversed
      from inventory_movements movement
      left join document_lines source_line
        on source_line.id = movement.document_line_id
       and source_line.org_id = movement.org_id
      left join documents source_document
        on source_document.id = source_line.document_id
       and source_document.org_id = movement.org_id
     where movement.org_id = ${orgId}
       and movement.id = ${line.selection.sourceIssueMovementId}
     ${lock ? sql`for update of movement` : sql``}
  `,
      "objects",
    )
  )[0];
  const label = `document line ${line.lineNumber} (item ${line.itemId})`;
  if (!source || source.kind !== "issue" || source.status !== "posted") {
    throw new InventoryError(`${label} must reference a posted issue movement`);
  }
  if (source.is_reversed) {
    throw new InventoryError(
      `${label} references a reversed shipment; its stock was already restored by the reversal`,
    );
  }
  // A cross-subsidiary shipment left the fulfilling entity's stock on the
  // selling entity's order; its return is credited by the selling entity.
  const crossShipment =
    source.subsidiary_id !== subsidiaryId
      ? await crossSubsidiaryShipment(runner, orgId, source.id)
      : null;
  if (
    source.item_id !== line.itemId ||
    (source.subsidiary_id !== subsidiaryId && crossShipment?.sellingSubsidiaryId !== subsidiaryId)
  ) {
    throw new InventoryError(`${label} source shipment must match its item and legal entity`);
  }
  // A shipment with no source document (manual adjustment) names no
  // customer: crediting one for it refunds a customer that never received
  // the goods. Refuse by name — a commercial-only credit (no
  // inventory-return evidence) stays available for balance-forward stock.
  if (source.source_document_kind === null) {
    throw new InventoryError(
      `${label} source shipment has no sales document behind it — returns credit the customer that received the goods, ` +
        `so raise the credit without inventory-return evidence instead of returning balance-forward stock`,
    );
  }
  // Stock leaves on an invoice or a paid-at-sale cash sale (both combined
  // ship-and-bill) or on a shipment against the sales order; all three name
  // the customer that received the goods.
  if (
    source.source_document_kind !== "customer_invoice" &&
    source.source_document_kind !== "cash_sale" &&
    source.source_document_kind !== SALES_FULFILLMENT_DOCUMENT_KIND
  ) {
    throw new InventoryError(`${label} source shipment is attached to a non-sales document`);
  }
  // A walk-in cash sale and its refund both name no customer, so both-null
  // matches; anything else must return to the customer that received the
  // goods. Refunding a named customer's goods to nobody (or to someone else)
  // stays refused.
  if (source.source_customer_id !== customerId) {
    throw new InventoryError(`${label} source shipment belongs to a different customer`);
  }
  if (line.tracking === "lot_serial") {
    if (
      !line.selection.lotId ||
      !line.selection.serialId ||
      source.lot_id !== line.selection.lotId ||
      source.serial_id !== line.selection.serialId
    )
      throw new InventoryError(`${label} requires both identifiers matching its source shipment`);
  } else if (line.tracking === "lot") {
    if (!line.selection.lotId || line.selection.serialId) {
      throw new InventoryError(`${label} requires exactly one selected lot`);
    }
    if (source.lot_id !== line.selection.lotId) {
      throw new InventoryError(`${label} selected lot does not match its shipment`);
    }
  } else if (line.tracking === "serial") {
    if (!line.selection.serialId || line.selection.lotId) {
      throw new InventoryError(`${label} requires exactly one selected serial`);
    }
    if (source.serial_id !== line.selection.serialId) {
      throw new InventoryError(`${label} selected serial does not match its shipment`);
    }
  } else if (line.selection.lotId || line.selection.serialId) {
    throw new InventoryError(`${label} cannot select lot or serial evidence for an untracked item`);
  }
  // An issue movement stores a negative quantity; the shipped quantity is its
  // absolute value, and prior returns against it are positive receipts.
  // The already-returned total shares the picker's rule (unreversed posted
  // returns only): a return that was itself reversed is returnable again.
  const shipped = fromUnits(-toUnits(source.quantity));
  const alreadyReturned = await postedReturnQuantity(runner, orgId, {
    returnKind: "receipt",
    evidenceKey: "sourceIssueMovementId",
    sourceMovementId: source.id,
  });
  if (cmp(add(alreadyReturned, line.quantity), shipped) > 0) {
    throw new InventoryError(
      `${label} return quantity exceeds the unreturned quantity on its source shipment ` +
        `(${shipped} shipped, ${alreadyReturned} already returned)`,
    );
  }
  return { source, alreadyReturned };
}

/**
 * Cost to restore for this slice of a shipment.
 *
 * The units come back at the cost they LEFT at, not at today's cost: the sale
 * relieved a specific carried cost and the return puts that same cost back, so
 * a revaluation or a later cheaper purchase between shipment and return cannot
 * turn a return into a margin event. The credit's selling price is a separate
 * commercial fact and posts to revenue, never to inventory.
 *
 * Partial returns prorate by CUMULATIVE quantity rather than per-slice, so
 * several partial returns of one shipment restore exactly the shipment's total
 * value with no rounding drift and no residual stranded in inventory.
 */
export function restoredReturnCost(
  shippedQuantity: string,
  shippedValue: string,
  alreadyReturned: string,
  returning: string,
): string {
  const shipped = toUnits(shippedQuantity);
  if (shipped <= 0n) {
    throw new InventoryError("a shipment with no quantity cannot be returned");
  }
  const value = toUnits(shippedValue);
  const before = roundDiv(value * toUnits(alreadyReturned), shipped);
  const after = roundDiv(value * (toUnits(alreadyReturned) + toUnits(returning)), shipped);
  return fromUnits(after - before);
}

/** Fail before the document transaction when return evidence is incomplete.
 * The same checks run again under the inventory-position lock before mutation. */
export async function assertCustomerCreditInventoryReturnsPostable(
  runner: Runner,
  orgId: string,
  documentId: string,
  customerId: string | null,
  subsidiaryId: string,
): Promise<void> {
  const document = (
    await runner.execute<{ document_date: string }>(
      sql`
    select document_date::text as document_date from documents
     where org_id = ${orgId} and id = ${documentId}`,
      "objects",
    )
  )[0];
  const lines = [
    ...(await loadCustomerCreditInventoryReturnLines(runner, orgId, documentId, false)),
    ...(document
      ? await expandKitCustomerCreditReturnLines(runner, orgId, documentId, document.document_date)
      : []),
  ];
  for (const line of lines) {
    await validateCustomerReturnSource(runner, orgId, customerId, subsidiaryId, line, false);
  }
}

async function returnCustomerCreditInventoryLine(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  customerId: string | null,
  subsidiaryId: string,
  date: string,
  line: CustomerCreditInventoryReturnLine,
): Promise<void> {
  // Deliberately NOT fenced by assertItemsActive (see item-active.ts): every
  // return names a specific posted source shipment and is capped at its
  // unreturned quantity at the cost the units left at — it unwinds that
  // shipment rather than minting a new position, so it must stay possible
  // after deactivation (physical returns still happen for discontinued
  // items, and the books must record them).
  const profile = await resolveProfile(orgId, line.itemId, runner, true);
  assertTracking(
    profile,
    {
      quantity: line.quantity,
      lotId: line.selection.lotId,
      serialId: line.selection.serialId,
    },
    "return",
  );
  await validateTrackingSelection(
    runner,
    orgId,
    line.itemId,
    line.stockLocationId,
    profile,
    {
      quantity: line.quantity,
      lotId: line.selection.lotId,
      serialId: line.selection.serialId,
    },
    "customer_return",
  );
  const { source, alreadyReturned } = await validateCustomerReturnSource(
    runner,
    orgId,
    customerId,
    subsidiaryId,
    line,
    true,
  );
  const reversesMovementId =
    profile.tracking === "serial" || profile.tracking === "lot_serial" ? source.id : null;
  const reversalReason = reversesMovementId
    ? `Customer credit return of shipment ${reversesMovementId}`
    : null;
  const movementActorId = reversesMovementId && actorId === null ? SYSTEM_ACTOR_ID : actorId;
  // Goods return to the entity that shipped them. For a cross-subsidiary
  // shipment that is the fulfilling entity, not the crediting one.
  const holderId = source.subsidiary_id;
  const crossSubsidiary = holderId !== subsidiaryId;
  if (source.total_value == null) {
    throw new InventoryError(
      `document line ${line.lineNumber} (item ${line.itemId}) source shipment carries no recorded cost; ` +
        `restore the stock with Inventory Adjust instead, which prices it explicitly`,
    );
  }
  // An issue records a negative value; the cost relieved is its absolute value.
  const shippedValue = fromUnits(-toUnits(source.total_value));
  const shippedQuantity = fromUnits(-toUnits(source.quantity));
  const cost = restoredReturnCost(shippedQuantity, shippedValue, alreadyReturned, line.quantity);
  const quantity = persistReceiptMoney(line.quantity, "customer return quantity");

  // Under standard costing inventory must carry at the CURRENT standard, so a
  // standard revised between shipment and return cannot be restored at the old
  // one. The inventory leg takes the current standard, COGS is relieved by the
  // cost the sale actually recognized, and the difference is a purchase-price
  // variance — the same split receiveInventory applies to a priced receipt.
  const standardCost = profile.costingMethod === "standard" ? profile.standardCost : null;
  const inventoryValue = standardCost === null ? cost : extendCost(quantity, standardCost);
  const variance = fromUnits(toUnits(inventoryValue) - toUnits(cost));
  if (!isZero(variance) && !profile.varianceAccountId) {
    throw new InventoryError(
      `document line ${line.lineNumber} (item ${line.itemId}) needs an inventory variance account: ` +
        `its standard cost changed since the shipment, so the return carries ${variance} of variance`,
    );
  }

  const ctx = await loadSubsidiaryContext(runner, orgId);
  assertMovementOwner(ctx, holderId);
  await assertStockLocationAdmitsSubsidiary(
    runner,
    orgId,
    ctx,
    line.stockLocationId,
    holderId,
    "inbound",
  );
  const periodId = await periodForDate(orgId, date, runner);
  if (!periodId) throw new InventoryError(`no accounting period for ${date}`);
  const bookId = await primaryBookId(orgId, runner);
  const currency = await subsidiaryCurrency(orgId, holderId, runner);
  // The selling entity's dimensions stay with its own cross-charge; the
  // fulfilling entity's restore carries only its warehouse location.
  const dims = {
    departmentId: crossSubsidiary ? null : line.departmentId,
    projectId: crossSubsidiary ? null : line.projectId,
    // A return without an explicit line location arrives at the stock
    // location's business location, like the shipment it reverses.
    locationId: await stockLocationDim(
      runner,
      orgId,
      line.stockLocationId,
      crossSubsidiary ? null : line.locationId,
    ),
  };
  // DR inventory / CR cost of sales at the restored cost: the sale's COGS is
  // relieved by exactly what it recognized for these units.
  const journalLines: JournalLineInput[] = [
    {
      accountId: profile.assetAccountId,
      amount: inventoryValue,
      ...dims,
      memo: "Customer return at original cost",
    },
    {
      accountId: profile.cogsAccountId,
      amount: neg(cost),
      ...dims,
      memo: "Customer return at original cost",
    },
    ...(isZero(variance)
      ? []
      : [
          {
            accountId: profile.varianceAccountId!,
            amount: neg(variance),
            ...dims,
            memo: "Customer return standard-cost variance",
          },
        ]),
  ];
  await validateSubsidiaryRestrictions(runner, {
    orgId,
    ctx,
    docSubsidiaryId: holderId,
    lines: journalLines.map((journalLine) => ({ ...journalLine, subsidiaryId: holderId })),
  });
  const entryId = await postInventoryEntry(runner, {
    orgId,
    bookId,
    subsidiaryId: holderId,
    actorId,
    currency,
    periodId,
    date,
    entryNumber: `INV-CRETURN-${date}-${line.lineId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    memo: "Inventory return from customer",
    lines: journalLines,
  });

  const unitCost = fromUnits(roundDiv(toUnits(inventoryValue) * 10000n, toUnits(quantity)));
  const movement = (
    await runner.execute<{ id: string }>(
      sql`
    insert into inventory_movements
      (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id,
       lot_id, serial_id, quantity, unit_cost, total_value, document_line_id,
       journal_entry_id, idempotency_key, reverses_movement_id, reversal_reason,
       status, memo, created_by, updated_by)
    values
      (${orgId}, ${holderId}, ${line.itemId}, 'receipt', ${date},
       ${line.stockLocationId}, ${line.selection.lotId}, ${line.selection.serialId},
       ${quantity}, ${unitCost}, ${inventoryValue}, ${line.lineId}, ${entryId},
       ${line.kitItemId ? inventoryKitComponentReturnKey(line.lineId, line.itemId) : inventoryPostingEffectKey(line.lineId, "return")},
       ${reversesMovementId}, ${reversalReason}, 'posted',
       ${`Customer return of shipment ${line.selection.sourceIssueMovementId}`},
       ${movementActorId}, ${movementActorId})
    returning id
  `,
      "objects",
    )
  )[0]!;
  // The layer carries the EXACT restored value, never quantity × a rounded
  // unit cost: several partial returns of one shipment must put back exactly
  // what the shipment relieved, with no penny stranded in inventory.
  await addLayerAtCost(
    runner,
    orgId,
    holderId,
    line.itemId,
    line.stockLocationId,
    quantity,
    inventoryValue,
    profile.costingMethod,
    movement.id,
    date,
    actorId,
  );
  if (crossSubsidiary) {
    // The selling entity's cost of sales at the transfer price unwinds with
    // the units, through the same intercompany cross-charge in reverse.
    const handler = crossSubsidiaryFulfillmentHandler();
    if (!handler)
      throw new InventoryError("cross-subsidiary returns are not available in this installation");
    const credit = (
      await runner.execute<{ document_id: string }>(
        sql`
      select document_id from document_lines where org_id = ${orgId} and id = ${line.lineId}`,
        "objects",
      )
    )[0];
    await handler.returned(runner, {
      orgId,
      actorId,
      creditDocumentId: credit!.document_id,
      creditLineId: line.lineId,
      sourceIssueMovementId: source.id,
      returnMovementId: movement.id,
      quantity,
      date,
      sellingSubsidiaryId: subsidiaryId,
    });
  }
  if (profile.tracking === "serial" || profile.tracking === "lot_serial") {
    await runner.execute(sql`
      update serials
         set status = 'in_stock', current_stock_location_id = ${line.stockLocationId},
             updated_at = now(), updated_by = ${movementActorId}
       where id = ${line.selection.serialId} and org_id = ${orgId}
    `);
  }
}

/**
 * Restore every returned unit carried by a customer credit inside the caller's
 * document transaction. Position locks serialize returns with issues and other
 * returns; the stable line key makes post-effect replay exactly once.
 */
export async function applyCustomerCreditInventoryReturns(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  documentId: string,
  date: string,
  subsidiaryId: string,
): Promise<number> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return 0;
  const document = (
    await runner.execute<{
      kind: string;
      party_id: string | null;
    }>(
      sql`
    select kind, party_id from documents
     where org_id = ${orgId} and id = ${documentId}
  `,
      "objects",
    )
  )[0];
  if (!document || (document.kind !== "customer_credit" && document.kind !== "cash_refund")) {
    throw new InventoryError("inventory customer return requires a customer credit or cash refund");
  }
  // Evidence-less historical/migration credits remain financial documents; a
  // credit line only restores stock when it explicitly claims a return.
  // Matching on the item as well as the line keeps kit pseudo-lines honest:
  // one kit line restores one receipt per component, and a replay finds each.
  const lines = [
    ...(await loadCustomerCreditInventoryReturnLines(runner, orgId, documentId, false)),
    ...(await expandKitCustomerCreditReturnLines(runner, orgId, documentId, date)),
  ];
  for (const key of [
    ...new Set(lines.map((line) => `${line.itemId}:${line.stockLocationId}`)),
  ].sort()) {
    const separator = key.indexOf(":");
    await lockInventoryPosition(runner, key.slice(0, separator), key.slice(separator + 1));
  }
  let count = 0;
  for (const line of lines) {
    const seen = (
      await runner.execute(
        sql`
      select 1 from inventory_movements
       where org_id = ${orgId} and document_line_id = ${line.lineId}
         and item_id = ${line.itemId} and kind = 'receipt'
       limit 1
    `,
        "objects",
      )
    )[0];
    if (seen) continue;
    await returnCustomerCreditInventoryLine(
      runner,
      orgId,
      actorId,
      document.party_id,
      subsidiaryId,
      date,
      line,
    );
    count++;
  }
  return count;
}

/** Post-commit repair path for a historical/pending posting-effect row. */
export async function applyInventoryReturnsForCustomerCredit(
  orgId: string,
  actorId: string | null,
  documentId: string,
  date: string,
  subsidiaryId: string,
): Promise<number> {
  return db.transaction((tx) =>
    applyCustomerCreditInventoryReturns(tx, orgId, actorId, documentId, date, subsidiaryId),
  );
}
