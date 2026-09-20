import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import type {
  FlowSubjectAdapter,
  FlowSubjectContext,
} from "./types.ts";
import {
  BUILT_IN_ROLE_NAMES,
  EVENT_SOURCE_OPTIONS,
} from "./subject-profiles.ts";
import { releaseHrmChangeRequest } from "../hrm/change-requests.ts";

/**
 * Employment change requests as a native flow subject.
 *
 * The subject is one hrm_employment_change_requests row: the frozen proposal
 * (payload + storage-computed digest) bound to the authored aggregate
 * revision. Routing and conditions see the proposal, never the mutable
 * canonical record. loadContext runs in whatever scope the caller
 * established (adapters never set scope themselves); every query below
 * additionally carries an explicit org predicate, and fails closed when no
 * ambient tenant is active rather than reading unscoped — parity with the
 * documents, budget-scenario, and timesheet adapters.
 *
 * Release is where the governed decision lands: the status flip plus the
 * decision snapshot plus the all-or-nothing canonical application happen in
 * releaseHrmChangeRequest, inside decideGate's savepoint — so a throw rolls
 * the whole decision back and the gate stays pending. Self-approval is
 * forbidden outright: independence of the decider is an HRM control, not a
 * tenant preference (period-close precedent).
 */

const REQUEST_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "withdrawn", label: "Withdrawn" },
  { value: "applied", label: "Applied" },
] as const;

export const hrmChangeRequestSubjectProfile: FlowSubjectProfile = {
  subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
  label: "Employment change request",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...REQUEST_STATUSES],
  fields: [
    { key: "requestId", label: "Request", type: "text" },
    { key: "employmentId", label: "Employment", type: "text" },
    { key: "changeKind", label: "Change kind", type: "text" },
    { key: "status", label: "Status", type: "enum", options: [...REQUEST_STATUSES] },
    { key: "expectedEmploymentRevision", label: "Expected employment revision", type: "number" },
    { key: "payloadDigest", label: "Payload digest", type: "text" },
    { key: "submittedBy", label: "Submitted by", type: "user" },
    { key: "reason", label: "Submission reason", type: "text" },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
  ],
  roles: [...BUILT_IN_ROLE_NAMES],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RequestRow = {
  org_id: string;
  employment_id: string;
  expected_employment_revision: number;
  payload: Record<string, unknown>;
  payload_digest: string;
  reason: string | null;
  status: string;
  submitted_by: string | null;
};

async function loadRequest(subjectId: string): Promise<RequestRow | null> {
  if (!UUID_RE.test(subjectId)) return null;
  // No ambient-tenant requirement and no org predicate here, by adapter
  // parity (documents, budget, timesheet): decideGate's pre-flight resolves
  // the submitter outside withOrg, and every caller scopes the subject
  // through its own org-scoped gate row. findCandidateIds below is the
  // tenant-bounded entry point and keeps the explicit boundary.
  const result = (await db.execute<RequestRow>(sql`
    select org_id, employment_id, expected_employment_revision, payload,
           payload_digest, reason, status, submitted_by
      from hrm_employment_change_requests
     where id = ${subjectId}
  `));
  return result.rows[0] ?? null;
}

export const hrmChangeRequestFlowAdapter: FlowSubjectAdapter = {
  subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
  profile: hrmChangeRequestSubjectProfile,
  // A flow must not rewrite the proposal it is approving: the payload
  // freezes on submit, so no header field is flow-writable.
  writableFields: new Set<string>(),
  selfApprovalPolicy: "forbidden",

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const request = await loadRequest(subjectId);
    if (!request) return null;
    const payload = request.payload as { kind?: unknown } & Record<string, unknown>;
    return {
      values: {
        id: subjectId,
        requestId: subjectId,
        employmentId: request.employment_id,
        changeKind: typeof payload.kind === "string" ? payload.kind : null,
        status: request.status,
        expectedEmploymentRevision: request.expected_employment_revision,
        payloadDigest: request.payload_digest,
        submittedBy: request.submitted_by,
        reason: request.reason,
        payload,
      },
      submitterUserId: request.submitted_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const kind = typeof values.changeKind === "string" ? values.changeKind : "change";
    return `Employment ${kind} ${subjectId.slice(0, 8)}`;
  },

  deepLink(subjectId: string): string {
    return `/hrm/change-requests?request=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadRequest(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error(
      "change-request status is released by the approval engine, not a flow action",
    );
  },

  async releaseApproval(subjectId, outcome, ctx, detail): Promise<void> {
    if (!UUID_RE.test(subjectId)) {
      throw new Error(`unknown employment change request ${subjectId}`);
    }
    await releaseHrmChangeRequest({
      orgId: ctx.orgId,
      actorId: ctx.userId ?? "",
      requestId: subjectId,
      outcome,
      comment: detail?.comment ?? null,
    });
  },

  async setField(): Promise<void> {
    throw new Error("change-request payloads are frozen on submit; file a new request");
  },

  /** Recent non-terminal requests, for scheduled fan-out (reminders). */
  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(
        `findCandidateIds for "${HRM_CHANGE_REQUEST_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    }
    const result = (await db.execute<{ id: string }>(sql`
      select id::text as id from hrm_employment_change_requests
       where org_id = ${orgId} and status in ('draft', 'pending_approval')
       order by created_at desc
       limit ${limit}
    `));
    return result.rows.map((row) => row.id);
  },
};
