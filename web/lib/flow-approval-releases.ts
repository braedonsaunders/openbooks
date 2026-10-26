import "server-only";
import { registerFlowApprovalReleaseHandler } from "@openbooks/engine/flows/module";

/**
 * Web-owned flow approval releases, registered at boot by
 * web/instrumentation.node.ts.
 *
 * Most flow subjects release entirely inside the engine. A few product
 * records orchestrate services that intentionally live in the web package
 * (field-ticket rate resolution and project-charge materialization,
 * timesheet stamping and pre-billing worksheets). The engine cannot
 * import web, so the node server registers those handlers here at boot,
 * exactly like the flow PDF renderer.
 *
 * The set of kinds registered here must cover handlerReleasedSubjectKinds()
 * from the engine subject registry — flow-approval-releases.test.ts enforces
 * that, so a new hook-delegated subject without a handler fails the suite
 * instead of stranding its approval gates pending forever.
 */
export async function registerFlowApprovalReleaseHandlers(): Promise<void> {
  // Field-ticket approval policy is tenant-authored in Flows. The engine owns
  // routing and gate decisions; this web hook supplies the product service
  // that atomically materializes ticket-owned project charges, provenance,
  // status, and audit evidence when the gate resolves. Time-entry approval and
  // payroll posting remain an independent lifecycle.
  registerFlowApprovalReleaseHandler(
    "field_ticket",
    async ({ subjectId, outcome, comment, approvalRunId, ctx }) => {
      if (!ctx.userId) throw new Error("field-ticket approval needs an acting user");
      const { releaseFieldTicketApproval } = await import("./field-tickets");
      await releaseFieldTicketApproval(
        ctx.orgId,
        ctx.userId,
        subjectId,
        outcome,
        comment,
        approvalRunId,
      );
    },
  );

  // Timesheet approval routing is tenant-authored in Flows too. The engine
  // decides WHO approves and when the gates resolve; this supplies what
  // approval means for hours — stamping the approver across the week, or
  // returning it with the approver's reason attached.
  registerFlowApprovalReleaseHandler(
    "timesheet_week",
    async ({ subjectId, outcome, comment, approvalRunId, ctx }) => {
      if (!ctx.userId) throw new Error("timesheet approval needs an acting user");
      const { releaseTimesheetWeekApproval } = await import("./timesheet-approval-release");
      await releaseTimesheetWeekApproval(
        ctx.orgId,
        ctx.userId,
        subjectId,
        outcome,
        ctx.allowedSubsidiaryIds ?? null,
        comment,
        approvalRunId,
      );
    },
  );

  // Pre-billing worksheet approval is tenant-authored in Flows. The engine
  // decides who approves; this supplies what approval means for a worksheet —
  // freezing its lines as approved, or returning it to draft with the
  // approver's reason attached.
  registerFlowApprovalReleaseHandler(
    "prebill",
    async ({ subjectId, outcome, comment, approvalRunId, ctx }) => {
      if (!ctx.userId) throw new Error("pre-billing approval needs an acting user");
      const { releasePrebillApproval } = await import("./pre-billing");
      await releasePrebillApproval(
        ctx.orgId,
        ctx.userId,
        subjectId,
        outcome,
        comment,
        approvalRunId,
      );
    },
  );
}
