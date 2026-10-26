import { sql } from "drizzle-orm";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { completedGateDecisionPolicy } from "../flows/approval-decision-policy.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  checkApprovalIdentitySeparation,
  loadActorPerson,
  loadApprovalPerson,
  requireHrmEmploymentApprove,
} from "./authorization.ts";
import { HrmChangeRequestError, validateChangePayload } from "./change-requests-payload.ts";
import {
  type RequestRow,
  type ChangeRequestDTO,
  toDTO,
  REQUEST_COLUMNS,
  requireOrgId,
  requireActorId,
  requireId,
  loadRequestForUpdate,
  decidedGatesOfRequest,
  buildDecisionSnapshot,
} from "./change-requests-core.ts";
import { applyApprovedRequest } from "./change-requests-apply.ts";

export interface ReleaseChangeRequestQuery {
  readonly approvalRunId?: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly outcome: "approved" | "rejected";
  readonly comment?: string | null;
}

export interface ReleaseChangeRequestResult {
  /** True when the request had already left pending_approval — nothing changed. */
  readonly noop: boolean;
  readonly request: ChangeRequestDTO;
}

export async function releaseHrmChangeRequest(
  query: ReleaseChangeRequestQuery,
): Promise<ReleaseChangeRequestResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  // withOrgTransaction joins the caller's ambient tenant transaction (the
  // decide savepoint) instead of opening a nested one, so everything below
  // commits or rolls back with the decision.
  return withOrgTransaction(orgId, async () => {
    const current = await loadRequestForUpdate(db, orgId, requestId);
    if (current.status !== "pending_approval") {
      return { noop: true, request: toDTO(current) };
    }
    if (!current.flow_run_id || !current.submitted_by) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this pending request carries no submission evidence — withdraw it and file a new request",
      );
    }
    // Permission/scope half over the trusted subject loaded in-transaction.
    const subject = await requireHrmEmploymentApprove(db, orgId, actorId, current.employment_id);
    // Identity half over trusted-DB-loaded parties. An approver with no
    // linked person cannot be separated from anyone, so the refusal names
    // the remedy: link the person in Admin → Users → Link person.
    const approver = await loadActorPerson(db, orgId, actorId);
    const approval = await completedGateDecisionPolicy(db, {
      orgId,
      subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
      subjectId: requestId,
      actorId,
      outcome: query.outcome,
      approvalRunId: query.approvalRunId,
    });
    if (!approval)
      throw new HrmChangeRequestError(
        "REFUSED",
        "Complete the configured native Flow gates before deciding this change.",
      );
    const submitter = await loadApprovalPerson(db, orgId, current.submitted_by);
    checkApprovalIdentitySeparation({
      approver,
      submitter,
      subjectWorkerPartyId: subject.workerPartyId,
      requireIndependentActor: !approval.allowsSelfApproval,
    });

    const gates = await decidedGatesOfRequest(db, orgId, requestId);
    const policies = (
      await db.execute<{ policy: unknown }>(
        sql`select context->'submissionPolicy' as policy from flow_runs where org_id = ${orgId} and subject_kind = ${HRM_CHANGE_REQUEST_SUBJECT_KIND} and subject_id = ${requestId} order by started_at, id`,
        "objects",
      )
    )
      .map((row) => row.policy)
      .filter(Boolean);
    const snapshot = {
      ...buildDecisionSnapshot({
        request: current,
        outcome: query.outcome,
        gates,
      }),
      mode: "approval",
      policies,
    };
    const flipped = (
      await db.execute<RequestRow>(
        sql`
      update hrm_employment_change_requests
         set status = ${query.outcome},
             decision_snapshot = ${JSON.stringify(snapshot)}::jsonb,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = 'pending_approval'
      returning ${REQUEST_COLUMNS}
    `,
        "objects",
      )
    )[0];
    if (!flipped) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "the request changed while the decision was being recorded — reload it and decide again",
      );
    }
    if (query.outcome === "rejected") {
      return { noop: false, request: toDTO(flipped) };
    }
    await applyApprovedRequest(db, {
      orgId,
      actorId,
      request: flipped,
      payload: validateChangePayload(flipped.payload),
    });
    const applied = (
      await db.execute<RequestRow>(
        sql`
      select ${REQUEST_COLUMNS} from hrm_employment_change_requests
       where org_id = ${orgId} and id = ${requestId}
    `,
        "objects",
      )
    )[0];
    if (!applied) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the applied request cannot be read back — the application wrote nothing observable; retry the decision",
      );
    }
    return { noop: false, request: toDTO(applied) };
  });
}
