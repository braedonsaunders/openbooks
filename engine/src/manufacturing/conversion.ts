import { type TimeCommandPermission, lockTimeWorkOrderTarget } from '../projects/time-work-target.ts'
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts'
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { add, cmp, fromUnits, isZero, neg, roundDiv, sum, toUnits } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import type { Runner } from "../inventory/contracts.ts";
import { assertInventoryAccountsPostable, type JournalLineInput } from "../inventory/journal.ts";
import { periodForDate, primaryBookId, subsidiaryCurrency } from "../inventory/position.ts";
import { calculateStandardOverheadAmounts, type StandardOverheadCard } from "../allocations/overhead-post.ts";
import { ManufacturingError } from "./errors.ts";
import { decimalValue } from "./master-support.ts";
import { manufacturingControlAccount, postManufacturingEntry } from "./journal.ts";

/**
 * Conversion-cost absorption: the labor, machine and overhead a work order
 * consumes become part of its WIP and therefore of the finished goods it
 * produces (IAS 2 / ASC 330 cost of conversion). Every completed operation
 * posts Dr Manufacturing WIP / Cr Labor Clearing (labor) / Cr Manufacturing
 * Overhead Applied (machine time and overhead). Rates come from the release
 * snapshot (standard labor rate, standard overhead cards) and the work
 * center's effective-dated machine rate. A required rate or account that is
 * not configured refuses by name; nothing is absorbed at zero by default.
 */

const MINUTES_PER_HOUR = 60n;
const MONEY_SCALE = 10_000n;

export interface OperationTimeInput {
  actualSetupMinutes?: string | null;
  actualRunMinutes?: string | null;
  actualLaborMinutes?: string | null;
}

type CenterKind = "machine" | "labor" | "cell";

type OperationCostRow = {
  id: string; sequence: number; status: string; work_center_id: string;
  planned_setup_minutes: string; planned_run_minutes: string; quantity_planned: string;
  standard_labor_final_rate: string | null;
  overhead_snapshot: { basis?: string; cards?: Array<{ id: string; rate: string; kind: string; category: string | null; effectiveFrom: string; effectiveTo: string | null }> } | null;
  center_code: string; center_kind: CenterKind; absorbs_overhead: boolean;
  labor_minutes_per_unit: string | null; labor_time_source: "operation" | "approved_time";
};

export type ConversionOrder = {
  id: string; number: string; subsidiary_id: string | null; quantity_ordered: string;
  bom_revision: string | null; routing_version: number | null;
};

function refuse(message: string, code: string, remedy: string, status = 422): never {
  throw new ManufacturingError(message, { status, code, remedy });
}

/** rate per hour x minutes, rounded once to ledger precision. */
function priceMinutes(ratePerHour: string, minutes: string): string {
  return fromUnits(roundDiv(toUnits(ratePerHour) * toUnits(minutes), MINUTES_PER_HOUR * MONEY_SCALE));
}

function scale(value: string, numerator: string, denominator: string): string {
  const d = toUnits(denominator);
  if (d <= 0n) return "0.0000";
  return fromUnits(roundDiv(toUnits(value) * toUnits(numerator), d));
}

function usesMachine(kind: CenterKind): boolean { return kind === "machine" || kind === "cell"; }
function usesLabor(kind: CenterKind): boolean { return kind === "labor" || kind === "cell"; }

async function loadOperationCost(tx: SqlExecutor, orgId: string, workOrderId: string, operationId?: string): Promise<OperationCostRow[]> {
  return (await tx.execute<OperationCostRow>(sql`
    select operation.id, operation.sequence, operation.status, operation.work_center_id,
           operation.planned_setup_minutes::text as planned_setup_minutes,
           operation.planned_run_minutes::text as planned_run_minutes,
           operation.quantity_planned::text as quantity_planned,
           operation.standard_labor_final_rate::text as standard_labor_final_rate,
           operation.overhead_snapshot,
           coalesce(nullif(btrim(center.code), ''), center.id::text) as center_code,
           center.kind as center_kind, center.absorbs_overhead,
           operation.labor_minutes_per_unit::text as labor_minutes_per_unit,operation.labor_time_source
      from mfg_wo_operations operation
      join mfg_work_centers center on center.org_id=operation.org_id and center.id=operation.work_center_id
     where operation.org_id=${orgId} and operation.work_order_id=${workOrderId}
       ${operationId ? sql`and operation.id=${operationId}` : sql``}
     order by operation.sequence`)).rows;
}

