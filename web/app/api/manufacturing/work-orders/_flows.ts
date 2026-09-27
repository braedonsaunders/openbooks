import { cancelDispatchRuns, dispatchFailureReason, runRecordFlows } from "@openbooks/engine/src/flows/index.ts";
import type { TriggerEvent } from "@openbooks/forms-core";
import { ManufacturingError } from "@openbooks/engine/src/manufacturing/errors.ts";
import { WORK_ORDER_SUBJECT_KIND } from "@openbooks/engine/src/flows/manufacturing-adapter.ts";

export async function dispatchWorkOrderFlow(
  event: TriggerEvent,
  subjectId: string,
  orgId: string,
  actorId: string,
): Promise<{ gatesCreated: number }> {
  const result = await runRecordFlows(event, WORK_ORDER_SUBJECT_KIND, subjectId, { orgId, userId: actorId });
  if (result.failed) {
    await cancelDispatchRuns(orgId, result.runs.map((run) => run.runId), { actorId });
    throw new ManufacturingError(
      `Work-order flow dispatch failed: ${dispatchFailureReason(result) ?? "an approval flow could not run"}.`,
      { status: 422, code: "work_order_flow_failed", remedy: "Correct the named work-order flow in Flows, then retry the action." },
    );
  }
  return { gatesCreated: result.gatesCreated };
}
