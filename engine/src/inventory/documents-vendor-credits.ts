import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, cmp, isZero, neg } from "../money/money.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { SYSTEM_ACTOR_ID } from "../banking/banking.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { assertTracking, validateTrackingSelection } from "./tracking.ts";
import { assertStockLocationAdmitsSubsidiary, resolveProfile, assertMovementOwner, inventoryFeatureEnabled } from "./profile-policy.ts";
import { stockLocationDim, postInventoryEntry, type JournalLineInput } from "./journal.ts";
import { primaryBookId, periodForDate, subsidiaryCurrency, getOnHandWith, lockInventoryPosition, persistReceiptMoney } from "./position.ts";
import { consumeLayers, recordConsumptions } from "./cost-layers.ts";
import { type MovementResult } from "./movements.ts";
import { loadDocumentInventoryLines, inventoryPostingEffectKey, UUID_RE, isJsonRecord, type DocumentInventoryLine } from "./document-lines.ts";
import { postedReturnQuantity } from "./return-quantities.ts";
import { PURCHASE_RECEIPT_DOCUMENT_KIND } from "./documents-purchasing.ts";

export interface VendorCreditInventoryReturnSelection {
  /** Posted receipt movement whose purchase/physical provenance is returned. */
  sourceReceiptMovementId: string;
  /** Required for lot-tracked stock and forbidden for other tracking modes. */
  lotId: string | null;
  /** Required for serial-tracked stock and forbidden for other tracking modes. */
  serialId: string | null;
}

/**
 * Native vendor-return evidence is stored on the immutable posted credit line.
 * Keeping the originating receipt beside the commercial line makes the source
 * link durable even for moving-average stock, whose physical receipts blend
 * into one costing layer. Layer-consumption rows independently preserve the
 * exact carried-cost provenance relieved by the return.
 */
export function parseVendorCreditInventoryReturnSelection(
  custom: unknown,
  lineLabel = "vendor-credit inventory line",
): VendorCreditInventoryReturnSelection {
  const evidence = isJsonRecord(custom) ? custom.inventoryReturn : null;
  if (!isJsonRecord(evidence)) {
    throw new InventoryError(
      `${lineLabel} requires custom.inventoryReturn evidence`,
    );
  }
  const sourceReceiptMovementId = evidence.sourceReceiptMovementId;
  const lotId = evidence.lotId ?? null;
  const serialId = evidence.serialId ?? null;
  if (
    typeof sourceReceiptMovementId !== "string" ||
    !UUID_RE.test(sourceReceiptMovementId)
  ) {
    throw new InventoryError(
      `${lineLabel} requires a valid inventoryReturn.sourceReceiptMovementId`,
    );
  }
  if (lotId !== null && (typeof lotId !== "string" || !UUID_RE.test(lotId))) {
    throw new InventoryError(
      `${lineLabel} inventoryReturn.lotId must be a UUID`,
    );
  }
  if (
    serialId !== null &&
    (typeof serialId !== "string" || !UUID_RE.test(serialId))
  ) {
    throw new InventoryError(
      `${lineLabel} inventoryReturn.serialId must be a UUID`,
    );
  }
  return { sourceReceiptMovementId, lotId, serialId };
}

interface VendorCreditInventoryReturnLine extends DocumentInventoryLine {
  offsetAccountId: string;
  selection: VendorCreditInventoryReturnSelection;
}

async function loadVendorCreditInventoryReturnLines(
  runner: Runner,
  orgId: string,
  documentId: string,
  requireEvidence: boolean,
): Promise<VendorCreditInventoryReturnLine[]> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return [];
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  const returns: VendorCreditInventoryReturnLine[] = [];
  for (const line of lines) {
    const custom = isJsonRecord(line.custom) ? line.custom : null;
    if (!custom || !("inventoryReturn" in custom)) {
      if (!requireEvidence) continue;
      throw new InventoryError(
        `document line ${line.lineNumber} (item ${line.itemId}) requires custom.inventoryReturn evidence`,
      );
    }
    const offsetAccountId =
      line.varianceAccountId ?? line.adjustmentAccountId;
    if (!offsetAccountId) {
      throw new InventoryError(
        `document line ${line.lineNumber} (item ${line.itemId}) has no inventory variance or adjustment account`,
      );
    }
    returns.push({
      ...line,
      offsetAccountId,
      selection: parseVendorCreditInventoryReturnSelection(
        line.custom,
        `document line ${line.lineNumber} (item ${line.itemId})`,
      ),
    });
  }
  return returns;
}

