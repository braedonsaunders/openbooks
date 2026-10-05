import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, cmp, fromUnits, isZero, neg, roundDiv, toUnits } from "../money/money.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
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
import { extendCost } from "./costing.ts";
import { stockLocationDim, postInventoryEntry, type JournalLineInput } from "./journal.ts";
import {
  loadDocumentInventoryLines,
  inventoryPostingEffectKey,
  isJsonRecord,
  type DocumentInventoryLine,
} from "./document-lines.ts";
import { postedReturnQuantity } from "./return-quantities.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  inventoryKitComponentReturnKey,
  kitComponentMovesStock,
  kitComponentQuantities,
  kitLabel,
  loadKitComponents,
  parseKitComponentReturnSources,
} from "./kits.ts";

/**
 * Immutable operational document created when stock physically leaves on a
 * sales order. Mirrors PURCHASE_RECEIPT_DOCUMENT_KIND on the buy side; the
 * client-side spelling lives in web/lib/order-kinds.ts.
 */
export const SALES_FULFILLMENT_DOCUMENT_KIND = "sales_fulfillment";

export interface CustomerCreditInventoryReturnSelection {
  /** Posted issue movement whose sale is being returned. */
  sourceIssueMovementId: string;
  /** Required for lot-tracked stock and forbidden for other tracking modes. */
  lotId: string | null;
  /** Required for serial-tracked stock and forbidden for other tracking modes. */
  serialId: string | null;
}

/**
 * Native sales-return evidence is stored on the immutable posted credit line,
 * naming the issue movement whose units are coming back. The issue is what
 * carries the cost the return must restore, so the link is the valuation
 * evidence as well as the provenance.
 */
export function parseCustomerCreditInventoryReturnSelection(
  custom: unknown,
  lineLabel = "customer-credit inventory line",
): CustomerCreditInventoryReturnSelection {
  const evidence = isJsonRecord(custom) ? custom.inventoryReturn : null;
  if (!isJsonRecord(evidence)) {
    throw new InventoryError(
      `${lineLabel} requires custom.inventoryReturn evidence`,
    );
  }
  const sourceIssueMovementId = evidence.sourceIssueMovementId;
  const lotId = evidence.lotId ?? null;
  const serialId = evidence.serialId ?? null;
  if (
    typeof sourceIssueMovementId !== "string" ||
    !isUuid(sourceIssueMovementId)
  ) {
    throw new InventoryError(
      `${lineLabel} requires a valid inventoryReturn.sourceIssueMovementId`,
    );
  }
  if (lotId !== null && !isUuid(lotId)) {
    throw new InventoryError(`${lineLabel} inventoryReturn.lotId must be a UUID`);
  }
  if (
    serialId !== null &&
    !isUuid(serialId)
  ) {
    throw new InventoryError(
      `${lineLabel} inventoryReturn.serialId must be a UUID`,
    );
  }
  return { sourceIssueMovementId, lotId, serialId };
}

interface CustomerCreditInventoryReturnLine extends DocumentInventoryLine {
  selection: CustomerCreditInventoryReturnSelection;
  /** Set on kit-exploded pseudo-lines: the kit item the return was raised on. */
  kitItemId: string | null;
}

async function loadCustomerCreditInventoryReturnLines(
  runner: Runner,
  orgId: string,
  documentId: string,
  requireEvidence: boolean,
): Promise<CustomerCreditInventoryReturnLine[]> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return [];
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  const returns: CustomerCreditInventoryReturnLine[] = [];
  for (const line of lines) {
    const custom = isJsonRecord(line.custom) ? line.custom : null;
    if (!custom || !("inventoryReturn" in custom)) {
      // A credit memo may legitimately carry no stock at all (a price
      // concession, a goodwill credit). Only lines that CLAIM a return are
      // held to the evidence contract at posting time.
      if (!requireEvidence) continue;
      throw new InventoryError(
        `document line ${line.lineNumber} (item ${line.itemId}) requires custom.inventoryReturn evidence`,
      );
    }
    // Kit lines never return themselves: they expand into one pseudo-line
    // per component below, each naming its own source issue movement.
    if (line.itemKind === "kit") continue;
    returns.push({
      ...line,
      kitItemId: null,
      selection: parseCustomerCreditInventoryReturnSelection(
        line.custom,
        `document line ${line.lineNumber} (item ${line.itemId})`,
      ),
    });
  }
  return returns;
}

