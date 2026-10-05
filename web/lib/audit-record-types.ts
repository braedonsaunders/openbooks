/** Record families exposed by the native, permission-scoped audit reader. */
export const AUDIT_RECORD_TABLES = ['documents', 'parties', 'item_rate_versions', 'hrm_benefit_enrollments', 'hrm_benefit_programs', 'hrm_benefit_plans', 'entitlement_plans', 'payroll_compensation_packages', 'payroll_compensation_versions', 'payroll_compensation_assignments'] as const
export type AuditRecordTable = typeof AUDIT_RECORD_TABLES[number]
export function isAuditRecordTable(table: unknown): table is AuditRecordTable {
  return typeof table === 'string' && (AUDIT_RECORD_TABLES as readonly string[]).includes(table)
}
