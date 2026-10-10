import { resolveAgencyPosting } from './drop-ship-agency.ts';
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, cmp, isZero, neg, toUnits } from "../money/money.ts";
import { extendCost, unitCostPerQuantity } from "./costing.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { assertDocumentLinesUntracked } from "./tracking.ts";
import { assertInventoryOffHoldsNoStock, assertMovementOwner, inventoryFeatureEnabled } from "./profile-policy.ts";
import { stockLocationDim, postInventoryEntry } from "./journal.ts";
import { primaryBookId, periodForDate, subsidiaryCurrency, lockInventoryPosition } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import { liveReceiptQuantity } from "./return-quantities.ts";
import { loadDocumentInventoryLines, unprofiledInventoryLines, assertNoUnprofiledInventoryLines, inventoryPostingEffectKey, isJsonRecord, type DocumentInventoryLine } from "./document-lines.ts";
import { kitLabel, kitNoStockRefusal } from "./kits.ts";
import { receivedNotBilledMissingMessage, resolveReceivedNotBilledAccount } from "../records/control-accounts.ts";
import { lineRequiresReceipt } from "../records/stock-receipt.ts";

/**
 * The received-not-billed account a line must clear, resolved through the
 * one authoritative policy (profile first, company control second). Throws
 * naming both configuration places when neither is set.
 */
async function requireLineRnbAccount(
  runner: SqlExecutor,
  orgId: string,
  line: DocumentInventoryLine,
  context: string,
): Promise<string> {
  const rnb = await resolveReceivedNotBilledAccount(runner, orgId, line.itemId);
  if (!rnb) {
    throw new InventoryError(
      `${context}: ${receivedNotBilledMissingMessage(`item ${line.itemId}`)}`,
    );
  }
  return rnb.accountId;
}

/**
 * lineId → the GL account a vendor bill's inventory line should DEBIT.
 * Purchase-order-matched lines clear received-not-billed (profile first,
 * company control second); every other inventory line debits its asset
 * account directly and brings its own stock in the drain below. A matched
 * line with no clearing account anywhere refuses naming both places instead
 * of debiting inventory. Consumed by the posting engine (posting.ts).
 */
export async function resolveBillInventoryAccounts(
  runner: Runner,
  orgId: string,
  documentId: string,
): Promise<Map<string, string>> {
  if (!(await inventoryFeatureEnabled(runner, orgId))) return new Map();
  const lines = await loadDocumentInventoryLines(runner, orgId, documentId);
  const map = new Map<string, string>();
  for (const l of lines) {
    if (
      lineRequiresReceipt(l.itemKind) &&
      billLinePurchaseOrderLineId(l.custom) !== null
    ) {
      map.set(
        l.lineId,
        await requireLineRnbAccount(
          runner,
          orgId,
          l,
          `document line ${l.lineNumber} (item ${l.itemId}) is matched to its purchase order`,
        ),
      );
      continue;
    }
    map.set(l.lineId, l.clearingAccountId ?? l.assetAccountId);
  }
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
  if (!(await inventoryFeatureEnabled(runner, orgId))) {
    await assertInventoryOffHoldsNoStock(runner as Runner, orgId,
      (await loadDocumentInventoryLines(runner as Runner, orgId, documentId)).map((line) => line.itemId), "bill");
    return;
  }
  assertNoUnprofiledInventoryLines(await unprofiledInventoryLines(runner, orgId, documentId));
  const agency = await resolveAgencyPosting(runner,orgId,documentId);
  const lines = (await loadDocumentInventoryLines(runner, orgId, documentId)).filter(line=>!agency.has(line.lineId));
  // Kits hold no stock: the post-commit receipt would die inside the drain
  // after the bill's journal has committed, so refuse before posting with
  // the components named as the receivable side.
  for (const line of lines) {
    if (line.itemKind !== "kit") continue;
    throw new InventoryError(
      kitNoStockRefusal(await kitLabel(runner, orgId, line.itemId), "receive") +
        ` (bill line ${line.lineNumber})`,
    );
  }
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
        await requireLineRnbAccount(
          runner,
          orgId,
          line,
          `standard-cost receipt of item ${line.itemId} books purchase price variance of ${variance}`,
        );
      }
    }
  }
  await assertManualBillLinesMatched(runner, orgId, lines);
}

/**
 * A vendor-bill line coded by hand for receipt-tracked stock must not bypass
 * three-way matching: billing it straight to the inventory asset and then
 * receiving the same stock on its purchase order counts it twice. When an
 * approved purchase order still holds that item open, refuse naming the
 * order — match the bill to its purchase-order line (or receive first)
 * instead. Direct counter purchases with no open order keep the legacy
 * bill-is-the-receipt path.
 */
