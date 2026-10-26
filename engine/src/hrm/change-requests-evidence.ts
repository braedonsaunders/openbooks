import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { HrmChangeRequestError } from "./change-requests-payload.ts";
import { type RequestRow, type ClosureElement } from "./change-requests-core.ts";

export const EMPLOYMENT_CHANGE_KINDS = [
  "created",
  "status_changed",
  "assignment_issued",
  "assignment_superseded",
  "corrected",
  "terminated",
  "bank_details_changed",
  "profile_changed",
] as const;

export type EmploymentChangeKind = (typeof EMPLOYMENT_CHANGE_KINDS)[number];

export async function insertEmploymentChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    employmentId: string;
    assignmentId: string | null;
    revision: number;
    changeKind: EmploymentChangeKind;
    priorSnapshot: Record<string, unknown>;
    closedVersions: ClosureElement[];
    reason: string;
    actorId: string;
    action?: string | null;
    reasonCode?: string | null;
  },
): Promise<string> {
  if (args.reason.trim().length === 0) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the application carries no reason — withdraw this request; evidence without a reason never applies",
    );
  }
  const inserted = (
    await exec.execute<{ id: string }>(
      sql`
    insert into employment_changes
      (org_id, employment_id, assignment_id, revision, change_kind,
       prior_snapshot, reason, recorded_source, recorded_by, closed_versions,
       action, reason_code, created_by, updated_by)
    values (${args.orgId}, ${args.employmentId}, ${args.assignmentId}, ${args.revision},
            ${args.changeKind}, ${JSON.stringify(args.priorSnapshot)}::jsonb,
            ${args.reason}, 'user', ${args.actorId},
            ${JSON.stringify(args.closedVersions)}::jsonb,
            ${args.action ?? null}, ${args.reasonCode ?? null}, ${args.actorId}, ${args.actorId})
    returning id
  `,
      "objects",
    )
  )[0];
  if (!inserted) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the canonical change event was not written — nothing applied; retry the decision",
    );
  }
  return inserted.id;
}

export async function linkAppliedEvidence(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    newRevision: number;
    changeId: string;
  },
): Promise<void> {
  const linked = await exec.execute(
    sql`
    update hrm_employment_change_requests
       set status = 'applied', applied_at = now(), applied_by = ${args.actorId},
           applied_employment_revision = ${args.newRevision},
           applied_employment_change_id = ${args.changeId},
           updated_by = ${args.actorId}, updated_at = now()
     where org_id = ${args.orgId} and id = ${args.request.id} and status = 'approved'
    returning id
  `,
    "objects",
  );
  if (linked.length !== 1) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the request left the approved state while applying — a concurrent application won; this attempt applied nothing",
    );
  }
}

export async function bumpAggregateRevision(
  exec: SqlExecutor,
  args: { orgId: string; actorId: string; request: RequestRow; expected: number; next: number },
): Promise<void> {
  const bumped = await exec.execute(
    sql`
    update worker_employments
       set revision = ${args.next}, updated_by = ${args.actorId}, updated_at = now()
     where org_id = ${args.orgId} and id = ${args.request.employment_id} and revision = ${args.expected}
    returning id
  `,
    "objects",
  );
  if (bumped.length !== 1) {
    throw new HrmChangeRequestError(
      "STALE_REVISION",
      "the employment changed while the approval was applying — this attempt applied nothing; file a new request",
    );
  }
}

/**
 * Per-org reporting-graph serialization counter (0184): bumped on every
 * governed application so concurrent writers across employments sharing one
 * reporting graph serialize on the row lock instead of walking stale
 * snapshots. Monotonic and product-meaningless — never read as data.
 */
export async function bumpGraphRevision(exec: SqlExecutor, orgId: string): Promise<void> {
  await exec.execute(sql`
    insert into hrm_graph_revisions (org_id, rev) values (${orgId}, 1)
    on conflict (org_id) do update set rev = hrm_graph_revisions.rev + 1, updated_at = now()
  `);
}
