import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { orderedNetOfCancelledSql } from "../records/order-line-remainders.ts";
import { documentRevisionCounterSql, isDocumentRevisionToken } from "../records/revision.ts";
import { lineRequiresReceipt } from "../records/stock-receipt.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { fromQuantityUnits, toQuantityUnits } from "../money/quantity.ts";
import { sameInventoryUnit } from "../inventory/costing.ts";
import {
  matchablePurchaseOrderLines,
  resolveEntityScope,
  unifiedUnbilledCover,
} from "../inventory/bill-matchable-lines.ts";

/**
 * Link a drawer-created vendor bill to its purchase order after the fact.
 *
 * A bill converted from its purchase order (or materialized from AP
 * capture) carries purchase-order provenance on every stocked line, so
 * posting clears received-not-billed instead of receiving the stock again.
 * A bill keyed by hand in the drawer carries none: when its purchase order
 * still holds the item open, posting refuses rather than double-count the
 * stock. Matching writes the same provenance conversion would have —
 * `purchaseOrderLineId` plus a `convertedFrom` cover the void path walks
 * back, a `bills` edge from the order, and a billed-quantity advance under
 * the same ceilings conversion faces — so the matched bill posts exactly
 * like a converted one. Advancing at match time (not at post) keeps one
 * rule for who owns received-and-unbilled cover: a void or draft-delete
 * of the bill restores precisely this cover through billing provenance.
 */
export class BillMatchError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "BillMatchError";
  }
}

export interface BillLineMatch {
  billLineId: string;
  purchaseOrderLineId: string;
}

export interface MatchedBillLine {
  billLineId: string;
  billLineNumber: number;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  purchaseOrderLineId: string;
  purchaseOrderLineNumber: number;
  quantity: string;
}

export type PurchaseReceiptReference = {
  id: string;
  documentNumber: string;
  documentDate: string;
  status: string;
};

export interface BillMatchCandidate {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  purchaseOrderLineId: string;
  purchaseOrderLineNumber: number;
  unit: string | null;
  unitPrice: string;
  orderedQuantity: string;
  fulfilledQuantity: string;
  billedQuantity: string;
  cancelledQuantity: string;
  billableQuantity: string;
  receipts: PurchaseReceiptReference[];
}

export interface BillMatchCandidateLine {
  billLineId: string;
  lineNumber: number;
  itemId: string;
  itemCode: string | null;
  itemName: string;
  quantity: string;
  unit: string | null;
  matched: {
    purchaseOrderNumber: string;
    purchaseOrderLineNumber: number;
  } | null;
  candidates: BillMatchCandidate[];
}

/** The purchase-order line a bill line already names, from either writer's evidence. */
function existingPurchaseOrderLineId(custom: unknown): string | null {
  if (!custom || typeof custom !== "object") return null;
  const bag = custom as Record<string, unknown>;
  const direct = bag.purchaseOrderLineId;
  if (typeof direct === "string" && direct) return direct;
  const capture = bag.apCaptureEvidence;
  if (capture && typeof capture === "object") {
    const indirect = (capture as Record<string, unknown>).purchaseOrderLineId;
    if (typeof indirect === "string" && indirect) return indirect;
  }
  return null;
}

/**
 * What a draft or approved unposted vendor bill can match: every stocked
 * bill line without provenance, each with the matchable purchase-order
 * lines — the one predicate the posting guard reads, so the dialog offers
 * exactly what the guard names — and the goods receipts behind them so
 * the operator confirms the right delivery. Read-only; matching
 * revalidates everything under row locks.
 */
