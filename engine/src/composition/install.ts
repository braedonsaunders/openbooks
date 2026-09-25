import { createScriptJournal } from "../ledger/journal-writes.ts";
import { registerScriptJournalWriter } from "../scripting/journal-writer.ts";
import { registerFlowApprovalReleaseHandler } from "../flows/approval-release-hook.ts";
import { registerFlowDocumentEffects } from "../flows/document-effects-hook.ts";
import { postPaymentWithApplications } from "../payments/payment-posting.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import {
  completeRequestedDocumentVoid,
  rejectRequestedDocumentVoid,
} from "../ledger/document-void.ts";
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
 * on this same root (C13), as does the document-effects port (C14).
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
  // Document effects (C14): post_document and before_void completion,
  // verbatim from flows/execute.ts and flows/documents-adapter.ts. Runs
  // inline in the caller's chain, so the ambient pinned org transaction
  // that `db` routes to does not change.
  registerFlowDocumentEffects({
    async postSubject({ subjectKind, subjectId, ctx }) {
      if (
        subjectKind === "vendor_payment" ||
        subjectKind === "customer_payment"
      ) {
        // Payment posting is a larger accounting unit than its GL entry:
        // applications, realized FX and provenance links must commit with it.
        return (
          await postPaymentWithApplications(
            subjectId,
            undefined,
            ctx.userId ?? undefined,
            "flows",
          )
        ).entryId;
      }
      const deps = { control: await loadRequiredControlAccounts(ctx.orgId) };
      return postDocument(subjectId, deps, {
        audit: { actorId: ctx.userId ?? null, source: "flows" },
      });
    },
    async completeRequestedVoid(subjectId, orgId, allowedSubsidiaryIds) {
      await completeRequestedDocumentVoid(
        subjectId,
        orgId,
        allowedSubsidiaryIds,
      );
    },
    async rejectRequestedVoid(subjectId, orgId, userId, comment) {
      await rejectRequestedDocumentVoid(subjectId, orgId, userId, comment);
    },
  });
}