/**
 * Expand kit credit lines into one return pseudo-line per component. A kit
 * sale issues one movement per stocked component, so a kit return names one
 * source issue movement per stocked component and restores each at the cost
 * its units left at. Non-stocked recipe lines never moved, so they name no
 * source and settle in money only. Component quantities re-derive from the
 * kit line exactly as the shipment derived them (line quantity × quantity
 * per), and every component returns to the credit line's own stock location
 * — the one place a credit line can name, and the location the operator
 * chose for the physical return.
 */
async function expandKitCustomerCreditReturnLines(
  runner: Runner,
  orgId: string,
  documentId: string,
  date: string,
): Promise<CustomerCreditInventoryReturnLine[]> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return [];
  const lines = (await loadDocumentInventoryLines(runner, orgId, documentId))
    .filter((line) => line.itemKind === "kit");
  const returns: CustomerCreditInventoryReturnLine[] = [];
  for (const line of lines) {
    const custom = isJsonRecord(line.custom) ? line.custom : null;
    // A kit line without return evidence is a commercial-only credit, like
    // any other evidence-less line: it reverses revenue and restores nothing.
    if (!custom || !("inventoryReturn" in custom)) continue;
    const lineLabel = `document line ${line.lineNumber} (kit ${await kitLabel(runner, orgId, line.itemId)})`;
    const topEvidence = custom.inventoryReturn;
    if (isJsonRecord(topEvidence) && (topEvidence.lotId != null || topEvidence.serialId != null)) {
      throw new InventoryError(
        `${lineLabel} names a lot or serial on the kit; choose lots and serials per component in inventoryReturn.kitComponents instead`,
      );
    }
    const sources = parseKitComponentReturnSources(line.custom, lineLabel);
    const components = await loadKitComponents(runner, orgId, line.itemId, date);
    if (sources.length > components.length) {
      throw new InventoryError(
        `${lineLabel} names ${sources.length} source shipments ` +
          `but kit ${await kitLabel(runner, orgId, line.itemId)} has ${components.length} components ` +
          `effective on ${date}; return every component at most once`,
      );
    }
    const seenSources = new Set<string>();
    for (const source of sources) {
      if (seenSources.has(source.sourceIssueMovementId)) {
        throw new InventoryError(`${lineLabel} names source shipment ${source.sourceIssueMovementId} twice`);
      }
      seenSources.add(source.sourceIssueMovementId);
    }
    const quantities = new Map(
      kitComponentQuantities(await kitLabel(runner, orgId, line.itemId), line.quantity, components)
        .map((entry) => [entry.componentItemId, entry.quantity]),
    );
    const sourceByComponent = new Map<string, { sourceIssueMovementId: string; lotId: string | null; serialId: string | null }>();
    const usedComponents = new Set<string>();
    for (const source of sources) {
      // The source must be a component issue of THIS kit's own sale: its
      // document line carries the kit item, so a standalone sale of the
      // same component can never price this kit's return.
      const movement = (await runner.execute<{ item_id: string }>(sql`
        select movement.item_id
          from inventory_movements movement
          join document_lines source_line
            on source_line.id = movement.document_line_id
           and source_line.org_id = movement.org_id
         where movement.org_id = ${orgId} and movement.id = ${source.sourceIssueMovementId}
           and source_line.item_id = ${line.itemId}`)).rows[0];
      if (!movement || !quantities.has(movement.item_id) || usedComponents.has(movement.item_id)) {
        throw new InventoryError(
          `${lineLabel} source shipment ${source.sourceIssueMovementId} is not an unclaimed component issue of this kit return`,
        );
      }
      usedComponents.add(movement.item_id);
      sourceByComponent.set(movement.item_id, source);
    }
    for (const component of components) {
      const source = sourceByComponent.get(component.componentItemId);
      if (!source) {
        // The sale never moved a non-stocked recipe line, so there is no
        // source to name and nothing to restore: it settles in money only.
        // A stocked component without a source is a half-return — refuse by
        // name instead of restoring its siblings and losing it.
        if (kitComponentMovesStock(component.componentKind)) {
          throw new InventoryError(
            `${lineLabel} names no source shipment for stocked component ` +
              `${await kitLabel(runner, orgId, component.componentItemId)}; return every stocked component together`,
          );
        }
        continue;
      }
      // The component's own tracking governs its return evidence: a tracked
      // component without its lot or serial is refused by the same source
      // validation as a direct return, before anything posts.
      const profile = await resolveProfile(orgId, component.componentItemId, runner);
      returns.push({
        ...line,
        itemId: component.componentItemId,
        itemKind: "kit-component",
        quantity: quantities.get(component.componentItemId)!,
        tracking: profile.tracking,
        kitItemId: line.itemId,
        selection: {
          sourceIssueMovementId: source.sourceIssueMovementId,
          lotId: source.lotId,
          serialId: source.serialId,
        },
      });
    }
  }
  return returns;
}

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
}