/** Approved employee captures are the labor quantity; elapsed machine minutes remain independent. */
async function approvedOperationTime(tx:SqlExecutor,orgId:string,workOrderId:string,operationId:string) {
  const unassigned=(await tx.execute(sql`select id from time_entries where org_id=${orgId} and work_order_id=${workOrderId} and wo_operation_id is null limit 1`)).rows[0]
  if (unassigned) refuse("This order has employee time with no operation.","production_time_unassigned","Assign the order's time lines to operations before completing an operation that consumes approved time.",409)
  const rows=(await tx.execute<{id:string;hours:string;status:string;consumed:string|null}>(sql`
    select id,hours::text,status,production_consumed_operation_id as consumed from time_entries
    where org_id=${orgId} and work_order_id=${workOrderId} and wo_operation_id=${operationId} order by id for update`)).rows
  if (!rows.length) refuse("No employee time has been recorded for this operation.","production_time_missing","Record and approve the employee hours in Production → Time before completing this operation.",409)
  if (rows.some(row=>row.status!=='approved')) refuse("This operation still has unapproved employee time.","production_time_unapproved","Submit and approve the operation's employee hours before completing it.",409)
  if (rows.some(row=>row.consumed)) refuse("The operation's employee time has already been consumed.","production_time_already_consumed","Reload the order; use a governed time correction for consumed hours.",409)
  const hours=sum(rows.map(row=>row.hours))
  if (cmp(hours,'0')<0) refuse("The operation's net employee time cannot be negative.","production_time_negative","Correct the operation's time lines before completion.")
  return {ids:rows.map(row=>row.id),entries:rows.map(row=>({id:row.id,hours:row.hours})),laborMinutes:fromUnits(toUnits(hours)*MINUTES_PER_HOUR)}
}
async function claimOperationTime(tx:SqlExecutor,orgId:string,actorId:string,operationId:string,ids:string[],entryId:string|null) {
  if (!ids.length) return
  const claim=await tx.execute(sql`update time_entries set production_consumed_operation_id=${operationId},cost_journal_entry_id=${entryId},updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and id=any(${`{${ids.join(',')}}`}::uuid[]) and status='approved' and production_consumed_operation_id is null and cost_journal_entry_id is null returning id`)
  if(claim.rows.length!==ids.length) refuse("Employee time changed during operation completion.","production_time_claim_conflict","Reload the operation and its time entries; nothing was completed.",409)
  for(const id of ids) if((await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'time_entries',${id},'update',${JSON.stringify({event:'production_time_consumed',operationId,journalEntryId:entryId})}::jsonb,${actorId}) returning id`)).rows.length!==1) refuse('Employee time consumption was not audited.','production_time_claim_conflict','Retry operation completion; no hours or costs were consumed.',409)
}

/** Labor and machine minutes for an operation producing `quantity` units. */
function operationMinutes(
  operation: OperationCostRow, quantity: string, setupMinutes: string, runMinutes: string, laborOverride?: string | null,
): { laborMinutes: string; machineMinutes: string } {
  const elapsed = add(setupMinutes, runMinutes);
  const machineMinutes = usesMachine(operation.center_kind) ? elapsed : "0.0000";
  let laborMinutes: string;
  if (laborOverride != null) laborMinutes = laborOverride;
  // A routing that states operator minutes per unit owns labor time; else a
  // labor or cell center is staffed for the whole elapsed time and an
  // unattended machine center consumes no operator time.
  else if (operation.labor_minutes_per_unit != null) laborMinutes = fromUnits(roundDiv(toUnits(operation.labor_minutes_per_unit) * toUnits(quantity), MONEY_SCALE));
  else laborMinutes = usesLabor(operation.center_kind) ? elapsed : "0.0000";
  return { laborMinutes, machineMinutes };
}

/** Completion, costing and setup resolve the same effective machine policy. */
export async function resolveMachineRate(tx:SqlExecutor,orgId:string,centerId:string,onDate:string,label:string):Promise<{id:string;rate:string}> {
  const rows=(await tx.execute<{id:string;rate:string}>(sql`select id,machine_rate_per_hour::text as rate from mfg_work_center_rates where org_id=${orgId} and work_center_id=${centerId} and effective_from<=${onDate}::date and (effective_to is null or effective_to>${onDate}::date) order by effective_from,id for share`)).rows;
  if(rows.length!==1) refuse(`Work center ${label} requires one effective machine rate covering ${onDate}.`,"machine_rate_missing",`Review the effective machine rates on work center ${label} before recording conversion cost.`);
  return rows[0]!;
}
async function machineRate(tx:SqlExecutor,orgId:string,operation:OperationCostRow,onDate:string) {
  return resolveMachineRate(tx,orgId,operation.work_center_id,onDate,operation.center_code);
}

function overheadCards(operation: OperationCostRow, orderNumber: string): StandardOverheadCard[] {
  const snapshot = operation.overhead_snapshot;
  const cards = snapshot?.cards ?? [];
  if (!snapshot || cards.length === 0) {
    refuse(`Work center ${operation.center_code} absorbs overhead, but operation ${operation.sequence} of work order ${orderNumber} was released with no standard overhead rate.`,
      "standard_overhead_rate_missing",
      `Add a standard overhead rate for the work center's department under Company Settings → Overhead and release a replacement work order, or turn off overhead absorption on work center ${operation.center_code} before completing the operation.`);
  }
  return cards.map((card) => ({
    id: card.id, orgId: "", departmentId: null, category: card.category, method: "standard" as const,
    rateKind: card.kind as StandardOverheadCard["rateKind"], ratePercent: card.rate,
    effectiveFrom: card.effectiveFrom, effectiveTo: card.effectiveTo,
  }));
}

