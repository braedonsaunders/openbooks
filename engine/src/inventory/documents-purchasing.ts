import { resolveAgencyPosting } from "./drop-ship-agency.ts";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { add, cmp, isZero, mulRate, neg } from "../money/money.ts";
import { fromQuantityUnits, toQuantityUnits } from "../money/quantity.ts";
import { orderedNetOfCancelledSql } from "../records/order-line-remainders.ts";
import { extendCost, unitCostPerQuantity } from "./costing.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { BillLinesUnmatchedError, InventoryError, type Runner } from "./contracts.ts";
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
  matchablePurchaseOrderLines,
  resolveEntityScope,
  unifiedUnbilledCover,
  type MatchablePurchaseOrderLine,
} from "./bill-matchable-lines.ts";
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
 * Match a hand-coded vendor-bill line to its purchase-order line inside the
 * posting transaction, with the Match action's own write set: the line
 * keeps conversion-grade provenance (`purchaseOrderLineId` plus a
 * `convertedFrom` cover the void path walks back), the order gains a
 * `bills` edge, and the order line's billed quantity advances under the
 * ordered ceiling. Approved bills and orders reopen only for the writes
 * and return to approved before commit, the established order-cycle
 * pattern for approved-source counter advances. Anything the match cannot
 * take — no candidate, several candidates, a quantity beyond cover, or a
 * unit the order line does not share — stays for the posting guard below,
 * which refuses it with the operator's remedy instead of receiving the
 * stock a second time.
 */
