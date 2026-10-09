import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { InventoryError } from "./contracts.ts";
import { lockInventoryPosition, persistReceiptMoney } from "./position.ts";
import { resolveProfile } from "./profile-policy.ts";
import { toBaseQuantity, toExactBaseQuantity } from "./costing.ts";
import { cmp } from "../money/money.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { resolveScan, ScanRefusal } from "./item-identifiers.ts";

export type ExecutionStage = "receive" | "putaway" | "pick" | "pack" | "count";
export interface ExecutionTask extends Record<string, unknown> {
  id: string;
  org_id: string;
  subsidiary_id: string;
  stage: ExecutionStage;
  document_line_id: string | null;
  count_line_id: string | null;
  item_id: string;
  lot_id: string | null;
  serial_id: string | null;
  from_stock_location_id: string;
  to_stock_location_id: string;
  quantity: string;
  document_quantity: string;
  document_unit: string | null;
  posting_date: string;
  basis: Record<string, unknown>;
  status: "open" | "done" | "cancelled";
  result: Record<string, unknown> | null;
}
export interface ExecutionScan {
  item: string;
  bin: string;
  quantity: string;
  lot?: string;
  serial?: string;
}
export interface ExecutionSuggestion {
  stage: ExecutionStage;
  subsidiaryId: string;
  itemId: string;
  documentLineId?: string | null;
  countLineId?: string | null;
  lotId?: string | null;
  serialId?: string | null;
  fromStockLocationId: string;
  toStockLocationId: string;
  quantity: string;
  documentQuantity: string;
  documentUnit: string | null;
  postingDate: string;
  basis: Record<string, unknown>;
  commandKey: string;
}

export async function admitExecution(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  stage: ExecutionStage,
  entityId: string,
) {
  const scope = await lockActorCommandAuthority(
    tx,
    orgId,
    actorId,
    entityId,
    stage === "pick" || stage === "pack" ? "orders.fulfill" : "items.post",
  );
  const feature =
    stage === "receive" || stage === "putaway"
      ? "warehousing"
      : stage === "count"
        ? "inventory"
        : "fulfillment";
  if (!(await lockAndCheckOrgFeature(tx, orgId, feature)))
    throw new InventoryError(
      `Turn on ${feature} in Company Settings → Features before executing warehouse work`,
    );
  return scope;
}

