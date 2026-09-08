import { sql, type SQL } from "drizzle-orm";

/** The role-derived subsidiary visibility a payroll engine caller carries. */
export type PayrollSubsidiaryScope = ReadonlySet<string> | null | undefined;

/**
 * Shared fail-closed SQL predicate for payroll engine reads. A null/undefined
 * scope is unrestricted; a present empty set matches nothing. Payroll records
 * are legal-entity-owned, so a null subsidiary never belongs to a restricted
 * caller (the same rule as the document API gate).
 */
export function payrollSubsidiaryScopeFilter(
  column: SQL,
  allowedSubsidiaryIds: PayrollSubsidiaryScope,
): SQL {
  if (allowedSubsidiaryIds == null) return sql``;
  const ids = [...allowedSubsidiaryIds];
  return ids.length > 0
    ? sql` and ${column} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
    : sql` and false`;
}

/** Predicate matching rows a restricted caller must not be allowed to read. */
export function payrollSubsidiaryOutsideScopeFilter(
  column: SQL,
  allowedSubsidiaryIds: PayrollSubsidiaryScope,
): SQL {
  if (allowedSubsidiaryIds == null) return sql`false`;
  const ids = [...allowedSubsidiaryIds];
  return ids.length > 0
    ? sql`${column} is null or ${column} not in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
    : sql`true`;
}

/** In-memory twin for direct service guards and tests. */
export function payrollSubsidiaryInScope(
  allowedSubsidiaryIds: PayrollSubsidiaryScope,
  subsidiaryId: string | null | undefined,
): boolean {
  if (allowedSubsidiaryIds == null) return true;
  return subsidiaryId != null && subsidiaryId !== "" && allowedSubsidiaryIds.has(subsidiaryId);
}


/** Whole-run totals are visible only when every stub and adjustment is visible. */
export function payrollRunPopulationScopeFilter(
  orgId: string,
  documentId: SQL,
  allowedSubsidiaryIds: PayrollSubsidiaryScope,
): SQL {
  if (allowedSubsidiaryIds == null) return sql``;
  return sql`and not exists (
    select 1 from (
      select employee_party_id from pay_stubs where org_id=${orgId} and pay_run_document_id=${documentId}
      union
      select employee_party_id from pay_run_adjustments where org_id=${orgId} and pay_run_document_id=${documentId}
    ) payroll_scope_member
    left join parties payroll_scope_party on payroll_scope_party.id=payroll_scope_member.employee_party_id
      and payroll_scope_party.org_id=${orgId}
    where payroll_scope_party.id is null or (${payrollSubsidiaryOutsideScopeFilter(sql`payroll_scope_party.subsidiary_id`, allowedSubsidiaryIds)})
  )`;
}
