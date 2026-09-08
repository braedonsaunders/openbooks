import { sql, type SQL } from "drizzle-orm";
import { PayrollError } from "./payroll-error.ts";
import { uuidArray } from "./subsidiaries.ts";

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

/** Caller already holds the run/document lock; no population writes may precede this check. */
export async function lockAndCheckPayrollRunPopulation(
  runner: import("./db.ts").SqlExecutor,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds: PayrollSubsidiaryScope,
  candidates: readonly { id: string; subsidiaryId?: string | null }[] = [],
): Promise<void> {
  if (allowedSubsidiaryIds == null) return;
  const candidateIds = candidates.map((candidate) => candidate.id);
  const participants = (await runner.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select p.id,p.subsidiary_id from parties p where p.org_id=${orgId} and p.id in (
      select employee_party_id from pay_stubs where org_id=${orgId} and pay_run_document_id=${documentId}
      union select employee_party_id from pay_run_adjustments where org_id=${orgId} and pay_run_document_id=${documentId}
      union select unnest(${uuidArray(candidateIds)}::uuid[])
    ) order by p.id for share`)).rows;
  if (participants.some((party) => !payrollSubsidiaryInScope(allowedSubsidiaryIds, party.subsidiary_id))) {
    throw new PayrollError("pay run not found");
  }
  const current = new Map(participants.map((party) => [party.id, party.subsidiary_id]));
  for (const candidate of candidates) {
    if (!current.has(candidate.id)) throw new PayrollError("pay run not found");
    if (candidate.subsidiaryId !== undefined && current.get(candidate.id) !== candidate.subsidiaryId) {
      throw new PayrollError("pay run employee ownership changed — calculate again");
    }
  }
  // Also refuse orphaned evidence; inner ownership locks cannot return it.
  const visible = (await runner.execute(sql`select 1 from pay_runs r where r.org_id=${orgId} and r.document_id=${documentId}
    ${payrollRunPopulationScopeFilter(orgId, sql`r.document_id`, allowedSubsidiaryIds)}`)).rows[0];
  if (!visible) throw new PayrollError("pay run not found");
}
