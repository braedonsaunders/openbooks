import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { fromQuantityUnits, toQuantityUnits } from "../money/quantity.ts";
import { orderedNetOfCancelledSql } from "../records/order-line-remainders.ts";
import { BillLinesUnmatchedError, InventoryError, type Runner } from "./contracts.ts";
import {
  loadDocumentInventoryLines,
  isJsonRecord,
  type DocumentInventoryLine,
} from "./document-lines.ts";
import {
  billLinePurchaseOrderLineId,
  matchablePurchaseOrderLines,
  resolveEntityScope,
  unifiedUnbilledCover,
  type MatchablePurchaseOrderLine,
} from "./bill-matchable-lines.ts";
import { lineRequiresReceipt } from "../records/stock-receipt.ts";

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
export async function assertManualBillLinesMatched(
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
