import { resolveAgencyPosting } from "./drop-ship-agency.ts";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, cmp, isZero, mulRate, neg } from "../money/money.ts";
import { toQuantityUnits } from "../money/quantity.ts";
import { extendCost, unitCostPerQuantity } from "./costing.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { assertDocumentLinesUntracked } from "./tracking.ts";
import {
  assertInventoryOffHoldsNoStock,
  assertMovementOwner,
  inventoryFeatureEnabled,
} from "./profile-policy.ts";
import { stockLocationDim, postInventoryEntry } from "./journal.ts";
import {
  primaryBookId,
  periodForDate,
  subsidiaryCurrency,
  lockInventoryPosition,
} from "./position.ts";
import { receiveInventory } from "./movements.ts";
import {
  loadDocumentInventoryLines,
  unprofiledInventoryLines,
  assertNoUnprofiledInventoryLines,
  inventoryPostingEffectKey,
  isJsonRecord,
  type DocumentInventoryLine,
} from "./document-lines.ts";
import { kitLabel, kitNoStockRefusal } from "./kits.ts";
import {
  billLinePurchaseOrderLineId,
  livePurchaseOrderLineReceipts,
} from "./bill-matchable-lines.ts";
import { assertManualBillLinesMatched } from "./bill-order-matching.ts";
import {
  receivedNotBilledMissingMessage,
  resolveReceivedNotBilledAccount,
} from "../records/control-accounts.ts";
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
    if (lineRequiresReceipt(l.itemKind) && billLinePurchaseOrderLineId(l.custom) !== null) {
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
    await assertInventoryOffHoldsNoStock(
      runner as Runner,
      orgId,
      (await loadDocumentInventoryLines(runner as Runner, orgId, documentId)).map(
        (line) => line.itemId,
      ),
      "bill",
    );
    return;
  }
  assertNoUnprofiledInventoryLines(await unprofiledInventoryLines(runner, orgId, documentId));
  const agency = await resolveAgencyPosting(runner, orgId, documentId);
  const lines = (await loadDocumentInventoryLines(runner, orgId, documentId)).filter(
    (line) => !agency.has(line.lineId),
  );
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
  const profiles = await runner.execute<{
    item_id: string;
    tracking: string;
    standard_cost: string | null;
  }>(
    sql`
    select item_id, tracking, standard_cost
      from item_inventory_profiles
     where org_id = ${orgId}
       and item_id in (${sql.join(
         lines.map((line) => sql`${line.itemId}`),
         sql`, `,
       )})`,
    "objects",
  );
  const byItem = new Map(profiles.map((row) => [row.item_id, row]));
  for (const line of lines) {
    const functionalAmount = mulRate(line.amount, line.fxRate);
    const profile = byItem.get(line.itemId);
    if (!profile) continue;
    if (line.costingMethod === "standard" && !line.clearingAccountId) {
      // Same exact math the receipt books: the extended amount less the
      // standard value is the variance, not quantity × a rounded rate. A
      // rounded precheck could pass a line the engine then refuses
      // post-commit — after the bill's GL has posted without stock.
      const standardUnitCost =
        profile.standard_cost ??
        (isZero(line.quantity) ? "0" : unitCostPerQuantity(functionalAmount, line.quantity)!);
      const variance = add(functionalAmount, neg(extendCost(line.quantity, standardUnitCost)));
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
  await assertManualBillLinesMatched(runner, orgId, documentId, lines);
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
    await assertInventoryOffHoldsNoStock(
      runner as Runner,
      orgId,
      (await loadDocumentInventoryLines(runner as Runner, orgId, documentId)).map(
        (line) => line.itemId,
      ),
      "bill",
    );
    return 0;
  }
  // Posted agency evidence survives later feature and configuration changes.
  // This drain owes no stock receipt for those immutable vendor-bill lines.
  const agency = new Set(
    (
      await runner.execute<{ id: string }>(
        sql`select document_line_id as id from drop_ship_agent_allocations where org_id=${orgId} and document_id=${documentId} and kind='vendor_bill'`,
        "objects",
      )
    ).map((row) => row.id),
  );
  const lines = (await loadDocumentInventoryLines(runner, orgId, documentId)).filter(
    (line) => !agency.has(line.lineId),
  );
  for (const key of [
    ...new Set(lines.map((line) => `${line.itemId}:${line.stockLocationId}`)),
  ].sort()) {
    const separator = key.indexOf(":");
    await lockInventoryPosition(runner, key.slice(0, separator), key.slice(separator + 1));
  }
  let count = 0;
  for (const line of lines) {
    const seen = await runner.execute(
      sql`
      select 1 from inventory_movements where org_id = ${orgId} and document_line_id = ${line.lineId} and kind = 'receipt' limit 1`,
      "objects",
    );
    if (seen[0]) continue;
    // A bill line drawn from a purchase-order line that a goods receipt
    // already brought into stock must not receive it again: the receipt
    // credited received-not-billed at the order price, this bill debits it at
    // the invoiced price, and the difference is purchase price variance.
    // Cover is the one shared definition the guard and the Match dialog
    // read, in the item's base units like the line's posting quantity.
    const purchaseOrderLineId = billLinePurchaseOrderLineId(line.custom);
    if (purchaseOrderLineId) {
      const live = await livePurchaseOrderLineReceipts(runner, orgId, purchaseOrderLineId);
      if (toQuantityUnits(live.quantity) > 0n) {
        await settleReceivedBillLineVariance(
          runner,
          orgId,
          actorId,
          line,
          live,
          date,
          subsidiaryId,
        );
        count++;
        continue;
      }
      // A linked line with no live cover left must refuse instead of
      // falling through to receiving the stock again: the goods were
      // returned or the receipt was voided after the match, so bringing
      // them in here would count stock the order no longer holds.
      if (lineRequiresReceipt(line.itemKind)) {
        const purchaseOrder = (
          await runner.execute<{ document_number: string; line_number: number }>(
            sql`
          select d.document_number, dl.line_number
            from document_lines dl
            join documents d on d.id = dl.document_id and d.org_id = dl.org_id
           where dl.id = ${purchaseOrderLineId} and dl.org_id = ${orgId}`,
            "objects",
          )
        )[0];
        const orderLabel = purchaseOrder
          ? `purchase order ${purchaseOrder.document_number} line ${purchaseOrder.line_number}`
          : `its purchase-order line`;
        throw new InventoryError(
          `document line ${line.lineNumber} (item ${line.itemId}) is matched to ${orderLabel} but no received cover remains for that order line — the goods were returned or the receipt was voided after matching. Receive the replacement goods and post the bill again, or void this bill and rebill once the goods arrive`,
        );
      }
    }
    // The bill already debited inventory at the line's extended amount: that
    // total is authoritative for the layer, never quantity × a rounded rate.
    await receiveInventory(orgId, actorId, {
      itemId: line.itemId,
      stockLocationId: line.stockLocationId,
      quantity: line.quantity,
      totalValue: mulRate(line.amount, line.fxRate),
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
      : extendCost(line.quantity, unitCostPerQuantity(received.value, received.quantity) ?? "0");
  const functionalAmount = mulRate(line.amount, line.fxRate);
  const variance = add(functionalAmount, neg(expected));
  if (isZero(variance)) return;
  if (!line.varianceAccountId) {
    throw new InventoryError(
      `document line ${line.lineNumber} (item ${line.itemId}) bills ${functionalAmount} in functional currency for stock received at ${expected}; the item has no purchase price variance account to carry the ${variance} difference`,
    );
  }
  const entryNumber = `INV-PPV-${line.lineId}`;
  const existing = await runner.execute(
    sql`
    select 1 from journal_entries where org_id = ${orgId} and entry_number = ${entryNumber} limit 1`,
    "objects",
  );
  if (existing[0]) return;
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

function purchaseReceiptEvidence(line: DocumentInventoryLine): {
  sourceLineId: string;
  lotId: string | null;
  serialId: string | null;
} {
  const evidence = isJsonRecord(line.custom) ? line.custom.receipt : null;
  const label = `goods-receipt line ${line.lineNumber} (item ${line.itemId})`;
  if (
    !isJsonRecord(evidence) ||
    typeof evidence.sourceLineId !== "string" ||
    !evidence.sourceLineId
  ) {
    throw new InventoryError(`${label} requires immutable receipt evidence`);
  }
  const lotId = evidence.lotId ?? null;
  const serialId = evidence.serialId ?? null;
  if (lotId !== null && typeof lotId !== "string")
    throw new InventoryError(`${label} has malformed lot evidence`);
  if (serialId !== null && typeof serialId !== "string")
    throw new InventoryError(`${label} has malformed serial evidence`);
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
  if (lines.length === 0)
    throw new InventoryError("a goods receipt must carry at least one stock line");
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
    const seen = await runner.execute(
      sql`
      select 1 from inventory_movements
       where org_id = ${orgId} and document_line_id = ${line.lineId} and kind = 'receipt'
       limit 1`,
      "objects",
    );
    if (seen[0]) continue;
    const evidence = purchaseReceiptEvidence(line);
    await receiveInventory(orgId, actorId, {
      itemId: line.itemId,
      stockLocationId: line.stockLocationId,
      quantity: line.quantity,
      totalValue: mulRate(line.amount, line.fxRate),
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
    applyBillInventoryReceipts(tx, orgId, actorId, documentId, billEntryId, date, subsidiaryId),
  );
}
