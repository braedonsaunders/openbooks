/**
 * Product-area groups for the flow record-type picker. Document lifecycles
 * share the documents group; dedicated subjects name their own area, so
 * same-named kinds from different families stay distinguishable under
 * their group header. Unknown future kinds fall into `other` at runtime
 * rather than rendering ungrouped — the groups test pins every known kind
 * to a deliberate group so new subjects get classified, not defaulted.
 *
 * The entries are the exact stored subjectKind discriminators (they match
 * the *_SUBJECT_KIND constants, inlined so this module stays import-free).
 * DOCUMENTS mirrors DOCUMENT_FLOW_KINDS minus pay_run, which carries
 * payroll's dedicated profile and groups with payroll instead.
 */
const DOCUMENTS_SUBJECT_KINDS = new Set([
  'vendor_bill',
  'vendor_credit',
  'customer_invoice',
  'customer_credit',
  'cash_sale',
  'cash_refund',
  'card_charge',
  'card_refund',
  'check',
  'deposit',
  'transfer',
  'project_charge',
  'internal_billing',
  'customer_payment',
  'vendor_payment',
  'expense_report',
  'sales_order',
  'purchase_order',
  'quote',
  'pick_list',
  'shipment',
  'rma',
  'journal',
])
const PEOPLE_SUBJECT_KINDS = new Set([
  'timesheet_week',
  'hrm_employment_change_request',
  'hrm_leave_request',
  'hrm_comp_cycle',
  'crew_time_batch',
  'hrm_employment_migration_mapping',
  'compensation_package_version',
  'compensation_package_assignment',
  'hrm_benefit_award',
  'hrm_benefit_enrollment',
  'resourcing_request',
])
const OPERATIONS_SUBJECT_KINDS = new Set([
  'work_order',
  'field_ticket',
  'prebill',
  'schedule_board',
  'schedule_distribution',
  'hrm_process_step',
])
const FINANCE_SUBJECT_KINDS = new Set([
  'close_run',
  'allocation_run',
  'budget_scenario',
  'fund_release',
  'financial_change',
  'party_bank_account',
  'outbound_payment_run',
  'inbound_payment_run',
])

export const FLOW_SUBJECT_GROUPS = [
  'documents',
  'payroll',
  'people',
  'operations',
  'finance',
  'other',
] as const

export type FlowSubjectGroup = (typeof FLOW_SUBJECT_GROUPS)[number]

export function flowSubjectGroup(subjectKind: string): FlowSubjectGroup {
  if (subjectKind === 'pay_run') return 'payroll'
  if (DOCUMENTS_SUBJECT_KINDS.has(subjectKind)) return 'documents'
  if (PEOPLE_SUBJECT_KINDS.has(subjectKind)) return 'people'
  if (OPERATIONS_SUBJECT_KINDS.has(subjectKind)) return 'operations'
  if (FINANCE_SUBJECT_KINDS.has(subjectKind)) return 'finance'
  return 'other'
}
