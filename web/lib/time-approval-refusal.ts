/**
 * A designed time-approval refusal: the approver sees exactly what failed
 * and what to do, never a generic failure. This module is a leaf — the
 * approval service, the timesheet routes and the inbox wiring all name the
 * refusal without importing each other. Callers map by instanceof (never by
 * regex over the message) to the refusal's status, and return its code,
 * remedy and details beside the message. Anything else is unexpected: it
 * rolls back with the transaction and answers generic (logged).
 */

export type TimeApprovalRefusalCode =
  | 'entries_unavailable'
  | 'mixed_cost_objects'
  | 'manufacturing_off'
  | 'projects_off'
  | 'no_covering_wage_rate'
  | 'week_owned_by_workflow'
  | 'already_approved'
  | 'nothing_submitted'
  | 'line_approved'
  | 'line_billed'

export interface UncoveredTimeEntry {
  employeeName: string | null
  workedOn: string
}

export class TimeApprovalRefusal extends Error {
  readonly name = 'TimeApprovalRefusal'
  constructor(
    message: string,
    readonly code: TimeApprovalRefusalCode,
    readonly status: 409 | 422,
    readonly remedy: string,
    readonly details?: Record<string, unknown>,
  ) { super(message) }
}
