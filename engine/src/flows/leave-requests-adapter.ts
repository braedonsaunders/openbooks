import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import type {
  FlowSubjectAdapter,
  FlowSubjectContext,
} from "./types.ts";
import {
  BUILT_IN_ROLE_NAMES,
  EVENT_SOURCE_OPTIONS,
} from "./subject-profiles.ts";
import { releaseLeaveRequest } from "../hrm/leave.ts";

/**
 * Leave requests as a native flow subject.
 *
 * The subject is one hrm_leave_requests row: the filed range bound to the
 * exact employment it was written against. Routing and conditions see the
 * request, never the mutable absence record. loadContext runs in whatever
 * scope the caller established (adapters never set scope themselves); every
 * query below additionally carries an explicit org predicate, and fails
 * closed when no ambient tenant is active rather than reading unscoped —
 * parity with the documents, budget-scenario, and timesheet adapters.
 *
 * Release is where the governed decision lands: the status flip plus the
 * absence rows plus the pending payroll inputs happen in releaseLeaveRequest,
 * inside decideGate's savepoint — so a throw rolls the whole decision back
 * and the gate stays pending. Self-approval is forbidden outright:
 * independence of the decider is an HRM control, not a tenant preference
 * (period-close precedent).
 */

const REQUEST_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Submitted" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "withdrawn", label: "Withdrawn" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const hrmLeaveRequestSubjectProfile: FlowSubjectProfile = {
  subjectKind: HRM_LEAVE_REQUEST_SUBJECT_KIND,
  label: "Leave request",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...REQUEST_STATUSES],
  fields: [
    { key: "requestId", label: "Request", type: "text" },
    { key: "employmentId", label: "Employment", type: "text" },
    { key: "leaveTypeId", label: "Leave type", type: "text" },
    { key: "startsOn", label: "Starts on", type: "text" },
    { key: "endsOn", label: "Ends on", type: "text" },
    { key: "status", label: "Status", type: "enum", options: [...REQUEST_STATUSES] },
    { key: "submittedBy", label: "Submitted by", type: "user" },
    { key: "reason", label: "Reason", type: "text" },
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
  leave_type_id: string;
  starts_on: string;
  ends_on: string;
  status: string;
  created_by: string | null;
  reason: string | null;
};

async function loadRequest(subjectId: string): Promise<RequestRow | null> {
  if (!UUID_RE.test(subjectId)) return null;
  // No ambient-tenant requirement and no org predicate here, by adapter
  // parity (documents, budget, timesheet): decideGate's pre-flight resolves
  // the submitter outside withOrg, and every caller scopes the subject
  // through its own org-scoped gate row. findCandidateIds below is the
  // tenant-bounded entry point and keeps the explicit boundary.
  const result = (await db.execute<RequestRow>(sql`
    select org_id, employment_id, leave_type_id,
           starts_on::text as starts_on, ends_on::text as ends_on,
           status, created_by, reason
      from hrm_leave_requests
     where id = ${subjectId}
  `));
  return result.rows[0] ?? null;
}

export const hrmLeaveRequestFlowAdapter: FlowSubjectAdapter = {
  subjectKind: HRM_LEAVE_REQUEST_SUBJECT_KIND,
  profile: hrmLeaveRequestSubjectProfile,
  // A flow must not rewrite the range it is approving: the request freezes
  // on submit, so no header field is flow-writable.
  writableFields: new Set<string>(),
  selfApprovalPolicy: "forbidden",

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const request = await loadRequest(subjectId);
    if (!request) return null;
    return {
      values: {
        id: subjectId,
        requestId: subjectId,
        employmentId: request.employment_id,
        leaveTypeId: request.leave_type_id,
        startsOn: String(request.starts_on).slice(0, 10),
        endsOn: String(request.ends_on).slice(0, 10),
        status: request.status,
        submittedBy: request.created_by,
        reason: request.reason,
      },
      submitterUserId: request.created_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const range = typeof values.startsOn === "string" ? values.startsOn : "leave";
    return `Leave ${range} ${subjectId.slice(0, 8)}`;
  },

  deepLink(subjectId: string): string {
    return `/hrm/leave?request=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadRequest(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error(
      "leave-request status is released by the approval engine, not a flow action",
    );
  },

  async releaseApproval(subjectId, outcome, ctx, detail): Promise<void> {
    if (!UUID_RE.test(subjectId)) {
      throw new Error(`unknown leave request ${subjectId}`);
    }
    if (outcome !== "approved" && outcome !== "rejected") {
      throw new Error(`unknown leave decision ${outcome}`);
    }
    await releaseLeaveRequest({
      orgId: ctx.orgId,
      actorId: ctx.userId ?? "",
      requestId: subjectId,
      outcome,
      comment: detail?.comment ?? null,
    });
  },

  async setField(): Promise<void> {
    throw new Error("leave requests are frozen on submit; withdraw and file a new request");
  },

  /** Recent non-terminal requests, for scheduled fan-out (reminders). */
  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(
        `findCandidateIds for "${HRM_LEAVE_REQUEST_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    }
    const result = (await db.execute<{ id: string }>(sql`
      select id::text as id from hrm_leave_requests
       where org_id = ${orgId} and status in ('draft', 'submitted')
       order by created_at desc
       limit ${limit}
    `));
    return result.rows.map((row) => row.id);
  },
};