interface SourceReceiptEvidence extends Record<string, unknown> {
  id: string;
  subsidiary_id: string;
  item_id: string;
  stock_location_id: string;
  lot_id: string | null;
  serial_id: string | null;
  quantity: string;
  kind: string;
  status: string;
  source_document_kind: string | null;
  source_vendor_id: string | null;
  is_reversed: boolean;
}

async function validateVendorReturnSource(
  runner: Runner,
  orgId: string,
  vendorId: string | null,
  subsidiaryId: string,
  line: VendorCreditInventoryReturnLine,
  lock: boolean,
): Promise<SourceReceiptEvidence> {
  const source = (await runner.execute<SourceReceiptEvidence>(sql`
    select movement.id, movement.subsidiary_id, movement.item_id,
           movement.stock_location_id, movement.lot_id, movement.serial_id,
           movement.quantity, movement.kind, movement.status,
           source_document.kind as source_document_kind,
           source_document.party_id as source_vendor_id,
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
       and movement.id = ${line.selection.sourceReceiptMovementId}
     ${lock ? sql`for update of movement` : sql``}
  `)).rows[0];
  const label = `document line ${line.lineNumber} (item ${line.itemId})`;
  if (!source || source.kind !== "receipt" || source.status !== "posted") {
    throw new InventoryError(
      `${label} must reference a posted receipt movement`,
    );
  }
  if (source.is_reversed) {
    throw new InventoryError(`${label} references a reversed receipt`);
  }
  if (
    source.item_id !== line.itemId ||
    source.stock_location_id !== line.stockLocationId ||
    source.subsidiary_id !== subsidiaryId
  ) {
    throw new InventoryError(
      `${label} source receipt must match its item, stock location, and legal entity`,
    );
  }
  if (source.source_document_kind !== null) {
    // Stock arrives either on the vendor bill (legacy bill-is-the-receipt) or
    // on a goods receipt against the purchase order; both name the vendor.
    if (
      source.source_document_kind !== "vendor_bill"
      && source.source_document_kind !== PURCHASE_RECEIPT_DOCUMENT_KIND
    ) {
      throw new InventoryError(
        `${label} source receipt is attached to a non-purchase document`,
      );
    }
    if (!vendorId || source.source_vendor_id !== vendorId) {
      throw new InventoryError(
        `${label} source receipt belongs to a different vendor`,
      );
    }
  }
  if (line.tracking === "lot") {
    if (!line.selection.lotId || line.selection.serialId) {
      throw new InventoryError(`${label} requires exactly one selected lot`);
    }
    if (source.lot_id !== line.selection.lotId) {
      throw new InventoryError(`${label} selected lot does not match its receipt`);
    }
  } else if (line.tracking === "serial") {
    if (!line.selection.serialId || line.selection.lotId) {
      throw new InventoryError(`${label} requires exactly one selected serial`);
    }
    if (source.serial_id !== line.selection.serialId) {
      throw new InventoryError(
        `${label} selected serial does not match its receipt`,
      );
    }
  } else if (line.selection.lotId || line.selection.serialId) {
    throw new InventoryError(
      `${label} cannot select lot or serial evidence for an untracked item`,
    );
  }
  // The already-returned total shares the picker's rule (unreversed posted
  // returns only, read as absolute values like the picker's remaining math),
  // so save, picker and post can never disagree on what is left to return.
  const allocated = await postedReturnQuantity(runner, orgId, {
    returnKind: "return",
    evidenceKey: "sourceReceiptMovementId",
    sourceMovementId: source.id,
  });
  if (cmp(add(allocated, line.quantity), source.quantity) > 0) {
    throw new InventoryError(
      `${label} return quantity exceeds the unreturned quantity on its source receipt`,
    );
  }
  return source;
}

