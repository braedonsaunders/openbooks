import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { assertManufacturingFeature } from "./gate.ts";
import {
  ManufacturingError,
  ManufacturingNotFoundError,
  ManufacturingIdempotencyConflictError,
} from "./errors.ts";
import {
  auditChange,
  decimalValue,
  compareDecimal,
  storageCode,
} from "./master-support.ts";
import { lockManufacturingExecutionAuthority } from "./authority.ts";
import { add } from "../money/money.ts";

export interface NormalScrapInput {
  operationId: string;
  quantity: string;
  reasonId: string;
}
/** Normal production loss remains in WIP. This command never disposes stocked inventory
 * or represents an abnormal loss, which requires a separately governed valuation. */
export async function recordNormalScrap(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  scope: ReadonlySet<string> | null,
  workOrderId: string,
  eventId: string,
  input: NormalScrapInput,
) {
  await assertManufacturingFeature(tx, orgId, "manufacturing");
  const order = (
    await tx.execute<{
      id: string;
      subsidiaryId: string | null;
      status: string;
      quantityOrdered: string;
      quantityCompleted: string;
      quantityScrapped: string;
    }>(
      sql`select id,subsidiary_id as "subsidiaryId",status,quantity_ordered::text as "quantityOrdered",quantity_completed::text as "quantityCompleted",quantity_scrapped::text as "quantityScrapped" from mfg_work_orders where org_id=${orgId} and id=${workOrderId} for update`,
    )
  ).rows[0];
  if (!order || !subsidiaryScopeAllows(scope, order.subsidiaryId))
    throw new ManufacturingNotFoundError();
  const effectiveScope = await lockManufacturingExecutionAuthority(
    tx,
    orgId,
    actorId,
    order.subsidiaryId,
    scope,
  );
  const quantity = decimalValue(
    input.quantity,
    "quantity",
    "Enter a positive exact quantity.",
  );
  if (compareDecimal(quantity, "0") <= 0)
    throw new ManufacturingError("Scrap quantity must be positive.", {
      code: "invalid_scrap_quantity",
      field: "quantity",
    });
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('manufacturing.scrap'),hashtext(${eventId}))`,
  );
  const replay = (
    await tx.execute<{
      id: string;
      operationId: string;
      quantity: string;
      reasonId: string;
      classification: string;
      workOrderId: string;
    }>(
      sql`select id,work_order_id as "workOrderId",operation_id as "operationId",quantity::text,reason_id as "reasonId",classification from mfg_scrap_events where org_id=${orgId} and id=${eventId}`,
    )
  ).rows[0];
  if (replay) {
    if (
      replay.workOrderId !== workOrderId ||
      replay.operationId !== input.operationId ||
      compareDecimal(replay.quantity, quantity) !== 0 ||
      replay.reasonId !== input.reasonId ||
      replay.classification !== "normal"
    )
      throw new ManufacturingIdempotencyConflictError();
    return replay;
  }
  if (order.status !== "in_progress")
    throw new ManufacturingError(
      "Record production scrap on an in-progress work order.",
      {
        status: 409,
        code: "invalid_work_order_transition",
        remedy: "Start or resume the work order first.",
      },
    );
  if (compareDecimal(order.quantityCompleted, "0") > 0)
    throw new ManufacturingError(
      "Record normal production loss before the first finished-goods receipt.",
      {
        code: "scrap_after_receipt_requires_review",
        remedy:
          "Hold the work order to review the loss and its existing receipt valuation.",
      },
    );
  const operation = (
    await tx.execute<{
      id: string;
      status: string;
      quantityPlanned: string;
      quantityDone: string;
      quantityScrappedHere: string;
      subsidiaryId: string | null;
    }>(
      sql`select o.id,o.status,o.quantity_planned::text as "quantityPlanned",o.quantity_done::text as "quantityDone",o.quantity_scrapped_here::text as "quantityScrappedHere",c.subsidiary_id as "subsidiaryId" from mfg_wo_operations o join mfg_work_centers c on c.org_id=o.org_id and c.id=o.work_center_id where o.org_id=${orgId} and o.work_order_id=${workOrderId} and o.id=${input.operationId} for update of o`,
    )
  ).rows[0];
  if (
    !operation ||
    !subsidiaryScopeAllows(effectiveScope, operation.subsidiaryId)
  )
    throw new ManufacturingNotFoundError();
  if (operation.status !== "running" && operation.status !== "paused")
    throw new ManufacturingError(
      "Scrap can be recorded while an operation is running or paused.",
      {
        status: 409,
        code: "invalid_operation_transition",
        remedy: "Start the operation before recording its scrap.",
      },
    );
  const reason = (
    await tx.execute<{ classification: string }>(
      sql`select classification from mfg_scrap_reasons where org_id=${orgId} and id=${input.reasonId} and is_active for share`,
    )
  ).rows[0];
  if (!reason) throw new ManufacturingNotFoundError();
  if (reason.classification !== "normal")
    throw new ManufacturingError(
      "This command records normal production loss only.",
      {
        code: "abnormal_scrap_requires_valuation",
        remedy: "Hold the work order while the abnormal loss is reviewed.",
      },
    );
  const total = add(order.quantityScrapped, quantity),
    atOperation = add(operation.quantityScrappedHere, quantity);
  if (compareDecimal(total, order.quantityOrdered) >= 0)
    throw new ManufacturingError(
      "An all-loss order needs a governed disposition rather than a normal output receipt.",
      {
        code: "all_loss_disposition_required",
        remedy: "Hold the work order for inventory and costing review.",
      },
    );
  if (
    compareDecimal(add(order.quantityCompleted, total), order.quantityOrdered) >
      0 ||
    compareDecimal(
      add(operation.quantityDone, atOperation),
      operation.quantityPlanned,
    ) > 0
  )
    throw new ManufacturingError(
      "The reported output and scrap exceed the planned quantity.",
      {
        code: "scrap_quantity_exceeded",
        field: "quantity",
        remedy: "Check the quantity and prior scrap events.",
      },
    );
  let saved: { id: string } | undefined;
  try {
    saved = (
      await tx.execute<{ id: string }>(
        sql`insert into mfg_scrap_events (id,org_id,work_order_id,operation_id,quantity,reason_id,classification,treatment,frozen_value,approval_required,created_by,updated_by) values (${eventId},${orgId},${workOrderId},${input.operationId},${quantity},${input.reasonId},'normal','evidence',0,false,${actorId},${actorId}) returning id`,
      )
    ).rows[0];
  } catch (error) {
    if (storageCode(error) === "23505")
      throw new ManufacturingIdempotencyConflictError();
    throw error;
  }
  if (!saved) throw new Error("The scrap event was not saved.");
  const op = await tx.execute(
    sql`update mfg_wo_operations set quantity_scrapped_here=${atOperation},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and work_order_id=${workOrderId} and id=${input.operationId} returning id`,
  );
  const wo = await tx.execute(
    sql`update mfg_work_orders set quantity_scrapped=${total},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${workOrderId} returning id`,
  );
  if (op.rows.length !== 1 || wo.rows.length !== 1)
    throw new Error("The scrap quantities were not saved.");
  await auditChange(tx, {
    orgId,
    actorId,
    table: "mfg_scrap_events",
    rowId: eventId,
    action: "insert",
    before: null,
    after: {
      ...input,
      quantity,
      classification: "normal",
      treatment: "evidence",
      frozenValue: "0",
    },
    requestId: eventId,
  });
  await auditChange(tx, {
    orgId,
    actorId,
    table: "mfg_work_orders",
    rowId: workOrderId,
    action: "update",
    before: { quantityScrapped: order.quantityScrapped },
    after: { quantityScrapped: total },
    requestId: eventId,
  });
  await auditChange(tx, {
    orgId,
    actorId,
    table: "mfg_wo_operations",
    rowId: input.operationId,
    action: "update",
    before: { quantityScrappedHere: operation.quantityScrappedHere },
    after: { quantityScrappedHere: atOperation },
    requestId: eventId,
  });
  return {
    ...saved,
    workOrderId,
    ...input,
    quantity,
    classification: "normal",
  };
}
