import { createScriptJournal } from "../ledger/journal-writes.ts";
import { registerScriptJournalWriter } from "../scripting/journal-writer.ts";
import { registerFlowApprovalReleaseHandler } from "../flows/approval-release-hook.ts";
import { ALLOCATION_RUN_SUBJECT_KIND } from "../flows/allocation-runs-adapter.ts";
import { CLOSE_RUN_SUBJECT_KIND } from "../flows/close-runs-adapter.ts";
import { HRM_COMP_CYCLE_SUBJECT_KIND } from "@openbooks/schema/src/hrm-compensation.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { releaseAllocationRunApproval } from "../allocations/flow-release.ts";
import { releaseCloseRunApproval } from "../close/flow-release.ts";
import {
  releaseCompCycleApproval,
  releaseHrmChangeRequestApproval,
  releaseLeaveRequestApproval,
} from "../hrm/flow-releases.ts";

/**
 * Composition root (ARCH-MODULE-CYCLE C12): the one place that wires engine
 * modules across layering seams.
 *
 * scripting sits below the ledger orchestrator, so it cannot import
 * createScriptJournal; instead the process installs the ledger's writer
 * here and the __journal_create host call invokes it inline, in the same
 * ambient transaction. The engine-owned approval-release handlers register
 * on this same root (C13); the document-effects port follows (C14).
 *
 * Idempotent: re-registering the same writer is a no-op. Call it from every
 * process that can post, run scripts or run flows — web/instrumentation,
 * scripts/worker-entry, and the engine CLIs — and explicitly in tests that
 * exercise those paths (never as a test-suite preload: loading payments
 * and ledger before per-test module mocks would break mocks governed by
 * check:test-mock-surface).
 */
export function installEngineSeams(): void {
  registerScriptJournalWriter(createScriptJournal);
  // Engine-owned approval releases (C13): the adapters delegate through
  // releaseFlowApproval; the handlers run inside decideGate's transaction.
  registerFlowApprovalReleaseHandler(ALLOCATION_RUN_SUBJECT_KIND, releaseAllocationRunApproval);
  registerFlowApprovalReleaseHandler(CLOSE_RUN_SUBJECT_KIND, releaseCloseRunApproval);
  registerFlowApprovalReleaseHandler(HRM_COMP_CYCLE_SUBJECT_KIND, releaseCompCycleApproval);
  registerFlowApprovalReleaseHandler(HRM_CHANGE_REQUEST_SUBJECT_KIND, releaseHrmChangeRequestApproval);
  registerFlowApprovalReleaseHandler(HRM_LEAVE_REQUEST_SUBJECT_KIND, releaseLeaveRequestApproval);
}