export async function autoMatchBillLinesToOrders(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  actorId: string | null,
): Promise<{ matched: { billLineId: string; purchaseOrderLineId: string; quantity: string }[] }> {
  const lines = await loadDocumentInventoryLines(runner as Runner, orgId, documentId);
  const manual = lines.filter(
    (line) =>
      lineRequiresReceipt(line.itemKind) && billLinePurchaseOrderLineId(line.custom) === null,
  );
  if (manual.length === 0) return { matched: [] };
  const bill = (
    await runner.execute<{
      id: string;
      document_number: string;
      status: string;
      party_id: string | null;
      subsidiary_id: string | null;
    }>(
      sql`
    select id, document_number, status, party_id, subsidiary_id from documents
     where id = ${documentId} and org_id = ${orgId} and kind = 'vendor_bill'
     for update`,
      "objects",
    )
  )[0];
  if (!bill) {
    throw new InventoryError("vendor bill not found while checking purchase-order matching");
  }
  if (bill.status !== "draft" && bill.status !== "approved") return { matched: [] };
  const entityId = await resolveEntityScope(runner, orgId, bill.subsidiary_id);
  // Cover compares in the order line's own unit, which the shared
  // predicate guarantees is the bill line's unit under folded spelling —
  // so plan against the bill lines' raw document quantities, not the
  // base-converted posting quantities the loader carries.
  const rawQuantities = new Map(
    (
      await runner.execute<{ id: string; quantity: string }>(
        sql`
      select id, quantity::text as quantity from document_lines
       where org_id = ${orgId} and document_id = ${documentId}`,
        "objects",
      )
    ).map((row) => [row.id, row.quantity]),
  );
  const planned: {
    line: DocumentInventoryLine;
    candidate: MatchablePurchaseOrderLine;
    cover: string;
  }[] = [];
  for (const line of manual) {
    const candidates = await matchablePurchaseOrderLines(runner, orgId, {
      itemId: line.itemId,
      unit: line.unit,
      partyId: bill.party_id,
      subsidiaryId: bill.subsidiary_id,
    });
    // Automatic only when exactly one order line covers the whole bill
    // line: anything ambiguous or partial belongs to the operator in the
    // Match dialog, and the guard below refuses it with that remedy.
    if (candidates.length !== 1) continue;
    const candidate = candidates[0]!;
    const raw = rawQuantities.get(line.lineId);
    if (!raw) continue;
    const billUnits = toQuantityUnits(raw);
    if (billUnits <= 0n) continue;
    if (billUnits > toQuantityUnits(candidate.billableQuantity)) continue;
    planned.push({ line, candidate, cover: fromQuantityUnits(billUnits) });
  }
  if (planned.length === 0) return { matched: [] };
  // Lock every purchase-order header before any line, in id order: the
  // same header-before-lines order conversion uses, so a concurrent
  // conversion of the same order serializes instead of deadlocking.
  const poIds = [...new Set(planned.map((row) => row.candidate.purchaseOrderId))].sort();
  const poHeaders = await runner.execute<{ id: string; status: string; document_number: string }>(
    sql`
    select id, status, document_number from documents
     where org_id = ${orgId} and id = any(${`{${poIds.join(",")}}`}::uuid[])
     order by id
     for update`,
    "objects",
  );
  if (poHeaders.length !== poIds.length) {
    throw new InventoryError("a purchase order changed while the bill was being matched");
  }
  const byPoLine = new Map<
    string,
    {
      id: string;
      document_id: string;
      status: string;
      document_number: string;
      party_id: string | null;
      subsidiary_id: string | null;
      line_number: number;
      item_id: string | null;
      unit: string | null;
      quantity: string;
      quantity_fulfilled: string;
      quantity_billed: string;
      quantity_cancelled: string;
    }
  >();
  const poLineRows = await runner.execute<{
    id: string;
    document_id: string;
    status: string;
    document_number: string;
    party_id: string | null;
    subsidiary_id: string | null;
    line_number: number;
    item_id: string | null;
    unit: string | null;
    quantity: string;
    quantity_fulfilled: string;
    quantity_billed: string;
    quantity_cancelled: string;
  }>(
    sql`
    select l.id, d.id as document_id, d.status, d.document_number, d.party_id, d.subsidiary_id,
           l.line_number, l.item_id, l.unit,
           l.quantity::text as quantity, l.quantity_fulfilled::text as quantity_fulfilled,
           l.quantity_billed::text as quantity_billed, l.quantity_cancelled::text as quantity_cancelled
      from document_lines l
      join documents d on d.id = l.document_id and d.org_id = l.org_id
     where l.org_id = ${orgId} and l.id = any(${`{${planned.map((row) => row.candidate.purchaseOrderLineId).join(",")}}`}::uuid[])
     order by l.document_id, l.id
     for update of l`,
    "objects",
  );
  for (const row of poLineRows) byPoLine.set(row.id, row);
  const reopened: string[] = [];
  const reopenForWrites = async (id: string, status: string, label: string) => {
    if (status !== "approved") return;
    const reopenedRow = (
      await runner.execute<{ id: string }>(
        sql`
      update documents set status = 'draft', updated_at = now(), updated_by = ${actorId}
       where id = ${id} and org_id = ${orgId} and status = 'approved'
      returning id`,
        "objects",
      )
    )[0];
    if (!reopenedRow) throw new InventoryError(`${label} changed while the bill was being matched`);
    reopened.push(id);
  };
  await reopenForWrites(bill.id, bill.status, `bill ${bill.document_number}`);
  for (const header of poHeaders) {
    await reopenForWrites(header.id, header.status, `purchase order ${header.document_number}`);
  }
  const matched: { billLineId: string; purchaseOrderLineId: string; quantity: string }[] = [];
  for (const row of planned) {
    const poLine = byPoLine.get(row.candidate.purchaseOrderLineId);
    if (!poLine)
      throw new InventoryError("a purchase-order line changed while the bill was being matched");
    if (poLine.status !== "approved") {
      throw new InventoryError(
        `purchase order ${poLine.document_number} is ${poLine.status} — only an approved order can be matched`,
      );
    }
    if (poLine.item_id !== row.line.itemId) {
      throw new InventoryError("a purchase-order line changed while the bill was being matched");
    }
    const poEntityId = await resolveEntityScope(runner, orgId, poLine.subsidiary_id);
    if ((bill.party_id ?? null) !== (poLine.party_id ?? null) || entityId !== poEntityId) {
      throw new InventoryError(
        "a purchase order changed to a different vendor or legal entity while the bill was being matched",
      );
    }
    const billUnits = toQuantityUnits(row.cover);
    const orderedOpen =
      toQuantityUnits(poLine.quantity) -
      toQuantityUnits(poLine.quantity_cancelled) -
      toQuantityUnits(poLine.quantity_billed);
    if (billUnits > orderedOpen) {
      throw new InventoryError(
        `purchase order ${poLine.document_number} line ${poLine.line_number} changed while the bill was being matched`,
      );
    }
    // Re-derive the unified cover under the locks: a concurrent receipt,
    // void, or return that consumed it makes THIS post refuse whole.
    const cover = await unifiedUnbilledCover(runner, orgId, {
      purchaseOrderLineId: poLine.id,
      itemId: row.line.itemId,
      unit: poLine.unit,
      orderedQuantity: poLine.quantity,
      fulfilledQuantity: poLine.quantity_fulfilled,
      billedQuantity: poLine.quantity_billed,
      cancelledQuantity: poLine.quantity_cancelled,
    });
    if (billUnits > toQuantityUnits(cover.billableQuantity)) {
      throw new InventoryError(
        `purchase order ${poLine.document_number} line ${poLine.line_number} changed while the bill was being matched`,
      );
    }
    const advanced = (
      await runner.execute<{ id: string }>(
        sql`
      update document_lines set quantity_billed = quantity_billed + ${row.cover}, updated_at = now(), updated_by = ${actorId}
       where id = ${poLine.id} and org_id = ${orgId}
         and quantity_billed + ${row.cover} <= ${orderedNetOfCancelledSql("document_lines")}
      returning id`,
        "objects",
      )
    )[0];
    if (!advanced) {
      throw new InventoryError("a purchase-order line changed while the bill was being matched");
    }
    // The next bill line may target this same order line. Carry forward the
    // quantity written above so its ordered and received cover is current.
    poLine.quantity_billed = fromQuantityUnits(toQuantityUnits(poLine.quantity_billed) + billUnits);
    const bag = (isJsonRecord(row.line.custom) ? { ...row.line.custom } : {}) as Record<
      string,
      unknown
    >;
    bag.purchaseOrderLineId = poLine.id;
    bag.convertedFrom = { documentId: poLine.document_id, lineId: poLine.id, quantity: row.cover };
    const stamped = (
      await runner.execute<{ id: string }>(
        sql`
      update document_lines set custom = ${JSON.stringify(bag)}::jsonb, updated_at = now(), updated_by = ${actorId}
       where id = ${row.line.lineId} and org_id = ${orgId}
      returning id`,
        "objects",
      )
    )[0];
    if (!stamped) throw new InventoryError("a bill line changed while the bill was being matched");
    const edge = (
      await runner.execute<{ id: string }>(
        sql`
      select id from document_links
       where org_id = ${orgId} and from_document_id = ${poLine.document_id}
         and to_document_id = ${documentId} and link_type = 'bills'`,
        "objects",
      )
    )[0];
    if (!edge) {
      await runner.execute(sql`
        insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
        values (${orgId}, ${poLine.document_id}, ${documentId}, 'bills', ${actorId})`);
    }
    matched.push({
      billLineId: row.line.lineId,
      purchaseOrderLineId: poLine.id,
      quantity: row.cover,
    });
  }
  for (const id of reopened) {
    const restored = (
      await runner.execute<{ id: string }>(
        sql`
      update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
       where id = ${id} and org_id = ${orgId} and status = 'draft'
      returning id`,
        "objects",
      )
    )[0];
    if (!restored) throw new InventoryError("a document changed while the bill was being matched");
  }
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'documents', ${documentId}, 'update',
            ${JSON.stringify({
              mode: "bill_lines_auto_matched",
              matchedLines: matched.map((row) => ({
                purchaseOrderLineId: row.purchaseOrderLineId,
                quantity: row.quantity,
              })),
            })}::jsonb, ${actorId})`);
  return { matched };
}

/**
 * A vendor-bill line coded by hand for receipt-tracked stock must not bypass
 * three-way matching: billing it with no purchase-order provenance and then
 * receiving the same stock on its purchase order counts it twice. Any line
 * the automatic match above could not take — no covering order line, or
 * several, or a quantity beyond cover — refuses here naming the orders the
 * one shared predicate finds, so the guard names exactly what the Match
 * dialog offers: match the bill to its purchase-order line (or receive
 * first) instead. Direct counter purchases with no matchable order keep
 * the legacy bill-is-the-receipt path.
 */
async function assertManualBillLinesMatched(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  lines: DocumentInventoryLine[],
): Promise<void> {
  const manual = lines.filter(
    (line) =>
      lineRequiresReceipt(line.itemKind) && billLinePurchaseOrderLineId(line.custom) === null,
  );
  if (manual.length === 0) return;
  const bill = (
    await runner.execute<{
      party_id: string | null;
      subsidiary_id: string | null;
    }>(
      sql`
    select party_id, subsidiary_id from documents
     where id = ${documentId} and org_id = ${orgId}`,
      "objects",
    )
  )[0];
  if (!bill) {
    throw new InventoryError("vendor bill not found while checking purchase-order matching");
  }
  let first: DocumentInventoryLine | null = null;
  let orders: MatchablePurchaseOrderLine[] = [];
  for (const line of manual) {
    const matchable = await matchablePurchaseOrderLines(
      runner,
      orgId,
      {
        itemId: line.itemId,
        unit: line.unit,
        partyId: bill.party_id,
        subsidiaryId: bill.subsidiary_id,
      },
      { includeUnreceived: true },
    );
    if (matchable.length > 0) {
      first = line;
      orders = matchable;
      break;
    }
  }
  if (!first) return;
  const [primary] = orders;
  const itemLabel = primary!.itemCode ?? primary!.itemName;
  const numbers = [...new Set(orders.map((order) => order.purchaseOrderNumber))];
  const more =
    orders.length > 1
      ? ` (and ${orders.length - 1} more open line${orders.length > 2 ? "s" : ""})`
      : "";
  const ordersLabel =
    numbers.length > 1 ? `purchase orders ${numbers.join(", ")}` : `purchase order ${numbers[0]}`;
  throw new BillLinesUnmatchedError(
    `vendor-bill line ${first.lineNumber} (${itemLabel}) is stock still open on ${ordersLabel} line ${primary!.purchaseOrderLineNumber}${more}: match the bill to its purchase-order line so it clears received-not-billed instead of receiving the stock again — billing unmatched stock now and receiving it later counts it twice`,
    toQuantityUnits(primary!.billableQuantity) > 0n
      ? `Match this bill to ${ordersLabel} (Match to purchase order), then post again`
      : `Receive the goods on ${ordersLabel}, then use Match to purchase order on this bill and post again`,
    { lineNumber: first.lineNumber, itemCode: primary!.itemCode, purchaseOrderNumbers: numbers },
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
