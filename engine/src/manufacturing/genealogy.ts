import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { lockManufacturingReadAuthority } from "./authority.ts";
import { orderResourcesVisible } from "./resource-scope.ts";
import { ManufacturingError, ManufacturingNotFoundError } from "./errors.ts";

export interface GenealogyNode { kind: "lot" | "serial"; id: string }
export interface GenealogyEdge {
  allocationBasis:"recorded"|"proportional"|"work_order";
  componentLotNumber:string|null;componentSerialNumber:string|null;outputLotNumber:string|null;outputSerialNumber:string|null;
  id: string; depth: number; orderId: string; orderNumber: string;
  componentMovementId: string; outputMovementId: string;
  componentItem: string; componentLotId: string | null; componentSerialId: string | null;
  componentIdentity: string | null; componentQuantity: string;
  outputItem: string; outputLotId: string | null; outputSerialId: string | null;
  outputIdentity: string | null; outputQuantity: string;
}

/** Receipt-batch input evidence takes precedence over legacy order associations.
 * Estimated allocations and legacy links remain explicitly distinguished from recorded inputs. */
export async function traceManufacturingGenealogy(
  tx: SqlExecutor, orgId: string, actorId: string,
  input: GenealogyNode & { direction: "forward" | "backward"; maxDepth?: number },
  requestedScope: ReadonlySet<string> | null = null,
) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const scope = await lockManufacturingReadAuthority(tx, orgId, actorId, requestedScope, ["manufacturing.read", "items.read"]);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)
    || !["lot", "serial"].includes(input.kind) || !["forward", "backward"].includes(input.direction)) {
    throw new ManufacturingError("Choose a lot or serial and a trace direction.", { code: "genealogy_identity_required" });
  }
  const depthLimit = input.maxDepth ?? 8;
  if (!Number.isInteger(depthLimit) || depthLimit < 1 || depthLimit > 32)
    throw new ManufacturingError("Trace depth must be between 1 and 32.", { code: "genealogy_depth_invalid" });
  const table = input.kind === "lot" ? sql`lots` : sql`serials`;
  const identityColumn = input.kind === "lot" ? sql`identity.lot_number` : sql`identity.serial_number`;
  const movementColumn = input.kind === "lot" ? sql`movement.lot_id` : sql`movement.serial_id`;
  const seed = (await tx.execute<{ id: string; label: string; itemName: string }>(sql`
    select identity.id,${identityColumn} as label,item.name as "itemName"
    from ${table} identity join items item on item.org_id=identity.org_id and item.id=identity.item_id
    where identity.org_id=${orgId} and identity.id=${input.id} and (${scope === null ? sql`true` : sql`exists (
      select 1 from inventory_movements movement join stock_locations stock on stock.org_id=movement.org_id and stock.id=movement.stock_location_id
      join locations location on location.org_id=stock.org_id and location.id=stock.location_id
      where movement.org_id=identity.org_id and ${movementColumn}=identity.id
      ${subsidiaryVisibleFilter(sql`movement.subsidiary_id`, scope)}
      ${subsidiaryVisibleFilter(sql`location.subsidiary_id`, scope, { orgWideNull: true })})`})
      and not exists(select 1 from inventory_movements movement
        left join stock_locations stock on stock.org_id=movement.org_id and stock.id=movement.stock_location_id
        left join locations location on location.org_id=stock.org_id and location.id=stock.location_id
        where movement.org_id=identity.org_id and ${movementColumn}=identity.id
          and (location.id is null or not(true ${subsidiaryVisibleFilter(sql`movement.subsidiary_id`,scope)})
            or not(true ${subsidiaryVisibleFilter(sql`location.subsidiary_id`,scope,{orgWideNull:true})})))
      and not exists(select 1 from consignment_stock owner where owner.org_id=identity.org_id
        and ${input.kind==='lot'?sql`owner.lot_id`:sql`owner.serial_id`}=identity.id
        and not(true ${subsidiaryVisibleFilter(sql`owner.subsidiary_id`,scope)}))`)).rows[0];
  if (!seed) throw new ManufacturingNotFoundError();
  const visited = new Set<string>();
  const seenEdges = new Set<string>();
  const edges: GenealogyEdge[] = [];
  let frontier: GenealogyNode[] = [{ kind: input.kind, id: input.id }];
  let truncated = false;
  for (let depth = 1; depth <= depthLimit && frontier.length; depth++) {
    const next = new Map<string, GenealogyNode>();
    for (const node of frontier) {
      const key = `${node.kind}:${node.id}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const tracked = input.direction === "forward" ? "component" : "output";
      const nodeColumn = sql.raw(`${tracked}.${node.kind === "lot" ? "lot_id" : "serial_id"}`);
      const rows = (await tx.execute<Omit<GenealogyEdge, "depth">>(sql`
        select coalesce(batch.allocation_basis,'work_order') as "allocationBasis",
          cl.lot_number as "componentLotNumber",cs.serial_number as "componentSerialNumber",ol.lot_number as "outputLotNumber",os.serial_number as "outputSerialNumber",
          component.id::text || ':' || output.id::text as id,work.id as "orderId",work.number as "orderNumber",
          component.id as "componentMovementId",output.id as "outputMovementId",
          ci.name as "componentItem",component.lot_id as "componentLotId",component.serial_id as "componentSerialId",
          concat_ws(' / ',cl.lot_number,cs.serial_number) as "componentIdentity",coalesce(allocation.quantity,-component.quantity)::text as "componentQuantity",
          oi.name as "outputItem",output.lot_id as "outputLotId",output.serial_id as "outputSerialId",
          concat_ws(' / ',ol.lot_number,os.serial_number) as "outputIdentity",output.quantity::text as "outputQuantity"
        from inventory_movements component
        join journal_entries ce on ce.org_id=component.org_id and ce.id=component.journal_entry_id and ce.origin='manufacturing' and ce.status='posted'
        join mfg_work_orders work on work.org_id=ce.org_id and work.number=ce.custom->>'work_order_number'
        join journal_entries oe on oe.org_id=work.org_id and oe.custom->>'work_order_number'=work.number and oe.origin='manufacturing' and oe.status='posted'
        join inventory_movements output on output.org_id=oe.org_id and output.journal_entry_id=oe.id
        left join mfg_completion_batches batch on batch.org_id=oe.org_id and batch.completion_entry_id=oe.id and batch.work_order_id=work.id
        left join mfg_completion_inputs allocation on allocation.org_id=batch.org_id and allocation.completion_entry_id=batch.completion_entry_id and allocation.input_movement_id=component.id
        join items ci on ci.org_id=component.org_id and ci.id=component.item_id
        join items oi on oi.org_id=output.org_id and oi.id=output.item_id
        join stock_locations cstock on cstock.org_id=component.org_id and cstock.id=component.stock_location_id
        join locations cplace on cplace.org_id=cstock.org_id and cplace.id=cstock.location_id
        join stock_locations ostock on ostock.org_id=output.org_id and ostock.id=output.stock_location_id
        join locations oplace on oplace.org_id=ostock.org_id and oplace.id=ostock.location_id
        left join lots cl on cl.org_id=component.org_id and cl.id=component.lot_id
        left join serials cs on cs.org_id=component.org_id and cs.id=component.serial_id
        left join lots ol on ol.org_id=output.org_id and ol.id=output.lot_id
        left join serials os on os.org_id=output.org_id and os.id=output.serial_id
        where work.org_id=${orgId} and ${nodeColumn}=${node.id}
          and (batch.id is null or allocation.id is not null)
          and component.kind='assembly_consume' and component.status='posted' and component.reverses_movement_id is null
          and output.kind='assembly_build' and output.status='posted' and output.reverses_movement_id is null
          and not exists(select 1 from inventory_movements reversal where reversal.org_id=component.org_id and reversal.reverses_movement_id=component.id and reversal.status='posted')
          and not exists(select 1 from inventory_movements reversal where reversal.org_id=output.org_id and reversal.reverses_movement_id=output.id and reversal.status='posted')
          ${subsidiaryVisibleFilter(sql`work.subsidiary_id`, scope)} ${orderResourcesVisible(scope, "work")}
          ${subsidiaryVisibleFilter(sql`component.subsidiary_id`, scope)} ${subsidiaryVisibleFilter(sql`output.subsidiary_id`, scope)}
          ${subsidiaryVisibleFilter(sql`cplace.subsidiary_id`, scope, { orgWideNull: true })}
          ${subsidiaryVisibleFilter(sql`oplace.subsidiary_id`, scope, { orgWideNull: true })}
        order by work.number,component.id,output.id limit 251`)).rows;
      if (rows.length > 250 || edges.length + rows.filter(row => !seenEdges.has(row.id)).length > 1000) {
        truncated = true;
        break;
      }
      for (const row of rows) {
        if (!seenEdges.has(row.id)) { edges.push({ ...row, depth }); seenEdges.add(row.id); }
        const lotId = input.direction === "forward" ? row.outputLotId : row.componentLotId;
        const serialId = input.direction === "forward" ? row.outputSerialId : row.componentSerialId;
        for (const target of [{ kind: "lot" as const, id: lotId }, { kind: "serial" as const, id: serialId }]) {
          if (target.id && !visited.has(`${target.kind}:${target.id}`)) next.set(`${target.kind}:${target.id}`, { kind: target.kind, id: target.id });
        }
      }
    }
    if (truncated) break;
    frontier = [...next.values()];
    if (depth === depthLimit && frontier.length) truncated = true;
  }
  return { seed, direction: input.direction, association: "receipt_evidence" as const, visibility: scope === null ? "organization" as const : "authorized_entities" as const, truncated, edges };
}
