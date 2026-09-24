/** Every source kind the inbox aggregates. Keep localized inbox copy for each kind. */
export const INBOX_KINDS = [
  "flows_approval",
  "hrm_process_step",
  "hrm_leave_request",
  "hrm_change_request",
  "hrm_review",
  "hrm_feedback_request",
  "hrm_benefit_enrollment_window",
  "hrm_qualification_alert",
  "field_ticket_signature",
  "timesheet_week",
  "crew_time_batch",
  "expense_report",
  "notification",
  "document_signature",
  "payroll_anomaly_block",
  "ai_capability_review",
] as const;

export type InboxKind = (typeof INBOX_KINDS)[number];
