import { sql } from "drizzle-orm";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  PAYLOAD_SCHEMA_VERSION,
  HrmChangeRequestError,
  canonicalPayloadText,
  mapGuardRefusal,
  type ChangeRequestPayload,
  validateChangePayload,
} from "./change-requests-payload.ts";
import {
  type RequestRow,
  type ChangeRequestDTO,
  toDTO,
  REQUEST_COLUMNS,
  requireOrgId,
  requireActorId,
  requireId,
  requireReason,
  loadRequestForUpdate,
  requireAuthoringAccess,
  assertKindPreconditions,
  buildDecisionSnapshot,
} from "./change-requests-core.ts";
import { applyApprovedRequest } from "./change-requests-apply.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { requireCompletedSubmissionRouting } from "../flows/submission-routing-proof.ts";
import type { FlowSubmissionResumeArgs } from "../flows/approval-release-hook.ts";

// --- Create / patch ----------------------------------------------------------

export interface CreateChangeRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly payload: unknown;
  /** Carried classification (0227, e.g. the correct-with-reapproval path). */
  readonly action?: string | null;
  readonly reasonCode?: string | null;
}

/**
 * File a draft proposal. Binds the live aggregate revision read in this
 * transaction (floor 1 holds by construction: reserved identities sit at
 * revision 1). The storage trigger computes the digest; the stored row is
 * read back so the caller holds the digest the approval will bind.
 */
export async function createChangeRequestDraft(
  query: CreateChangeRequestQuery,
): Promise<ChangeRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  const payload = validateChangePayload(query.payload);
  return withOrgTransaction(orgId, async () => {
    // Authority first: denial (including unknown/other-org employment)
    // reports uniformly through the kind-aware authorization gate.
    const subject = await requireAuthoringAccess(db, orgId, actorId, employmentId, payload);
    await assertKindPreconditions(db, orgId, employmentId, payload);
    // payload_digest is NOT NULL without a default, but the guard trigger
    // overwrites it on insert with the canonical sha256 — the 64-zero
    // placeholder never survives the trigger and is never read back.
    const inserted = (
      await db.execute<RequestRow>(
        sql`
      insert into hrm_employment_change_requests
        (org_id, employment_id, expected_employment_revision, payload,
         payload_digest, payload_schema_version, action, reason_code, created_by, updated_by)
      values (${orgId}, ${employmentId}, ${subject.revision},
              ${JSON.stringify(payload)}::jsonb,
              ${"0".repeat(64)}, ${PAYLOAD_SCHEMA_VERSION},
              ${query.action ?? null}::text, ${query.reasonCode ?? null}::text,
              ${actorId}, ${actorId})
      returning ${REQUEST_COLUMNS}
    `,
        "objects",
      )
    )[0];
    if (!inserted) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the draft was not stored — no row was written; retry the request",
      );
    }
    if (!/^[0-9a-f]{64}$/.test(inserted.payload_digest)) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the stored digest is not storage-computed sha256 hex — the guard trigger did not run; refuse the draft",
      );
    }
    return toDTO(inserted);
  });
}

export interface UpdateChangeRequestPayloadQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly payload: unknown;
}

/** Edit a draft's frozen proposal (draft only; bumps request_revision by one). */
export async function updateChangeRequestPayload(
  query: UpdateChangeRequestPayloadQuery,
): Promise<ChangeRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  const payload = validateChangePayload(query.payload);
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, HRM_CHANGE_REQUEST_SUBJECT_KIND, requestId);
    const current = await loadRequestForUpdate(db, orgId, requestId);
    const storedPayload = validateChangePayload(current.payload);
    // The draft's existing kind owns the authoring boundary until it is
    // submitted; a caller cannot cross that boundary by replacing the kind.
    await requireAuthoringAccess(db, orgId, actorId, current.employment_id, storedPayload);
    if (current.status !== "draft") {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        `a ${current.status} request is frozen — file a new request for a revised proposal instead`,
      );
    }
    if (payload.kind !== storedPayload.kind) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "a draft request's kind cannot be changed — create a new request for a different change",
      );
    }
    await assertKindPreconditions(db, orgId, current.employment_id, payload);
    // An unchanged canonical payload is a touch, not an edit: the 0185
    // guard refuses a revision bump without a draft edit, so skip the write
    // and hand back the stored row — the drawer re-sends the stored payload
    // on submit-for-approval without touching a field.
    if (
      current.payload_schema_version === PAYLOAD_SCHEMA_VERSION &&
      canonicalPayloadText(payload) === canonicalPayloadText(current.payload)
    ) {
      return toDTO(current);
    }
    // request_revision moves by exactly one with a draft edit; the digest is
    // recomputed by the guard trigger from the new payload.
    const updated = await db
      .execute<RequestRow>(
        sql`
        update hrm_employment_change_requests
           set payload = ${JSON.stringify(payload)}::jsonb,
               payload_schema_version = ${PAYLOAD_SCHEMA_VERSION},
               request_revision = ${current.request_revision + 1},
               updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${requestId}
        returning ${REQUEST_COLUMNS}
      `,
        "objects",
      )
      .then((result) => result[0])
      .catch((error: unknown): RequestRow => mapGuardRefusal(error));
    if (!updated) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the draft edit was not stored — no row was written; retry the request",
      );
    }
    return toDTO(updated);
  });
}

