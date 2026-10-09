import {sql} from 'drizzle-orm';
import {automationGraphSchema} from '@openbooks/forms-core';
import {db,withTransactionSavepoint} from '../platform/db.ts';
import {lockAndCheckOrgFeature} from '../organization/org-feature-lock.ts';
import {runRecordFlows} from '../flows/run.ts';
import {registerScheduleEmailHandler} from '../flows/schedule-distribution-hook.ts';
import {registerScheduleDistributionHooks} from '../schedule-boards/distribution-hooks.ts';
import {enqueueReviewedSchedule,prepareScheduleLifecycle} from '../schedule-boards/distribution.ts';
import { CHECKLIST_STEP_SUBJECT_KIND } from "@openbooks/forms-core";
import { releaseChecklistStepApproval } from "../hrm/processes.ts";
import { BENEFIT_ENROLLMENT_SUBJECT_KIND } from "@openbooks/schema/src/hrm-benefits.ts";
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
import { FUND_RELEASE_SUBJECT_KIND } from "../flows/fund-releases-adapter.ts";
import { CLOSE_RUN_SUBJECT_KIND } from "../flows/close-runs-adapter.ts";
import { HRM_COMP_CYCLE_SUBJECT_KIND } from "@openbooks/schema/src/hrm-compensation.ts";
import { COMPENSATION_VERSION_SUBJECT_KIND, COMPENSATION_ASSIGNMENT_SUBJECT_KIND } from "@openbooks/schema/src/payroll-compensation.ts";
import { releaseCompensationPackageFlowApproval } from "../payroll/compensation-package-flow-release.ts";
import { BENEFIT_AWARD_SUBJECT_KIND } from "@openbooks/schema/src/benefits-programs.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { RESOURCING_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/resourcing.ts";
import { WORK_ORDER_SUBJECT_KIND } from "../flows/manufacturing-adapter.ts";
import {
  INBOUND_PAYMENT_RUN_SUBJECT_KIND,
  OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
} from "../flows/payment-runs-adapter.ts";
import { releasePaymentRunFlowApproval } from "../payments/flow-release.ts";
import { releaseAllocationRunApproval } from "../allocations/flow-release.ts";
import { releaseFundReleaseFlowApproval } from "../nonprofit/flow-release.ts";
import { releaseCloseRunApproval } from "../close/flow-release.ts";
import { registerBalancingLegProvider } from "../journal/balancing-hooks.ts";
import { fundBalancingLegProvider } from "../nonprofit/fund-posting.ts";
import { budgetaryControlProvider } from "../nonprofit/encumbrances.ts";
import { form990ReturnInputProvider } from "../nonprofit/form990.ts";
import { registerReturnInputProvider } from "../tax-returns/return.ts";
import {
  releaseBenefitAwardFlowApproval,
  releaseBenefitEnrollmentFlowApproval,
  releaseCompCycleApproval,
  releaseHrmChangeRequestApproval,
  releaseLeaveRequestApproval,
} from "../hrm/flow-releases.ts";
import { releaseResourcingRequestApproval } from "../resourcing/flow-release.ts";
import { releaseWorkOrderApproval } from "../manufacturing/flow-release.ts";

/**
 * Composition root: the one place that wires engine
 * modules across layering seams.
 *
 * scripting sits below the ledger orchestrator, so it cannot import
 * createScriptJournal; instead the process installs the ledger's writer
 * here and the __journal_create host call invokes it inline, in the same
 * ambient transaction. The engine-owned approval-release handlers register
 * on this same root, as does the document-effects port.
 *
 * Idempotent: re-registering the same writer is a no-op. Call it from every
 * process that can post, run scripts or run flows — web/instrumentation,
 * scripts/worker-entry, and the engine CLIs — and explicitly in tests that
 * exercise those paths (never as a test-suite preload: loading payments
 * and ledger before per-test module mocks would break mocks governed by
 * check:test-mock-surface).
 */