export async function billMatchCandidates(
  orgId: string,
  billId: string,
): Promise<{ billNumber: string; billStatus: string; lines: BillMatchCandidateLine[] }> {
  if (!isUuid(billId)) throw new BillMatchError("bill not found", 404);
  const bill = (
    await db.execute<{
      id: string;
      document_number: string;
      status: string;
      party_id: string | null;
      subsidiary_id: string | null;
    }>(
      sql`
    select id, document_number, status, party_id, subsidiary_id from documents
     where id = ${billId} and org_id = ${orgId} and kind = 'vendor_bill'`,
      "objects",
    )
  )[0];
  if (!bill) throw new BillMatchError("bill not found", 404);
  const billLines = await db.execute<{
    id: string;
    line_number: number;
    item_id: string | null;
    item_kind: string | null;
    item_code: string | null;
    item_name: string | null;
    quantity: string;
    unit: string | null;
    custom: unknown;
  }>(
    sql`
    select dl.id, dl.line_number, dl.item_id, i.kind as item_kind, i.code as item_code, i.name as item_name,
           dl.quantity::text as quantity, dl.unit, dl.custom
      from document_lines dl
      left join items i on i.id = dl.item_id and i.org_id = dl.org_id
     where dl.org_id = ${orgId} and dl.document_id = ${billId}
     order by dl.line_number`,
    "objects",
  );
  const lines: BillMatchCandidateLine[] = [];
  for (const billLine of billLines) {
    const base = {
      billLineId: billLine.id,
      lineNumber: billLine.line_number,
      itemId: billLine.item_id ?? "",
      itemCode: billLine.item_code,
      itemName: billLine.item_name ?? "",
      quantity: billLine.quantity,
      unit: billLine.unit,
    };
    const poLineId = existingPurchaseOrderLineId(billLine.custom);
    if (poLineId) {
      const matched = (
        await db.execute<{ document_number: string; line_number: number }>(
          sql`
        select d.document_number, dl.line_number
          from document_lines dl
          join documents d on d.id = dl.document_id and d.org_id = dl.org_id
         where dl.id = ${poLineId} and dl.org_id = ${orgId}`,
          "objects",
        )
      )[0];
      lines.push({
        ...base,
        matched: matched
          ? {
              purchaseOrderNumber: matched.document_number,
              purchaseOrderLineNumber: matched.line_number,
            }
          : null,
        candidates: [],
      });
      continue;
    }
    if (billLine.item_id == null || !lineRequiresReceipt(billLine.item_kind)) {
      lines.push({ ...base, matched: null, candidates: [] });
      continue;
    }
    // The one matchable-line predicate, shared with the posting guard:
    // same vendor and entity, approved order, same item with unit
    // spellings folded, received-not-yet-billed cover outstanding.
    const candidates = await matchablePurchaseOrderLines(db, orgId, {
      itemId: billLine.item_id,
      unit: billLine.unit,
      partyId: bill.party_id,
      subsidiaryId: bill.subsidiary_id,
    });
    const result: BillMatchCandidate[] = [];
    for (const candidate of candidates) {
      const receipts = await db.execute<PurchaseReceiptReference>(
        sql`
        select r.id, r.document_number as "documentNumber", r.document_date::text as "documentDate", r.status
          from document_links link
          join documents r on r.id = link.to_document_id and r.org_id = link.org_id
         where link.org_id = ${orgId}
           and link.from_document_id = ${candidate.purchaseOrderId}
           and link.link_type = 'fulfills'
           and r.kind = 'purchase_receipt'
         order by r.document_date, r.document_number`,
        "objects",
      );
      result.push({
        purchaseOrderId: candidate.purchaseOrderId,
        purchaseOrderNumber: candidate.purchaseOrderNumber,
        purchaseOrderLineId: candidate.purchaseOrderLineId,
        purchaseOrderLineNumber: candidate.purchaseOrderLineNumber,
        unit: candidate.unit,
        unitPrice: candidate.unitPrice,
        orderedQuantity: candidate.orderedQuantity,
        fulfilledQuantity: candidate.fulfilledQuantity,
        billedQuantity: candidate.billedQuantity,
        cancelledQuantity: candidate.cancelledQuantity,
        billableQuantity: candidate.billableQuantity,
        receipts,
      });
    }
    lines.push({ ...base, matched: null, candidates: result });
  }
  return { billNumber: bill.document_number, billStatus: bill.status, lines };
}

/**
 * Match stocked vendor-bill lines to their purchase-order lines.
 *
 * Each match stamps the conversion-grade provenance the posting engine
 * reads (`purchaseOrderLineId` plus a `convertedFrom` cover the void path
 * walks back), links the order to the bill, and advances the order line's
 * billed quantity under conversion's own ceilings — so the matched bill
 * posts exactly like a converted one: matched lines clear
 * received-not-billed at the receipt value, price differences land in
 * purchase price variance. One transaction: any refusal rolls every line
 * back. An approved bill (and every approved order touched) reopens only
 * for the writes and returns to approved before commit, the established
 * order-cycle pattern for approved-source counter advances.
 */