// --- Submit / withdraw --------------------------------------------------------

export interface SubmitChangeRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly reason: unknown;
  /** Generic HR action (0227). Persisted, never validated here: the
   *  require-both validation (enforced once the org declares an active
   *  reason code) lives in the web boundary (automations action-reasons)
   *  so this module never depends on the automations engine module. */
  readonly action?: string | null;
  readonly reasonCode?: string | null;
}

/**
 * Submit through native Flows. Reached gates pause the change; a successful
 * flow may explicitly apply a gate-free path through the same canonical
 * writer. Approval is an optional Flow: with no enabled flow for
 * employment change requests, the submission applies directly through the
 * governed admission (automatic snapshot, actor recorded) instead of
 * refusing. Every dispatch failure refuses the whole change. Each
 * application retains the proposal, exact revision, policy graph and
 * execution evidence; automatic application never invents a human approver.
 */
export async function submitChangeRequest(
  query: SubmitChangeRequestQuery,
): Promise<ChangeRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, HRM_CHANGE_REQUEST_SUBJECT_KIND, requestId);
    // The row lock serializes a double-click or replayed submit against the
    // status check and the run stamp below.
    const current = await loadRequestForUpdate(db, orgId, requestId);
    // Stored payload validates before the gate so the kind-aware gate
    // routes on a known kind; stored rows are always service-written.
    const storedPayload = validateChangePayload(current.payload);
    await requireAuthoringAccess(db, orgId, actorId, current.employment_id, storedPayload);
    if (current.status !== "draft") {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        `a ${current.status} request cannot be submitted — only drafts submit`,
      );
    }
    const payload = storedPayload;
    await assertKindPreconditions(db, orgId, current.employment_id, payload);

    const { routeSubjectSubmission } = await import("../flows/submission-policy.ts");
    const {
      policy,
      dispatch: flowResult,
      submissionId,
    } = await routeSubjectSubmission({
      orgId,
      actorId,
      subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
      subjectId: requestId,
      source: "api",
    });
    const gatedRun = flowResult.runs.find((run) => run.gatesCreated > 0);
    if (policy.kind === "ungated")
      return applyDirectRequest({
        orgId,
        actorId,
        request: current,
        payload,
        reason,
        action: query.action ?? null,
        reasonCode: query.reasonCode ?? null,
        submissionId,
        policy,
      });
    if (!gatedRun)
      throw new HrmChangeRequestError(
        "FLOW_ERROR",
        "The submission has no pending native gate; review its Flow history.",
      );
    const submitted = (
      await db.execute<RequestRow>(
        sql`
      update hrm_employment_change_requests
         set status = 'pending_approval',
             reason = ${reason},
             action = coalesce(${query.action ?? null}::text, action),
             reason_code = coalesce(${query.reasonCode ?? null}::text, reason_code),
             submitted_by = ${actorId}, submitted_at = now(),
             flow_run_id = ${gatedRun.runId},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId} and status = 'draft'
      returning ${REQUEST_COLUMNS}
    `,
        "objects",
      )
    )[0];
    if (!submitted) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "the request changed while submission was being recorded — reload it and submit again",
      );
    }
    return toDTO(submitted);
  });
}

