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
  labor_minutes_per_unit: string | null;
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
           routing_operation.labor_minutes_per_unit::text as labor_minutes_per_unit
      from mfg_wo_operations operation
      join mfg_work_centers center on center.org_id=operation.org_id and center.id=operation.work_center_id
      join mfg_work_orders work_order on work_order.org_id=operation.org_id and work_order.id=operation.work_order_id
      left join mfg_routing_operations routing_operation
        on routing_operation.org_id=operation.org_id and routing_operation.routing_id=work_order.routing_id
       and routing_operation.sequence=operation.sequence
     where operation.org_id=${orgId} and operation.work_order_id=${workOrderId}
       ${operationId ? sql`and operation.id=${operationId}` : sql``}
     order by operation.sequence`)).rows;
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

async function machineRate(tx: SqlExecutor, orgId: string, operation: OperationCostRow, onDate: string): Promise<{ id: string; rate: string }> {
  const row = (await tx.execute<{ id: string; rate: string }>(sql`
    select id, machine_rate_per_hour::text as rate from mfg_work_center_rates
     where org_id=${orgId} and work_center_id=${operation.work_center_id}
       and effective_from <= ${onDate} and (effective_to is null or effective_to > ${onDate})
     order by effective_from desc limit 1`)).rows[0];
  if (!row) {
    refuse(`Work center ${operation.center_code} has no machine rate covering ${onDate}, so operation ${operation.sequence}'s machine time cannot be costed.`,
      "machine_rate_missing", `Add a machine rate for work center ${operation.center_code} effective on or before ${onDate}, then complete the operation again.`);
  }
  return row;
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
export async function absorbOperationConversion(
  tx: SqlExecutor, orgId: string, actorId: string, order: ConversionOrder, operationId: string,
  doneQty: string, input: OperationTimeInput,
): Promise<{ entryId: string | null; setupMinutes: string; runMinutes: string; laborMinutes: string }> {
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
  const { laborMinutes, machineMinutes } = operationMinutes(operation, doneQty, setupMinutes, runMinutes, actualLabor);
  const timeBasis = actualSetup !== null || actualRun !== null || actualLabor !== null ? "reported" : "standard";

  const date = await businessToday(orgId);
  const labor = laborAmount(operation, order.number, laborMinutes);
  const machine = usesMachine(operation.center_kind) && !isZero(machineMinutes)
    ? await machineRate(tx, orgId, operation, date) : null;
  const machineCost = machine ? priceMinutes(machine.rate, machineMinutes) : "0.0000";
  const overhead = overheadAmount(operation, order.number, doneQty, laborMinutes, machineMinutes);
  const applied = add(machineCost, overhead);
  const total = add(labor, applied);
  const result = { entryId: null as string | null, setupMinutes, runMinutes, laborMinutes };
  if (isZero(total)) return result;

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
        timeBasis, quantity: doneQty, setupMinutes, runMinutes, laborMinutes, machineMinutes,
        laborRate: operation.standard_labor_final_rate, laborAmount: labor,
        machineRateId: machine?.id ?? null, machineRate: machine?.rate ?? null, machineAmount: machineCost,
        overheadBasis: operation.absorbs_overhead ? operation.overhead_snapshot?.basis ?? null : null, overheadAmount: overhead,
      },
    },
  });
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
    select coalesce(sum((custom->>'conversion_labor_amount')::numeric), 0)::text as absorbed_labor,
           coalesce(sum((custom->>'conversion_overhead_amount')::numeric), 0)::text as absorbed_overhead,
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