async function validateCustomerReturnSource(
  runner: Runner,
  orgId: string,
  customerId: string | null,
  subsidiaryId: string,
  line: CustomerCreditInventoryReturnLine,
  lock: boolean,
): Promise<{ source: SourceIssueEvidence; alreadyReturned: string }> {
  const source = (await runner.execute<SourceIssueEvidence>(sql`
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
  `)).rows[0];
  const label = `document line ${line.lineNumber} (item ${line.itemId})`;
  if (!source || source.kind !== "issue" || source.status !== "posted") {
    throw new InventoryError(`${label} must reference a posted issue movement`);
  }
  if (source.is_reversed) {
    throw new InventoryError(
      `${label} references a reversed shipment; its stock was already restored by the reversal`,
    );
  }
  if (
    source.item_id !== line.itemId ||
    source.subsidiary_id !== subsidiaryId
  ) {
    throw new InventoryError(
      `${label} source shipment must match its item and legal entity`,
    );
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
    throw new InventoryError(
      `${label} source shipment is attached to a non-sales document`,
    );
  }
  // A walk-in cash sale and its refund both name no customer, so both-null
  // matches; anything else must return to the customer that received the
  // goods. Refunding a named customer's goods to nobody (or to someone else)
  // stays refused.
  if (source.source_customer_id !== customerId) {
    throw new InventoryError(
      `${label} source shipment belongs to a different customer`,
    );
  }
  if (line.tracking === "lot") {
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
      throw new InventoryError(
        `${label} selected serial does not match its shipment`,
      );
    }
  } else if (line.selection.lotId || line.selection.serialId) {
    throw new InventoryError(
      `${label} cannot select lot or serial evidence for an untracked item`,
    );
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
  const document = (await runner.execute<{ document_date: string }>(sql`
    select document_date::text as document_date from documents
     where org_id = ${orgId} and id = ${documentId}`)).rows[0];
  const lines = [
    ...(await loadCustomerCreditInventoryReturnLines(runner, orgId, documentId, false)),
    ...(document
      ? await expandKitCustomerCreditReturnLines(runner, orgId, documentId, document.document_date)
      : []),
  ];
  for (const line of lines) {
    await validateCustomerReturnSource(
      runner,
      orgId,
      customerId,
      subsidiaryId,
      line,
      false,
    );
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
    "receipt",
  );
  const { source, alreadyReturned } = await validateCustomerReturnSource(
    runner,
    orgId,
    customerId,
    subsidiaryId,
    line,
    true,
  );
  if (source.total_value == null) {
    throw new InventoryError(
      `document line ${line.lineNumber} (item ${line.itemId}) source shipment carries no recorded cost; ` +
        `restore the stock with Inventory Adjust instead, which prices it explicitly`,
    );
  }
  // An issue records a negative value; the cost relieved is its absolute value.
  const shippedValue = fromUnits(-toUnits(source.total_value));
  const shippedQuantity = fromUnits(-toUnits(source.quantity));
  const cost = restoredReturnCost(
    shippedQuantity,
    shippedValue,
    alreadyReturned,
    line.quantity,
  );
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
  assertMovementOwner(ctx, subsidiaryId);
  await assertStockLocationAdmitsSubsidiary(
    runner,
    orgId,
    ctx,
    line.stockLocationId,
    subsidiaryId,
    "inbound",
  );
  const periodId = await periodForDate(orgId, date, runner);
  if (!periodId) throw new InventoryError(`no accounting period for ${date}`);
  const bookId = await primaryBookId(orgId, runner);
  const currency = await subsidiaryCurrency(orgId, subsidiaryId, runner);
  const dims = {
    departmentId: line.departmentId,
    projectId: line.projectId,
    // A return without an explicit line location arrives at the stock
    // location's business location, like the shipment it reverses.
    locationId: await stockLocationDim(runner, orgId, line.stockLocationId, line.locationId),
  };
  // DR inventory / CR cost of sales at the restored cost: the sale's COGS is
  // relieved by exactly what it recognized for these units.
  const journalLines: JournalLineInput[] = [
    { accountId: profile.assetAccountId, amount: inventoryValue, ...dims, memo: "Customer return at original cost" },
    { accountId: profile.cogsAccountId, amount: neg(cost), ...dims, memo: "Customer return at original cost" },
    ...(isZero(variance)
      ? []
      : [{ accountId: profile.varianceAccountId!, amount: neg(variance), ...dims, memo: "Customer return standard-cost variance" }]),
  ];
  await validateSubsidiaryRestrictions(runner, {
    orgId,
    ctx,
    docSubsidiaryId: subsidiaryId,
    lines: journalLines.map((journalLine) => ({ ...journalLine, subsidiaryId })),
  });
  const entryId = await postInventoryEntry(runner, {
    orgId,
    bookId,
    subsidiaryId,
    actorId,
    currency,
    periodId,
    date,
    entryNumber: `INV-CRETURN-${date}-${line.lineId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    memo: "Inventory return from customer",
    lines: journalLines,
  });

  const unitCost = fromUnits(roundDiv(toUnits(inventoryValue) * 10000n, toUnits(quantity)));
  const movement = (await runner.execute<{ id: string }>(sql`
    insert into inventory_movements
      (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id,
       lot_id, serial_id, quantity, unit_cost, total_value, document_line_id,
       journal_entry_id, idempotency_key, status, memo, created_by, updated_by)
    values
      (${orgId}, ${subsidiaryId}, ${line.itemId}, 'receipt', ${date},
       ${line.stockLocationId}, ${line.selection.lotId}, ${line.selection.serialId},
       ${quantity}, ${unitCost}, ${inventoryValue}, ${line.lineId}, ${entryId},
       ${line.kitItemId ? inventoryKitComponentReturnKey(line.lineId, line.itemId) : inventoryPostingEffectKey(line.lineId, "return")}, 'posted',
       ${`Customer return of shipment ${line.selection.sourceIssueMovementId}`},
       ${actorId}, ${actorId})
    returning id
  `)).rows[0]!;
  // The layer carries the EXACT restored value, never quantity × a rounded
  // unit cost: several partial returns of one shipment must put back exactly
  // what the shipment relieved, with no penny stranded in inventory.
  await addLayerAtCost(
    runner,
    orgId,
    subsidiaryId,
    line.itemId,
    line.stockLocationId,
    quantity,
    inventoryValue,
    profile.costingMethod,
    movement.id,
    date,
    actorId,
  );
  if (profile.tracking === "serial") {
    await runner.execute(sql`
      update serials
         set status = 'in_stock', current_stock_location_id = ${line.stockLocationId},
             updated_at = now(), updated_by = ${actorId}
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
  const document = (await runner.execute<{
    kind: string;
    party_id: string | null;
  }>(sql`
    select kind, party_id from documents
     where org_id = ${orgId} and id = ${documentId}
  `)).rows[0];
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
    await lockInventoryPosition(
      runner,
      key.slice(0, separator),
      key.slice(separator + 1),
    );
  }
  let count = 0;
  for (const line of lines) {
    const seen = (await runner.execute(sql`
      select 1 from inventory_movements
       where org_id = ${orgId} and document_line_id = ${line.lineId}
         and item_id = ${line.itemId} and kind = 'receipt'
       limit 1
    `)).rows[0];
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
    applyCustomerCreditInventoryReturns(
      tx,
      orgId,
      actorId,
      documentId,
      date,
      subsidiaryId,
    ),
  );
}