async function assertManualBillLinesMatched(
  runner: SqlExecutor,
  orgId: string,
  lines: DocumentInventoryLine[],
): Promise<void> {
  const manual = lines.filter(
    (line) =>
      lineRequiresReceipt(line.itemKind) &&
      billLinePurchaseOrderLineId(line.custom) === null,
  );
  if (manual.length === 0) return;
  const open = (await runner.execute<{
    item_id: string;
    document_number: string;
    line_number: number;
  }>(sql`
    select dl.item_id, d.document_number, dl.line_number
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
     where dl.org_id = ${orgId}
       and d.kind = 'purchase_order'
       and d.status = 'approved'
       and dl.item_id in (${sql.join(
         [...new Set(manual.map((line) => line.itemId))].map(
           (itemId) => sql`${itemId}`,
         ),
         sql`, `,
       )})
       and (dl.quantity - dl.quantity_billed - dl.quantity_cancelled) > 0`));
  if (open.rows.length === 0) return;
  const byItem = new Map<string, { document_number: string; line_number: number }[]>();
  for (const row of open.rows) {
    const list = byItem.get(row.item_id) ?? [];
    list.push({ document_number: row.document_number, line_number: row.line_number });
    byItem.set(row.item_id, list);
  }
  const first = manual.find((line) => byItem.has(line.itemId))!;
  const orders = byItem.get(first.itemId)!;
  const [primary] = orders;
  const more =
    orders.length > 1 ? ` (and ${orders.length - 1} more open line${orders.length > 2 ? "s" : ""})` : "";
  throw new InventoryError(
    `vendor-bill line ${first.lineNumber} (item ${first.itemId}) is stock still open on purchase order ${primary!.document_number} line ${primary!.line_number}${more}: match the bill to its purchase-order line instead of coding it directly to the inventory asset — billing unmatched stock now and receiving it later counts it twice`,
  );
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
  if (!(await inventoryFeatureEnabled(runner, orgId))) {
    await assertInventoryOffHoldsNoStock(runner as Runner, orgId,
      (await loadDocumentInventoryLines(runner as Runner, orgId, documentId)).map((line) => line.itemId), "bill");
    return 0;
  }
  // Posted agency evidence survives later feature and configuration changes.
  // This drain owes no stock receipt for those immutable vendor-bill lines.
  const agency = new Set((await runner.execute<{id:string}>(sql`select document_line_id as id from drop_ship_agent_allocations where org_id=${orgId} and document_id=${documentId} and kind='vendor_bill'`)).rows.map(row=>row.id));
  const lines = (await loadDocumentInventoryLines(runner, orgId, documentId)).filter(line=>!agency.has(line.lineId));
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
 * Live stock a goods receipt (purchase_receipt document) still holds for a
 * purchase-order line: posted receipt movements on receipt lines whose
 * immutable evidence names that source line, each net of its posted
 * reversals through the shared live-receipt helper. A receipt the return
 * flow treats as dead nets to zero here, so the bill falls through to the
 * legacy bill-is-the-receipt path and brings the stock into layers instead
 * of clearing a variance against vanished stock. Null when nothing live
 * was received that way.
 */
async function purchaseReceiptCoverage(
  runner: SqlExecutor,
  orgId: string,
  purchaseOrderLineId: string,
): Promise<{ quantity: string; value: string } | null> {
  const receipts = (await runner.execute<{ id: string }>(sql`
    select m.id
      from inventory_movements m
      join document_lines rl on rl.id = m.document_line_id and rl.org_id = m.org_id
      join documents rd on rd.id = rl.document_id and rd.org_id = rl.org_id
     where m.org_id = ${orgId} and m.kind = 'receipt' and m.status = 'posted'
       and rd.kind = ${PURCHASE_RECEIPT_DOCUMENT_KIND}
       and rl.custom->'receipt'->>'sourceLineId' = ${purchaseOrderLineId}
  `)).rows;
  // One movement per receipt line in practice; each nets its own reversals
  // through the helper the vendor-return guard shares, so both readers
  // agree on what "received" means.
  let quantity = "0";
  let value = "0";
  for (const receipt of receipts) {
    const live = await liveReceiptQuantity(runner, orgId, receipt.id);
    quantity = add(quantity, live.quantity);
    value = add(value, live.value);
  }
  const dropShipConfirmations = (await runner.execute<{ quantity: string; value: string }>(sql`
    select rl.quantity::text as quantity, rl.amount::text as value
      from document_lines rl
      join documents rd on rd.id = rl.document_id and rd.org_id = rl.org_id
     where rl.org_id = ${orgId}
       and rd.kind = ${PURCHASE_RECEIPT_DOCUMENT_KIND}
       and rd.status in ('approved', 'posted')
       and rd.custom ? 'dropShipConfirmation'
       and rl.custom->'receipt'->>'sourceLineId' = ${purchaseOrderLineId}
  `)).rows;
  for (const confirmation of dropShipConfirmations) {
    quantity = add(quantity, confirmation.quantity);
    value = add(value, confirmation.value);
  }
  if (toUnits(quantity) <= 0n) return null;
  return { quantity, value };
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
  // The clearing account follows the one policy even when the profile is
  // blank: a company-level control still lets the bill clear what the
  // receipt credited.
  const clearingAccountId = await requireLineRnbAccount(
    runner,
    orgId,
    line,
    `document line ${line.lineNumber} (item ${line.itemId}) was received against its purchase order`,
  );
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
      { accountId: clearingAccountId, amount: neg(variance), ...dims, memo: "Received not billed" },
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
  // Resolved once per line up front so validation and posting agree on the
  // same account: a company-level control must reach the journal, not just
  // the pre-check.
  const clearingByLine = new Map<string, string>();
  for (const line of lines) {
    clearingByLine.set(
      line.lineId,
      await requireLineRnbAccount(
        runner,
        orgId,
        line,
        `goods-receipt line ${line.lineNumber} (item ${line.itemId}) cannot be received before its bill`,
      ),
    );
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
      offsetAccountId: clearingByLine.get(line.lineId)!,
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
