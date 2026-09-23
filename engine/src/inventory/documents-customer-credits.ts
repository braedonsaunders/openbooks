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
  UUID_RE,
  isJsonRecord,
  type DocumentInventoryLine,
} from "./document-lines.ts";
import { postedReturnQuantity } from "./return-quantities.ts";

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
    !UUID_RE.test(sourceIssueMovementId)
  ) {
    throw new InventoryError(
      `${lineLabel} requires a valid inventoryReturn.sourceIssueMovementId`,
    );
  }
  if (lotId !== null && (typeof lotId !== "string" || !UUID_RE.test(lotId))) {
    throw new InventoryError(`${lineLabel} inventoryReturn.lotId must be a UUID`);
  }
  if (
    serialId !== null &&
    (typeof serialId !== "string" || !UUID_RE.test(serialId))
  ) {
    throw new InventoryError(
      `${lineLabel} inventoryReturn.serialId must be a UUID`,
    );
  }
  return { sourceIssueMovementId, lotId, serialId };
}

interface CustomerCreditInventoryReturnLine extends DocumentInventoryLine {
  selection: CustomerCreditInventoryReturnSelection;
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
    returns.push({
      ...line,
      selection: parseCustomerCreditInventoryReturnSelection(
        line.custom,
        `document line ${line.lineNumber} (item ${line.itemId})`,
      ),
    });
  }
  return returns;
}

interface SourceIssueEvidence extends Record<string, unknown> {
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
    source.stock_location_id !== line.stockLocationId ||
    source.subsidiary_id !== subsidiaryId
  ) {
    throw new InventoryError(
      `${label} source shipment must match its item, stock location, and legal entity`,
    );
  }
  if (source.source_document_kind !== null) {
    // Stock leaves either on the invoice (combined ship-and-bill) or on a
    // shipment against the sales order; both name the customer.
    if (
      source.source_document_kind !== "customer_invoice" &&
      source.source_document_kind !== SALES_FULFILLMENT_DOCUMENT_KIND
    ) {
      throw new InventoryError(
        `${label} source shipment is attached to a non-sales document`,
      );
    }
    if (!customerId || source.source_customer_id !== customerId) {
      throw new InventoryError(
        `${label} source shipment belongs to a different customer`,
      );
    }
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
  const lines = await loadCustomerCreditInventoryReturnLines(
    runner,
    orgId,
    documentId,
    false,
  );
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
       ${inventoryPostingEffectKey(line.lineId, "return")}, 'posted',
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
  if (!document || document.kind !== "customer_credit") {
    throw new InventoryError("inventory customer return requires a customer credit");
  }
  // Evidence-less historical/migration credits remain financial documents; a
  // credit line only restores stock when it explicitly claims a return.
  const lines = await loadCustomerCreditInventoryReturnLines(
    runner,
    orgId,
    documentId,
    false,
  );
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
         and kind = 'receipt'
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
