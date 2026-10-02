import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { BENEFIT_ENROLLMENT_SUBJECT_KIND } from "@openbooks/schema/src/hrm-benefits.ts";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import { tableScope } from "./subject-scope.ts";
import { EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowSubjectAdapter } from "./types.ts";

export const benefitEnrollmentSubjectProfile: FlowSubjectProfile = {
  subjectKind: BENEFIT_ENROLLMENT_SUBJECT_KIND,
  label: "Benefits enrollment or election change",
  supportsUngatedSubmission: true,
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: ["elected", "pending_approval", "active", "waived", "ended", "cancelled"]
    .map((value) => ({ value, label: value })),
  fields: [
    { key: "planId", label: "Program", type: "text" },
    { key: "planCode", label: "Program code", type: "text" },
    { key: "planName", label: "Program name", type: "text" },
    { key: "planKind", label: "Program type", type: "enum", options: ["health", "retirement", "other"].map((value) => ({value, label:value})) },
    { key: "classKey", label: "Eligibility class", type: "text" },
    { key: "employmentId", label: "Employment", type: "text" },
    { key: "legalEntityId", label: "Legal entity", type: "text" },
    { key: "departmentId", label: "Department", type: "text" },
    { key: "effectiveFrom", label: "Coverage starts", type: "date" },
    { key: "effectiveTo", label: "Coverage ends", type: "date" },
    { key: "replacesEnrollmentId", label: "Replaces enrollment", type: "text" },
    { key: "createdBy", label: "Created by", type: "user" },
    { key: "event_source", label: "Event source", type: "enum", options: [...EVENT_SOURCE_OPTIONS] },
  ],
};

type EnrollmentContext = {
  id: string;
  org_id: string;
  status: string;
  created_by: string | null;
  submitted_by: string | null;
  flow_run_id: string | null;
  submission_snapshot: Record<string, unknown> | null;
};
async function loadEnrollment(id: string): Promise<EnrollmentContext | null> {
  if (!isUuid(id)) return null;
  const rows = (await db.execute<EnrollmentContext>(sql`
    select id,org_id,status,created_by,submitted_by,flow_run_id,submission_snapshot
      from hrm_benefit_enrollments where id=${id}`)).rows;
  return rows[0] ?? null;
}

/** Native gates decide pinned election evidence; they never edit current contributions. */
export const benefitEnrollmentsFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: BENEFIT_ENROLLMENT_SUBJECT_KIND,
  permissions: { read: "hrm.benefits.read", edit: "hrm.benefits.manage", approve: "hrm.benefits.manage" },
  scope: tableScope("employment", "hrm_benefit_enrollments", "employment_id"),
  profile: benefitEnrollmentSubjectProfile,
  releaseViaHandler: true,
  selfApprovalPolicy: "configurable",
  async loadContext(id) {
    const enrollment = await loadEnrollment(id);
    if (!enrollment) return null;
    const pinned = enrollment.flow_run_id
      ? (await db.execute<{ context: Record<string, unknown> }>(sql`
          select context from flow_runs where org_id=${enrollment.org_id} and id=${enrollment.flow_run_id}
            and subject_kind=${BENEFIT_ENROLLMENT_SUBJECT_KIND} and subject_id=${id}`)).rows[0]?.context
      : enrollment.submission_snapshot;
    if (!pinned) throw new Error("Enrollment submission evidence is unavailable; reopen the election and submit its complete contribution terms.");
    return { values: {...pinned, id, status: enrollment.status},
      submitterUserId: enrollment.submitted_by ?? enrollment.created_by, makerUserId: enrollment.created_by };
  },
  label(id, values) { return `${String(values.planName ?? "Benefits enrollment")} ${id.slice(0,8)}`; },
  deepLink(id) { return `/hrm/benefits?view=enrolments&enrollmentConfig=${id}`; },
  async getStatus(id) { return (await loadEnrollment(id))?.status ?? null; },
  async changeStatus() { throw new Error("Enrollment status is controlled by submission and approval decisions; use its record actions."); },
  async setField() { throw new Error("Submitted enrollment evidence is immutable; create an effective-dated election change instead."); },
  async releaseApproval(subjectId, outcome, ctx, detail) {
    await releaseFlowApproval({ subjectKind: BENEFIT_ENROLLMENT_SUBJECT_KIND, subjectId, outcome, ctx, comment: detail?.comment });
  },
  async findCandidateIds(limit) {
    const orgId = ambientTenantOrgId();
    if (!orgId) throw new Error("Benefits enrollment candidates require an ambient organization context.");
    return (await db.execute<{id:string}>(sql`select id from hrm_benefit_enrollments where org_id=${orgId}
      and status in ('elected','pending_approval') order by created_at desc,id limit ${limit}`)).rows.map((row)=>row.id);
  },
});