/** Overhead for one operation on its frozen basis. Hour bases price minutes exactly. */
function overheadAmount(operation: OperationCostRow, orderNumber: string, quantity: string, laborMinutes: string, machineMinutes: string): string {
  if (!operation.absorbs_overhead) return "0.0000";
  const cards = overheadCards(operation, orderNumber);
  const basis = operation.overhead_snapshot?.basis;
  if (basis === "units") return calculateStandardOverheadAmounts(cards, quantity).total;
  const minutes = basis === "machine_hours" ? machineMinutes : laborMinutes;
  return sum(cards.map((card) => priceMinutes(card.ratePercent, minutes)));
}

function laborAmount(operation: OperationCostRow, orderNumber: string, laborMinutes: string): string {
  if (isZero(laborMinutes)) return "0.0000";
  if (operation.standard_labor_final_rate == null) {
    refuse(`Operation ${operation.sequence} of work order ${orderNumber} has labor time but no frozen standard labor rate.`,
      "standard_labor_rate_missing", "Release a replacement work order after configuring a standard labor rate under Company Settings → Labor costing.");
  }
  return priceMinutes(operation.standard_labor_final_rate, laborMinutes);
}

/**
 * Resolve the time an operation consumed and absorb its conversion cost into
 * WIP. Reported actual minutes win; otherwise the routing's standard time for
 * the completed quantity is used and the evidence says so. Returns the
 * minutes to persist on the operation and the posted entry (null when the
 * operation consumed nothing that carries a cost).
 */
