import { cmp, fitsLedgerRange, toUnits } from "../money/money.ts";
import { InventoryError } from "./contracts.ts";

export interface InspectionMeasure { key:string; label:string; unit:string; required:boolean; minimum?:string|null; maximum?:string|null }
export interface InspectionPlanSnapshot { id:string; name:string; point:"receipt"|"operation"; operationSequence:number|null; measures:InspectionMeasure[] }

export function inspectionDecimal(value:unknown, label:string):string {
  if (typeof value!=="string" || !/^-?\d+(?:\.\d{1,4})?$/.test(value) || !fitsLedgerRange(value)) throw new InventoryError(`${label} must be an exact number with at most four decimal places.`);
  toUnits(value);
  return value;
}
export function inspectionMeasures(value:unknown):InspectionMeasure[] {
  if (!Array.isArray(value) || value.length>100) throw new InventoryError("An inspection plan supports at most 100 measurements.");
  const seen=new Set<string>();
  return value.map(raw=>{
    if (!raw || typeof raw!=="object" || typeof raw.key!=="string" || !/^[a-z][a-z0-9_]{0,63}$/.test(raw.key) || seen.has(raw.key)) throw new InventoryError("Give each measurement a distinct key beginning with a letter.");
    seen.add(raw.key);
    if (typeof raw.label!=="string" || !raw.label.trim() || raw.label.length>200 || typeof raw.unit!=="string" || raw.unit.length>40 || typeof raw.required!=="boolean") throw new InventoryError("Each measurement requires a label, unit and required setting.");
    const minimum=raw.minimum==null ? null : inspectionDecimal(raw.minimum,"Minimum"), maximum=raw.maximum==null ? null : inspectionDecimal(raw.maximum,"Maximum");
    if (minimum!==null && maximum!==null && cmp(minimum,maximum)>0) throw new InventoryError("The measurement minimum cannot exceed its maximum.");
    return {key:raw.key,label:raw.label.trim(),unit:raw.unit.trim(),required:raw.required,minimum,maximum};
  });
}
/** Limits are frozen with the inspection. An operator cannot pass an out-of-range measurement. */
export function inspectionOutcome(plan:InspectionPlanSnapshot, declared:"pass"|"fail", measurements:Record<string,string>):"pass"|"fail" {
  if (declared!=="pass" && declared!=="fail") throw new InventoryError("Choose pass or fail.");
  if (!measurements || typeof measurements!=="object" || Array.isArray(measurements)) throw new InventoryError("Enter the inspection measurements.");
  const keys=new Set(plan.measures.map(measure=>measure.key));
  if (Object.keys(measurements).some(key=>!keys.has(key))) throw new InventoryError("A measurement is not part of this inspection plan.");
  let outcome=declared;
  for (const measure of plan.measures) {
    const supplied=measurements[measure.key];
    if (supplied===undefined || supplied==="") {
      if (measure.required) throw new InventoryError(`Enter ${measure.label} (${measure.unit}).`);
      continue;
    }
    const value=inspectionDecimal(supplied,measure.label);
    if ((measure.minimum!=null && cmp(value,measure.minimum)<0) || (measure.maximum!=null && cmp(value,measure.maximum)>0)) outcome="fail";
  }
  return outcome;
}
