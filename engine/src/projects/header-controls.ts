import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { cmp } from "../money/money.ts";

/**
 * Controls on the two project header fields that posted and billed history
 * depends on. Every writer of `projects.contract_value` or
 * `projects.subsidiary_id` (the project header edit, the migration mirror and
 * the project-financial input sync) runs its change through
 * `assertProjectHeaderChangeAllowed` inside the same transaction as its
 * write, so the rule has one owner and no path can skip it.
 *
 * - Contract value: once billing begins (the first application for payment
 *   exists), the contract sum moves only through an approved change order,
 *   which records the change, its approver and the schedule-of-values line it
 *   lands on. A direct edit would move the billing ceiling, the revenue
 *   recognition transaction price and the earned view with no paper trail.
 * - Subsidiary: retainage held and cost-to-date are read from the project's
 *   journal lines filtered to the project's CURRENT subsidiary, so re-homing
 *   a project with posted history in another entity would silently strand
 *   that history. Posted history is any posted or reversed journal line
 *   tagged to the project (which covers posted invoices, bills, costed time
 *   and retainage) or any posted document tagged to the project on its
 *   header or a line, sitting in a subsidiary other than the target; and any
 *   application for payment that is not void, wherever it sits (its
 *   cumulative chain and retainage belong to the entity that billed it).
 *   Re-homing a project whose posted history already sits in the target
 *   (for example assigning a subsidiary to a project that had none) stays
 *   allowed, because nothing is stranded.
 */
export type ProjectHeaderControlCode =
  | "project_not_found"
  | "contract_value_controlled"
  | "contract_value_controlled_type_changed"
  | "subsidiary_has_posted_history";

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
  subsidiary_has_posted_history:
    "This project already has posted history (ledger postings, posted documents or applications for payment) in another subsidiary, " +
    "and moving it would strand its retainage and cost-to-date there. " +
    "Close this project and create a new project in the target subsidiary for the remaining work.",
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
 * Lock the project row and refuse a contract-value or subsidiary change the
 * controls above forbid. Must run on the writer's own transaction, before its
 * write: the row lock holds until commit, so a pay application or posting
 * that would make the change unsafe cannot slip in between check and write.
 * Fields left `undefined` are not being changed and are not checked; a value
 * equal to the stored one is not a change.
 */
export async function assertProjectHeaderChangeAllowed(
  runner: SqlExecutor,
  orgId: string,
  projectId: string,
  change: { contractValue?: string | null; subsidiaryId?: string | null },
): Promise<void> {
  const row = (await runner.execute<{
    contract_value: string | null;
    subsidiary_id: string | null;
    procedure: string | null;
  }>(sql`
    select p.contract_value::text as contract_value, p.subsidiary_id,
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

  if (change.subsidiaryId !== undefined && row.subsidiary_id !== change.subsidiaryId) {
    const target = change.subsidiaryId;
    const history = (await runner.execute<{ found: boolean }>(sql`
      select exists (
               select 1 from journal_lines jl
                 join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
                where jl.org_id = ${orgId} and jl.project_id = ${projectId}
                  and je.status in ('posted', 'reversed')
                  and jl.subsidiary_id is distinct from ${target}::uuid)
          or exists (
               select 1 from documents d
                where d.org_id = ${orgId} and d.status = 'posted'
                  and d.subsidiary_id is distinct from ${target}::uuid
                  and (d.project_id = ${projectId}
                       or exists (select 1 from document_lines dl
                                   where dl.org_id = d.org_id and dl.document_id = d.id
                                     and dl.project_id = ${projectId})))
          or exists (
               select 1 from pay_applications pa
                where pa.org_id = ${orgId} and pa.project_id = ${projectId}
                  and pa.status <> 'void') as found
    `)).rows[0];
    if (history?.found) refuse("subsidiary_has_posted_history");
  }
}