async function resolveOperationConversion(tx:SqlExecutor,orgId:string,order:ConversionOrder,operationId:string,doneQty:string,input:OperationTimeInput,onDate?:string) {
  const operation = (await loadOperationCost(tx, orgId, order.id, operationId))[0];
  if (!operation) refuse("The work-order operation was not found.", "operation_not_found", "Reload the work order and retry.", 404);
  const reported = (value: string | null | undefined, field: string) => {
    if (value == null) return null;
    const minutes = decimalValue(value, field, "Enter non-negative minutes with no more than four decimal places.");
    if (cmp(minutes, "0") < 0) refuse(`${field} for operation ${operation.sequence} cannot be negative.`, "invalid_operation_minutes", "Enter non-negative minutes.");
    return minutes;
  };
  const actualSetup = reported(input.actualSetupMinutes, "actualSetupMinutes");
  const actualRun = reported(input.actualRunMinutes, "actualRunMinutes");
  const actualLabor = reported(input.actualLaborMinutes, "actualLaborMinutes");
  const setupMinutes = actualSetup ?? operation.planned_setup_minutes;
  const runMinutes = actualRun ?? scale(operation.planned_run_minutes, doneQty, operation.quantity_planned);
  if (operation.labor_time_source==='approved_time' && actualLabor!==null) refuse("This operation takes labor from approved employee time.","production_time_override_refused","Correct the shared employee time instead of entering another labor quantity.")
  const approvedTime=operation.labor_time_source==='approved_time' ? await approvedOperationTime(tx,orgId,order.id,operationId) : null
  const { laborMinutes, machineMinutes } = operationMinutes(operation, doneQty, setupMinutes, runMinutes, approvedTime?.laborMinutes ?? actualLabor);
  const timeBasis = approvedTime ? "approved_time" : actualSetup !== null || actualRun !== null || actualLabor !== null ? "reported" : "standard";

  const date = onDate ?? await businessToday(orgId);
  const labor = laborAmount(operation, order.number, laborMinutes);
  const machine = usesMachine(operation.center_kind) && !isZero(machineMinutes)
    ? await machineRate(tx, orgId, operation, date) : null;
  const machineCost = machine ? priceMinutes(machine.rate, machineMinutes) : "0.0000";
  const overhead = overheadAmount(operation, order.number, doneQty, laborMinutes, machineMinutes);
  const applied = add(machineCost, overhead);
  const total = add(labor, applied);
  const result = { entryId: null as string | null, setupMinutes, runMinutes, laborMinutes };
  return {operation,approvedTime,timeBasis,date,labor,machine,machineCost,overhead,applied,total,result,machineMinutes};
}

/** Governed loss previews reuse the native conversion algorithm and frozen release rates. */
export async function previewOperationConversion(tx:SqlExecutor,orgId:string,order:ConversionOrder,operationId:string,doneQty:string,input:OperationTimeInput,onDate:string) {
  const cost=await resolveOperationConversion(tx,orgId,order,operationId,doneQty,input,onDate);
  return {operation:cost.operation,approvedTime:cost.approvedTime,timeBasis:cost.timeBasis,date:cost.date,labor:cost.labor,machine:cost.machine,machineCost:cost.machineCost,overhead:cost.overhead,total:cost.total,setupMinutes:cost.result.setupMinutes,runMinutes:cost.result.runMinutes,laborMinutes:cost.result.laborMinutes};
}

