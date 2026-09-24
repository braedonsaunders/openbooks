import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, cmp, isZero, neg, toUnits } from "../money/money.ts";
import { extendCost, unitCostPerQuantity } from "./costing.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { assertDocumentLinesUntracked } from "./tracking.ts";
import { assertMovementOwner, inventoryFeatureEnabled } from "./profile-policy.ts";
import { stockLocationDim, postInventoryEntry } from "./journal.ts";
import { primaryBookId, periodForDate, subsidiaryCurrency, lockInventoryPosition } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import { loadDocumentInventoryLines, unprofiledInventoryLines, assertNoUnprofiledInventoryLines, inventoryPostingEffectKey, isJsonRecord, type DocumentInventoryLine } from "./document-lines.ts";

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
  if (!(await inventoryFeatureEnabled(runner, orgId))) return new Map();
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  const map = new Map<string, string>();
  for (const l of lines)
    map.set(l.lineId, l.clearingAccountId ?? l.assetAccountId);
  return map;
}

/**
 * A vendor bill may only post into a state its receipt effects can satisfy.
 * Document lines carry no lot or serial evidence, so a tracked line cannot be
 * received. A standard-cost variance likewise needs a received-not-billed
 * account. Reject either condition before the posting transaction writes.
 */
export async function assertBillReceiptsPostable(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<void> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return;
  assertNoUnprofiledInventoryLines(await unprofiledInventoryLines(runner, orgId, documentId));
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  if (lines.length === 0) return;
  assertDocumentLinesUntracked(lines, {
    movement: "receipt",
    carrier: "vendor-bill lines",
    remedy: "receive the goods on a goods receipt naming the lot or serial instead",
  });
  const profiles = (await runner.execute<{
    item_id: string;
    tracking: string;
    standard_cost: string | null;
  }>(sql`
    select item_id, tracking, standard_cost
      from item_inventory_profiles
     where org_id = ${orgId}
       and item_id in (${sql.join(lines.map((line) => sql`${line.itemId}`), sql`, `)})`));
  const byItem = new Map(profiles.rows.map((row) => [row.item_id, row]));
  for (const line of lines) {
    const profile = byItem.get(line.itemId);
    if (!profile) continue;
    if (line.costingMethod === "standard" && !line.clearingAccountId) {
      // Same exact math the receipt books: the extended amount less the
      // standard value is the variance, not quantity × a rounded rate. A
      // rounded precheck could pass a line the engine then refuses
      // post-commit — after the bill's GL has posted without stock.
      const standardUnitCost = profile.standard_cost
        ?? (isZero(line.quantity)
          ? "0"
          : unitCostPerQuantity(line.amount, line.quantity)!);
      const variance = add(
        line.amount,
        neg(extendCost(line.quantity, standardUnitCost)),
      );
      if (!isZero(variance)) {
        throw new InventoryError(
          `standard-cost receipt of item ${line.itemId} books purchase price variance of ${variance} but has no received-not-billed account`,
        );
      }
    }
  }
}

/**
 * Apply every inventory receipt a vendor bill owes in the caller's transaction.
 * All lines are one accounting unit: a failure on any line rolls the complete
 * set back. Stored movements make a replay idempotent per document line.
 */
