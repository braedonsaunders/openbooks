import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { restrictionAdmits, type SubsidiaryContext } from "../organization/subsidiaries.ts";

/**
 * Cross-subsidiary fulfillment seam.
 *
 * A stock location belongs to the legal entity its location is restricted
 * to, and inventory never moves another entity's stock: an issue from a
 * location that does not admit the issuing entity is refused as a
 * cross-entity attempt. Cross-subsidiary fulfillment is the one governed
 * exception. When it is switched on, a sales fulfillment line whose
 * warehouse belongs to another entity is handed to the registered handler,
 * which issues the stock in the owning entity at its own cost and posts the
 * intercompany cross-charge at the transfer price. The handler lives above
 * inventory (it needs intercompany policy), so it registers at engine boot;
 * with none registered, or with the feature off, the line falls through to
 * the ordinary issue and its cross-entity refusal.
 */

export const CROSS_SUBSIDIARY_FULFILLMENT_FEATURE = "crossSubsidiaryFulfillment";

export interface CrossSubsidiaryIssueRequest {
  orgId: string;
  actorId: string | null;
  /** The sales fulfillment document and line being shipped. */
  fulfillmentDocumentId: string;
  lineId: string;
  lineNumber: number;
  itemId: string;
  stockLocationId: string;
  quantity: string;
  lotId: string | null;
  serialId: string | null;
  departmentId: string | null;
  projectId: string | null;
  date: string;
  /** The entity selling to the customer (the sales order's entity). */
  sellingSubsidiaryId: string;
  /** The entity whose warehouse ships the goods. */
  fulfillingSubsidiaryId: string;
}

export interface CrossSubsidiaryReturnRequest {
  orgId: string;
  actorId: string | null;
  creditDocumentId: string;
  creditLineId: string;
  /** The fulfilling entity's original issue movement being returned. */
  sourceIssueMovementId: string;
  /** The fulfilling entity's receipt movement that took the goods back. */
  returnMovementId: string;
  quantity: string;
  date: string;
  sellingSubsidiaryId: string;
}

export interface CrossSubsidiaryVoidRequest {
  orgId: string;
  actorId: string;
  /** The fulfilling entity's issue movement the void just reversed. */
  issueMovementId: string;
  reversalDate: string;
  reason: string;
}

export interface CrossSubsidiaryFulfillmentHandler {
  /** Issue in the fulfilling entity and post the cross-charge, in the caller's transaction. */
  fulfill(runner: SqlExecutor, request: CrossSubsidiaryIssueRequest): Promise<void>;
  /** Reverse the cross-charge for units returned against a cross-subsidiary shipment. */
  returned(runner: SqlExecutor, request: CrossSubsidiaryReturnRequest): Promise<void>;
  /** Reverse the whole cross-charge of a shipment that is being voided. */
  voided(runner: SqlExecutor, request: CrossSubsidiaryVoidRequest): Promise<void>;
}

type HandlerRuntime = typeof globalThis & {
  __openbooksCrossSubsidiaryFulfillment?: CrossSubsidiaryFulfillmentHandler;
};

const runtime = globalThis as HandlerRuntime;

export function registerCrossSubsidiaryFulfillmentHandler(
  handler: CrossSubsidiaryFulfillmentHandler,
): void {
  runtime.__openbooksCrossSubsidiaryFulfillment = handler;
}

export function crossSubsidiaryFulfillmentHandler(): CrossSubsidiaryFulfillmentHandler | null {
  return runtime.__openbooksCrossSubsidiaryFulfillment ?? null;
}

/**
 * The entity that owns a stock location when it is not `sellingSubsidiaryId`:
 * the location's subsidiary restriction when that restriction does not admit
 * the selling entity. Null when the selling entity may use the location.
 */
export async function foreignStockLocationOwner(
  runner: SqlExecutor,
  orgId: string,
  ctx: SubsidiaryContext,
  stockLocationId: string,
  sellingSubsidiaryId: string,
): Promise<string | null> {
  const row = (
    await runner.execute<{ subsidiary_id: string | null; include_children: boolean }>(
      sql`
    select l.subsidiary_id, l.subsidiary_include_children as include_children
      from stock_locations sl
      join locations l on l.org_id = sl.org_id and l.id = sl.location_id
     where sl.org_id = ${orgId} and sl.id = ${stockLocationId}`,
      "objects",
    )
  )[0];
  if (!row?.subsidiary_id) return null;
  if (restrictionAdmits(ctx, row.subsidiary_id, row.include_children, sellingSubsidiaryId))
    return null;
  return row.subsidiary_id;
}

/** Whether a foreign-warehouse line should be routed to the handler. */
export async function crossSubsidiaryFulfillmentActive(
  runner: SqlExecutor,
  orgId: string,
): Promise<boolean> {
  if (!crossSubsidiaryFulfillmentHandler()) return false;
  return lockAndCheckOrgFeature(runner, orgId, CROSS_SUBSIDIARY_FULFILLMENT_FEATURE);
}

/**
 * The cross-subsidiary charge an issue movement settled, if any: the selling
 * entity a return of that shipment is credited in.
 */
export async function crossSubsidiaryShipment(
  runner: SqlExecutor,
  orgId: string,
  issueMovementId: string,
): Promise<{ sellingSubsidiaryId: string; fulfillingSubsidiaryId: string } | null> {
  const row = (
    await runner.execute<{ selling_subsidiary_id: string; fulfilling_subsidiary_id: string }>(
      sql`
    select selling_subsidiary_id, fulfilling_subsidiary_id from intercompany_fulfillment_charges
     where org_id = ${orgId} and movement_id = ${issueMovementId} and kind = 'fulfillment'`,
      "objects",
    )
  )[0];
  return row
    ? {
        sellingSubsidiaryId: row.selling_subsidiary_id,
        fulfillingSubsidiaryId: row.fulfilling_subsidiary_id,
      }
    : null;
}
