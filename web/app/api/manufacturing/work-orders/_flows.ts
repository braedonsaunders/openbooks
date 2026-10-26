import {
  cancelDispatchRuns,
  dispatchFailureReason,
  runRecordFlows,
} from "@openbooks/engine/flows/module";
import type { TriggerEvent } from "@openbooks/forms-core";
import { ManufacturingError } from "@openbooks/engine/manufacturing/errors";
import { WORK_ORDER_SUBJECT_KIND } from "@openbooks/engine/flows/manufacturing-adapter";

export async function dispatchWorkOrderFlow(
  event: TriggerEvent,
  subjectId: string,
  orgId: string,
  actorId: string,
): Promise<{ gatesCreated: number }> {
  const result = await runRecordFlows(event, WORK_ORDER_SUBJECT_KIND, subjectId, {
    orgId,
    userId: actorId,
  });
  if (result.failed) {
    await cancelDispatchRuns(
      orgId,
      result.runs.map((run) => run.runId),
      { actorId },
    );
    throw new ManufacturingError(
      `Work-order flow dispatch failed: ${dispatchFailureReason(result) ?? "an approval flow could not run"}.`,
      {
        status: 422,
        code: "work_order_flow_failed",
        remedy: "Correct the named work-order flow in Flows, then retry the action.",
      },
    );
  }
  return { gatesCreated: result.gatesCreated };
}