export async function absorbOperationConversion(
  tx: SqlExecutor, orgId: string, actorId: string, order: ConversionOrder, operationId: string,
  doneQty: string, input: OperationTimeInput, options?:{onDate?:string},
): Promise<{ entryId: string | null; setupMinutes: string; runMinutes: string; laborMinutes: string }> {
  const {operation,approvedTime,timeBasis,date,labor,machine,machineCost,overhead,applied,total,result,machineMinutes}=await resolveOperationConversion(tx,orgId,order,operationId,doneQty,input,options?.onDate);
  const {setupMinutes,runMinutes,laborMinutes}=result;
  if (isZero(total)) {
    if(approvedTime) await claimOperationTime(tx,orgId,actorId,operationId,approvedTime.ids,null)
    return result
  }

  const prior = (await tx.execute<{ id: string }>(sql`
    select id from journal_entries where org_id=${orgId} and origin='manufacturing'
      and custom->>'work_order_number'=${order.number} and custom->>'operation_id'=${operationId}
      and custom ? 'conversion_labor_amount' limit 1`)).rows[0];
  if (prior) return { ...result, entryId: prior.id };

  if (!order.subsidiary_id || !order.bom_revision || order.routing_version === null) {
    refuse(`Work order ${order.number} is missing its released posting evidence.`, "work_order_snapshot_missing", "Release a new work order from a valid BOM and routing version.", 409);
  }
  const wipId = await manufacturingControlAccount(tx, orgId, order.subsidiary_id, "mfgWip");
  const lines: JournalLineInput[] = [{ accountId: wipId, amount: total, memo: `${order.number} operation ${operation.sequence} conversion cost` }];
  if (!isZero(labor)) {
    const clearing = await manufacturingControlAccount(tx, orgId, order.subsidiary_id, "laborClearing");
    lines.push({ accountId: clearing, amount: neg(labor), memo: `${order.number} operation ${operation.sequence} labor absorbed` });
  }
  if (!isZero(applied)) {
    const appliedId = await manufacturingControlAccount(tx, orgId, order.subsidiary_id, "mfgOverheadApplied");
    lines.push({ accountId: appliedId, amount: neg(applied), memo: `${order.number} operation ${operation.sequence} machine and overhead absorbed` });
  }
  await assertInventoryAccountsPostable(tx as Runner, orgId, lines.map((line) => line.accountId));
  const periodId = await periodForDate(orgId, date, tx as Runner);
  if (!periodId) refuse(`No accounting period covers ${date}.`, "posting_period_missing", "Open an accounting period for the operation completion date.");
  const entryId = await postManufacturingEntry(tx as Runner, {
    orgId, bookId: await primaryBookId(orgId, tx as Runner), subsidiaryId: order.subsidiary_id, actorId,
    currency: await subsidiaryCurrency(orgId, order.subsidiary_id, tx as Runner), periodId, date,
    entryNumber: `MFG-CONV-${date}-${randomUUID().slice(0, 12)}`,
    memo: `Conversion cost for work order ${order.number} operation ${operation.sequence}`, lines,
    custom: {
      workOrderNumber: order.number, bomRevision: order.bom_revision, routingVersion: String(order.routing_version),
      operation_id: operationId, operation_sequence: String(operation.sequence),
      conversion_labor_amount: labor, conversion_overhead_amount: applied,
      conversion: {
        timeBasis, timeEntryIds: approvedTime?.ids ?? [], quantity: doneQty, setupMinutes, runMinutes, laborMinutes, machineMinutes,
        laborRate: operation.standard_labor_final_rate, laborAmount: labor,
        machineRateId: machine?.id ?? null, machineRate: machine?.rate ?? null, machineAmount: machineCost,
        overheadBasis: operation.absorbs_overhead ? operation.overhead_snapshot?.basis ?? null : null, overheadAmount: overhead,
      },
    },
  });
  if(approvedTime) await claimOperationTime(tx,orgId,actorId,operationId,approvedTime.ids,entryId)
  return { ...result, entryId };
}

/**
 * The conversion cost a completion relieves from WIP and, for standard-cost
 * output, the standard conversion allowed for the completed quantity on the
 * operations already done. Absorbed and relieved amounts are read from the
 * work order's live (unreversed) entries, so a reversed completion returns
 * its share to WIP.
 */
export async function conversionRelief(
  tx: SqlExecutor, orgId: string, order: ConversionOrder, quantity: string, remainingQuantity: string, final: boolean,
  withStandard: boolean,
): Promise<{ relievedLabor: string; relievedOverhead: string; standardLabor: string; standardOverhead: string }> {
  const totals = (await tx.execute<{ absorbed_labor: string; absorbed_overhead: string; relieved_labor: string; relieved_overhead: string }>(sql`
    select coalesce(sum(case when custom->>'conversion_disposition'='variance' then 0 else (custom->>'conversion_labor_amount')::numeric end), 0)::text as absorbed_labor,
           coalesce(sum(case when custom->>'conversion_disposition'='variance' then 0 else (custom->>'conversion_overhead_amount')::numeric end), 0)::text as absorbed_overhead,
           coalesce(sum((custom->>'relieved_labor')::numeric), 0)::text as relieved_labor,
           coalesce(sum((custom->>'relieved_overhead')::numeric), 0)::text as relieved_overhead
      from journal_entries where org_id=${orgId} and origin='manufacturing'
       and custom->>'work_order_number'=${order.number}
       -- Live entries only: reversal entries repeat the original conversion evidence, so both must be excluded.
       and status='posted' and reverses_entry_id is null`)).rows[0]!;
  const openLabor = add(totals.absorbed_labor, neg(totals.relieved_labor));
  const openOverhead = add(totals.absorbed_overhead, neg(totals.relieved_overhead));
  const relievedLabor = final ? openLabor : scale(openLabor, quantity, remainingQuantity);
  const relievedOverhead = final ? openOverhead : scale(openOverhead, quantity, remainingQuantity);
  let standardLabor = "0.0000";
  let standardOverhead = "0.0000";
  if (withStandard) {
    const date = await businessToday(orgId);
    for (const operation of await loadOperationCost(tx, orgId, order.id)) {
      if (operation.status !== "done") continue;
      // Setup is a batch cost: each unit is allowed its share of the order's setup.
      const setup = scale(operation.planned_setup_minutes, quantity, operation.quantity_planned);
      const run = scale(operation.planned_run_minutes, quantity, operation.quantity_planned);
      const { laborMinutes, machineMinutes } = operationMinutes(operation, quantity, setup, run);
      standardLabor = add(standardLabor, laborAmount(operation, order.number, laborMinutes));
      if (usesMachine(operation.center_kind) && !isZero(machineMinutes)) {
        standardOverhead = add(standardOverhead, priceMinutes((await machineRate(tx, orgId, operation, date)).rate, machineMinutes));
      }
      standardOverhead = add(standardOverhead, overheadAmount(operation, order.number, quantity, laborMinutes, machineMinutes));
    }
  }
  return { relievedLabor, relievedOverhead, standardLabor, standardOverhead };
}