/** Apply the frozen proposal through the same writer used by human decisions. */
async function applyAutomaticRequest(
  orgId: string,
  actorId: string,
  submitted: RequestRow,
  payload: ChangeRequestPayload,
  evidence: Record<string, unknown>,
): Promise<ChangeRequestDTO> {
  const snapshot = {
    ...buildDecisionSnapshot({
      request: submitted,
      outcome: "approved",
      gates: [],
    }),
    ...evidence,
    mode: "automatic",
  };
  const approved = (
    await db.execute<RequestRow>(
      sql`
    update hrm_employment_change_requests set status='approved', decision_snapshot=${JSON.stringify(snapshot)}::jsonb,
      updated_by=${actorId}, updated_at=now()
    where org_id=${orgId} and id=${submitted.id} and status='pending_approval'
      and request_revision=${submitted.request_revision} and payload_digest=${submitted.payload_digest}
      and flow_run_id=${submitted.flow_run_id}
    returning ${REQUEST_COLUMNS}
  `,
      "objects",
    )
  )[0];
  if (!approved)
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "The employment proposal changed; reload its current state before retrying.",
    );
  await applyApprovedRequest(db, {
    orgId,
    actorId,
    request: approved,
    payload,
  });
  const applied = await loadRequestForUpdate(db, orgId, submitted.id);
  if (applied.status !== "applied")
    throw new HrmChangeRequestError(
      "REFUSED",
      "The employment change was not applied; review its workflow before retrying.",
    );
  return toDTO(applied);
}

/** Complete only the original submitted proposal after native automatic routing. */
export async function completeHrmChangeRequestSubmission(
  args: FlowSubmissionResumeArgs,
): Promise<{ status: string }> {
  const orgId = requireOrgId(args.ctx.orgId),
    actorId = requireActorId(args.ctx.userId ?? "");
  const requestId = requireId(args.subjectId, "requestId");
  if (args.mode !== "automatic" || args.subjectKind !== HRM_CHANGE_REQUEST_SUBJECT_KIND) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "Choose the native automatic employment submission.",
    );
  }
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, HRM_CHANGE_REQUEST_SUBJECT_KIND, requestId);
    const routing = await requireCompletedSubmissionRouting({
      orgId,
      actorId,
      subjectKind: args.subjectKind,
      subjectId: requestId,
      runId: args.runId,
    });
    const request = await loadRequestForUpdate(db, orgId, requestId);
    const payload = validateChangePayload(request.payload);
    await requireAuthoringAccess(db, orgId, actorId, request.employment_id, payload);
    const context = routing.context;
    if (
      request.flow_run_id !== args.runId ||
      !request.submitted_by ||
      routing.createdBy !== request.submitted_by ||
      context.requestId !== request.id ||
      context.employmentId !== request.employment_id ||
      context.expectedEmploymentRevision !== request.expected_employment_revision ||
      context.payloadDigest !== request.payload_digest ||
      !context.payload ||
      canonicalJson(context.payload) !== canonicalJson(payload)
    ) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "The employment proposal differs from its original submission; review its current request and workflow.",
      );
    }
    if (
      request.status === "applied" &&
      request.decision_snapshot?.mode === "automatic" &&
      request.decision_snapshot.routingRunId === args.runId
    )
      return { status: "applied" };
    if (request.status !== "pending_approval")
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "Only the original pending employment submission can resume.",
      );
    await assertKindPreconditions(db, orgId, request.employment_id, payload);
    const applied = await applyAutomaticRequest(orgId, actorId, request, payload, {
      policy: context.submissionPolicy,
      routingRunId: args.runId,
      routing: context.submissionRouting,
    });
    return { status: applied.status };
  });
}

/**
 * Whether an enabled Flow governs employment change requests. With none, a
 * submission applies directly on save; surfaces describe the path the
 * organization actually takes from this one answer.
 */
export async function employmentChangeFlowsEnabled(orgId: string): Promise<boolean> {
  const row = (
    await db.execute<{ n: number }>(
      sql`
    select count(*)::int as n from flows
     where org_id = ${orgId} and subject_kind = ${HRM_CHANGE_REQUEST_SUBJECT_KIND} and enabled
  `,
      "objects",
    )
  )[0];
  return (row?.n ?? 0) > 0;
}

/**
 * Governed direct application for a submission no flow claimed (zero
 * enabled flows for employment change requests). Approval is an optional
 * Flow: the submitter's own save flips draft → approved with an
 * automatic decision snapshot (no gates, policy recording that no flow
 * is configured) and runs the same canonical writer every approval uses
 * — audited, actor recorded, all in the caller's transaction, so a throw
 * rolls the flip and every canonical write back together. Admitted by
 * the forward 0185 admission (no-flow direct apply); without it the
 * guard refuses the draft → approved transition.
 */
