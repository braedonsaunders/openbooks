/**
 * HR-15 inbox module entrypoint — registers every adapter.
 *
 * Importing this module wires the read model: flows approvals first
 * (the approvals leg), then the HRM legs, then operations signatures,
 * weeks, expenses, and the HR-19 placeholder. The registry tolerates
 * adapters whose source has not landed (qualification alerts,
 * document signatures) — they list nothing until their source exists.
 */
import { documentSignatureAdapter } from "./adapters/document-signature.ts";
import { expenseReportAdapter } from "./adapters/expense-report.ts";
import { fieldTicketSignatureAdapter } from "./adapters/field-ticket-signature.ts";
import { flowsApprovalAdapter } from "./adapters/flows-approval.ts";
import { hrmBenefitEnrollmentWindowAdapter } from "./adapters/hrm-benefit-enrollment-window.ts";
import { hrmChangeRequestAdapter } from "./adapters/hrm-change-request.ts";
import { hrmLeaveRequestAdapter } from "./adapters/hrm-leave-request.ts";
import { hrmProcessStepAdapter } from "./adapters/hrm-process-step.ts";
import { hrmQualificationAlertAdapter } from "./adapters/hrm-qualification-alert.ts";
import { hrmReviewAdapter } from "./adapters/hrm-review.ts";
import { notificationAdapter } from "./adapters/notification.ts";
import { timesheetWeekAdapter } from "./adapters/timesheet-week.ts";
import { registerInboxAdapter } from "./registry.ts";

registerInboxAdapter(flowsApprovalAdapter);
registerInboxAdapter(hrmProcessStepAdapter);
registerInboxAdapter(hrmLeaveRequestAdapter);
registerInboxAdapter(hrmChangeRequestAdapter);
registerInboxAdapter(hrmReviewAdapter);
registerInboxAdapter(notificationAdapter);
registerInboxAdapter(hrmBenefitEnrollmentWindowAdapter);
registerInboxAdapter(hrmQualificationAlertAdapter);
registerInboxAdapter(fieldTicketSignatureAdapter);
registerInboxAdapter(timesheetWeekAdapter);
registerInboxAdapter(expenseReportAdapter);
registerInboxAdapter(documentSignatureAdapter);

export { actOnInboxItem, countInbox, InboxError, listInbox } from "./registry.ts";
export { writeNotification, type NotificationWrite } from "./adapters/notification.ts";
export type { InboxAdapter } from "./registry.ts";
export type {
  InboxActionDef,
  InboxActionStyle,
  InboxItem,
  InboxKind,
  InboxListContext,
  InboxPriority,
} from "./types.ts";
export { compareInboxItems, inboxItemId, parseInboxItemId, priorityForDueDate } from "./types.ts";
