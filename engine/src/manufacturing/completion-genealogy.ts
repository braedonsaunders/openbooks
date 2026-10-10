import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { fromUnits, roundDiv, toUnits } from "../money/money.ts";
import { isUuid } from "../platform/uuid.ts";
import { ManufacturingError } from "./errors.ts";
import { auditChange, decimalValue } from "./master-support.ts";

export interface CompletionComponentSelection { movementId: string; quantity: string }
type Source = { id: string; itemId: string; quantity: string; assigned: string };
const fail = (message: string): never => { throw new ManufacturingError(message,{code:"completion_genealogy_refused",status:409,remedy:"Review the posted material issues and prior receipt batches; select only unassigned component quantities from this work order."}); };

/** A receipt batch records its inputs independently of financial WIP allocation.
 * Recorded selections identify actual inputs; automatic proportional allocation
 * is explicitly retained as an estimate, never presented as observed genealogy. */
export async function recordCompletionGenealogy(
  tx: SqlExecutor, orgId: string, actorId: string,
  input: {workOrderId:string;orderNumber:string;entryId:string;quantity:string;remainingGood:string;final:boolean;components?:CompletionComponentSelection[]},
) {
  const sources = (await tx.execute<Source>(sql`
    select movement.id,movement.item_id as "itemId",(-movement.quantity)::text as quantity,
      coalesce((select sum(allocation.quantity) from mfg_completion_inputs allocation
        join journal_entries receipt on receipt.org_id=allocation.org_id and receipt.id=allocation.completion_entry_id
        where allocation.org_id=movement.org_id and allocation.input_movement_id=movement.id
          and receipt.status='posted' and receipt.reverses_entry_id is null),0)::text as assigned
    from inventory_movements movement join journal_entries entry on entry.org_id=movement.org_id and entry.id=movement.journal_entry_id
    where movement.org_id=${orgId} and movement.kind='assembly_consume' and movement.status='posted'
      and movement.reverses_movement_id is null and entry.origin='manufacturing' and entry.status='posted'
      and entry.custom->>'work_order_number'=${input.orderNumber}
      and not exists(select 1 from inventory_movements reversal where reversal.org_id=movement.org_id and reversal.reverses_movement_id=movement.id and reversal.status='posted')
    order by entry.created_at,entry.id,movement.id for share of movement,entry`)).rows;
  const remaining = new Map(sources.map(source=>[source.id,toUnits(source.quantity)-toUnits(source.assigned)]));
  if ([...remaining.values()].some(quantity=>quantity<0n)) fail("A material issue is assigned beyond its posted quantity.");
  const allocations: Array<{movementId:string;quantity:string}> = [];
  if (input.components !== undefined) {
    if (!Array.isArray(input.components) || input.components.length<1 || input.components.length>500) fail("Record between one and 500 component selections for this receipt batch.");
    const seen = new Set<string>();
    for (const selection of input.components) {
      if (!isUuid(selection.movementId) || seen.has(selection.movementId)) fail("Choose distinct posted component movements.");
      seen.add(selection.movementId);
      const quantity=toUnits(decimalValue(selection.quantity,"component allocation","Enter a positive exact component quantity."));
      const available=remaining.get(selection.movementId);
      if (available===undefined || quantity<=0n || quantity>available) fail("A selected component quantity is unavailable or already assigned to another live receipt batch.");
      allocations.push({movementId:selection.movementId,quantity:fromUnits(quantity)});
      remaining.set(selection.movementId,available-quantity);
    }
    if (input.final && [...remaining.values()].some(quantity=>quantity>0n)) fail("The final receipt must account for all remaining issued components, including normal batch loss.");
  } else {
    const byItem = new Map<string,Source[]>();
    for (const source of sources) byItem.set(source.itemId,[...(byItem.get(source.itemId)??[]),source]);
    const denominator=toUnits(input.remainingGood);
    if (denominator<=0n) fail("No good output remains for component allocation.");
    for (const group of byItem.values()) {
      const available=group.reduce((quantity,source)=>quantity+remaining.get(source.id)!,0n);
      let target=input.final ? available : roundDiv(available*toUnits(input.quantity),denominator);
      if (target>available) target=available;
      for (const source of group) {
        const quantity=remaining.get(source.id)!<target ? remaining.get(source.id)! : target;
        if (quantity>0n) allocations.push({movementId:source.id,quantity:fromUnits(quantity)});
        target-=quantity;
        if (target===0n) break;
      }
    }
  }
  // A marker also distinguishes genuinely empty-input batches from legacy receipts with no captured evidence.
  const marker=await tx.execute<{id:string}>(sql`insert into mfg_completion_batches(org_id,work_order_id,completion_entry_id,allocation_basis,quantity,created_by,updated_by)
    values(${orgId},${input.workOrderId},${input.entryId},${input.components===undefined ? "proportional" : "recorded"},${input.quantity},${actorId},${actorId}) returning id`);
  if (marker.rows.length!==1) fail("The completion batch evidence was not stored.");
  for (const allocation of allocations) {
    const inserted=await tx.execute<{id:string}>(sql`insert into mfg_completion_inputs(org_id,work_order_id,completion_entry_id,input_movement_id,quantity,created_by,updated_by)
      values(${orgId},${input.workOrderId},${input.entryId},${allocation.movementId},${allocation.quantity},${actorId},${actorId}) returning id`);
    if (inserted.rows.length!==1) fail("A completion input was not stored.");
  }
  await auditChange(tx,{orgId,actorId,table:"mfg_completion_batches",rowId:marker.rows[0]!.id,action:"insert",before:null,after:{...input,allocationBasis:input.components===undefined ? "proportional" : "recorded",components:allocations}});
}