export function installEngineSeams(): void {
  registerScheduleEmailHandler(async({requestId,runId,ctx})=> {
    if(!ctx.userId)throw new Error('Schedule delivery needs its original acting user.');
    return enqueueReviewedSchedule({orgId:ctx.orgId,actorId:ctx.userId,requestId,runId});
  });
  registerScheduleDistributionHooks(async({event,requestId,actor})=> {
    const result=await runRecordFlows({kind:event,occurrenceKey:`schedule:${requestId}:${event}`},'schedule_distribution',requestId,{orgId:actor.orgId,userId:actor.actorId});
    return {failed:result.failed,error:result.error??result.runs.find(r=>r.status==='failed')?.error??null,runs:result.runs.length};
  },async(input)=> {
    if(!await lockAndCheckOrgFeature(db,input.actor.orgId,'flows'))return null;
    const flows=(await db.execute<{graph:unknown}>(sql`select graph from flows where org_id=${input.actor.orgId} and subject_kind='schedule_distribution' and enabled`)).rows;
    const observed=flows.some(flow=>{const parsed=automationGraphSchema.safeParse(flow.graph);return !parsed.success||parsed.data.nodes.some(node=>node.data.kind==='trigger'&&node.data.trigger.trigger===input.event);});
    if(!observed)return null;
    // Optional distribution never undoes a saved booking; its native Flow records issuance failures.
    try {
      const result=await withTransactionSavepoint(db,()=>prepareScheduleLifecycle(input.actor,input.boardId,input.from,input.through,input.event,input.occurrence,input.subjectIds));
      return result.failed?{message:result.error??'An enabled Schedule distribution Flow refused this report.',remedy:'Review the failed native Flow run, contact and email settings; the bookings remain saved.'}:null;
    } catch(error) {
      return {message:error instanceof Error?error.message:'The schedule report could not be prepared.',remedy:'Review the board recipient/sharing and email settings, then explicitly preview/send the report. The bookings remain saved.'};
    }
  });
  registerScriptJournalWriter(createScriptJournal);
  registerFlowApprovalReleaseHandler(CHECKLIST_STEP_SUBJECT_KIND, releaseChecklistStepApproval);
  registerBalancingLegProvider("fund", fundBalancingLegProvider);
  registerBalancingLegProvider("budgetary-control", budgetaryControlProvider);
  registerReturnInputProvider("form990", form990ReturnInputProvider);
  // Engine-owned approval releases: the adapters delegate through
  // releaseFlowApproval; the handlers run inside decideGate's transaction.
  registerFlowApprovalReleaseHandler(ALLOCATION_RUN_SUBJECT_KIND, releaseAllocationRunApproval);
  registerFlowApprovalReleaseHandler(FUND_RELEASE_SUBJECT_KIND, releaseFundReleaseFlowApproval);
  registerFlowApprovalReleaseHandler(CLOSE_RUN_SUBJECT_KIND, releaseCloseRunApproval);
  registerFlowApprovalReleaseHandler(BENEFIT_AWARD_SUBJECT_KIND, releaseBenefitAwardFlowApproval);
  registerFlowApprovalReleaseHandler(BENEFIT_ENROLLMENT_SUBJECT_KIND, releaseBenefitEnrollmentFlowApproval);
  registerFlowApprovalReleaseHandler(HRM_COMP_CYCLE_SUBJECT_KIND, releaseCompCycleApproval);
  registerFlowApprovalReleaseHandler(COMPENSATION_VERSION_SUBJECT_KIND, releaseCompensationPackageFlowApproval);
  registerFlowApprovalReleaseHandler(COMPENSATION_ASSIGNMENT_SUBJECT_KIND, releaseCompensationPackageFlowApproval);
  registerFlowApprovalReleaseHandler(HRM_CHANGE_REQUEST_SUBJECT_KIND, releaseHrmChangeRequestApproval);
  registerFlowApprovalReleaseHandler(HRM_LEAVE_REQUEST_SUBJECT_KIND, releaseLeaveRequestApproval);
  registerFlowApprovalReleaseHandler(RESOURCING_REQUEST_SUBJECT_KIND, releaseResourcingRequestApproval);
  registerFlowApprovalReleaseHandler(WORK_ORDER_SUBJECT_KIND, releaseWorkOrderApproval);
  registerFlowApprovalReleaseHandler(OUTBOUND_PAYMENT_RUN_SUBJECT_KIND, releasePaymentRunFlowApproval);
  registerFlowApprovalReleaseHandler(INBOUND_PAYMENT_RUN_SUBJECT_KIND, releasePaymentRunFlowApproval);
  // Document effects: post_document and before_void completion,
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
