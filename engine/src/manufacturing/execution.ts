import { db, withOrgTransaction } from "../platform/db.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { executeIdempotentInventoryAction } from "../inventory/action-idempotency.ts";
import { ManufacturingNotFoundError } from "./errors.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { lockManufacturingOrderExecutionAuthority } from "./authority.ts";
import { getWorkOrder } from "./work-orders.ts";
import {
  completeWorkOrder,
  type CompleteWorkOrderInput,
} from "./completion.ts";
import { issueMaterials, type MaterialIssueLine } from "./materials.ts";
/** Native inventory claims store the result atomically with its production postings.
 * Feature and entity authority are checked again before returning a retained result. */
export async function executeManufacturingReceipt(
  orgId: string,
  actorId: string,
  scope: ReadonlySet<string> | null,
  id: string,
  key: string,
  input: CompleteWorkOrderInput,
) {
  return execute(
    orgId,
    actorId,
    scope,
    id,
    key,
    "manufacturing.receipt",
    input,
    () => completeWorkOrder(db, orgId, actorId, id, input),
  );
}
export async function executeManufacturingIssue(
  orgId: string,
  actorId: string,
  scope: ReadonlySet<string> | null,
  id: string,
  key: string,
  lines: MaterialIssueLine[],
) {
  return execute(
    orgId,
    actorId,
    scope,
    id,
    key,
    "manufacturing.issue",
    { lines },
    () => issueMaterials(db, orgId, actorId, id, lines),
  );
}
async function execute<T>(
  orgId: string,
  actorId: string,
  scope: ReadonlySet<string> | null,
  id: string,
  key: string,
  operation: string,
  input: unknown,
  command: () => Promise<T>,
) {
  return withOrgTransaction(orgId, async () => {
    await assertManufacturingFeature(db, orgId, "manufacturing");
    const order = await getWorkOrder(db, orgId, id);
    if (!order || !subsidiaryScopeAllows(scope, order.subsidiaryId))
      throw new ManufacturingNotFoundError();
    await lockManufacturingOrderExecutionAuthority(db,orgId,actorId,id,scope);
    return executeIdempotentInventoryAction(orgId, actorId, {
      operation,
      idempotencyKey: key,
      request: { workOrderId: id, input },
      execute: command,
    });
  });
}