/** Correct consumed employee hours forward. Before the first receipt the delta changes WIP; after a receipt it is an explicit variance, never a rewrite of finished-goods history. */
export async function applyProductionTimeCorrections(tx:SqlExecutor,orgId:string,actorId:string,timeEntryIds:string[], permission: TimeCommandPermission = 'time.approve') {
  if(!timeEntryIds.length) return
  const candidates=(await tx.execute<{id:string;workOrderId:string;operationId:string;amendsEntryId:string|null}>(sql`
    select e.id,e.work_order_id as "workOrderId",e.wo_operation_id as "operationId",e.amends_entry_id as "amendsEntryId"
    from time_entries e join mfg_wo_operations o on o.org_id=e.org_id and o.work_order_id=e.work_order_id and o.id=e.wo_operation_id
    where e.org_id=${orgId} and e.id=any(${`{${timeEntryIds.join(',')}}`}::uuid[]) and (o.status='done' or exists(select 1 from mfg_work_orders work where work.org_id=o.org_id and work.id=o.work_order_id and work.status='cancelled' and work.loss_change_id is not null))
    and o.labor_time_source='approved_time' order by e.work_order_id,e.wo_operation_id,e.id`)).rows
  for(const candidate of candidates) {
    const target=await lockTimeWorkOrderTarget(tx,orgId,actorId,{workOrderId:candidate.workOrderId,operationId:candidate.operationId,requestedScope:null,permission,requireOpen:false})
    await lockActorCommandAuthority(tx,orgId,actorId,target.subsidiaryId,'manufacturing.manage')
    await lockActorCommandAuthority(tx,orgId,actorId,target.subsidiaryId,'items.post')
    const order=(await tx.execute<ConversionOrder & {quantity_completed:string;status:string}>(sql`select id,number,subsidiary_id,quantity_ordered::text,bom_revision,routing_version,quantity_completed::text,status from mfg_work_orders where org_id=${orgId} and id=${candidate.workOrderId} for update`)).rows[0]
    if(!order) refuse('The production order is unavailable.','work_order_not_found','Reload the week and order.',404)
    const operation=(await loadOperationCost(tx,orgId,order.id,candidate.operationId))[0]!
    const entry=(await tx.execute<{hours:string;status:string;consumed:string|null;amends_entry_id:string|null;corrects_entry_id:string|null;employee_party_id:string;worked_on:string;time_type_id:string|null}>(sql`select hours::text,status,production_consumed_operation_id as consumed,amends_entry_id,corrects_entry_id,employee_party_id,worked_on::text,time_type_id from time_entries where org_id=${orgId} and id=${candidate.id} for update`)).rows[0]
    if(!entry || entry.status!=='approved') refuse('Only approved time may correct production costs.','production_time_not_approved','Approve the correcting time entry first.',409)
    if(entry.consumed) continue
    const sourceId=entry.amends_entry_id ?? entry.corrects_entry_id
    const original=sourceId ? (await tx.execute<{hours:string;operation_id:string|null;employee_party_id:string;worked_on:string;time_type_id:string|null}>(sql`select hours::text,production_consumed_operation_id as operation_id,employee_party_id,worked_on::text,time_type_id from time_entries where org_id=${orgId} and id=${sourceId} and work_order_id=${order.id} and wo_operation_id=${operation.id} for share`)).rows[0] : null
    const contra=sourceId ? (await tx.execute<{id:string;hours:string;employee_party_id:string;worked_on:string;time_type_id:string|null}>(sql`select id,hours::text,employee_party_id,worked_on::text,time_type_id from time_entries where org_id=${orgId} and amends_entry_id=${sourceId} and work_order_id=${order.id} and wo_operation_id=${operation.id} and status='approved' for share`)).rows : []
    const sameContext = original && entry.employee_party_id===original.employee_party_id && entry.worked_on===original.worked_on && entry.time_type_id===original.time_type_id
    const validContra = original && contra.length===1 && cmp(contra[0]!.hours,neg(original.hours))===0 && contra[0]!.employee_party_id===original.employee_party_id && contra[0]!.worked_on===original.worked_on && contra[0]!.time_type_id===original.time_type_id
    const validCorrection=entry.amends_entry_id ? validContra && contra[0]!.id===candidate.id : entry.corrects_entry_id && validContra && cmp(entry.hours,'0')>=0
    if(!original || original.operation_id!==operation.id || !sameContext || !validCorrection) refuse('This time is not an exact correction of consumed production time.','production_time_correction_required','Use the time amendment action for the consumed entry.',409)
    const minutes=fromUnits(toUnits(entry.hours)*MINUTES_PER_HOUR)
    const labor=laborAmount(operation,order.number,minutes)
    const overhead=operation.absorbs_overhead && operation.overhead_snapshot?.basis==='labor_hours' ? overheadAmount(operation,order.number,'0',minutes,'0') : '0.0000'
    const toWip=cmp(order.quantity_completed,'0')===0 && !['done','closed','cancelled'].includes(order.status)
    let journalId:string|null=null
    if(!isZero(add(labor,overhead))) {
      const date=await businessToday(orgId)
      const periodId=await periodForDate(orgId,date,tx as Runner)
      if(!periodId || !order.bom_revision || order.routing_version===null) refuse('Production correction lacks an open accounting period or released evidence.','production_correction_evidence_missing','Open the current accounting period and use a released production order.',409)
      const lines:JournalLineInput[]=[]
      if(!isZero(labor)) {
        lines.push({accountId:await manufacturingControlAccount(tx,orgId,target.subsidiaryId,toWip?'mfgWip':'mfgLaborEfficiencyVariance'),amount:labor,memo:'Consumed production time correction'})
        lines.push({accountId:await manufacturingControlAccount(tx,orgId,target.subsidiaryId,'laborClearing'),amount:neg(labor),memo:'Production labor clearing correction'})
      }
      if(!isZero(overhead)) {
        lines.push({accountId:await manufacturingControlAccount(tx,orgId,target.subsidiaryId,toWip?'mfgWip':'mfgOverheadVariance'),amount:overhead,memo:'Production labor-based overhead correction'})
        lines.push({accountId:await manufacturingControlAccount(tx,orgId,target.subsidiaryId,'mfgOverheadApplied'),amount:neg(overhead),memo:'Production applied overhead correction'})
      }
      await assertInventoryAccountsPostable(tx as Runner,orgId,lines.map(line=>line.accountId))
      journalId=await postManufacturingEntry(tx as Runner,{orgId,actorId,subsidiaryId:target.subsidiaryId,bookId:await primaryBookId(orgId,tx as Runner),currency:await subsidiaryCurrency(orgId,target.subsidiaryId,tx as Runner),periodId,date,entryNumber:`MFG-TIME-${candidate.id}`,memo:`Time amendment for ${order.number}`,lines,
        custom:{workOrderNumber:order.number,bomRevision:order.bom_revision,routingVersion:String(order.routing_version),operation_id:operation.id,time_entry_id:candidate.id,amends_time_entry_id:entry.amends_entry_id,corrects_time_entry_id:entry.corrects_entry_id,conversion_labor_amount:labor,conversion_overhead_amount:overhead,conversion_disposition:toWip?'wip':'variance',conversion:{timeBasis:'approved_time_correction',laborMinutes:minutes}}})
    }
    await claimOperationTime(tx,orgId,actorId,operation.id,[candidate.id],journalId)
  }
}
