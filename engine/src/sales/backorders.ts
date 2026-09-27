import { sql } from "drizzle-orm";
import { orderLineCancellations } from "@openbooks/schema";
import type { db, SqlExecutor } from "../platform/db.ts";
import { canonicalDecimal, compareDecimal, isPositiveDecimal } from "../money/exact-decimal.ts";
import { decimalNullRefusal } from "../money/decimal-refusal.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import {
  openQuantitySql,
  salesOrderLineRemainders,
  type SalesOrderLineRemainder,
} from "../records/order-line-remainders.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type BackorderRefusalCode =
  | "feature_disabled"
  | "order_line_not_found"
  | "not_a_sales_order_line"
  | "order_not_open"
  | "not_a_stock_line"
  | "invalid_quantity"
  | "reason_required"
  | "nothing_open"
  | "exceeds_open_quantity";

/**
 * A backorder request the business rules refuse. Carries the HTTP status the
 * route factory answers with, a stable code, and the remedy the operator can
 * act on.
 */
export class BackorderRefusal extends Error {
  readonly name = "BackorderRefusal";

  constructor(
    message: string,
    readonly code: BackorderRefusalCode,
    readonly status: 404 | 409 | 422,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

/** Backorders are a Fulfillment capability; Fulfillment requires Orders and Warehousing. */
const FULFILLMENT_FEATURE = "fulfillment";

function fulfillmentDisabled(): BackorderRefusal {
  return new BackorderRefusal(
    "Fulfillment is turned off for this organization",
    "feature_disabled",
    409,
    "Turn on Warehousing and Fulfillment on Company Settings → Features",
  );
}

/** A sales order's scope facts, for a route to check before it reads or
 *  writes the order's backorders. Null when no such sales order exists. */
export async function salesOrderScope(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<{ id: string; subsidiaryId: string | null } | null> {
  const row = (await runner.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from documents
     where org_id = ${orgId} and id = ${documentId} and kind = 'sales_order'
  `)).rows[0];
  return row ? { id: row.id, subsidiaryId: row.subsidiary_id } : null;
}

export interface BackorderPositionFilter {
  documentId?: string;
  /** Null means unrestricted, by explicit sentinel only. */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

/**
 * The backorder position: every approved sales-order stock line with open
 * quantity above zero, narrowed to the caller's visible subsidiaries.
 */
export async function backorderPosition(
  runner: SqlExecutor,
  orgId: string,
  filter: BackorderPositionFilter,
): Promise<SalesOrderLineRemainder[]> {
  if (!(await orgFeatureEnabled(orgId, FULFILLMENT_FEATURE, runner))) throw fulfillmentDisabled();
  const rows = await salesOrderLineRemainders(runner, orgId, {
    documentId: filter.documentId,
    openOnly: true,
  });
  return rows.filter((row) => subsidiaryScopeAllows(filter.allowedSubsidiaryIds, row.subsidiaryId));
}

export interface CancelOrderLineRemainderInput {
  /** The order the caller addressed; the line must belong to it. */
  documentId: string;
  lineId: string;
  quantity: unknown;
  reason: unknown;
  /** Null means unrestricted, by explicit sentinel only. */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

export interface CancelOrderLineRemainderResult {
  cancellationId: string;
  lineId: string;
  lineNumber: number;
  quantity: string;
  cancelled: string;
  open: string;
}

interface LockedOrderRow extends Record<string, unknown> {
  id: string;
  kind: string;
  status: string;
  document_number: string | null;
  subsidiary_id: string | null;
}

interface LockedLineRow extends Record<string, unknown> {
  id: string;
  line_number: number;
  quantity_cancelled: string;
  open: string;
  is_stock_line: boolean;
}

/** Trim a numeric(28,8) database string for a message: "4.00000000" → "4". */
function shown(quantity: string): string {
  return canonicalDecimal(quantity, 8) ?? quantity;
}

/**
 * Cancel part or all of an approved sales-order stock line's open quantity.
 * The cancelled quantity is no longer owed: fulfilment cannot ship it and
 * billing stops at the ordered quantity net of it. One evidence row, the
 * line's running total and an audit entry are written together.
 *
 * Approved lines are storage-immutable (migration 0034), and the cancelled
 * quantity is operational order state, not a commercial edit: the order row
 * is locked, briefly returned to draft while the line advances, and restored
 * to approved before the transaction can be observed — the same mechanism
 * fulfilment uses to advance the shipped quantity.
 */
export async function cancelOrderLineRemainder(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: CancelOrderLineRemainderInput,
): Promise<CancelOrderLineRemainderResult> {
  if (!(await lockAndCheckOrgFeature(tx, orgId, FULFILLMENT_FEATURE))) throw fulfillmentDisabled();
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) {
    throw new BackorderRefusal(
      "A reason is required to cancel an order-line remainder",
      "reason_required",
      422,
      "Enter why the remaining quantity will not be shipped, then cancel again",
    );
  }
  const quantity = canonicalDecimal(input.quantity, 8);
  if (quantity === null) {
    throw new BackorderRefusal(
      decimalNullRefusal("Quantity to cancel", "a quantity", input.quantity, 8),
      "invalid_quantity",
      422,
    );
  }
  if (!isPositiveDecimal(quantity)) {
    throw new BackorderRefusal(
      "Quantity to cancel must be greater than zero",
      "invalid_quantity",
      422,
      "Enter a positive quantity no larger than the line's open quantity",
    );
  }

  // Lock the order before its line, the order every order-cycle writer uses.
  const order = (await tx.execute<LockedOrderRow>(sql`
    select d.id, d.kind, d.status, d.document_number, d.subsidiary_id
      from documents d
     where d.org_id = ${orgId}
       and d.id = (select dl.document_id from document_lines dl
                    where dl.org_id = ${orgId} and dl.id = ${input.lineId})
     for update of d
  `)).rows[0];
  if (
    !order ||
    order.id !== input.documentId ||
    !subsidiaryScopeAllows(input.allowedSubsidiaryIds, order.subsidiary_id)
  ) {
    throw new BackorderRefusal("Order line not found", "order_line_not_found", 404);
  }
  const orderLabel = order.document_number ?? "This order";
  if (order.kind !== "sales_order") {
    throw new BackorderRefusal(
      `${orderLabel} is not a sales order; only a sales-order remainder can be cancelled`,
      "not_a_sales_order_line",
      422,
    );
  }
  if (order.status !== "approved") {
    throw new BackorderRefusal(
      `${orderLabel} is ${order.status}; only an issued sales order has a remainder to cancel`,
      "order_not_open",
      409,
      order.status === "draft" ? "Change the line quantity on the draft order instead" : undefined,
    );
  }

  const line = (await tx.execute<LockedLineRow>(sql`
    select dl.id, dl.line_number, dl.quantity_cancelled::text as quantity_cancelled,
           ${openQuantitySql("dl")}::text as open,
           exists (select 1 from item_inventory_profiles profile
                    where profile.org_id = dl.org_id and profile.item_id = dl.item_id) as is_stock_line
      from document_lines dl
     where dl.org_id = ${orgId} and dl.id = ${input.lineId} and dl.document_id = ${order.id}
     for update of dl
  `)).rows[0];
  if (!line) throw new BackorderRefusal("Order line not found", "order_line_not_found", 404);
  const lineLabel = `${orderLabel} line ${line.line_number}`;
  if (!line.is_stock_line) {
    throw new BackorderRefusal(
      `${lineLabel} is not a stock line; only stock lines are backordered`,
      "not_a_stock_line",
      422,
      "Bill or void the order for lines that are not stock",
    );
  }
  if (!isPositiveDecimal(line.open)) {
    throw new BackorderRefusal(
      `${lineLabel} has nothing open to cancel`,
      "nothing_open",
      409,
    );
  }
  if (compareDecimal(quantity, line.open) > 0) {
    throw new BackorderRefusal(
      `${lineLabel} has ${shown(line.open)} open; cannot cancel ${quantity}`,
      "exceeds_open_quantity",
      422,
      `Cancel at most ${shown(line.open)}`,
    );
  }

  const reopened = (await tx.execute<{ id: string }>(sql`
    update documents set status = 'draft', updated_by = ${actorId}
     where id = ${order.id} and org_id = ${orgId} and status = 'approved'
    returning id
  `)).rows[0];
  if (!reopened) {
    throw new BackorderRefusal(`${orderLabel} changed while the remainder was being cancelled`, "order_not_open", 409, "Reload the order and try again");
  }
  const advanced = (await tx.execute<{ quantity_cancelled: string; open: string }>(sql`
    update document_lines
       set quantity_cancelled = quantity_cancelled + ${quantity}::numeric,
           updated_by = ${actorId}
     where id = ${line.id} and org_id = ${orgId}
       and ${openQuantitySql("document_lines")} >= ${quantity}::numeric
    returning quantity_cancelled::text as quantity_cancelled,
              ${openQuantitySql("document_lines")}::text as open
  `)).rows[0];
  if (!advanced) {
    throw new BackorderRefusal(`${lineLabel} changed while its remainder was being cancelled`, "exceeds_open_quantity", 409, "Reload the order and try again");
  }
  const restored = (await tx.execute<{ id: string }>(sql`
    update documents set status = 'approved', updated_by = ${actorId}
     where id = ${order.id} and org_id = ${orgId} and status = 'draft'
    returning id
  `)).rows[0];
  if (!restored) {
    throw new BackorderRefusal(`${orderLabel} changed while the remainder was being cancelled`, "order_not_open", 409, "Reload the order and try again");
  }

  const [evidence] = await tx
    .insert(orderLineCancellations)
    .values({ orgId, documentId: order.id, lineId: line.id, quantity, reason, actorId })
    .returning({ id: orderLineCancellations.id });
  if (!evidence) throw new Error("order-line cancellation evidence was not recorded");

  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${orgId}, 'document_lines', ${line.id}, 'update',
      ${JSON.stringify({
        mode: "order_line_remainder_cancelled",
        orderId: order.id,
        lineNumber: line.line_number,
        cancellationId: evidence.id,
        quantity,
        reason,
        before: { quantityCancelled: line.quantity_cancelled, open: line.open },
        after: { quantityCancelled: advanced.quantity_cancelled, open: advanced.open },
      })}::jsonb,
      ${actorId}
    )
  `);

  return {
    cancellationId: evidence.id,
    lineId: line.id,
    lineNumber: Number(line.line_number),
    quantity,
    cancelled: advanced.quantity_cancelled,
    open: advanced.open,
  };
}
