/**
 * Employment migration mapping-set flow subject.
 *
 * The subject is one hrm_employment_migration_approvals row: the SHA-256
 * digest of the exact operator employer/date mapping set under review.
 * Routing and conditions see the digest and the requester, never the
 * mutable mapping file. The migration preflight and apply verify the
 * deciding gate (approved, human decider distinct from the applying actor)
 * against this row's digest before any mapped candidate is applicable —
 * free-text approvedBy/approvedAt/rationale on the mapping itself carry no
 * authority.
 *
 * Release is engine-owned: the status flip on this row happens in
 * releaseApproval, inside decideGate's savepoint — so a throw rolls the
 * whole decision back and the gate stays pending. Self-approval is
 * forbidden outright: independence of the decider is a migration control,
 * not a tenant preference (period-close and HRM change-request precedent).
 * A flow must not rewrite the digest it is approving: no field is
 * flow-writable.
 */

import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import type {
  FlowExecCtx,
  FlowSubjectAdapter,
  FlowSubjectContext,
} from "./types.ts";
import {
  BUILT_IN_ROLE_NAMES,
  EVENT_SOURCE_OPTIONS,
} from "./subject-profiles.ts";
import { HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND } from "@openbooks/schema/src/hrm.ts";

const MAPPING_APPROVAL_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
] as const;

export const employmentMigrationSubjectProfile: FlowSubjectProfile = {
  subjectKind: HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND,
  label: "Employment migration mapping",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...MAPPING_APPROVAL_STATUSES],
  fields: [
    { key: "approvalId", label: "Approval", type: "text" },
    { key: "mappingDigest", label: "Mapping digest", type: "text" },
    { key: "status", label: "Status", type: "enum", options: [...MAPPING_APPROVAL_STATUSES] },
    { key: "requestedBy", label: "Requested by", type: "user" },
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

type ApprovalRow = {
  org_id: string;
  mapping_digest: string;
  status: string;
  requested_by: string | null;
};

async function loadApproval(subjectId: string): Promise<ApprovalRow | null> {
  if (!UUID_RE.test(subjectId)) return null;
  // No ambient-tenant requirement and no org predicate here, by adapter
  // parity (documents, budget, timesheet, HRM change requests): decideGate's
  // pre-flight resolves the decider outside withOrg, and every caller scopes
  // the subject through its own org-scoped gate row. findCandidateIds below
  // is the tenant-bounded entry point and keeps the explicit boundary.
  const result = (await db.execute<ApprovalRow>(sql`
    select org_id, mapping_digest, status, requested_by::text as requested_by
      from hrm_employment_migration_approvals
     where id = ${subjectId}
  `));
  return result.rows[0] ?? null;
}

export const employmentMigrationFlowAdapter: FlowSubjectAdapter = {
  subjectKind: HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND,
  profile: employmentMigrationSubjectProfile,
  // A flow must not rewrite the digest it is approving: the mapping set
  // freezes when the approval is requested, so no field is flow-writable.
  writableFields: new Set<string>(),
  selfApprovalPolicy: "forbidden",

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const approval = await loadApproval(subjectId);
    if (!approval) return null;
    return {
      values: {
        id: subjectId,
        approvalId: subjectId,
        mappingDigest: approval.mapping_digest,
        status: approval.status,
        requestedBy: approval.requested_by,
      },
      submitterUserId: approval.requested_by,
      makerUserId: approval.requested_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const digest = typeof values.mappingDigest === "string" ? values.mappingDigest.slice(0, 12) : subjectId;
    return `Employment migration mapping ${digest}`;
  },

  deepLink(): string {
    // A mapping set has no record drawer: the digest pins a CLI-side file,
    // not a module record. The approvals worklist row still shows the
    // label; the hub is the landing surface (party_bank_account precedent).
    return "/inbox";
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadApproval(subjectId))?.status ?? null;
  },

  async changeStatus(subjectId: string, to: string, _ctx: FlowExecCtx): Promise<void> {
    // The submit path owns draft → pending_approval; the approval release
    // owns every later transition. A flow action must never flip either.
    void _ctx;
    throw new Error(
      `employment migration mapping status is released by the approval engine, not a flow action (requested ${to})`,
    );
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
  ): Promise<void> {
    if (!UUID_RE.test(subjectId)) {
      throw new Error(`unknown employment migration approval ${subjectId}`);
    }
    if (outcome !== "approved" && outcome !== "rejected") {
      throw new Error(`unknown migration mapping decision ${outcome}`);
    }
    // Idempotent by design: only the awaiting-approval row flips, so a
    // replayed release is a no-op instead of a second decision. A flip that
    // matches no row is a failure, never success: under RLS an unscoped
    // write silently matches nothing and reports success.
    const flipped = (await db.execute<{ id: string }>(sql`
      update hrm_employment_migration_approvals
         set status = ${outcome},
             updated_by = ${ctx.userId},
             updated_at = now()
       where id = ${subjectId}
         and status = 'pending_approval'
      returning id::text as id
    `)) as unknown as { rows: Array<{ id: string }> };
    if (flipped.rows.length > 1) {
      throw new Error(
        `employment migration approval ${subjectId} matched ${flipped.rows.length} rows; ` +
          "refusing a release that is not exactly one row",
      );
    }
    if (flipped.rows.length === 0) {
      const current = await loadApproval(subjectId);
      if (!current) throw new Error(`employment migration approval ${subjectId} is not visible`);
      if (current.status === outcome) return;
      throw new Error(
        `employment migration approval ${subjectId} is ${current.status}, not awaiting approval; ` +
          "refusing to release outside the decision — resubmit the mapping set instead",
      );
    }
    void detail;
  },

  async setField(): Promise<void> {
    throw new Error("mapping digests are not writable by flows; request a new approval");
  },

  async findCandidateIds(limit: number): Promise<string[]> {
    // Same tenant-boundary rule as the timesheet and crew adapters: the
    // explicit org predicate, never ambient RLS alone.
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(
        `findCandidateIds for "${HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    }
    const result = (await db.execute<{ id: string }>(sql`
      select id::text as id from hrm_employment_migration_approvals
       where org_id = ${orgId}
         and status = 'pending_approval'
       order by created_at desc
       limit ${limit}
    `));
    return result.rows.map((row) => row.id);
  },
};
