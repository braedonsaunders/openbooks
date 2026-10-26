import "server-only";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/db";
import {
  EXPENSE_AUTHORITY_PERMISSION,
  expenseOwnerPredicate,
  ExpenseSelfServiceRefusal,
  expenseAccessAllows,
  expenseAccessForScope,
  expenseAuthorityGrants,
  expenseGrantScope,
  type ExpenseAccess,
  type ExpenseAuthority,
} from "@openbooks/engine/records/expense-access";
import { can, getAuthz, guardPermission, requirePermission, type Authz } from "./authz";
import type { ReportExpenseAccess } from "@openbooks/reports";
import { resolveAuthzByUserId } from "./authz-core";

export type { ExpenseAccess, ExpenseAuthority };

/**
 * Expense-report authority at the API and page boundary. The org-wide grants
 * reach every report in the caller's subsidiary scope; `expenses.self`
 * reaches only the caller's own reports (see records/expense-access). Every
 * expense route resolves its access here and passes it to the shared loaders,
 * which treat another employee's report as missing.
 */

/** The reach of the caller's authority, or null when they hold no expense grant. */
export function expenseScope(authz: Authz, authority: ExpenseAuthority): "all" | "own" | null {
  return expenseGrantScope((permission) => can(authz, permission), authority);
}

/** True when the caller works only with their own expense reports. */
export function ownExpensesOnly(authz: Authz, authority: ExpenseAuthority): boolean {
  return expenseScope(authz, authority) === "own";
}

/** The caller's expense access, or null without a grant. */
export async function expenseAccess(
  authz: Authz,
  authority: ExpenseAuthority,
  executor: SqlExecutor = db,
): Promise<ExpenseAccess | null> {
  const scope = expenseScope(authz, authority);
  return scope === null
    ? null
    : expenseAccessForScope(executor, authz.user.orgId, authz.user.id, scope);
}

/**
 * `defineRoute({ authorize })` gate for expense routes: the org-wide grant or
 * the self-service grant. A caller with neither meets the org-wide grant's
 * standard refusal.
 */
export function authorizeExpenses(authority: ExpenseAuthority) {
  return async (): Promise<Authz | NextResponse> => {
    const primary = await guardPermission(EXPENSE_AUTHORITY_PERMISSION[authority]);
    if (!(primary instanceof NextResponse) || primary.status !== 403) return primary;
    for (const grant of expenseAuthorityGrants(authority)) {
      if (grant === EXPENSE_AUTHORITY_PERMISSION[authority]) continue;
      const alternative = await guardPermission(grant);
      if (!(alternative instanceof NextResponse)) return alternative;
    }
    return primary;
  };
}

/**
 * Page gate for expense surfaces: the first grant the caller holds among the
 * org-wide and self-service grants, or the org-wide grant's access-denied
 * explanation when they hold none.
 */
export async function requireExpensePermission(authority: ExpenseAuthority): Promise<Authz> {
  const viewer = await getAuthz();
  const held = viewer
    ? expenseAuthorityGrants(authority).find((grant) => can(viewer, grant))
    : undefined;
  return requirePermission(held ?? EXPENSE_AUTHORITY_PERMISSION[authority]);
}

/**
 * Whether the caller reaches one expense report by its employee: always under
 * org-wide access (the caller's subsidiary scope is checked separately), and
 * only for their own report under self-service access.
 */
export async function expenseReportReachable(
  authz: Authz,
  authority: ExpenseAuthority,
  documentId: string,
  executor: SqlExecutor = db,
): Promise<boolean> {
  const access = await expenseAccess(authz, authority, executor);
  if (!access) return false;
  if (access.scope === "all") return true;
  const row = (
    await executor.execute<{ partyId: string | null }>(
      sql`
    select party_id as "partyId" from documents
     where id = ${documentId} and org_id = ${authz.user.orgId} and kind = 'expense_report'
  `,
      "objects",
    )
  )[0];
  return row !== undefined && expenseAccessAllows(access, row.partyId);
}

/**
 * The expense list's owner predicate for one viewer: null when they read every
 * report, their own reports under self-service, and nothing at all without a
 * read grant.
 */
export async function expenseListOwnerFilter(orgId: string, userId: string): Promise<SQL | null> {
  const authz = await resolveAuthzByUserId(orgId, userId);
  const access = authz ? await expenseAccess(authz, "read") : null;
  if (!access) return sql`false`;
  return access.scope === "all" ? null : expenseOwnerPredicate(access, sql`d.party_id`);
}

/**
 * The reader's expense authority for report, Insights and analytics
 * execution: every expense report, only their own, or none. Reports never
 * widen it: an org-wide report grant reads no expense report without an
 * expense grant.
 */
export async function reportExpenseAccess(
  authz: Authz,
  executor: SqlExecutor = db,
): Promise<ReportExpenseAccess> {
  return (await expenseAccess(authz, "read", executor)) ?? { scope: "none" };
}

export { ExpenseSelfServiceRefusal, expenseAccessAllows };