async function applyDirectRequest(args: {
  orgId: string;
  actorId: string;
  request: RequestRow;
  payload: ChangeRequestPayload;
  reason: string;
  action: string | null;
  reasonCode: string | null;
  submissionId: string;
  policy: import("../platform/flow-submission-policy.ts").FlowSubmissionPolicy;
}): Promise<ChangeRequestDTO> {
  const { orgId, actorId, request, payload, reason, action, reasonCode } = args;
  const snapshot = {
    ...buildDecisionSnapshot({ request, outcome: "approved", gates: [] }),
    mode: "automatic",
    policy: args.policy,
    submissionId: args.submissionId,
  };
  const approved = (
    await db.execute<RequestRow>(
      sql`
    update hrm_employment_change_requests
       set status = 'approved',
           reason = ${reason},
           action = coalesce(${action}::text, action),
           reason_code = coalesce(${reasonCode}::text, reason_code),
           submitted_by = ${actorId}, submitted_at = now(),
           decision_snapshot = ${JSON.stringify(snapshot)}::jsonb,
           updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${request.id} and status = 'draft'
    returning ${REQUEST_COLUMNS}
  `,
      "objects",
    )
  )[0];
  if (!approved) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "the request changed while direct application was being recorded — reload it and try again",
    );
  }
  await applyApprovedRequest(db, {
    orgId,
    actorId,
    request: approved,
    payload,
  });
  const applied = await loadRequestForUpdate(db, orgId, request.id);
  if (applied.status !== "applied") {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the change was not applied — reload the record and try again",
    );
  }
  return toDTO(applied);
}

export interface WithdrawChangeRequestQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId: string;
  /** Why the proposal is being withdrawn — required; withdrawal of a pending
   * request revokes an in-flight approval other people are party to. */
  readonly reason: unknown;
}

/**
 * Withdraw a draft or a pending request. Terminal states never resurrect:
 * approved, applied, and rejected refuse; a withdrawn-while-pending request
 * keeps its submission evidence and its bound run is cancelled so no
 * dangling gate can later release it.
 */
export async function withdrawChangeRequest(
  query: WithdrawChangeRequestQuery,
): Promise<ChangeRequestDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requestId = requireId(query.requestId, "requestId");
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, HRM_CHANGE_REQUEST_SUBJECT_KIND, requestId);
    const current = await loadRequestForUpdate(db, orgId, requestId);
    // Stored payload validates before the gate so the kind-aware gate
    // routes on a known kind; stored rows are always service-written.
    await requireAuthoringAccess(
      db,
      orgId,
      actorId,
      current.employment_id,
      validateChangePayload(current.payload),
    );
    if (current.status !== "draft" && current.status !== "pending_approval") {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        `a ${current.status} request is terminal — file a new request for a revised proposal instead`,
      );
    }
    if (current.status === "pending_approval" && current.flow_run_id) {
      await db.execute(sql`
        update flow_gates set status = 'cancelled', updated_at = now()
         where run_id = ${current.flow_run_id} and org_id = ${orgId}
           and status in ('pending', 'escalated')
      `);
      await db.execute(sql`
        update flow_runs set status = 'cancelled', finished_at = now()
         where id = ${current.flow_run_id} and org_id = ${orgId}
           and status in ('running', 'waiting')
      `);
    }
    const withdrawn = (
      await db.execute<RequestRow>(
        sql`
      update hrm_employment_change_requests
         set status = 'withdrawn', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${requestId}
         and status in ('draft', 'pending_approval')
      returning ${REQUEST_COLUMNS}
    `,
        "objects",
      )
    )[0];
    if (!withdrawn) {
      throw new HrmChangeRequestError(
        "BAD_STATE",
        "the request changed while withdrawal was being recorded — reload it and try again",
      );
    }
    // Audit evidence for the withdrawal itself: actor, before/after state,
    // the reason, and the run it revoked. The request row keeps its
    // submission stamps; this is the record of who took them out of play.
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'hrm_employment_change_requests', ${requestId}, 'update', ${JSON.stringify({
        event: "withdrawn",
        actor: { kind: "user", userId: actorId },
        before: { status: current.status },
        after: { status: "withdrawn" },
        reason,
        employmentId: current.employment_id,
        cancelledFlowRunId: current.status === "pending_approval" ? current.flow_run_id : null,
      })}::jsonb, ${actorId})
    `);
    return toDTO(withdrawn);
  });
}

// --- Reads (org-scoped, authorization-gated per row) --------------------------
