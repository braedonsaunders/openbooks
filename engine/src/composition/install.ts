import { lockPaymentAttempt } from "../payments/payment-attempt-lock.ts";
import { approveBatch, rejectBatch } from "../hrm/field-time/crew.ts";
import { withdrawCloseRunSubmission } from "../close/approvals.ts";
import { closeCalibrationSession } from "../hrm/performance/calibration.ts";
import { releaseCloseTaskApproval, withdrawCloseTaskSubmission } from "../close/tasks.ts";
import { documentPostingPermission } from "../records/document-kind-permissions.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { transitionTrainingCourse } from "../hrm/training/store.ts";
import { signOffFromSourceEvidence } from "../banking/source-evidence.ts";
import { markReconciled } from "../banking/reconciliation.ts";
import { revalidateReconciliationSignOff } from "../banking/reconciliation-revalidation.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import {
  approveDisputeReview,
  rejectDisputeReview,
} from "../payments/psp-refund-automation.ts";
import { registerDocumentApprovalFacts } from "../flows/document-approval-facts.ts";
import { loadQuoteTerms, valueQuoteTerms } from "../billing/quote-to-cash.ts";
import { submitCertificateVerification } from "../compliance/certificate-verification.ts";
import { submitComplianceWaiver } from "../compliance/waivers.ts";
import { releasePromotionApproval } from "../sandbox/promote.ts";
import {
  approvePlan,
  approvePlanLine,
} from "../hrm/compensation/headcount-plans.ts";
import { approveLine, rejectLine } from "../hrm/compensation/cycles.ts";
import { approveEntry } from "../hrm/construction/per-diem.ts";
import {
  approveSubcontract,
  approveSubcontractChangeOrder,
  approveVendorPayApplication,
} from "../projects/subcontracts.ts";
import {
  approvePayApplication,
  submitCustomerChangeOrder,
} from "../projects/construction-billing.ts";
import {
  approveRebateAgreement,
  approveRebateClaim,
} from "../revenue/rebates.ts";
import {
  correctEmploymentChange,
  rescindEmploymentChange,
} from "../hrm/change-event-actions.ts";
import { routeApprovalCommand } from "../flows/command-approval.ts";
import { releaseOfferApproval } from "../hrm/recruiting/offers.ts";
import { releaseNormalizationApproval } from "../billing/metrics/metrics-normalization-service.ts";
import { releaseQuotaApproval } from "../crm/sales.ts";
import { cancelDispatchRuns } from "../flows/dispatch-result.ts";
import { completedGateDecisionPolicy } from "../flows/approval-decision-policy.ts";
import {
  registerApprovalRouter,
  registerApprovalDecisionReader,
  registerApprovalCanceller,
  registerApprovalCommandRouter,
  registerApprovalSubjectFence,
} from "../platform/approval-routing.ts";
import { registerFinancialChangeSubmission } from "../platform/financial-changes.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import {
  registerStockCountRouting,
  releaseStockCountReview,
} from "../inventory/stock-count-approval.ts";
import { STOCK_COUNT_SUBJECT_KIND } from "../flows/stock-counts-adapter.ts";
import { routeSubjectSubmission } from "../flows/submission-policy.ts";
import { CLOSE_REOPEN_SUBJECT_KIND } from "../flows/close-reopen-requests-adapter.ts";
import { finalizePeriodReopenApproval } from "../close/reopen-lifecycle.ts";
import {sql} from 'drizzle-orm';
import {automationGraphSchema} from '@openbooks/forms-core';
import {db,withTransactionSavepoint} from '../platform/db.ts';
import {lockAndCheckOrgFeature} from '../organization/org-feature-lock.ts';
import {runRecordFlows} from '../flows/run.ts';
import {
  registerAutomaticScheduleHandler,
  registerScheduleEmailHandler,
} from "../flows/schedule-distribution-hook.ts";
import {registerScheduleDistributionHooks} from '../schedule-boards/distribution-hooks.ts';
import { registerShiftRequestRouting, releaseShiftRequestApproval, SHIFT_REQUEST_SUBJECT_KIND } from "../schedule-boards/requests.ts";
import { registerSchedulePublicationRouting, releasePublicationApproval, SCHEDULE_PUBLICATION_SUBJECT_KIND } from "../schedule-boards/publications.ts";
import { releaseCompletionReview } from "../service/completion.ts";
import { SERVICE_VISIT_COMPLETION_SUBJECT_KIND } from "../flows/service-visit-adapter.ts";
import {
  deliverAutomaticSchedule,
  enqueueReviewedSchedule,
  prepareScheduleLifecycle,
} from "../schedule-boards/distribution.ts";
import { CHECKLIST_STEP_SUBJECT_KIND } from "@openbooks/forms-core";
import { releaseChecklistStepApproval } from "../hrm/processes.ts";
import { BENEFIT_ENROLLMENT_SUBJECT_KIND } from "@openbooks/schema/src/hrm-benefits.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import { registerScriptJournalWriter } from "../scripting/journal-writer.ts";
import { registerFlowApprovalReleaseHandler, registerFlowSubmissionResumeHandler, registerFlowCommandWithdrawalHandler } from "../flows/approval-release-hook.ts";
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
import { releaseCompensationPackageFlowApproval, resumeCompensationPackageSubmission } from "../payroll/compensation-package-flow-release.ts";
import { BENEFIT_AWARD_SUBJECT_KIND } from "@openbooks/schema/src/benefits-programs.ts";
import { completeBenefitAwardSubmission } from "../hrm/benefits/awards.ts";
import { completeBenefitEnrollmentSubmission } from "../hrm/benefits/enrollments.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { completeHrmChangeRequestSubmission } from "../hrm/change-requests-lifecycle.ts";
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { RESOURCING_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/resourcing.ts";
import { WORK_ORDER_SUBJECT_KIND } from "../flows/manufacturing-adapter.ts";
import {
  INBOUND_PAYMENT_RUN_SUBJECT_KIND,
  OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
} from "../flows/payment-runs-adapter.ts";
import { releasePaymentRunFlowApproval } from "../payments/flow-release.ts";
import { EQUITY_ACTION_SUBJECT_KIND } from "../flows/equity-actions-adapter.ts";
import { releaseEquityActionFlowApproval } from "../equity/action-release.ts";
import { INTERCOMPANY_NETTING_RUN_SUBJECT_KIND } from "../flows/intercompany-netting-runs-adapter.ts";
import { releaseNettingRunFlowApproval } from "../intercompany/flow-release.ts";
import { crossSubsidiaryFulfillmentHandlerImpl } from "../intercompany/fulfillment.ts";
import { registerCrossSubsidiaryFulfillmentHandler } from "../inventory/cross-subsidiary.ts";
import { releaseAllocationRunApproval } from "../allocations/flow-release.ts";
import { releaseFundReleaseFlowApproval } from "../nonprofit/flow-release.ts";
import { releaseCloseRunApproval } from "../close/flow-release.ts";
import { genericSegmentBalancingProvider } from "../journal/generic-balancing.ts";
import { registerBalancingLegProvider } from "../journal/balancing-hooks.ts";
import { fundBalancingLegProvider } from "../nonprofit/fund-posting.ts";
import { budgetaryControlProvider } from "../nonprofit/encumbrances.ts";
import { mergedAccountPostingProvider, segmentDependencyPostingProvider } from "../chart/posting-policies.ts";
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
import { installPostingContributors } from "./posting-contributors.ts";

/**
 * Composition root: the one place that wires engine
 * modules across layering seams.
 *
 * scripting sits below the ledger orchestrator, so it cannot import
 * createScriptJournal; instead the process installs the ledger's writer
 * here and the __journal_create host call invokes it inline, in the same
 * ambient transaction. The engine-owned approval-release handlers register
 * on this same root, as do the document-effects port and the domain posting
 * contributors the ledger resolves when it posts, edits or voids.
 *
 * Idempotent: re-registering the same writer is a no-op. Call it from every
 * process that can post, run scripts or run flows — web/instrumentation,
 * scripts/worker-entry, and the engine CLIs — and explicitly in tests that
 * exercise those paths (never as a test-suite preload: loading payments
 * and ledger before per-test module mocks would break mocks governed by
 * check:test-mock-surface).
 */
export function installEngineSeams(): void {
  installPostingContributors();
  registerFlowApprovalReleaseHandler("crew_time_batch", async ({ subjectId, outcome, comment, approvalRunId, ctx }) => {
    if (!ctx.userId || !approvalRunId) throw new Error("Crew batch decisions require their native Flow gate and acting user.");
    const allowedSubsidiaryIds = await actorAllowedSubsidiaryIds(db, ctx.orgId, ctx.userId);
    if (outcome === "approved") {
      await approveBatch({ orgId: ctx.orgId, actorUserId: ctx.userId, batchId: subjectId,
        comment, approvalRunId, allowedSubsidiaryIds });
    } else {
      await rejectBatch({ orgId: ctx.orgId, actorUserId: ctx.userId, batchId: subjectId,
        reason: comment?.trim() || "Rejected by approver", approvalRunId, allowedSubsidiaryIds });
    }
  });
  registerApprovalSubjectFence("payment_dispute_review",async(orgId,subjectId)=>{
    const row=(await db.execute<{attempt_id:string|null}>(sql`select attempt_id from payment_disputes where org_id=${orgId} and id=${subjectId}`, "objects"))[0];
    if(row?.attempt_id)await lockPaymentAttempt(orgId,row.attempt_id);
  });
  registerDocumentApprovalFacts("quote", async (orgId, id) => {
    const terms = await loadQuoteTerms(db, orgId, id);
    const value = valueQuoteTerms(terms);
    return {
      subscriptionDiscountPercent: value.discountPct,
      subscriptionFloorBreached: value.floorBreached,
      subscriptionTotalContractValue: value.tcv,
    };
  });
  registerAutomaticScheduleHandler(async ({ boardId, runId, ctx }) => {
    if (!ctx.userId || !ctx.scheduledOccurrence)
      throw new Error(
        "Automatic schedule delivery needs its stored operator and durable occurrence.",
      );
    return deliverAutomaticSchedule({
      orgId: ctx.orgId,
      boardId,
      runId,
      operatorId: ctx.userId,
      occurrence: ctx.scheduledOccurrence,
    });
  });
  registerScheduleEmailHandler(async({requestId,runId,ctx})=> {
    if(!ctx.userId)throw new Error('Schedule delivery needs its original acting user.');
    return enqueueReviewedSchedule({orgId:ctx.orgId,actorId:ctx.userId,requestId,runId});
  });
  for (const side of ["customer", "vendor"]) {
    for (const type of ["agreement", "claim"]) {
      registerFlowApprovalReleaseHandler(
        `${side}_rebate_${type}`,
        async (args) => {
          if (args.outcome !== "approved") return;
          if (
            !args.ctx.userId ||
            !args.approvalRunId ||
            typeof args.command?.reason !== "string"
          )
            throw new Error("The rebate submission command is incomplete.");
          if (type === "agreement")
            await approveRebateAgreement(
              args.ctx.orgId,
              args.ctx.userId,
              args.subjectId,
              args.command.reason,
              args.approvalRunId,
            );
          else
            await approveRebateClaim(
              args.ctx.orgId,
              args.ctx.userId,
              args.subjectId,
              args.command.reason,
              args.approvalRunId,
            );
        },
      );
    }
  }
  registerFlowApprovalReleaseHandler(
    "employment_change_action",
    async (args) => {
      if (args.outcome !== "approved") return;
      if (!args.ctx.userId || typeof args.command?.reason !== "string")
        throw new Error("The employment correction command is incomplete.");
      const input = {
        orgId: args.ctx.orgId,
        actorId: args.ctx.userId,
        changeId: args.subjectId,
        reason: args.command.reason,
        approvalRunId: args.approvalRunId,
      };
      if (args.command.action === "rescind")
        await rescindEmploymentChange(input);
      else if (
        args.command.action === "correct" &&
        args.command.correctedFields &&
        typeof args.command.correctedFields === "object" &&
        !Array.isArray(args.command.correctedFields)
      )
        await correctEmploymentChange({
          ...input,
          correctedFields: args.command.correctedFields as Record<
            string,
            unknown
          >,
        });
      else
        throw new Error("The submitted employment correction is unsupported.");
    },
  );
  for (const kind of [
    "subcontract",
    "subcontract_change_order",
    "vendor_pay_application",
    "customer_pay_application",
  ]) {
    registerFlowApprovalReleaseHandler(kind, async (args) => {
      if (args.outcome !== "approved") return;
      if (!args.ctx.userId || !args.approvalRunId)
        throw new Error(
          "The native construction approval command is incomplete.",
        );
      const orgId = args.ctx.orgId,
        actorId = args.ctx.userId,
        id = args.subjectId;
      if (kind === "subcontract")
        await approveSubcontract(orgId, actorId, id, args.approvalRunId);
      else if (kind === "vendor_pay_application")
        await approveVendorPayApplication(
          orgId,
          actorId,
          id,
          args.approvalRunId,
        );
      else if (kind === "customer_pay_application") {
        const { actorAllowedSubsidiaryIds } =
          await import("../organization/actor-subsidiaries.ts");
        await approvePayApplication(
          orgId,
          actorId,
          id,
          await actorAllowedSubsidiaryIds(db, orgId, actorId),
          args.approvalRunId,
        );
      } else if (typeof args.command?.approvedOn === "string")
        await approveSubcontractChangeOrder(
          orgId,
          actorId,
          id,
          args.command.approvedOn,
          args.approvalRunId,
        );
      else throw new Error("The submitted change order has no approval date.");
    });
  }
  for (const kind of [
    "headcount_plan",
    "headcount_plan_line",
    "compensation_cycle_line",
    "per_diem_entry",
    "travel_pay_entry",
  ]) {
    registerFlowApprovalReleaseHandler(kind, async (args) => {
      if (!args.ctx.userId || !args.approvalRunId)
        throw new Error("The workforce approval command is incomplete.");
      const input = {
        orgId: args.ctx.orgId,
        actorId: args.ctx.userId,
        approvalRunId: args.approvalRunId,
      };
      if (kind === "compensation_cycle_line") {
        if (args.outcome === "rejected")
          await rejectLine({
            ...input,
            lineId: args.subjectId,
            reason:
              args.comment?.trim() ||
              "Rejected through the configured Flow gate.",
          });
        else
          await approveLine({
            ...input,
            lineId: args.subjectId,
            reason:
              typeof args.command?.reason === "string"
                ? args.command.reason
                : null,
          });
      } else if (args.outcome === "approved") {
        if (kind === "headcount_plan")
          await approvePlan({ ...input, planId: args.subjectId });
        else if (kind === "headcount_plan_line")
          await approvePlanLine({
            ...input,
            lineId: args.subjectId,
            reason:
              typeof args.command?.reason === "string"
                ? args.command.reason
                : null,
          });
        else
          await approveEntry(db, {
            ...input,
            entryId: args.subjectId,
            kind: kind === "per_diem_entry" ? "per_diem" : "travel",
          });
      }
    });
  }
  registerFlowApprovalReleaseHandler(
    "sandbox_change_set",
    releasePromotionApproval,
  );
  registerFlowApprovalReleaseHandler("compliance_waiver", async (args) => {
    if (args.outcome !== "approved") return;
    if (!args.ctx.userId || !args.approvalRunId)
      throw new Error("The exception submission is incomplete.");
    await submitComplianceWaiver({
      orgId: args.ctx.orgId,
      actorId: args.ctx.userId,
      id: args.subjectId,
      approvalRunId: args.approvalRunId,
    });
  });
  registerFlowApprovalReleaseHandler("customer_change_order", async (args) => {
    if (args.outcome !== "approved") return;
    if (
      !args.ctx.userId ||
      !args.approvalRunId ||
      typeof args.command?.approvedOn !== "string"
    )
      throw new Error("The customer change-order command is incomplete.");
    await submitCustomerChangeOrder({
      orgId: args.ctx.orgId,
      actorId: args.ctx.userId,
      id: args.subjectId,
      approvedOn: args.command.approvedOn,
      approvalRunId: args.approvalRunId,
    });
  });
  registerFlowApprovalReleaseHandler("compliance_certificate", async (args) => {
    if (args.outcome !== "approved") return;
    if (
      !args.ctx.userId ||
      !args.approvalRunId ||
      typeof args.command?.revision !== "number"
    )
      throw new Error("The certificate submission is incomplete.");
    await submitCertificateVerification({
      orgId: args.ctx.orgId,
      actorId: args.ctx.userId,
      id: args.subjectId,
      revision: args.command.revision,
      approvalRunId: args.approvalRunId,
    });
  });
  registerFlowApprovalReleaseHandler("payment_dispute_review", async (args) => {
    if (!args.ctx.userId || !args.approvalRunId)
      throw new Error(
        "Provider return decisions require a native Flow gate and acting user.",
      );
    const scope = await actorAllowedSubsidiaryIds(
      db,
      args.ctx.orgId,
      args.ctx.userId,
    );
    if (args.outcome === "approved")
      await approveDisputeReview(
        args.ctx.orgId,
        args.subjectId,
        args.ctx.userId,
        scope,
        args.approvalRunId,
      );
    else
      await rejectDisputeReview(
        args.ctx.orgId,
        args.subjectId,
        args.ctx.userId,
        args.comment ?? "Rejected through the tenant's Flow",
        scope,
        args.approvalRunId,
      );
  });
  for (const kind of [
    "bank_reconciliation_sign_off",
    "bank_reconciliation_review",
  ]) {
    registerFlowApprovalReleaseHandler(kind, async (args) => {
      if (args.outcome !== "approved") return;
      if (!args.ctx.userId || !args.approvalRunId)
        throw new Error(
          "Bank reconciliation release requires its native Flow decision.",
        );
      const ctx = {
        orgId: args.ctx.orgId,
        userId: args.ctx.userId,
        allowedSubsidiaryIds: await actorAllowedSubsidiaryIds(
          db,
          args.ctx.orgId,
          args.ctx.userId,
        ),
      };
      if (kind === "bank_reconciliation_sign_off") {
        if (args.command?.sourceEvidence === true) {
          const record = (await db.execute<{ account_id: string }>(
              sql`select account_id from reconciliations where org_id=${ctx.orgId} and id=${args.subjectId}`, "objects",
            ))[0];
          if (!record)
            throw new Error("The source reconciliation is unavailable.");
          const result = await signOffFromSourceEvidence(
            {
              accountId: record.account_id,
              reconciliationId: args.subjectId,
              approvalRunId: args.approvalRunId,
            },
            ctx,
          );
          if (!result.signed)
            throw new Error(
              "The source evidence no longer admits this sign-off. Recall the submission and review the source reconciliation.",
            );
        } else await markReconciled(args.subjectId, ctx, args.approvalRunId);
      } else {
        if (
          typeof args.command?.expectedDigest !== "string" ||
          typeof args.command.reason !== "string"
        )
          throw new Error(
            "The reconciliation review has no complete frozen evidence.",
          );
        await revalidateReconciliationSignOff(
          args.subjectId,
          {
            expectedDigest: args.command.expectedDigest,
            reason: args.command.reason,
            approvalRunId: args.approvalRunId,
          },
          ctx,
        );
      }
    });
  }
  registerFlowApprovalReleaseHandler("hrm_calibration_session",async args=>{
    if(args.outcome!=="approved")return;
    if(!args.ctx.userId || !args.approvalRunId || args.command?.action!=="close")throw new Error("The calibration publication command is incomplete; recall and resubmit it.");
    await closeCalibrationSession({orgId:args.ctx.orgId,actorId:args.ctx.userId,id:args.subjectId,approvalRunId:args.approvalRunId});
  });
  registerFlowCommandWithdrawalHandler("close_task",withdrawCloseTaskSubmission);
  registerFlowCommandWithdrawalHandler("close_run",withdrawCloseRunSubmission);
  registerFlowApprovalReleaseHandler("close_task",async args=>{
    if(!args.ctx.userId || !args.approvalRunId || !args.command)throw new Error("The close task submission is incomplete; recall and resubmit it.");
    await releaseCloseTaskApproval({orgId:args.ctx.orgId,actorId:args.ctx.userId,taskId:args.subjectId,
      approvalRunId:args.approvalRunId,outcome:args.outcome,command:args.command});
  });
  registerFlowApprovalReleaseHandler("training_course", async (args) => {
    if (args.outcome !== "approved") return;
    if (
      !args.ctx.userId ||
      !args.approvalRunId ||
      typeof args.command?.expectedRevision !== "number" ||
      typeof args.command.reason !== "string"
    )
      throw new Error(
        "The training course submission is incomplete. Recall it and submit its current revision.",
      );
    await transitionTrainingCourse({
      orgId: args.ctx.orgId,
      actorId: args.ctx.userId,
      courseId: args.subjectId,
      action: "submit",
      expectedRevision: args.command.expectedRevision,
      reason: args.command.reason,
      approvalRunId: args.approvalRunId,
    });
  });
  registerApprovalRouter(routeSubjectSubmission);
  registerApprovalCommandRouter(routeApprovalCommand);
  registerApprovalCanceller(async (input) => {
    const rows = await db.execute<{
        id: string;
      }>(sql`select id from flow_runs where org_id=${input.orgId}
      and subject_kind=${input.subjectKind} and subject_id=${input.subjectId} and status in ('running','waiting') order by id for update`, "objects");
    await cancelDispatchRuns(
      input.orgId,
      rows.map((row) => row.id),
      { actorId: input.actorId },
    );
  });
  registerFlowApprovalReleaseHandler("sales_quota", releaseQuotaApproval);
  registerFlowApprovalReleaseHandler("recruiting_offer", releaseOfferApproval);
  registerFlowApprovalReleaseHandler(
    "metrics_normalization",
    releaseNormalizationApproval,
  );
  registerApprovalDecisionReader((input) =>
    completedGateDecisionPolicy(db, input),
  );
  registerScheduleDistributionHooks(async({event,requestId,actor})=> {
    const result=await runRecordFlows({kind:event,occurrenceKey:`schedule:${requestId}:${event}`},'schedule_distribution',requestId,{orgId:actor.orgId,userId:actor.actorId});
      return {
        failed: result.failed,
        error:
          result.error ??
          result.runs.find((r) => r.status === "failed")?.error ??
          null,
        runs: result.runs.length,
      };
  },async(input)=> {
      if (!(await lockAndCheckOrgFeature(db, input.actor.orgId, "flows")))
        return null;
    const flows=await db.execute<{graph:unknown}>(sql`select graph from flows where org_id=${input.actor.orgId} and subject_kind='schedule_distribution' and enabled`, "objects");
      const observed = flows.some((flow) => {
        const parsed = automationGraphSchema.safeParse(flow.graph);
        return (
          !parsed.success ||
          parsed.data.nodes.some(
            (node) =>
              node.data.kind === "trigger" &&
              node.data.trigger.trigger === input.event,
          )
        );
      });
    if(!observed)return null;
    // Optional distribution never undoes a saved booking; its native Flow records issuance failures.
    try {
      const result=await withTransactionSavepoint(db,()=>prepareScheduleLifecycle(input.actor,input.boardId,input.from,input.through,input.event,input.occurrence,input.subjectIds));
      return result.failed?{message:result.error??'An enabled Schedule distribution Flow refused this report.',remedy:'Review the failed native Flow run, contact and email settings; the bookings remain saved.'}:null;
    } catch(error) {
      return {message:error instanceof Error?error.message:'The schedule report could not be prepared.',remedy:'Review the board recipient/sharing and email settings, then explicitly preview/send the report. The bookings remain saved.'};
    }
  });
  // Shift requests and governed schedule publications submit to optional
  // Flows; a gating Flow owns the decision and releases it through the
  // scheduling service, otherwise the submission applies at once.
  const submitToFlows =
    (subjectKind: string) =>
    async (actor: { orgId: string; actorId: string }, subjectId: string) => {
      const result = (
        await routeSubjectSubmission({
          orgId: actor.orgId,
          actorId: actor.actorId,
          subjectKind,
          subjectId,
          source: "api",
        })
      ).dispatch;
      const failedRun = result.runs.find((run) => run.status === "failed");
      return {
      gated: result.gatesCreated > 0,
      runId: result.runs.find((run) => run.gatesCreated > 0)?.runId ?? null,
      failed: result.failed || Boolean(failedRun),
      error: result.error ?? failedRun?.error ?? null,
    };
    };
  registerShiftRequestRouting(submitToFlows(SHIFT_REQUEST_SUBJECT_KIND));
  registerSchedulePublicationRouting(submitToFlows(SCHEDULE_PUBLICATION_SUBJECT_KIND));
  registerFlowApprovalReleaseHandler(
    SHIFT_REQUEST_SUBJECT_KIND,
    async ({ subjectId, outcome, comment, ctx, approvalRunId }) => {
      if (!ctx.userId) throw new Error("Shift request decisions need the deciding user.");
      await releaseShiftRequestApproval({
        orgId: ctx.orgId,
        actorId: ctx.userId,
        requestId: subjectId,
        outcome,
        comment,
        approvalRunId,
      });
    },
  );
  registerFlowApprovalReleaseHandler(
    SCHEDULE_PUBLICATION_SUBJECT_KIND,
    async ({ subjectId, outcome, comment, ctx, approvalRunId }) => {
      if (!ctx.userId) throw new Error("Schedule publication decisions need the deciding user.");
      await releasePublicationApproval({
        orgId: ctx.orgId,
        actorId: ctx.userId,
        publicationId: subjectId,
        outcome,
        comment,
        approvalRunId,
      });
    },
  );
  // A service visit completion review is decided in its Flow; the service
  // module applies the decision inside the gate's transaction.
  registerFlowApprovalReleaseHandler(SERVICE_VISIT_COMPLETION_SUBJECT_KIND, async ({ subjectId, outcome, comment, ctx }) => {
    if (!ctx.userId) throw new Error("Service visit completion decisions need the deciding user.");
    await releaseCompletionReview({ orgId: ctx.orgId, actorId: ctx.userId, visitId: subjectId, outcome, comment });
  });
  registerScriptJournalWriter(createScriptJournal);
  registerFlowApprovalReleaseHandler(CHECKLIST_STEP_SUBJECT_KIND, releaseChecklistStepApproval);
  registerBalancingLegProvider("fund", fundBalancingLegProvider);
  registerBalancingLegProvider("budgetary-control", budgetaryControlProvider);
  registerBalancingLegProvider("merged-accounts", mergedAccountPostingProvider);
  registerBalancingLegProvider("segment-dependencies", segmentDependencyPostingProvider);
  registerBalancingLegProvider("generic-segments", genericSegmentBalancingProvider);
  registerReturnInputProvider("form990", form990ReturnInputProvider);
  // Engine-owned approval releases: the adapters delegate through
  // releaseFlowApproval; the handlers run inside decideGate's transaction.
  registerFlowApprovalReleaseHandler(ALLOCATION_RUN_SUBJECT_KIND, releaseAllocationRunApproval);
  registerFlowApprovalReleaseHandler(FUND_RELEASE_SUBJECT_KIND, releaseFundReleaseFlowApproval);
  registerFinancialChangeSubmission(submitFinancialChange);
  registerStockCountRouting(async ({ orgId, actorId, countId, cancel }) => {
    if (cancel) {
      const runs = await db.execute<{
          id: string;
        }>(sql`select id from flow_runs where org_id=${orgId}
        and subject_kind=${STOCK_COUNT_SUBJECT_KIND} and subject_id=${countId}`, "objects");
      await cancelDispatchRuns(
        orgId,
        runs.map((run) => run.id),
        { actorId },
      );
      return;
    }
    return (
      await routeSubjectSubmission({
        orgId,
        actorId,
        subjectId: countId,
        subjectKind: STOCK_COUNT_SUBJECT_KIND,
      })
    ).policy;
  });
  registerFlowApprovalReleaseHandler(
    STOCK_COUNT_SUBJECT_KIND,
    async ({ subjectId, outcome, approvalRunId, ctx }) => {
      if (!ctx.userId)
        throw new Error("A stock count decision requires its native actor.");
      const proof = await completedGateDecisionPolicy(db, {
        orgId: ctx.orgId,
        subjectKind: STOCK_COUNT_SUBJECT_KIND,
        subjectId,
        approvalRunId,
        actorId: ctx.userId,
        outcome,
      });
      if (!proof)
        throw new Error(
          "Complete the stock count Flow gates before releasing review.",
        );
      await releaseStockCountReview({
        orgId: ctx.orgId,
        countId: subjectId,
        actorId: ctx.userId,
        outcome,
      });
    },
  );
  registerFlowApprovalReleaseHandler(CLOSE_RUN_SUBJECT_KIND, releaseCloseRunApproval);
  registerFlowApprovalReleaseHandler(
    CLOSE_REOPEN_SUBJECT_KIND,
    async ({ subjectId, outcome, comment, approvalRunId, ctx }) => {
      if (!ctx.userId)
        throw new Error("Period reopen decisions require a signed-in actor.");
      await finalizePeriodReopenApproval({
        orgId: ctx.orgId,
        requestId: subjectId,
        actorId: ctx.userId,
        outcome,
        comment,
        approvalRunId,
      });
    },
  );
  registerFlowApprovalReleaseHandler(BENEFIT_AWARD_SUBJECT_KIND, releaseBenefitAwardFlowApproval);
  registerFlowApprovalReleaseHandler(BENEFIT_ENROLLMENT_SUBJECT_KIND, releaseBenefitEnrollmentFlowApproval);
  registerFlowApprovalReleaseHandler(HRM_COMP_CYCLE_SUBJECT_KIND, releaseCompCycleApproval);
  registerFlowApprovalReleaseHandler(COMPENSATION_VERSION_SUBJECT_KIND, releaseCompensationPackageFlowApproval);
  registerFlowApprovalReleaseHandler(COMPENSATION_ASSIGNMENT_SUBJECT_KIND, releaseCompensationPackageFlowApproval);
  registerFlowApprovalReleaseHandler(HRM_CHANGE_REQUEST_SUBJECT_KIND, releaseHrmChangeRequestApproval);
  registerFlowSubmissionResumeHandler(BENEFIT_AWARD_SUBJECT_KIND, (args) => {
    if (!args.ctx.userId) throw new Error('Benefit submission completion requires its original acting user.');
    return completeBenefitAwardSubmission({ orgId: args.ctx.orgId, actorId: args.ctx.userId,
      awardId: args.subjectId, runId: args.runId, mode: args.mode });
  });
  registerFlowSubmissionResumeHandler(BENEFIT_ENROLLMENT_SUBJECT_KIND, (args) => {
    if (!args.ctx.userId) throw new Error('Benefit submission completion requires its original acting user.');
    return completeBenefitEnrollmentSubmission({ orgId: args.ctx.orgId, actorId: args.ctx.userId,
      enrollmentId: args.subjectId, runId: args.runId, mode: args.mode });
  });
  registerFlowSubmissionResumeHandler(HRM_CHANGE_REQUEST_SUBJECT_KIND, completeHrmChangeRequestSubmission);
  registerFlowSubmissionResumeHandler(COMPENSATION_VERSION_SUBJECT_KIND, resumeCompensationPackageSubmission);
  registerFlowSubmissionResumeHandler(COMPENSATION_ASSIGNMENT_SUBJECT_KIND, resumeCompensationPackageSubmission);
  registerFlowApprovalReleaseHandler(HRM_LEAVE_REQUEST_SUBJECT_KIND, releaseLeaveRequestApproval);
  registerFlowApprovalReleaseHandler(RESOURCING_REQUEST_SUBJECT_KIND, releaseResourcingRequestApproval);
  registerFlowApprovalReleaseHandler(WORK_ORDER_SUBJECT_KIND, releaseWorkOrderApproval);
  registerFlowApprovalReleaseHandler(OUTBOUND_PAYMENT_RUN_SUBJECT_KIND, releasePaymentRunFlowApproval);
  registerFlowApprovalReleaseHandler(INBOUND_PAYMENT_RUN_SUBJECT_KIND, releasePaymentRunFlowApproval);
  // Governed equity actions apply through the equity module when their Flow approves.
  registerFlowApprovalReleaseHandler(EQUITY_ACTION_SUBJECT_KIND, releaseEquityActionFlowApproval);
  registerFlowApprovalReleaseHandler(INTERCOMPANY_NETTING_RUN_SUBJECT_KIND, releaseNettingRunFlowApproval);
  // Cross-subsidiary fulfillment: inventory hands a line shipped from another
  // entity's warehouse to the intercompany handler, which sits above it.
  registerCrossSubsidiaryFulfillmentHandler(crossSubsidiaryFulfillmentHandlerImpl);
  // Document effects: post_document and before_void completion,
  // verbatim from flows/execute.ts and flows/documents-adapter.ts. Runs
  // inline in the caller's chain, so the ambient pinned org transaction
  // that `db` routes to does not change.
  registerFlowDocumentEffects({
    async postSubject({ subjectKind, subjectId, ctx }) {
      const identity = (await db.execute<{
          subsidiary_id: string | null;
          status: string;
          posted_entry_id: string | null;
        }>(sql`
        select subsidiary_id,status,posted_entry_id from documents where org_id=${ctx.orgId} and id=${subjectId} and kind=${subjectKind} for update`, "objects"))[0];
      const permission = documentPostingPermission(subjectKind);
      if (!identity || !ctx.userId || !permission)
        throw new Error(
          "Flow posting requires its native document and authorized acting user.",
        );
      await lockActorCommandAuthority(
        db,
        ctx.orgId,
        ctx.userId,
        identity.subsidiary_id,
        permission,
      );
      if (identity.status === "posted") {
        const retained = (await db.execute<{
            id: string;
          }>(sql`select id from journal_entries where org_id=${ctx.orgId} and id=${identity.posted_entry_id}
          -- Live entries only: posting replay requires the retained journal to remain effective.
          and source_document_id=${subjectId} and status='posted'`, "objects"))[0];
        if (!retained)
          throw new Error(
            "The posted document has no intact native journal. Review its accounting history before retrying.",
          );
        return retained.id;
      }
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
