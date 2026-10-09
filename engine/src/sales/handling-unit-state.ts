import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { InventoryError } from "../inventory/contracts.ts";

export class PackingRefusal extends InventoryError {
  readonly name = "PackingRefusal";
  readonly status = 409;
  readonly code = "packing_required";
}
export interface HandlingUnit extends Record<string, unknown> {
  id: string;
  org_id: string;
  subsidiary_id: string;
  code: string;
  warehouse_id: string;
  current_stock_location_id: string;
  shipment_document_id: string;
  status: "open" | "packed" | "shipped" | "voided";
  content_version: string;
}
/** Compare physical confirmation with the current shipment before buying a label or posting a shipment. */
export async function assertPackedUnit(
  tx: SqlExecutor,
  orgId: string,
  shipmentId: string,
  unitId: string,
) {
  const unit = (
    await tx.execute<HandlingUnit>(sql`select *,content_version::text from handling_units
    where org_id=${orgId} and shipment_document_id=${shipmentId} and id=${unitId} for update`)
  ).rows[0];
  if (!unit || unit.status !== "packed")
    throw new PackingRefusal(
      "Select a packed handling unit; confirm its carton contents first",
    );
  const proof = (
    await tx.execute<{
      valid: boolean;
    }>(sql`select count(*)>0 and bool_and(coalesce(
      content.confirmed_at is not null and line.id is not null and fl.line_id is not null
      and line.document_id=${shipmentId} and line.item_id=content.item_id
      and line.quantity=content.document_quantity and line.stock_location_id=${unit.current_stock_location_id}
      and fl.carton=${unit.code} and fl.pick_line_id=content.pick_line_id and fl.lot_id is not distinct from content.lot_id
      and fl.serial_id is not distinct from content.serial_id,false)) as valid
    from handling_unit_contents content
    left join document_lines line on line.org_id=content.org_id and line.id=content.shipment_line_id
    left join fulfillment_lines fl on fl.org_id=content.org_id and fl.line_id=content.shipment_line_id
    where content.org_id=${orgId} and content.handling_unit_id=${unit.id}`)
  ).rows[0];
  if (!proof?.valid)
    throw new PackingRefusal(
      "Carton contents changed or remain unconfirmed; restore the confirmed shipment contents or void this shipment and create a replacement",
    );
  return unit;
}

export async function assertShipmentPacked(
  tx: SqlExecutor,
  orgId: string,
  shipmentId: string,
) {
  const required = (
    await tx.execute<{
      execution_required: boolean;
    }>(sql`select execution_required from fulfillment_documents
    where org_id=${orgId} and document_id=${shipmentId}`)
  ).rows[0];
  if (!required)
    throw new PackingRefusal("Shipment execution policy was not found");
  if (!required.execution_required) return;
  const missing = (
    await tx.execute(sql`select line.id from document_lines line
    left join handling_unit_contents content on content.org_id=line.org_id and content.shipment_line_id=line.id
    left join handling_units unit on unit.org_id=content.org_id and unit.id=content.handling_unit_id
    where line.org_id=${orgId} and line.document_id=${shipmentId} and line.item_id is not null
      and (content.confirmed_at is null or unit.status<>'packed') limit 1`)
  ).rows[0];
  if (missing)
    throw new PackingRefusal(
      "Confirm every shipment line in a packed handling unit before shipping",
    );
  const units = (
    await tx.execute<{
      id: string;
    }>(sql`select id from handling_units where org_id=${orgId}
    and shipment_document_id=${shipmentId} and status='packed' order by id`)
  ).rows;
  if (!units.length)
    throw new PackingRefusal(
      "Pack this shipment into a handling unit before shipping",
    );
  for (const unit of units)
    await assertPackedUnit(tx, orgId, shipmentId, unit.id);
}
