import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  documentRevisionCounterSql,
  isDocumentRevisionToken,
} from "@openbooks/engine/records/revision";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "@openbooks/engine/organization/scope";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "@openbooks/engine/records/transaction-audit";
import { SubmitError, submitAndReleaseIfUngated } from "@openbooks/engine/flows/module";
import { computeOrderTotals, exactOrderMoney, orderTaxProfileMap } from "../app/api/_order/lib";
import { exactOrderQuantity, exactOrderUnitPrice } from "../app/api/_order/line-selection";
import { persistLineTaxComponents } from "./bills";
import { compareDecimal } from "./exact-decimal";
import { purchaseOrderAmendQuantityFloor } from "./purchase-order-amend-quantity";

/**
 * Amendment refusal: the order is not amendable (wrong status, stale
 * revision, unknown line, a quantity below received/billed evidence, or
 * nothing to change) or the re-approval routing failed. Callers map this to
 * a 4xx with the message intact — a refused amendment is request state, not
 * a server defect.
 */
export class PurchaseOrderAmendError extends Error {
  readonly name = "PurchaseOrderAmendError";
  constructor(
    message: string,
    readonly status: number = 422,
    readonly code:
      | "invalid_status"
      | "stale-revision"
      | "not-found"
      | "applied"
      | "no-changes"
      | "flow-refused" = "invalid_status",
  ) {
    super(message);
  }
}

export interface AmendLineInput {
  /** document_lines id of the order line to change. */
  lineId: string;
  /** New ordered quantity (decimal text); omitted = unchanged. */
  quantity?: unknown;
  /** New unit price (decimal text); omitted = unchanged. */
  unitPrice?: unknown;
}

export interface AmendPurchaseOrderInput {
  readonly orderId: string;
  readonly orgId: string;
  readonly actorId: string | null;
  /** Why the approved order changes — required; the audit trail records it. */
  readonly reason: unknown;
  /** Optimistic concurrency token from the opened drawer; checked under lock. */
  readonly expectedUpdatedAt?: string | null;
  readonly allowedSubsidiaryIds?: ReadonlySet<string> | null;
  readonly lines: AmendLineInput[];
}

export interface AmendPurchaseOrderResult {
  readonly status: "approved" | "pending_approval";
  /** True when a Flow gates the order: it must be re-approved. */
  readonly gated: boolean;
  readonly runId: string | null;
}

function requireAmendReason(reason: unknown): string {
  const value = typeof reason === "string" ? reason.trim() : "";
  if (value.length < 5 || value.length > 500) {
    throw new PurchaseOrderAmendError(
      "an amendment reason between 5 and 500 characters is required",
    );
  }
  return value;
}

/**
 * Amend an approved purchase order's lines (quantity and/or unit price) when
 * receipts or bills already guard a redraft. Quantities may rise to cover an
 * over-shipment but never fall below received or billed evidence; every
 * change carries the reason, is audited before/after, and bumps the revision
 * so stale drawers refuse. The amended order re-approves through the native
 * Flow release: ungated it stays approved, gated it goes pending_approval
 * into a new run.
 *
 * The aggregate lock precedes every check and the writes, so a concurrent
 * receipt, bill, or amendment converges to exactly one outcome.
 */
