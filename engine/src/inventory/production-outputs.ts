import { apportion,fromUnits, toUnits } from '../money/money.ts';
import { InventoryError } from './contracts.ts';

export interface JointProductionOutput { itemId:string;quantity:string;costWeight:string }

/** Relative cost weights are per base unit; the primary output has weight one.
 * Largest remainders preserve every ledger unit without negative residual allocations. */
export function allocateJointProductionCost(total:string,outputs:readonly JointProductionOutput[]):Map<string,string> {
  const value=toUnits(total),seen=new Set<string>();
  if(value<0n||!outputs.length)throw new InventoryError('Joint production requires a non-negative cost and actual output quantities.');
  const rows=outputs.map(output=>{
    const quantity=toUnits(output.quantity),weight=toUnits(output.costWeight);
    if(seen.has(output.itemId)||quantity<=0n||weight<=0n)throw new InventoryError('Every joint output needs a distinct item, positive quantity and positive exact cost weight.');
    seen.add(output.itemId);
    return {itemId:output.itemId,weight:quantity*weight};
  });
  const ordered=[...rows].sort((a,b)=>a.itemId<b.itemId?-1:a.itemId>b.itemId?1:0);
  const shares=apportion(value,ordered.map(row=>row.weight));
  const allocated=new Map(ordered.map((row,index)=>[row.itemId,fromUnits(shares[index]!)]));
  return new Map(rows.map(row=>[row.itemId,allocated.get(row.itemId)!]));
}
