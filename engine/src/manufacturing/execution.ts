import { db, withOrgTransaction } from "../platform/db.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { executeIdempotentInventoryAction } from "../inventory/action-idempotency.ts";
import { ManufacturingNotFoundError } from "./errors.ts";
import { assertManufacturingFeature } from "./gate.ts";
import { lockManufacturingOrderExecutionAuthority } from "./authority.ts";
import { getWorkOrder } from "./work-orders.ts";
import { completeWorkOrder, type CompleteWorkOrderInput } from "./completion.ts";
import { issueMaterials, type MaterialIssueLine } from "./materials.ts";
import {
  correctWorkOrderCompletionDate,
  type CompletionDateCorrectionInput,
} from "./completion-redate.ts";

// The web app reaches the completion-date correction through this public contract.
export {
  correctWorkOrderCompletionDate,
  type CompletionDateCorrectionInput,
} from "./completion-redate.ts";
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
  return execute(orgId, actorId, scope, id, key, "manufacturing.receipt", input, () =>
    completeWorkOrder(db, orgId, actorId, id, input),
  );
}
export async function executeManufacturingIssue(
  orgId: string,
  actorId: string,
  scope: ReadonlySet<string> | null,
  id: string,
  key: string,
  lines: MaterialIssueLine[],
  issuedOn: string | null = null,
) {
  return execute(
    orgId,
    actorId,
    scope,
    id,
    key,
    "manufacturing.issue",
    issuedOn === null ? { lines } : { lines, issuedOn },
    () => issueMaterials(db, orgId, actorId, id, lines, { issuedOn }),
  );
}
/** A retried completion-date correction returns the retained result instead of posting again. */
export async function executeManufacturingCompletionDateCorrection(
  orgId: string,
  actorId: string,
  scope: ReadonlySet<string> | null,
  id: string,
  key: string,
  input: CompletionDateCorrectionInput,
) {
  return execute(orgId, actorId, scope, id, key, "manufacturing.completion-date", input, () =>
    correctWorkOrderCompletionDate(db, orgId, actorId, id, input),
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
    await lockManufacturingOrderExecutionAuthority(db, orgId, actorId, id, scope);
    return executeIdempotentInventoryAction(orgId, actorId, {
      operation,
      idempotencyKey: key,
      request: { workOrderId: id, input },
      execute: command,
    });
  });
}
