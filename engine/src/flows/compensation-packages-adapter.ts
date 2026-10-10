import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { COMPENSATION_VERSION_SUBJECT_KIND, COMPENSATION_ASSIGNMENT_SUBJECT_KIND } from "@openbooks/schema/src/payroll-compensation.ts";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import { tableScope } from "./subject-scope.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowSubjectAdapter, FlowSubjectScope } from "./types.ts";

type SubjectTable = "payroll_compensation_versions" | "payroll_compensation_assignments";
type SubjectRow = {
  org_id: string; package_id: string; revision: number; status: string;
  submitted_by: string | null; created_by: string; effective_from: string; effective_to: string | null;
  subsidiary_id: string; package_name: string; employment_id: string | null; employee_party_id: string | null;
};

function profile(subjectKind: string, label: string, statuses: string[]): FlowSubjectProfile {
  return {
    subjectKind, label, pinsSubmissionPolicy: true, supportsUngatedSubmission: true, triggers: ["on_submit"], actions: ["send_email", "notify"],
    statuses: statuses.map(value => ({ value, label: value })),
    fields: [
      { key: "packageId", label: "Package", type: "text" },
      { key: "revision", label: "Submitted revision", type: "number" },
      { key: "employmentId", label: "Employment", type: "text" },
      { key: "employeePartyId", label: "Employee", type: "text" },
      { key: "subsidiaryId", label: "Legal employer", type: "text" },
      { key: "effectiveFrom", label: "Effective from", type: "date" },
      { key: "effectiveTo", label: "Effective to", type: "date" },
      { key: "status", label: "Status", type: "enum" },
      { key: "submittedBy", label: "Submitted by", type: "user" },
      { key: "event_source", label: "Event source", type: "enum", options: [...EVENT_SOURCE_OPTIONS] },
    ],
  };
}

export const compensationVersionSubjectProfile = profile(COMPENSATION_VERSION_SUBJECT_KIND, "Compensation package version", ["draft", "submitted", "approved", "rejected"]);
export const compensationAssignmentSubjectProfile = profile(COMPENSATION_ASSIGNMENT_SUBJECT_KIND, "Compensation package assignment", ["draft", "submitted", "active", "rejected", "ended", "cancelled"]);

async function loadSubject(table: SubjectTable, id: string): Promise<SubjectRow | null> {
  if (!isUuid(id)) return null;
  const orgId = ambientTenantOrgId();
  return (await db.execute<SubjectRow>(sql`
    select s.org_id,s.package_id,s.revision,s.status,s.submitted_by,s.created_by,
      s.effective_from::text,s.effective_to::text,p.subsidiary_id,p.name as package_name,
      ${table === "payroll_compensation_assignments" ? sql`s.employment_id` : sql`null::uuid`} as employment_id,
      ${table === "payroll_compensation_assignments" ? sql`s.employee_party_id` : sql`null::uuid`} as employee_party_id
    from ${sql.identifier(table)} s join payroll_compensation_packages p
      on p.org_id=s.org_id and p.id=s.package_id
    where s.id=${id} ${orgId ? sql`and s.org_id=${orgId}` : sql``}
  `)).rows[0] ?? null;
}

const versionScope: FlowSubjectScope = {
  via: "custom",
  async subsidiaryOf(orgId, ids, allowed, lock) {
    const rows = (await db.execute<{ id: string; subsidiary_id: string }>(sql`
      select s.id,p.subsidiary_id from payroll_compensation_versions s
      join payroll_compensation_packages p on p.org_id=s.org_id and p.id=s.package_id
      where s.org_id=${orgId} and s.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) ids(value))
      ${lock ? sql`for share of s,p` : sql``}
    `)).rows;
    return new Map(rows.map(row => [row.id, subsidiaryScopeAllows(allowed, row.subsidiary_id) ? row.subsidiary_id : null]));
  },
};

function adapter(table: SubjectTable, subjectProfile: FlowSubjectProfile, scope: FlowSubjectScope): FlowSubjectAdapter {
  return defineTableSubjectAdapter({
    subjectKind: subjectProfile.subjectKind, profile: subjectProfile, scope,
    permissions: { read: "payroll.read", edit: "payroll.manage", approve: "hrm.compensation.approve" },
    selfApprovalPolicy: "configurable", releaseViaHandler: true,
    async loadContext(id) {
      const row = await loadSubject(table, id);
      if (!row) return null;
      return { values: { id, packageId: row.package_id, revision: row.revision, status: row.status,
        employmentId: row.employment_id, employeePartyId: row.employee_party_id, subsidiaryId: row.subsidiary_id,
        effectiveFrom: row.effective_from, effectiveTo: row.effective_to, submittedBy: row.submitted_by },
        submitterUserId: row.submitted_by ?? row.created_by, makerUserId: row.created_by };
    },
    label(id, values) { return `${subjectProfile.label} ${String(values.packageId ?? id).slice(0,8)}`; },
    deepLink(id) { return `/admin/setup/payroll?tab=compensation-packages&${table === "payroll_compensation_versions" ? "packageVersionsRow" : "packageAssignmentsRow"}=${id}`; },
    async getStatus(id) { return (await loadSubject(table, id))?.status ?? null; },
    async changeStatus() { throw new Error("Compensation status follows its submitted Flow decision; use the native approval action."); },
    async setField() { throw new Error("Submitted compensation terms are frozen; create an effective-dated successor to change them."); },
    async findCandidateIds(limit) {
      const orgId = ambientTenantOrgId();
      if (!orgId) throw new Error("Compensation Flow candidates require an organization context.");
      return (await db.execute<{ id: string }>(sql`select id from ${sql.identifier(table)}
        where org_id=${orgId} and status='submitted' order by submitted_at desc,id limit ${limit}`)).rows.map(row => row.id);
    },
    async releaseApproval(subjectId, outcome, ctx, detail, run) {
      await releaseFlowApproval({ subjectKind: subjectProfile.subjectKind, subjectId, outcome, ctx,
        comment: detail?.comment, approvalRunId: run?.id });
    },
  });
}

export const compensationVersionsFlowAdapter = adapter("payroll_compensation_versions", compensationVersionSubjectProfile, versionScope);
export const compensationAssignmentsFlowAdapter = adapter("payroll_compensation_assignments", compensationAssignmentSubjectProfile, tableScope("column", "payroll_compensation_assignments", "subsidiary_id"));