export async function applyBillInventoryReceipts(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  documentId: string,
  billEntryId: string,
  date: string,
  subsidiaryId: string,
): Promise<number> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return 0;
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  for (const key of [
    ...new Set(
      lines.map((line) => `${line.itemId}:${line.stockLocationId}`),
    ),
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
      select 1 from inventory_movements where org_id = ${orgId} and document_line_id = ${line.lineId} and kind = 'receipt' limit 1`));
    if (seen.rows[0]) continue;
    // A bill line drawn from a purchase-order line that a goods receipt
    // already brought into stock must not receive it again: the receipt
    // credited received-not-billed at the order price, this bill debits it at
    // the invoiced price, and the difference is purchase price variance.
    const purchaseOrderLineId = billLinePurchaseOrderLineId(line.custom);
    if (purchaseOrderLineId) {
      const received = await purchaseReceiptCoverage(runner, orgId, purchaseOrderLineId);
      if (received) {
        await settleReceivedBillLineVariance(runner, orgId, actorId, line, received, date, subsidiaryId);
        count++;
        continue;
      }
    }
    // The bill already debited inventory at the line's extended amount: that
    // total is authoritative for the layer, never quantity × a rounded rate.
    await receiveInventory(orgId, actorId, {
      itemId: line.itemId,
      stockLocationId: line.stockLocationId,
      quantity: line.quantity,
      totalValue: line.amount,
      subsidiaryId,
      offsetAccountId: line.clearingAccountId ?? undefined,
      postJournal: line.clearingAccountId != null,
      linkEntryId: billEntryId,
      date,
      documentLineId: line.lineId,
      idempotencyKey: inventoryPostingEffectKey(line.lineId, "receipt"),
      memo: "Inventory receipt (bill)",
      tx: runner,
    });
    count++;
  }
  return count;
}

/** The purchase-order line a bill line was drawn from, from either writer's evidence. */
function billLinePurchaseOrderLineId(custom: unknown): string | null {
  if (!isJsonRecord(custom)) return null;
  const direct = custom.purchaseOrderLineId;
  if (typeof direct === "string" && direct) return direct;
  const capture = custom.apCaptureEvidence;
  if (isJsonRecord(capture) && typeof capture.purchaseOrderLineId === "string" && capture.purchaseOrderLineId) {
    return capture.purchaseOrderLineId;
  }
  return null;
}

/**
 * Stock a goods receipt (purchase_receipt document) already brought in for a
 * purchase-order line: posted receipt movements on receipt lines whose
 * immutable evidence names that source line. Null when nothing was received
 * that way, so the legacy bill-is-the-receipt path applies.
 */
async function purchaseReceiptCoverage(
  runner: SqlExecutor,
  orgId: string,
  purchaseOrderLineId: string,
): Promise<{ quantity: string; value: string } | null> {
  const row = (await runner.execute<{ quantity: string; value: string }>(sql`
    select coalesce(sum(m.quantity), 0)::text as quantity,
           coalesce(sum(m.total_value), 0)::text as value
      from inventory_movements m
      join document_lines rl on rl.id = m.document_line_id and rl.org_id = m.org_id
      join documents rd on rd.id = rl.document_id and rd.org_id = rl.org_id
     where m.org_id = ${orgId} and m.kind = 'receipt' and m.status = 'posted'
       and rd.kind = ${PURCHASE_RECEIPT_DOCUMENT_KIND}
       and rl.custom->'receipt'->>'sourceLineId' = ${purchaseOrderLineId}
  `)).rows[0];
  if (!row || toUnits(row.quantity) <= 0n) return null;
  return { quantity: row.quantity, value: row.value };
}

/**
 * A bill line for received stock debits received-not-billed at the invoiced
 * amount while the receipt credited it at the order price. Clear the
 * difference to the item's purchase price variance account so GRNI nets to
 * zero for the billed quantity. Deterministic entry number = idempotent on
 * replay; storage also refuses the duplicate under journal_entries_org_number.
 */
async function settleReceivedBillLineVariance(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  line: DocumentInventoryLine,
  received: { quantity: string; value: string },
  date: string,
  subsidiaryId: string,
): Promise<void> {
  if (!line.clearingAccountId) {
    throw new InventoryError(
      `document line ${line.lineNumber} (item ${line.itemId}) was received against its purchase order but the item has no received-not-billed account`,
    );
  }
  // A bill for exactly what was received clears at the received value
  // itself, never quantity × a rounded rate — otherwise received-not-billed
  // nets to a rounding penny instead of zero on non-terminating amounts.
  const expected =
    cmp(line.quantity, received.quantity) === 0
      ? received.value
      : extendCost(
          line.quantity,
          unitCostPerQuantity(received.value, received.quantity) ?? "0",
        );
  const variance = add(line.amount, neg(expected));
  if (isZero(variance)) return;
  if (!line.varianceAccountId) {
    throw new InventoryError(
      `document line ${line.lineNumber} (item ${line.itemId}) bills ${line.amount} for stock received at ${expected}; the item has no purchase price variance account to carry the ${variance} difference`,
    );
  }
  const entryNumber = `INV-PPV-${line.lineId}`;
  const existing = (await runner.execute(sql`
    select 1 from journal_entries where org_id = ${orgId} and entry_number = ${entryNumber} limit 1`));
  if (existing.rows[0]) return;
  const period = await periodForDate(orgId, date, runner);
  if (!period) throw new InventoryError(`no accounting period for ${date}`);
  const bookId = await primaryBookId(orgId, runner);
  const currency = await subsidiaryCurrency(orgId, subsidiaryId, runner);
  const dims = {
    departmentId: line.departmentId,
    projectId: line.projectId,
    // Document lines without an explicit location inherit the received stock
    // location, matching direct receipts.
    locationId: await stockLocationDim(runner, orgId, line.stockLocationId, line.locationId),
  };
  await postInventoryEntry(runner, {
    orgId,
    bookId,
    subsidiaryId,
    actorId,
    currency,
    periodId: period,
    date,
    entryNumber,
    memo: "Purchase price variance (bill vs goods receipt)",
    lines: [
      { accountId: line.varianceAccountId, amount: variance, ...dims, memo: "PPV" },
      { accountId: line.clearingAccountId, amount: neg(variance), ...dims, memo: "Received not billed" },
    ],
  });
}

export const PURCHASE_RECEIPT_DOCUMENT_KIND = "purchase_receipt";

function purchaseReceiptEvidence(
  line: DocumentInventoryLine,
): { sourceLineId: string; lotId: string | null; serialId: string | null } {
  const evidence = isJsonRecord(line.custom) ? line.custom.receipt : null;
  const label = `goods-receipt line ${line.lineNumber} (item ${line.itemId})`;
  if (!isJsonRecord(evidence) || typeof evidence.sourceLineId !== "string" || !evidence.sourceLineId) {
    throw new InventoryError(`${label} requires immutable receipt evidence`);
  }
  const lotId = evidence.lotId ?? null;
  const serialId = evidence.serialId ?? null;
  if (lotId !== null && typeof lotId !== "string") throw new InventoryError(`${label} has malformed lot evidence`);
  if (serialId !== null && typeof serialId !== "string") throw new InventoryError(`${label} has malformed serial evidence`);
  return { sourceLineId: evidence.sourceLineId, lotId, serialId };
}

/**
 * Bring a goods receipt (purchase_receipt document) into stock: one receipt
 * movement per line at the order price, DR inventory / CR received-not-billed.
 * The vendor bill later debits received-not-billed instead of receiving the
 * stock again (see applyBillInventoryReceipts). Every line must name a
 * received-not-billed account: receiving before billing has no other GL home.
 */
export async function applyPurchaseReceiptInventory(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  documentId: string,
  date: string,
  subsidiaryId: string | null,
): Promise<number> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) {
    throw new InventoryError("Inventory is disabled");
  }
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  if (lines.length === 0) throw new InventoryError("a goods receipt must carry at least one stock line");
  const ctx = await loadSubsidiaryContext(runner, orgId);
  const movementSubsidiaryId = subsidiaryId ?? ctx.rootId;
  assertMovementOwner(ctx, movementSubsidiaryId);
  for (const line of lines) {
    if (!line.clearingAccountId) {
      throw new InventoryError(
        `goods-receipt line ${line.lineNumber} (item ${line.itemId}) cannot be received before its bill: the item has no received-not-billed account`,
      );
    }
  }
  for (const key of [
    ...new Set(lines.map((line) => `${line.itemId}:${line.stockLocationId}`)),
  ].sort()) {
    const separator = key.indexOf(":");
    await lockInventoryPosition(runner, key.slice(0, separator), key.slice(separator + 1));
  }
  let count = 0;
  for (const line of lines) {
    const seen = (await runner.execute(sql`
      select 1 from inventory_movements
       where org_id = ${orgId} and document_line_id = ${line.lineId} and kind = 'receipt'
       limit 1`));
    if (seen.rows[0]) continue;
    const evidence = purchaseReceiptEvidence(line);
    await receiveInventory(orgId, actorId, {
      itemId: line.itemId,
      stockLocationId: line.stockLocationId,
      quantity: line.quantity,
      totalValue: line.amount,
      subsidiaryId: movementSubsidiaryId,
      offsetAccountId: line.clearingAccountId!,
      postJournal: true,
      date,
      documentLineId: line.lineId,
      idempotencyKey: inventoryPostingEffectKey(line.lineId, "receipt"),
      lotId: evidence.lotId,
      serialId: evidence.serialId,
      departmentId: line.departmentId,
      projectId: line.projectId,
      locationId: line.locationId,
      memo: "Inventory receipt (goods receipt)",
      tx: runner,
    });
    count++;
  }
  return count;
}

/**
 * Post-commit drain for historical pending rows. New postings apply receipts
 * inside their accounting transaction; a replay applies any missing receipts
 * together and skips those already stored.
 */
export async function applyInventoryReceiptsForBill(
  orgId: string,
  actorId: string | null,
  documentId: string,
  billEntryId: string,
  date: string,
  subsidiaryId: string,
): Promise<number> {
  return db.transaction((tx) =>
    applyBillInventoryReceipts(
      tx,
      orgId,
      actorId,
      documentId,
      billEntryId,
      date,
      subsidiaryId,
    ),
  );
}