/** Route an inventory return's commercial amount through the item's policy
 * account. The return journal debits that same account at carried cost, leaving
 * only purchase-price variance there while AP reflects the vendor credit. */
export async function resolveVendorCreditInventoryAccounts(
  runner: Runner,
  orgId: string,
  documentId: string,
): Promise<Map<string, string>> {
  const lines = await loadVendorCreditInventoryReturnLines(
    runner,
    orgId,
    documentId,
    true,
  );
  return new Map(lines.map((line) => [line.lineId, line.offsetAccountId]));
}

/** Fail before the document transaction when return evidence is incomplete.
 * The same checks run again under the inventory-position lock before mutation. */
export async function assertVendorCreditInventoryReturnsPostable(
  runner: Runner,
  orgId: string,
  documentId: string,
  vendorId: string | null,
  subsidiaryId: string,
): Promise<void> {
  const lines = await loadVendorCreditInventoryReturnLines(
    runner,
    orgId,
    documentId,
    true,
  );
  for (const line of lines) {
    await validateVendorReturnSource(
      runner,
      orgId,
      vendorId,
      subsidiaryId,
      line,
      false,
    );
  }
}

async function returnVendorCreditInventoryLine(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  vendorId: string | null,
  subsidiaryId: string,
  date: string,
  line: VendorCreditInventoryReturnLine,
): Promise<MovementResult> {
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
  const ctx = await loadSubsidiaryContext(runner, orgId);
  assertMovementOwner(ctx, subsidiaryId);
  await assertStockLocationAdmitsSubsidiary(
    runner,
    orgId,
    ctx,
    line.stockLocationId,
    subsidiaryId,
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
    "issue",
  );
  const sourceReceipt = await validateVendorReturnSource(
    runner,
    orgId,
    vendorId,
    subsidiaryId,
    line,
    true,
  );

  // A serial receipt is exactly one unit and can therefore be fully reversed
  // by this return. The serial lifecycle guard requires that exact source ->
  // reversal edge before it allows the serial to become returned. Lot returns
  // may be partial (and a source may be allocated by several credits), so they
  // deliberately keep their immutable document-line evidence without claiming
  // the source movement's one permitted reversal slot.
  const reversesMovementId =
    profile.tracking === "serial" ? sourceReceipt.id : null;
  const reversalReason = reversesMovementId
    ? `Vendor credit return of receipt ${reversesMovementId}`
    : null;
  // Reversal evidence is required to name an actor. A posting-effect replay
  // may be system initiated, in which case use the documented engine actor
  // rather than weakening the storage invariant with a null author.
  const movementActorId =
    reversesMovementId && actorId === null ? SYSTEM_ACTOR_ID : actorId;

  // Moving-average stock is one blended pool. Its immutable credit-line
  // evidence still identifies the commercial receipt, while the consumption
  // relieves the pool's actual carried cost. FIFO/standard returns select the
  // originating receipt's own layer and therefore cannot silently substitute
  // a different purchase lot at another cost.
  const sourceReceiptMovementId =
    profile.costingMethod === "moving_average"
      ? null
      : line.selection.sourceReceiptMovementId;
  const selection = {
    lotId: line.selection.lotId,
    serialId: line.selection.serialId,
    sourceReceiptMovementId,
    subsidiaryId,
  };
  const onHand = await getOnHandWith(
    runner,
    orgId,
    line.itemId,
    line.stockLocationId,
    selection,
  );
  if (cmp(line.quantity, onHand.quantity) > 0) {
    throw new InventoryError(
      `document line ${line.lineNumber} (item ${line.itemId}) cannot return ${line.quantity}; ` +
        `only ${onHand.quantity} remains on the selected receipt/layer`,
    );
  }
  const { cost, unitCost, consumptions, shortfallQuantity } =
    await consumeLayers(
      runner,
      orgId,
      profile,
      line.itemId,
      line.stockLocationId,
      line.quantity,
      onHand,
      onHand.unitCost,
      selection,
      subsidiaryId,
      movementActorId,
    );
  if (!isZero(shortfallQuantity)) {
    throw new InventoryError(
      `document line ${line.lineNumber} (item ${line.itemId}) would overconsume its selected cost layer`,
    );
  }

  const periodId = await periodForDate(orgId, date, runner);
  if (!periodId) throw new InventoryError(`no accounting period for ${date}`);
  const bookId = await primaryBookId(orgId, runner);
  const currency = await subsidiaryCurrency(orgId, subsidiaryId, runner);
  const dims = {
    departmentId: line.departmentId,
    projectId: line.projectId,
    // A return without an explicit line location leaves from the received
    // stock location, like the receipt it reverses.
    locationId: await stockLocationDim(runner, orgId, line.stockLocationId, line.locationId),
  };
  const journalLines: JournalLineInput[] = [
    {
      accountId: line.offsetAccountId,
      amount: cost,
      ...dims,
      memo: "Vendor return at carried cost",
    },
    {
      accountId: profile.assetAccountId,
      amount: neg(cost),
      ...dims,
      memo: "Vendor return at carried cost",
    },
  ];
  await validateSubsidiaryRestrictions(runner, {
    orgId,
    ctx,
    docSubsidiaryId: subsidiaryId,
    lines: journalLines.map((journalLine) => ({
      ...journalLine,
      subsidiaryId,
    })),
  });
  const entryId = await postInventoryEntry(runner, {
    orgId,
    bookId,
    subsidiaryId,
    actorId,
    currency,
    periodId,
    date,
    entryNumber: `INV-VRETURN-${date}-${line.lineId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    memo: "Inventory return to vendor",
    lines: journalLines,
  });

  const quantity = persistReceiptMoney(line.quantity, "vendor return quantity");
  const movement = (await runner.execute<{ id: string }>(sql`
    insert into inventory_movements
      (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id,
       lot_id, serial_id, quantity, unit_cost, total_value, document_line_id,
       journal_entry_id, idempotency_key, reverses_movement_id, reversal_reason,
       status, memo, created_by, updated_by)
    values
      (${orgId}, ${subsidiaryId}, ${line.itemId}, 'return', ${date},
       ${line.stockLocationId}, ${line.selection.lotId}, ${line.selection.serialId},
       ${neg(quantity)}, ${unitCost}, ${neg(cost)}, ${line.lineId}, ${entryId},
       ${inventoryPostingEffectKey(line.lineId, "return")}, ${reversesMovementId},
       ${reversalReason}, 'posted',
       ${`Vendor return of receipt ${line.selection.sourceReceiptMovementId}`},
       ${movementActorId}, ${movementActorId})
    returning id
  `)).rows[0]!;
  await recordConsumptions(
    runner,
    orgId,
    subsidiaryId,
    consumptions,
    movement.id,
    actorId,
  );
  if (profile.tracking === "serial") {
    await runner.execute(sql`
      update serials
         set status = 'returned', current_stock_location_id = null,
             updated_at = now(), updated_by = ${movementActorId}
       where id = ${line.selection.serialId} and org_id = ${orgId}
    `);
  }
  return { movementId: movement.id, entryId, value: neg(cost) };
}

/**
 * Apply every inventory return carried by a vendor credit inside the caller's
 * document transaction. Position locks serialize returns with issues and other
 * returns; the stable line key makes post-effect replay exactly once.
 */
export async function applyVendorCreditInventoryReturns(
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
  if (!document || document.kind !== "vendor_credit") {
    throw new InventoryError("inventory vendor return requires a vendor credit");
  }
  // Evidence-less historical/migration credits remain financial documents;
  // native posting preflight requires evidence on every inventory item line.
  const lines = await loadVendorCreditInventoryReturnLines(
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
         and kind = 'return'
       limit 1
    `)).rows[0];
    if (seen) continue;
    await returnVendorCreditInventoryLine(
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
export async function applyInventoryReturnsForVendorCredit(
  orgId: string,
  actorId: string | null,
  documentId: string,
  date: string,
  subsidiaryId: string,
): Promise<number> {
  return db.transaction((tx) =>
    applyVendorCreditInventoryReturns(
      tx,
      orgId,
      actorId,
      documentId,
      date,
      subsidiaryId,
    ),
  );
}