/** Domain callers supply a native source snapshot; no API accepts arbitrary suggestion identities. */
export async function createExecutionSuggestion(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  input: ExecutionSuggestion,
) {
  await admitExecution(tx, orgId, actorId, input.stage, input.subsidiaryId);
  const quantity = persistReceiptMoney(
    input.quantity,
    "suggested base quantity",
  );
  if (
    cmp(quantity, "0") < 0 ||
    (!["count", "pick"].includes(input.stage) && cmp(quantity, "0") === 0)
  )
    throw new InventoryError(
      "Warehouse work requires a positive quantity; counts and full short picks may record zero",
    );
  if (input.commandKey.trim().length < 8 || input.commandKey.length > 200)
    throw new InventoryError(
      "Warehouse suggestion requires a stable command key of 8–200 characters",
    );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`warehouse-suggest:${orgId}:${input.commandKey}`},0))`,
  );
  const prior = (
    await tx.execute<ExecutionTask>(sql`select *,posting_date::text as posting_date,
    basis=${JSON.stringify(input.basis)}::jsonb as basis_matches from warehouse_execution_tasks
    where org_id=${orgId} and command_key=${input.commandKey}`)
  ).rows[0];
  if (prior) {
    if (
      prior.stage !== input.stage ||
      prior.item_id !== input.itemId ||
      prior.subsidiary_id !== input.subsidiaryId ||
      prior.from_stock_location_id !== input.fromStockLocationId ||
      prior.to_stock_location_id !== input.toStockLocationId ||
      prior.document_line_id !== (input.documentLineId ?? null) ||
      prior.count_line_id !== (input.countLineId ?? null) ||
      prior.lot_id !== (input.lotId ?? null) ||
      prior.serial_id !== (input.serialId ?? null) ||
      cmp(prior.quantity, quantity) !== 0 ||
      compareDecimal(prior.document_quantity, input.documentQuantity) !== 0 ||
      prior.document_unit !== input.documentUnit ||
      prior.posting_date.slice(0, 10) !== input.postingDate ||
      prior.basis_matches !== true
    )
      throw new InventoryError(
        "Suggestion key was already used for different warehouse work; refresh with a new key",
      );
    return prior;
  }
  const inserted = (
    await tx.execute<ExecutionTask>(sql`insert into warehouse_execution_tasks
    (org_id,subsidiary_id,stage,document_line_id,count_line_id,item_id,lot_id,serial_id,
     from_stock_location_id,to_stock_location_id,quantity,document_quantity,document_unit,posting_date,basis,command_key,created_by,updated_by)
    values(${orgId},${input.subsidiaryId},${input.stage},${input.documentLineId ?? null},${input.countLineId ?? null},
      ${input.itemId},${input.lotId ?? null},${input.serialId ?? null},${input.fromStockLocationId},${input.toStockLocationId},
      ${quantity},${input.documentQuantity},${input.documentUnit},${input.postingDate},${JSON.stringify(input.basis)}::jsonb,
      ${input.commandKey},${actorId},${actorId}) returning *,posting_date::text as posting_date`)
  ).rows[0];
  if (!inserted)
    throw new InventoryError("Warehouse suggestion was not recorded");
  return inserted;
}

function scannedQuantity(value: string): string {
  const quantity = canonicalDecimal(value, 8);
  if (quantity === null || compareDecimal(quantity, "0") < 0)
    throw new InventoryError(
      "Scan a non-negative decimal quantity with at most eight decimal places",
    );
  return quantity;
}

async function scanMismatch(
  tx: SqlExecutor,
  orgId: string,
  task: ExecutionTask,
  scan: ExecutionScan,
  scope: ReadonlySet<string> | null,
) {
  try {
    const item = await resolveScan(tx, orgId, {
      field: "item",
      value: scan.item,
      allowedSubsidiaryIds: scope,
    });
    const bin = await resolveScan(tx, orgId, {
      field: "bin",
      value: scan.bin,
      allowedSubsidiaryIds: scope,
    });
    if (item.id !== task.item_id)
      return "Item scan does not match the suggested item. Set the item aside and rescan the suggestion.";
    if (bin.id !== task.to_stock_location_id)
      return "Bin scan does not match the suggested bin. Keep stock in place and rescan the suggested bin.";
    const profile = await resolveProfile(orgId, task.item_id, tx);
    const quantity = persistReceiptMoney(
      toBaseQuantity(
        scannedQuantity(scan.quantity),
        item.unit,
        profile.unitConversions ?? {},
        profile.baseUnit,
      ),
      "scanned base quantity",
    );
    const observedExact = toExactBaseQuantity(
      scannedQuantity(scan.quantity),
      item.unit,
      profile.unitConversions ?? {},
      profile.baseUnit,
    );
    const expectedExact = toExactBaseQuantity(
      task.document_quantity,
      task.document_unit,
      profile.unitConversions ?? {},
      profile.baseUnit,
    );
    if (
      cmp(quantity, task.quantity) !== 0 ||
      compareDecimal(observedExact, expectedExact) !== 0
    )
      return "Quantity does not match the suggestion. Record a short pick or refresh the counted quantity instead of changing the suggestion.";
    for (const field of ["lot", "serial"] as const) {
      const expected = field === "lot" ? task.lot_id : task.serial_id;
      if (!expected && !scan[field]) continue;
      if (!expected || !scan[field])
        return `Scan the suggested ${field}; untracked identifiers cannot replace the suggestion.`;
      const match = await resolveScan(tx, orgId, {
        field,
        value: scan[field]!,
        itemId: task.item_id,
        allowedSubsidiaryIds: scope,
      });
      if (match.id !== expected)
        return `${field} scan does not match the suggestion. Keep stock aside and rescan the suggested identifier.`;
    }
    return null;
  } catch (error) {
    if (error instanceof ScanRefusal)
      return "Scan could not identify one exact permitted record. Rescan the suggested item and bin.";
    if (error instanceof InventoryError) return error.message;
    throw error;
  }
}

export type ExecutionOutcome =
  | { status: "exception"; taskId: string; reason: string }
  | {
      status: "done";
      taskId: string;
      result: Record<string, unknown>;
      replayed: boolean;
    };
/** A mismatch commits exception evidence only; the native operation never receives replacement identifiers. */
export async function confirmExecutionTask(
  orgId: string,
  actorId: string,
  input: { taskId: string; scan?: ExecutionScan },
  execute: (
    tx: SqlExecutor,
    task: ExecutionTask,
  ) => Promise<Record<string, unknown>>,
): Promise<ExecutionOutcome> {
  return withOrgTransaction(orgId, async () => {
    const observed = (
      await db.execute<ExecutionTask>(sql`select *,posting_date::text as posting_date from warehouse_execution_tasks
      where org_id=${orgId} and id=${input.taskId}`)
    ).rows[0];
    if (!observed) throw new InventoryError("Warehouse work was not found");
    for (const bin of [
      ...new Set([
        observed.from_stock_location_id,
        observed.to_stock_location_id,
      ]),
    ].sort())
      await lockInventoryPosition(db, observed.item_id, bin);
    const scope = await admitExecution(
      db,
      orgId,
      actorId,
      observed.stage,
      observed.subsidiary_id,
    );
    const task = (
      await db.execute<ExecutionTask>(sql`select *,posting_date::text as posting_date from warehouse_execution_tasks
      where org_id=${orgId} and id=${input.taskId} for update`)
    ).rows[0]!;
    if (task.status === "cancelled")
      throw new InventoryError(
        "This suggestion was cancelled; create fresh warehouse work",
      );
    const scanning = await lockAndCheckOrgFeature(db, orgId, "barcodeScanning");
    const mismatch = scanning
      ? input.scan
        ? await scanMismatch(db, orgId, task, input.scan, scope)
        : "Scan the suggested bin, item and quantity to confirm this warehouse work."
      : null;
    if (mismatch) {
      const written =
        await db.execute(sql`insert into warehouse_scan_events(org_id,task_id,outcome,observed,reason,created_by)
        values(${orgId},${task.id},'exception',${JSON.stringify(input.scan ?? {})}::jsonb,${mismatch},${actorId}) returning id`);
      if (written.rows.length !== 1)
        throw new InventoryError("Scan exception was not recorded");
      return { status: "exception", taskId: task.id, reason: mismatch };
    }
    if (task.status === "done")
      return {
        status: "done",
        taskId: task.id,
        result: task.result ?? {},
        replayed: true,
      };
    const written =
      await db.execute(sql`insert into warehouse_scan_events(org_id,task_id,outcome,observed,created_by)
      values(${orgId},${task.id},'confirmed',${JSON.stringify(input.scan ?? { mode: "manual" })}::jsonb,${actorId}) returning id`);
    if (written.rows.length !== 1)
      throw new InventoryError("Warehouse confirmation was not recorded");
    const result = await execute(db, task);
    const done =
      await db.execute(sql`update warehouse_execution_tasks set status='done',result=${JSON.stringify(result)}::jsonb,
      updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${task.id} and status='open' returning id`);
    if (done.rows.length !== 1)
      throw new InventoryError(
        "Warehouse work changed during confirmation; reload the suggestion",
      );
    return { status: "done", taskId: task.id, result, replayed: false };
  });
}

export async function executionTaskView(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  taskId: string,
) {
  const task = (
    await tx.execute<ExecutionTask>(sql`select *,posting_date::text as posting_date from warehouse_execution_tasks
    where org_id=${orgId} and id=${taskId}`)
  ).rows[0];
  if (!task) throw new InventoryError("Warehouse work was not found");
  await admitExecution(tx, orgId, actorId, task.stage, task.subsidiary_id);
  const labels = (
    await tx.execute<{
      item_label: string;
      bin_code: string;
      lot_number: string | null;
      serial_number: string | null;
    }>(sql`
    select coalesce(nullif(item.code,''),item.name) as item_label,bin.code as bin_code,lot.lot_number,serial.serial_number
    from items item join stock_locations bin on bin.org_id=item.org_id and bin.id=${task.to_stock_location_id}
    left join lots lot on lot.org_id=item.org_id and lot.id=${task.lot_id}
    left join serials serial on serial.org_id=item.org_id and serial.id=${task.serial_id}
    where item.org_id=${orgId} and item.id=${task.item_id}`)
  ).rows[0];
  if (!labels)
    throw new InventoryError(
      "Suggested item or bin is unavailable; refresh warehouse work",
    );
  const barcodeScanning = await lockAndCheckOrgFeature(
    tx,
    orgId,
    "barcodeScanning",
  );
  return {
    id: task.id,
    stage: task.stage,
    status: task.status,
    itemLabel: labels.item_label,
    binCode: labels.bin_code,
    lotNumber: labels.lot_number,
    serialNumber: labels.serial_number,
    quantity: task.document_quantity,
    unit: task.document_unit,
    baseQuantity: task.quantity,
    barcodeScanning,
  };
}
