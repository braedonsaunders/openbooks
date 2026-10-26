import type { RecordApprovalState } from "../components/approval-actions";

/** Complete native record-state response for browser transport fixtures. */
export function recordApprovalState(options: {
  status: string;
  gateId?: string;
  canDecide?: boolean;
  neverSubmitted?: boolean;
  submittedByViewer?: boolean;
}): RecordApprovalState {
  const gateId = options.gateId;
  return {
    approvalState: {
      status: options.status,
      pendingWith: gateId
        ? [{ name: "Assigned reviewer", gateId, since: "2026-10-01T10:00:00Z" }]
        : [],
      myActions: gateId && options.canDecide ? { gateId, signatureRequired: false } : null,
    },
    history: [],
    failedRun: null,
    canRetry: false,
    neverSubmitted: options.neverSubmitted ?? false,
    submittedByViewer: options.submittedByViewer ?? false,
  };
}
