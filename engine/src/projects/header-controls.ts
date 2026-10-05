import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { cmp } from "../money/money.ts";

/**
 * Controls on the project header field that billed history depends on.
 * Every writer of `projects.contract_value` (the project header edit, the
 * migration mirror and the project-financial input sync) runs its change
 * through `assertProjectHeaderChangeAllowed` inside the same transaction as
 * its write, so the rule has one owner and no path can skip it.
 *
 * - Contract value: once billing begins (the first application for payment
 *   exists), the contract sum moves only through an approved change order,
 *   which records the change, its approver and the schedule-of-values line it
 *   lands on. A direct edit would move the billing ceiling, the revenue
 *   recognition transaction price and the earned view with no paper trail.
 */
export type ProjectHeaderControlCode =
  | "project_not_found"
  | "contract_value_controlled"
  | "contract_value_controlled_type_changed";

export class ProjectHeaderControlError extends Error {
  readonly status: number;
  constructor(
    readonly code: ProjectHeaderControlCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectHeaderControlError";
    this.status = code === "project_not_found" ? 404 : 422;
  }
}

export const PROJECT_HEADER_CONTROL_MESSAGES: Record<ProjectHeaderControlCode, string> = {
  project_not_found: "Project not found",
  contract_value_controlled:
    "After billing begins, contract value must change through an approved change order. " +
    "Record a change order under Change orders on the project's Billing tab and have a different user approve it; approval moves the contract value.",
  contract_value_controlled_type_changed:
    "After billing begins, contract value must change through an approved change order, " +
    "but this project's type no longer bills by applications for payment, so change orders are unavailable. " +
    "Switch the project back to a project type that bills by applications for payment, then record and approve a change order on its Billing tab.",
};

function refuse(code: ProjectHeaderControlCode): never {
  throw new ProjectHeaderControlError(code, PROJECT_HEADER_CONTROL_MESSAGES[code]);
}

/**
 * Billing has begun once the project has any application for payment. This is
 * the one predicate behind every contract-value control (the schedule-of-values
 * insert and the header edit alike).
 */
export async function projectBillingHasBegun(
  runner: SqlExecutor,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  const prior = await runner.execute(
    sql`select 1 from pay_applications where org_id = ${orgId} and project_id = ${projectId} limit 1`,
  );
  return prior.rows.length > 0;
}

function sameMoney(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return cmp(a, b) === 0;
}

/**
 * Lock the project row and refuse a contract-value change the control above
 * forbids. Must run on the writer's own transaction, before its write: the
 * row lock holds until commit, so a pay application that would make the
 * change unsafe cannot slip in between check and write.
 * Fields left `undefined` are not being changed and are not checked; a value
 * equal to the stored one is not a change.
 */
export async function assertProjectHeaderChangeAllowed(
  runner: SqlExecutor,
  orgId: string,
  projectId: string,
  change: { contractValue?: string | null },
): Promise<void> {
  const row = (await runner.execute<{
    contract_value: string | null;
    procedure: string | null;
  }>(sql`
    select p.contract_value::text as contract_value,
           pt.invoicing_profile->>'billingProcedure' as procedure
      from projects p
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
     where p.id = ${projectId} and p.org_id = ${orgId}
       for update of p
  `)).rows[0];
  if (!row) refuse("project_not_found");

  if (
    change.contractValue !== undefined &&
    !sameMoney(row.contract_value, change.contractValue) &&
    (await projectBillingHasBegun(runner, orgId, projectId))
  ) {
    refuse(
      row.procedure === "application_for_payment"
        ? "contract_value_controlled"
        : "contract_value_controlled_type_changed",
    );
  }
}
