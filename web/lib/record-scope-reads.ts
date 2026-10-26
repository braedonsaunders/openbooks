import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";

/**
 * Small identity reads route handlers run before calling a native command:
 * which document, project or subcontract a request names, and the entity it
 * belongs to, so the route can apply the caller's subsidiary scope. Kept
 * here so route modules hold no SQL of their own.
 */

/** A document's kind, status and entity, optionally locked for the caller's transaction. */
export async function readDocumentScope(
  orgId: string,
  documentId: string,
  options: { kind?: string; lock?: boolean } = {},
): Promise<{ kind: string; status: string; subsidiaryId: string | null } | null> {
  return (
    (
      await db.execute<{ kind: string; status: string; subsidiaryId: string | null }>(
        sql`
    select kind, status, subsidiary_id as "subsidiaryId"
      from documents
     where id = ${documentId} and org_id = ${orgId}
       ${options.kind ? sql`and kind = ${options.kind}` : sql``}
       ${options.lock ? sql`for update` : sql``}`,
        "objects",
      )
    )[0] ?? null
  );
}

/** A project's entity, or null when the project is not in the organization. */
export async function readProjectSubsidiary(
  orgId: string,
  projectId: string,
): Promise<{ subsidiaryId: string | null } | null> {
  return (
    (
      await db.execute<{ subsidiaryId: string | null }>(
        sql`
    select subsidiary_id as "subsidiaryId" from projects where org_id = ${orgId} and id = ${projectId}`,
        "objects",
      )
    )[0] ?? null
  );
}

/** Whether a production subcontract belongs to the named work order. */
export async function subcontractBelongsToWorkOrder(
  orgId: string,
  subcontractId: string,
  workOrderId: string,
): Promise<boolean> {
  return (
    (
      await db.execute(
        sql`
    select id from mfg_subcontracts where org_id = ${orgId} and id = ${subcontractId} and work_order_id = ${workOrderId}`,
        "objects",
      )
    ).length > 0
  );
}

/** Active, non-elimination entities, root first — the default entity a new record lands in. */
export async function activeOperatingSubsidiaryIds(orgId: string): Promise<string[]> {
  return (
    await db.execute<{ id: string }>(
      sql`
    select id from subsidiaries
     where org_id = ${orgId} and is_active and not is_elimination
     order by (parent_id is null) desc, name`,
      "objects",
    )
  ).map((row) => row.id);
}

/** The organization's display name. */
export async function readOrgName(orgId: string): Promise<string> {
  return (
    (
      await db.execute<{ name: string }>(sql`select name from orgs where id = ${orgId}`, "objects")
    )[0]?.name ?? ""
  );
}

/** A purchase order's lines with their item kind and category, for the receive form. */
export async function readPurchaseOrderLinesForReceipt(orgId: string, purchaseOrderId: string) {
  return await db.execute<{
    id: string;
    line_number: number;
    item_id: string | null;
    description: string | null;
    unit: string | null;
    unit_price: string;
    quantity: string;
    quantity_fulfilled: string;
    quantity_cancelled: string;
    stock_location_id: string | null;
    item_kind: string | null;
    item_category: string | null;
  }>(
    sql`
    select line.id, line.line_number, line.item_id, line.description, line.unit, line.unit_price,
           line.quantity, line.quantity_fulfilled, line.quantity_cancelled,
           line.stock_location_id, i.kind as item_kind,
           i.category as item_category
      from document_lines line
      left join items i on i.id = line.item_id and i.org_id = line.org_id
     where line.org_id = ${orgId} and line.document_id = ${purchaseOrderId}
     order by line.line_number
  `,
    "objects",
  );
}