export async function matchVendorBillLines(input: {
  orgId: string;
  billId: string;
  actorId: string | null;
  matches: BillLineMatch[];
  expectedUpdatedAt?: string;
}): Promise<{ matched: MatchedBillLine[] }> {
  const { orgId, billId, actorId } = input;
  if (!isUuid(billId)) throw new BillMatchError("bill not found", 404);
  if (!Array.isArray(input.matches) || input.matches.length === 0) {
    throw new BillMatchError("choose at least one bill line to match");
  }
  const seen = new Set<string>();
  for (const match of input.matches) {
    if (!match || !isUuid(match.billLineId) || !isUuid(match.purchaseOrderLineId)) {
      throw new BillMatchError("each match names a bill line and a purchase-order line");
    }
    if (seen.has(match.billLineId)) {
      throw new BillMatchError("a bill line can be matched once per request");
    }
    seen.add(match.billLineId);
  }
  if (input.expectedUpdatedAt !== undefined && !isDocumentRevisionToken(input.expectedUpdatedAt)) {
    throw new BillMatchError(
      "this bill changed after you opened it; reload and review the latest revision",
      409,
    );
  }
  return withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      const bill = (
        await tx.execute<{
          id: string;
          document_number: string;
          status: string;
          party_id: string | null;
          subsidiary_id: string | null;
          revision: string;
        }>(
          sql`
        select id, document_number, status, party_id, subsidiary_id,
               ${documentRevisionCounterSql(sql`revision_seq`)} as revision
          from documents
         where id = ${billId} and org_id = ${orgId} and kind = 'vendor_bill'
         for update`,
          "objects",
        )
      )[0];
      if (!bill) throw new BillMatchError("bill not found", 404);
      if (bill.status !== "draft" && bill.status !== "approved") {
        throw new BillMatchError(
          `only a draft or approved bill can be matched — this bill is ${bill.status}`,
        );
      }
      if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== bill.revision) {
        throw new BillMatchError(
          "this bill changed after you opened it; reload and review the latest revision",
          409,
        );
      }
      const billLines = await tx.execute<{
        id: string;
        line_number: number;
        item_id: string | null;
        item_kind: string | null;
        item_code: string | null;
        item_name: string | null;
        quantity: string;
        unit: string | null;
        base_unit: string | null;
        custom: unknown;
      }>(
        sql`
        select dl.id, dl.line_number, dl.item_id, i.kind as item_kind, i.code as item_code, i.name as item_name,
               dl.quantity::text as quantity, dl.unit, profile.base_unit, dl.custom
          from document_lines dl
          left join items i on i.id = dl.item_id and i.org_id = dl.org_id
          left join item_inventory_profiles profile on profile.org_id = dl.org_id and profile.item_id = dl.item_id
         where dl.org_id = ${orgId} and dl.document_id = ${billId}
         order by dl.line_number
         for update of dl`,
        "objects",
      );
      const byBillLine = new Map(billLines.map((line) => [line.id, line]));
      for (const match of input.matches) {
        const billLine = byBillLine.get(match.billLineId);
        if (!billLine) throw new BillMatchError("a matched line is not on this bill", 409);
        if (billLine.item_id == null || !lineRequiresReceipt(billLine.item_kind)) {
          throw new BillMatchError(
            `bill line ${billLine.line_number} is not stocked goods and has no purchase-order line to match`,
          );
        }
        if (existingPurchaseOrderLineId(billLine.custom) !== null) {
          throw new BillMatchError(
            `bill line ${billLine.line_number} is already matched to its purchase order`,
          );
        }
        const quantity = canonicalDecimal(billLine.quantity, 8);
        if (quantity === null || toQuantityUnits(quantity) <= 0n) {
          throw new BillMatchError(
            `bill line ${billLine.line_number} has no positive quantity to match`,
          );
        }
      }
      // Lock every purchase-order header before any line, in id order: the
      // same header-before-lines order conversion uses, so a concurrent
      // conversion of the same order serializes instead of deadlocking.
      // Header ids come from an unlocked discovery read; every property is
      // revalidated under the locks below.
      const poLineIds = [
        ...new Set(input.matches.map((match) => match.purchaseOrderLineId)),
      ].sort();
      const discoveredPoIds = (
        await tx.execute<{ document_id: string }>(
          sql`
        select distinct document_id from document_lines
         where org_id = ${orgId} and id = any(${`{${poLineIds.join(",")}}`}::uuid[])`,
          "objects",
        )
      )
        .map((row) => row.document_id)
        .sort();
      const poHeaders = await tx.execute<{ id: string; status: string }>(
        sql`
        select id, status from documents
         where org_id = ${orgId} and id = any(${`{${discoveredPoIds.join(",")}}`}::uuid[])
         order by id
         for update`,
        "objects",
      );
      const poLines = await tx.execute<{
        id: string;
        document_id: string;
        document_number: string;
        document_status: string;
        document_party_id: string | null;
        document_subsidiary_id: string | null;
        line_number: number;
        item_id: string | null;
        item_kind: string | null;
        unit: string | null;
        quantity: string;
        quantity_fulfilled: string;
        quantity_billed: string;
        quantity_cancelled: string;
      }>(
        sql`
        select l.id, d.id as document_id, d.document_number, d.status as document_status,
               d.party_id as document_party_id, d.subsidiary_id as document_subsidiary_id,
               l.line_number, l.item_id, i.kind as item_kind, l.unit,
               l.quantity::text as quantity, l.quantity_fulfilled::text as quantity_fulfilled,
               l.quantity_billed::text as quantity_billed, l.quantity_cancelled::text as quantity_cancelled
          from document_lines l
          join documents d on d.id = l.document_id and d.org_id = l.org_id
          left join items i on i.id = l.item_id and i.org_id = l.org_id
         where l.org_id = ${orgId} and l.id = any(${`{${poLineIds.join(",")}}`}::uuid[])
         order by l.document_id, l.id
         for update of l`,
        "objects",
      );
      if (poLines.length !== poLineIds.length) {
        throw new BillMatchError(
          "a chosen purchase-order line is missing — reload and match again",
          409,
        );
      }
      const poIds = [...new Set(poLines.map((line) => line.document_id))].sort();
      if (
        poHeaders.length !== poIds.length ||
        !poIds.every((id) => poHeaders.some((header) => header.id === id))
      ) {
        throw new BillMatchError("a chosen purchase order changed while it was being matched", 409);
      }
      const byPoLine = new Map(poLines.map((line) => [line.id, line]));
      const prepared: {
        billLine: (typeof billLines)[number];
        poLine: (typeof poLines)[number];
        cover: string;
      }[] = [];
      for (const match of input.matches) {
        const billLine = byBillLine.get(match.billLineId)!;
        const poLine = byPoLine.get(match.purchaseOrderLineId)!;
        if (poLine.document_status !== "approved") {
          throw new BillMatchError(
            `purchase order ${poLine.document_number} is ${poLine.document_status} — only an approved order can be matched`,
          );
        }
        if (poLine.item_id !== billLine.item_id) {
          throw new BillMatchError(
            `bill line ${billLine.line_number} (${billLine.item_code ?? billLine.item_name}) is not the item on purchase order ${poLine.document_number} line ${poLine.line_number}`,
          );
        }
        if (!sameInventoryUnit(billLine.unit, poLine.unit, billLine.base_unit)) {
          throw new BillMatchError(
            `bill line ${billLine.line_number} is billed in ${billLine.unit ?? "no unit"} but purchase order ${poLine.document_number} line ${poLine.line_number} orders in ${poLine.unit ?? "no unit"} — match lines share one unit`,
          );
        }
        // A blank entity is the hierarchy root (the posting default) on
        // both sides, so a bill that leaves it blank matches an order
        // that names the root explicitly, and vice versa.
        const billEntityId = await resolveEntityScope(tx, orgId, bill.subsidiary_id);
        const poEntityId = await resolveEntityScope(tx, orgId, poLine.document_subsidiary_id);
        if (
          (bill.party_id ?? null) !== (poLine.document_party_id ?? null) ||
          billEntityId !== poEntityId
        ) {
          throw new BillMatchError(
            `purchase order ${poLine.document_number} is a different vendor or legal entity than this bill — match within one vendor and entity`,
          );
        }
        const billUnits = toQuantityUnits(canonicalDecimal(billLine.quantity, 8)!);
        const orderedOpen =
          toQuantityUnits(poLine.quantity) -
          toQuantityUnits(poLine.quantity_cancelled) -
          toQuantityUnits(poLine.quantity_billed);
        if (billUnits > orderedOpen) {
          throw new BillMatchError(
            `purchase order ${poLine.document_number} line ${poLine.line_number} has only ${fromQuantityUnits(orderedOpen < 0n ? 0n : orderedOpen)} open to bill`,
          );
        }
        // The one shared cover: counter or live receipts, less billed.
        const cover = await unifiedUnbilledCover(tx, orgId, {
          purchaseOrderLineId: poLine.id,
          itemId: poLine.item_id!,
          unit: poLine.unit,
          orderedQuantity: poLine.quantity,
          fulfilledQuantity: poLine.quantity_fulfilled,
          billedQuantity: poLine.quantity_billed,
          cancelledQuantity: poLine.quantity_cancelled,
        });
        const receivedOpen = toQuantityUnits(cover.coverQuantity);
        if (billUnits > receivedOpen) {
          throw new BillMatchError(
            `purchase order ${poLine.document_number} line ${poLine.line_number} has only ${fromQuantityUnits(receivedOpen < 0n ? 0n : receivedOpen)} received and unbilled — receive the goods first, then match`,
          );
        }
        prepared.push({ billLine, poLine, cover: fromQuantityUnits(billUnits) });
        // Later bill lines in this request must see the cover consumed by
        // earlier lines targeting the same purchase-order line.
        poLine.quantity_billed = fromQuantityUnits(
          toQuantityUnits(poLine.quantity_billed) + billUnits,
        );
      }
      const reopened: string[] = [];
      const reopenForWrites = async (id: string, status: string, label: string) => {
        if (status !== "approved") return;
        const reopenedRow = (
          await tx.execute<{ id: string }>(
            sql`
          update documents set status = 'draft', updated_at = now(), updated_by = ${actorId}
           where id = ${id} and org_id = ${orgId} and status = 'approved'
          returning id`,
            "objects",
          )
        )[0];
        if (!reopenedRow)
          throw new BillMatchError(`${label} changed while it was being matched`, 409);
        reopened.push(id);
      };
      await reopenForWrites(billId, bill.status, `bill ${bill.document_number}`);
      for (const poId of poIds) {
        const header = poHeaders.find((row) => row.id === poId)!;
        await reopenForWrites(poId, header.status, `purchase order ${poLineLabel(poLines, poId)}`);
      }
      const matched: MatchedBillLine[] = [];
      for (const { billLine, poLine, cover } of prepared) {
        // The ordered ceiling stays in storage arithmetic; the received
        // ceiling is the unified cover validated above under these same
        // locks (live receipts can exceed the received counter after a
        // return or a historic write, so the counter ceiling cannot stand).
        const advanced = (
          await tx.execute<{ id: string }>(
            sql`
          update document_lines set quantity_billed = quantity_billed + ${cover}, updated_at = now(), updated_by = ${actorId}
           where id = ${poLine.id} and org_id = ${orgId}
             and quantity_billed + ${cover} <= ${orderedNetOfCancelledSql("document_lines")}
          returning id`,
            "objects",
          )
        )[0];
        if (!advanced) {
          throw new BillMatchError(
            `purchase order ${poLine.document_number} line ${poLine.line_number} changed while it was being matched`,
            409,
          );
        }
        const bag = (
          billLine.custom && typeof billLine.custom === "object"
            ? { ...(billLine.custom as Record<string, unknown>) }
            : {}
        ) as Record<string, unknown>;
        bag.purchaseOrderLineId = poLine.id;
        bag.convertedFrom = { documentId: poLine.document_id, lineId: poLine.id, quantity: cover };
        const stamped = (
          await tx.execute<{ id: string }>(
            sql`
          update document_lines set custom = ${JSON.stringify(bag)}::jsonb, updated_at = now(), updated_by = ${actorId}
           where id = ${billLine.id} and org_id = ${orgId}
          returning id`,
            "objects",
          )
        )[0];
        if (!stamped)
          throw new BillMatchError("a bill line changed while it was being matched", 409);
        const edge = (
          await tx.execute<{ id: string }>(
            sql`
          select id from document_links
           where org_id = ${orgId} and from_document_id = ${poLine.document_id}
             and to_document_id = ${billId} and link_type = 'bills'`,
            "objects",
          )
        )[0];
        if (!edge) {
          await tx.execute(sql`
            insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
            values (${orgId}, ${poLine.document_id}, ${billId}, 'bills', ${actorId})`);
        }
        matched.push({
          billLineId: billLine.id,
          billLineNumber: billLine.line_number,
          purchaseOrderId: poLine.document_id,
          purchaseOrderNumber: poLine.document_number,
          purchaseOrderLineId: poLine.id,
          purchaseOrderLineNumber: poLine.line_number,
          quantity: cover,
        });
      }
      for (const id of reopened) {
        const restored = (
          await tx.execute<{ id: string }>(
            sql`
          update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
           where id = ${id} and org_id = ${orgId} and status = 'draft'
          returning id`,
            "objects",
          )
        )[0];
        if (!restored)
          throw new BillMatchError("a document changed while it was being matched", 409);
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'documents', ${billId}, 'update',
                ${JSON.stringify({
                  mode: "bill_lines_matched",
                  purchaseOrderIds: poIds,
                  matchedLines: matched.map((row) => ({
                    billLineNumber: row.billLineNumber,
                    purchaseOrderNumber: row.purchaseOrderNumber,
                    purchaseOrderLineNumber: row.purchaseOrderLineNumber,
                    quantity: row.quantity,
                  })),
                })}::jsonb, ${actorId})`);
      return { matched };
    }),
  );
}

function poLineLabel(
  poLines: { document_id: string; document_number: string }[],
  poId: string,
): string {
  return poLines.find((line) => line.document_id === poId)?.document_number ?? poId;
}