export async function amendPurchaseOrder(
  input: AmendPurchaseOrderInput,
): Promise<AmendPurchaseOrderResult> {
  const reason = requireAmendReason(input.reason);
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new PurchaseOrderAmendError(
      "at least one line change is required to amend a purchase order",
    );
  }
  return withOrgTransaction(input.orgId, async () => {
    const locked = (
      await db.execute<{
        id: string;
        status: string;
        number: string | null;
        subsidiaryId: string | null;
        documentDate: string | null;
        revision: string;
      }>(
        sql`
      select id, status,
             document_number as number,
             subsidiary_id as "subsidiaryId",
             document_date as "documentDate",
             ${documentRevisionCounterSql(sql.raw("revision_seq"))} as revision
        from documents
       where id = ${input.orderId} and kind = 'purchase_order' and org_id = ${input.orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!locked) {
      throw new PurchaseOrderAmendError(
        "purchase order not found in this organization",
        404,
        "not-found",
      );
    }
    if (
      input.allowedSubsidiaryIds !== undefined &&
      !subsidiaryScopeAllows(input.allowedSubsidiaryIds, locked.subsidiaryId)
    ) {
      throw new ScopeNotFoundError();
    }
    if (
      input.expectedUpdatedAt != null &&
      (!isDocumentRevisionToken(input.expectedUpdatedAt) ||
        input.expectedUpdatedAt !== locked.revision)
    ) {
      throw new PurchaseOrderAmendError(
        "this purchase order changed after you opened it; reload and review the latest revision",
        409,
        "stale-revision",
      );
    }
    const name = locked.number ?? "this purchase order";
    if (locked.status === "draft") {
      throw new PurchaseOrderAmendError(
        `${name} is already a draft — edit it directly instead of amending`,
      );
    }
    if (locked.status === "voided") {
      throw new PurchaseOrderAmendError(`${name} is voided — voided orders are terminal`);
    }
    if (locked.status === "pending_approval") {
      throw new PurchaseOrderAmendError(
        `${name} is still awaiting approval — decide or withdraw the approval request before amending`,
      );
    }
    if (locked.status !== "approved") {
      throw new PurchaseOrderAmendError(
        `${name} is ${locked.status} — only an approved order is amended`,
      );
    }

    const stored = await db.execute<{
      id: string;
      lineNumber: number;
      quantity: string;
      unitPrice: string;
      quantityFulfilled: string;
      quantityBilled: string;
      quantityCancelled: string;
      taxCodeId: string | null;
      taxGroupId: string | null;
    }>(
      sql`
      select id, line_number as "lineNumber",
             quantity::text as quantity, unit_price::text as "unitPrice",
             quantity_fulfilled::text as "quantityFulfilled",
             quantity_billed::text as "quantityBilled",
             quantity_cancelled::text as "quantityCancelled",
             tax_code_id as "taxCodeId", tax_group_id as "taxGroupId"
        from document_lines
       where org_id = ${input.orgId} and document_id = ${input.orderId}
       order by line_number
       for update
    `,
      "objects",
    );
    const byId = new Map(stored.map((line) => [line.id, line]));

    const amendments: { line: (typeof stored)[number]; quantity: string; unitPrice: string }[] = [];
    for (const change of input.lines) {
      const line = typeof change?.lineId === "string" ? byId.get(change.lineId) : undefined;
      if (!line) {
        throw new PurchaseOrderAmendError(
          `purchase-order line was not found on ${name}`,
          404,
          "not-found",
        );
      }
      let quantity = String(line.quantity);
      if (change.quantity !== undefined) {
        const parsed = exactOrderQuantity(change.quantity);
        if (parsed === "invalid" || compareDecimal(parsed, "0") <= 0) {
          throw new PurchaseOrderAmendError(
            `line ${line.lineNumber}: quantity must be a positive decimal quantity`,
          );
        }
        // Fulfillment, billing, and cancellations already consume the order
        // quantity. An amendment may grow past them but may not invalidate
        // the remaining-quantity equations used by receiving and billing.
        const floor = purchaseOrderAmendQuantityFloor(
          String(line.quantityFulfilled),
          String(line.quantityBilled),
          String(line.quantityCancelled),
        );
        if (compareDecimal(parsed, floor) < 0) {
          throw new PurchaseOrderAmendError(
            `line ${line.lineNumber}: quantity ${parsed} is below the received or billed quantity plus cancellations ${floor} — increase it to at least ${floor}, or correct the recorded receipt or bill first`,
            422,
            "applied",
          );
        }
        quantity = parsed;
      }
      let unitPrice = String(line.unitPrice);
      if (change.unitPrice !== undefined) {
        const parsed = exactOrderUnitPrice(change.unitPrice);
        if (parsed === "invalid" || compareDecimal(parsed, "0") < 0) {
          throw new PurchaseOrderAmendError(
            `line ${line.lineNumber}: unit price must be a non-negative decimal amount`,
          );
        }
        unitPrice = parsed;
      }
      if (quantity !== String(line.quantity) || unitPrice !== String(line.unitPrice)) {
        amendments.push({ line, quantity, unitPrice });
      }
    }
    if (amendments.length === 0) {
      throw new PurchaseOrderAmendError(
        "no line changes — the amended values match the approved order",
        422,
        "no-changes",
      );
    }

    const before = await captureTransactionAuditSnapshot(db, input.orderId, input.orgId);
    if (!before) {
      throw new PurchaseOrderAmendError(
        "purchase order not found in this organization",
        404,
        "not-found",
      );
    }

    // Approved lines are storage-immutable: the same reopen/advance/restore
    // the receipt path uses. Park the header in draft under the
    // compare-and-set (a concurrent receipt, bill, or amendment that moved
    // first fails this flip instead of interleaving), edit the lines, then
    // re-approve through the native release below.
    const parked = (
      await db.execute<{ id: string }>(
        sql`
      update documents set status = 'draft', updated_at = now(), updated_by = ${input.actorId}
       where id = ${input.orderId} and org_id = ${input.orgId} and status = 'approved'
      returning id
    `,
        "objects",
      )
    )[0];
    if (!parked) {
      throw new PurchaseOrderAmendError(
        `${name} changed while it was being amended; reload and try again`,
      );
    }

    // Recompute every line's amount and the header totals through the same
    // tax profiles a drawer save uses, so the amended order's totals follow
    // its lines instead of going stale.
    const computed = computeOrderTotals(
      stored.map((line) => {
        const amended = amendments.find((entry) => entry.line.id === line.id);
        return {
          quantity: amended?.quantity ?? String(line.quantity),
          unitPrice: amended?.unitPrice ?? String(line.unitPrice),
          taxCodeId: line.taxCodeId,
          taxGroupId: line.taxGroupId,
        };
      }),
      await orderTaxProfileMap(input.orgId, locked.documentDate ?? undefined),
    );
    const subtotal = exactOrderMoney(computed.subtotal);
    const taxTotal = exactOrderMoney(computed.taxTotal);
    const total = exactOrderMoney(computed.total);
    if (subtotal === "invalid" || taxTotal === "invalid" || total === "invalid") {
      throw new PurchaseOrderAmendError("amended order totals contain an invalid amount");
    }

    for (let index = 0; index < stored.length; index++) {
      const line = stored[index]!;
      const recomputed = computed.lines[index]!;
      const amount = exactOrderMoney(recomputed.amount);
      const taxInputAmount = exactOrderMoney(recomputed.taxInputAmount);
      const taxAmount = exactOrderMoney(recomputed.taxAmount);
      if (amount === "invalid" || taxInputAmount === "invalid" || taxAmount === "invalid") {
        throw new PurchaseOrderAmendError("amended order totals contain an invalid amount");
      }
      const amended = amendments.find((entry) => entry.line.id === line.id);
      const flipped = (
        await db.execute<{ id: string }>(
          sql`
        update document_lines
           set quantity = ${amended?.quantity ?? String(line.quantity)},
               unit_price = ${amended?.unitPrice ?? String(line.unitPrice)},
               amount = ${amount},
               tax_input_amount = ${taxInputAmount},
               tax_amount = ${taxAmount},
               updated_by = ${input.actorId}
         where id = ${line.id} and org_id = ${input.orgId}
        returning id
      `,
          "objects",
        )
      )[0];
      if (!flipped) {
        throw new PurchaseOrderAmendError(
          `${name} changed while it was being amended; reload and try again`,
        );
      }
      await db.execute(sql`
        delete from document_line_tax_components
         where org_id = ${input.orgId} and document_line_id = ${line.id}
      `);
      await persistLineTaxComponents(db, {
        orgId: input.orgId,
        documentLineId: line.id,
        components: recomputed.taxComponents,
        actorId: input.actorId,
      });
    }
    const header = (
      await db.execute<{ id: string }>(
        sql`
      update documents
         set subtotal = ${subtotal}, tax_total = ${taxTotal}, total = ${total},
             updated_at = now(), updated_by = ${input.actorId}
       where id = ${input.orderId} and org_id = ${input.orgId} and status = 'draft'
      returning id
    `,
        "objects",
      )
    )[0];
    if (!header) {
      throw new PurchaseOrderAmendError(
        `${name} changed while it was being amended; reload and try again`,
      );
    }

    // Re-approval rides the native submit/release: no configured Flow
    // releases straight back to approved; a configured one gates into a new
    // run and the order goes pending_approval.
    let release: { gated: boolean; runId: string | null; autoApproved: boolean };
    try {
      const outcome = await submitAndReleaseIfUngated(
        "purchase_order",
        input.orderId,
        input.actorId,
      );
      release = { gated: outcome.gated, runId: outcome.runId, autoApproved: outcome.autoApproved };
      if (outcome.flowError) {
        throw new PurchaseOrderAmendError(
          `amendment re-approval refused: ${outcome.flowError}`,
          422,
          "flow-refused",
        );
      }
    } catch (error) {
      if (error instanceof SubmitError) {
        throw new PurchaseOrderAmendError(
          `amendment re-approval refused: ${error.message}`,
          422,
          "flow-refused",
        );
      }
      throw error;
    }

    const after = await captureTransactionAuditSnapshot(db, input.orderId, input.orgId);
    if (!after) {
      throw new PurchaseOrderAmendError(
        `${name} changed while it was being amended; reload and try again`,
      );
    }
    await recordTransactionAudit(db, {
      orgId: input.orgId,
      documentId: input.orderId,
      action: "update",
      actorId: input.actorId,
      source: "purchase-orders.amend",
      reason,
      before,
      after,
    });
    return {
      status: release.gated ? ("pending_approval" as const) : ("approved" as const),
      gated: release.gated,
      runId: release.runId,
    };
  });
}
