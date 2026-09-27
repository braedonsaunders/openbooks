import { and, desc, eq, inArray } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import {
  RESOURCING_REQUEST_SUBJECT_KIND,
  resRequests,
} from "@openbooks/schema/src/resourcing.ts";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { BUILT_IN_ROLE_NAMES, EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import { tableScope } from "./subject-scope.ts";

const REQUEST_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "submitted", label: "Submitted" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const resourcingRequestSubjectProfile: FlowSubjectProfile = {
  subjectKind: RESOURCING_REQUEST_SUBJECT_KIND,
  label: "Resource request",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...REQUEST_STATUSES],
  fields: [
    { key: "requestId", label: "Request", type: "text" },
    { key: "projectId", label: "Project", type: "text" },
    { key: "employeePartyId", label: "Employee", type: "text" },
    { key: "jobTitle", label: "Job title", type: "text" },
    { key: "firstWeek", label: "First week", type: "text" },
    { key: "lastWeek", label: "Last week", type: "text" },
    { key: "hoursPerWeek", label: "Hours per week", type: "number" },
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

async function loadRequest(subjectId: string) {
  if (!UUID_RE.test(subjectId)) return null;
  // The gate supplies the org scope on release; the tenant-bounded fan-out
  // below is the entry point for background candidate selection.
  const [row] = await db.select({
    orgId: resRequests.orgId,
    projectId: resRequests.projectId,
    employeePartyId: resRequests.employeePartyId,
    jobTitle: resRequests.jobTitle,
    firstWeek: resRequests.firstWeek,
    lastWeek: resRequests.lastWeek,
    hoursPerWeek: resRequests.hoursPerWeek,
    status: resRequests.status,
    createdBy: resRequests.createdBy,
    reason: resRequests.reason,
  }).from(resRequests).where(eq(resRequests.id, subjectId));
  return row ?? null;
}

export const resourcingRequestFlowAdapter: FlowSubjectAdapter = {
  subjectKind: RESOURCING_REQUEST_SUBJECT_KIND,
  // A request belongs to its project's legal entity.
  permissions: { read: "resourcing.read", edit: "resourcing.manage", approve: "resourcing.manage" },
  scope: tableScope("project", "res_requests", "project_id"),
  profile: resourcingRequestSubjectProfile,
  releaseViaHandler: true,
  writableFields: new Set<string>(),
  selfApprovalPolicy: "forbidden",

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const request = await loadRequest(subjectId);
    if (!request) return null;
    return {
      values: {
        id: subjectId,
        requestId: subjectId,
        projectId: request.projectId,
        employeePartyId: request.employeePartyId,
        jobTitle: request.jobTitle,
        firstWeek: String(request.firstWeek).slice(0, 10),
        lastWeek: String(request.lastWeek).slice(0, 10),
        hoursPerWeek: request.hoursPerWeek,
        status: request.status,
        submittedBy: request.createdBy,
        reason: request.reason,
      },
      submitterUserId: request.createdBy,
    };
  },

  label(subjectId: string): string {
    return `Resource request ${subjectId.slice(0, 8)}`;
  },

  deepLink(subjectId: string): string {
    return `/resourcing/requests?request=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadRequest(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error("resource request status is released by the approval engine, not a flow action");
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
  ): Promise<void> {
    await releaseFlowApproval({
      subjectKind: RESOURCING_REQUEST_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
    });
  },

  async setField(): Promise<void> {
    throw new Error("resource requests are frozen on submit; cancel and file a new request");
  },

  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(`findCandidateIds for "${RESOURCING_REQUEST_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`);
    }
    const rows = await db.select({ id: resRequests.id }).from(resRequests)
      .where(and(
        eq(resRequests.orgId, orgId),
        inArray(resRequests.status, ["draft", "submitted"]),
      ))
      .orderBy(desc(resRequests.updatedAt))
      .limit(limit);
    return rows.map((row) => row.id);
  },
};
