import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { grantsConferring } from "../organization/permissions.ts";

/**
 * Who may work with which expense reports.
 *
 * An expense report belongs to its employee (`documents.party_id`). The
 * org-wide grants (`expenses.read`, `expenses.create`) reach every report
 * inside the actor's subsidiary scope. The self-service grant
 * (`expenses.self`, declared in PERMISSION_IMPLICATIONS) reaches only the
 * reports whose employee is the person linked to the actor's login: another
 * employee's report is indistinguishable from a missing one, and a new report
 * is always the actor's own.
 */

export type ExpenseAuthority = "read" | "edit";

/** The catalogue key behind each authority over everyone's reports. */
export const EXPENSE_AUTHORITY_PERMISSION = {
  read: "expenses.read",
  edit: "expenses.create",
} as const satisfies Record<ExpenseAuthority, string>;

/** Everyone's reports, or only the reports of the person linked to the login. */
export type ExpenseAccess = { scope: "all" } | { scope: "own"; partyId: string | null };

export const ALL_EXPENSE_REPORTS: ExpenseAccess = { scope: "all" };

/**
 * The reach of an authority from a permission predicate: the org-wide grant
 * (or a grant implying it over everyone's records) first, then an own-scope
 * grant. Null when the holder has neither.
 */
export function expenseGrantScope(
  holds: (permission: string) => boolean,
  authority: ExpenseAuthority,
): "all" | "own" | null {
  const permission = EXPENSE_AUTHORITY_PERMISSION[authority];
  if (grantsConferring(permission, "all").some(holds)) return "all";
  if (grantsConferring(permission, "own").some(holds)) return "own";
  return null;
}

/** Every catalogue key that opens an authority at either reach. */
export function expenseAuthorityGrants(authority: ExpenseAuthority): string[] {
  const permission = EXPENSE_AUTHORITY_PERMISSION[authority];
  return [...grantsConferring(permission, "all"), ...grantsConferring(permission, "own")];
}

/** The person linked to a login, or null for a login with no person. */
export async function actorLinkedPartyId(
  executor: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<string | null> {
  const row = (
    await executor.execute<{ partyId: string | null }>(
      sql`
    select party_id as "partyId" from users where id = ${actorId} and org_id = ${orgId}
  `,
      "objects",
    )
  )[0];
  return row?.partyId ?? null;
}

/** Expand a reach into the access an expense command enforces. */
export async function expenseAccessForScope(
  executor: SqlExecutor,
  orgId: string,
  actorId: string,
  scope: "all" | "own",
): Promise<ExpenseAccess> {
  return scope === "all"
    ? ALL_EXPENSE_REPORTS
    : { scope: "own", partyId: await actorLinkedPartyId(executor, orgId, actorId) };
}

/** Resolve an actor's expense access from the database, for services and background work. */
export async function resolveExpenseAccess(
  executor: SqlExecutor,
  orgId: string,
  actorId: string,
  authority: ExpenseAuthority,
): Promise<ExpenseAccess | null> {
  const permission = EXPENSE_AUTHORITY_PERMISSION[authority];
  for (const grant of grantsConferring(permission, "all")) {
    if (await actorHasPermission(executor, orgId, actorId, grant)) return ALL_EXPENSE_REPORTS;
  }
  for (const grant of grantsConferring(permission, "own")) {
    if (await actorHasPermission(executor, orgId, actorId, grant))
      return expenseAccessForScope(executor, orgId, actorId, "own");
  }
  return null;
}

/** True when the access reaches a report whose employee is `partyId`. */
export function expenseAccessAllows(
  access: ExpenseAccess,
  partyId: string | null | undefined,
): boolean {
  if (access.scope === "all") return true;
  return access.partyId !== null && partyId != null && partyId === access.partyId;
}

/**
 * The report-owner predicate for a query over expense reports: nothing for
 * org-wide access; the linked person for self-service access, and no rows at
 * all for a login linked to no person.
 */
export function expenseOwnerPredicate(access: ExpenseAccess, employeeColumn: SQL): SQL {
  if (access.scope === "all") return sql`true`;
  return access.partyId === null ? sql`false` : sql`${employeeColumn} = ${access.partyId}`;
}

/**
 * Refusal for self-service access that cannot name the employee: the login
 * is linked to no person, so it has no reports to create.
 */
export class ExpenseSelfServiceRefusal extends Error {
  readonly name = "ExpenseSelfServiceRefusal";
  readonly status = 403;
  readonly code: string;
  readonly remedy: string;
  constructor(kind: "unlinked" | "other_employee") {
    super(
      kind === "unlinked"
        ? "Your login is not linked to an employee record, so there are no expense reports of yours to create or open."
        : "You can only file expense reports for yourself.",
    );
    this.code = kind === "unlinked" ? "expense_self_unlinked" : "expense_self_only";
    this.remedy =
      kind === "unlinked"
        ? "Ask an administrator to link your user to your employee record under Administration → Users."
        : "Leave the employee as yourself; to file for a coworker, ask an administrator for a role that enters everyone's expense reports.";
  }
}

/**
 * The employee a new or edited report may name under this access. Org-wide
 * access names any employee (checked elsewhere against the report's entity);
 * self-service access names only the linked person, which is also the
 * employee when the request names none.
 */
export function expenseEmployeeForAccess(
  access: ExpenseAccess,
  requested: string | null | undefined,
): string | null | undefined {
  if (access.scope === "all") return requested;
  if (access.partyId === null) throw new ExpenseSelfServiceRefusal("unlinked");
  if (requested != null && requested !== access.partyId)
    throw new ExpenseSelfServiceRefusal("other_employee");
  return access.partyId;
}
