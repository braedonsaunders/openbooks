/**
 * HR-15 inbox module entrypoint — registers every adapter.
 *
 * Importing this module wires the read model: flows approvals first
 * (the approvals leg), then the HRM legs, then operations signatures,
 * weeks, expenses, and the HR-19 placeholder. The registry tolerates
 * adapters whose source has not landed (qualification alerts,
 * document signatures) — they list nothing until their source exists.
 */
import { aiCapabilityReviewAdapter, payrollAnomalyBlockAdapter } from "./adapters/ai-rails.ts";
import { documentSignatureAdapter } from "./adapters/document-signature.ts";
import { expenseReportAdapter } from "./adapters/expense-report.ts";
import { fieldTicketSignatureAdapter } from "./adapters/field-ticket-signature.ts";
import { flowsApprovalAdapter } from "./adapters/flows-approval.ts";
import { hrmBenefitEnrollmentWindowAdapter } from "./adapters/hrm-benefit-enrollment-window.ts";
import { hrmChangeRequestAdapter } from "./adapters/hrm-change-request.ts";
import { hrmLeaveRequestAdapter } from "./adapters/hrm-leave-request.ts";
import { hrmProcessStepAdapter } from "./adapters/hrm-process-step.ts";
import { hrmQualificationAlertAdapter } from "./adapters/hrm-qualification-alert.ts";
import { hrmFeedbackRequestAdapter } from "./adapters/hrm-feedback-request.ts";
import { hrmReviewAdapter } from "./adapters/hrm-review.ts";
import { notificationAdapter } from "./adapters/notification.ts";
import { timesheetWeekAdapter } from "./adapters/timesheet-week.ts";
// HR-20 begin
import { crewTimeBatchAdapter } from "./adapters/crew-time-batch.ts";
// HR-20 end
import { registerInboxAdapter } from "./registry.ts";

registerInboxAdapter(flowsApprovalAdapter);
registerInboxAdapter(hrmProcessStepAdapter);
registerInboxAdapter(hrmLeaveRequestAdapter);
registerInboxAdapter(hrmChangeRequestAdapter);
registerInboxAdapter(hrmReviewAdapter);
// HR-17 begin: feedback requests waiting on the actor.
registerInboxAdapter(hrmFeedbackRequestAdapter);
// HR-17 end
registerInboxAdapter(notificationAdapter);
registerInboxAdapter(hrmBenefitEnrollmentWindowAdapter);
registerInboxAdapter(hrmQualificationAlertAdapter);
registerInboxAdapter(fieldTicketSignatureAdapter);
registerInboxAdapter(timesheetWeekAdapter);
// HR-20 begin
registerInboxAdapter(crewTimeBatchAdapter);
// HR-20 end
registerInboxAdapter(expenseReportAdapter);
registerInboxAdapter(documentSignatureAdapter);
// HR-21: blocking payroll checks and overdue capability reviews.
registerInboxAdapter(payrollAnomalyBlockAdapter);
registerInboxAdapter(aiCapabilityReviewAdapter);

export { actOnInboxItem, countInbox, InboxError, listInbox, type InboxSourceNotice } from "./registry.ts";
export { markNotificationsRead, writeNotification, type NotificationWrite } from "./adapters/notification.ts";
export type { InboxAdapter, InboxPage } from "./registry.ts";
export type {
  InboxActionDef,
  InboxActionStyle,
  InboxItem,
  InboxKind,
  InboxListContext,
  InboxPriority,
} from "./types.ts";
export { compareInboxItems, inboxItemId, parseInboxItemId, priorityForDueDate } from "./types.ts";
