import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import { BUILT_IN_ROLE_NAMES, EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";

export const FUND_RELEASE_SUBJECT_KIND = "fund_release";

const FUND_RELEASE_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "posted", label: "Posted" },
  { value: "void", label: "Void" },
] as const;

export const fundReleaseSubjectProfile: FlowSubjectProfile = {
  subjectKind: FUND_RELEASE_SUBJECT_KIND,
  label: "Fund release",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...FUND_RELEASE_STATUSES],
  fields: [
    { key: "releaseNumber", label: "Release number", type: "text" },
    { key: "releaseDate", label: "Release date", type: "text" },
    { key: "fromFundCode", label: "From fund", type: "text" },
    { key: "fromRestrictionClass", label: "From restriction class", type: "text" },
    { key: "toFundCode", label: "To fund", type: "text" },
    { key: "toRestrictionClass", label: "To restriction class", type: "text" },
    { key: "amount", label: "Amount", type: "number" },
    { key: "purpose", label: "Purpose", type: "text" },
    { key: "satisfactionRef", label: "Satisfaction reference", type: "text" },
    { key: "status", label: "Status", type: "enum", options: [...FUND_RELEASE_STATUSES] },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
  ],
  roles: [...BUILT_IN_ROLE_NAMES],
};

interface FundReleaseFlowRow extends Record<string, unknown> {
  org_id: string;
  release_number: string;
  release_date: string;
  amount: string;
  purpose: string;
  satisfaction_ref: string;
  status: string;
  submitted_by: string | null;
  created_by: string;
  from_code: string | null;
  from_name: string;
  from_class: string;
  to_code: string | null;
  to_name: string;
  to_class: string;
}

async function loadRelease(subjectId: string): Promise<FundReleaseFlowRow | null> {
  const row = (await db.execute<FundReleaseFlowRow>(sql`
    select r.org_id, r.release_number, r.release_date::text, r.amount::text,
           r.purpose, r.satisfaction_ref, r.status,
           r.submitted_by::text, r.created_by::text,
           from_value.code as from_code, from_value.name as from_name,
           from_fund.restriction_class as from_class,
           to_value.code as to_code, to_value.name as to_name,
           to_fund.restriction_class as to_class
      from fund_releases r
      join funds from_fund on from_fund.org_id = r.org_id and from_fund.id = r.from_fund_id
      join segment_values from_value on from_value.org_id = r.org_id and from_value.id = from_fund.id
      join funds to_fund on to_fund.org_id = r.org_id and to_fund.id = r.to_fund_id
      join segment_values to_value on to_value.org_id = r.org_id and to_value.id = to_fund.id
     where r.id = ${subjectId}
  `)).rows[0];
  return row ?? null;
}

export const fundReleasesFlowAdapter: FlowSubjectAdapter = {
  subjectKind: FUND_RELEASE_SUBJECT_KIND,
  // Releases post at the primary book's root and carry no subsidiary.
  permissions: { read: "funds.read", edit: "funds.manage", approve: "funds.manage" },
  scope: { via: "none" },
  profile: fundReleaseSubjectProfile,
  writableFields: new Set<string>(),
  selfApprovalPolicy: "forbidden",
  releaseViaHandler: true,

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const release = await loadRelease(subjectId);
    if (!release) return null;
    return {
      values: {
        id: subjectId,
        releaseNumber: release.release_number,
        releaseDate: release.release_date,
        fromFundCode: release.from_code ?? release.from_name,
        fromRestrictionClass: release.from_class,
        toFundCode: release.to_code ?? release.to_name,
        toRestrictionClass: release.to_class,
        amount: release.amount,
        purpose: release.purpose,
        satisfactionRef: release.satisfaction_ref,
        status: release.status,
        requestedBy: release.submitted_by,
      },
      submitterUserId: release.submitted_by,
      makerUserId: release.created_by,
    };
  },

  label(_subjectId: string, values: Record<string, unknown>): string {
    const number = values.releaseNumber;
    const from = values.fromFundCode;
    const to = values.toFundCode;
    return `Fund release ${String(number ?? "")}: ${String(from ?? "")} → ${String(to ?? "")}`;
  },

  deepLink(): string {
    // Fund releases have no record page yet; the hub is the landing surface
    // until one ships (party_bank_account precedent).
    return "/inbox";
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadRelease(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error("fund release status is changed by the release approval lifecycle");
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
  ): Promise<void> {
    await releaseFlowApproval({
      subjectKind: FUND_RELEASE_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
    });
  },

  async setField(): Promise<void> {
    throw new Error("fund release fields are not writable by flows");
  },

  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(
        `findCandidateIds for "${FUND_RELEASE_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    }
    const rows = (await db.execute<{ id: string }>(sql`
      select id::text as id from fund_releases
       where org_id = ${orgId} and status = 'pending_approval'
       order by submitted_at desc, id
       limit ${limit}
    `)).rows;
    return rows.map((row) => row.id);
  },
};
