import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { BENEFIT_AWARD_SUBJECT_KIND } from "@openbooks/schema/src/benefits-programs.ts";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";
import { tableScope } from "./subject-scope.ts";
import { EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowSubjectAdapter } from "./types.ts";

export const benefitAwardSubjectProfile: FlowSubjectProfile = {
  subjectKind: BENEFIT_AWARD_SUBJECT_KIND,
  label: "Benefits reward or incentive award",
  supportsUngatedSubmission: true,
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [
    "draft",
    "pending",
    "approved",
    "rejected",
    "queued",
    "delivered",
    "voided",
  ].map((value) => ({ value, label: value })),
  fields: [
    { key: "programId", label: "Program", type: "text" },
    { key: "programCode", label: "Program code", type: "text" },
    { key: "programName", label: "Program name", type: "text" },
    {
      key: "family",
      label: "Program type",
      type: "enum",
      options: ["reward", "allowance", "incentive", "custom"].map((value) => ({
        value,
        label: value,
      })),
    },
    { key: "value", label: "Award amount", type: "number" },
    { key: "currency", label: "Currency", type: "text" },
    { key: "employmentId", label: "Employment", type: "text" },
    { key: "legalEntityId", label: "Legal entity", type: "text" },
    { key: "departmentId", label: "Department", type: "text" },
    { key: "periodFrom", label: "Period starts", type: "date" },
    { key: "periodTo", label: "Period ends", type: "date" },
    { key: "createdBy", label: "Created by", type: "user" },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
  ],
};

type AwardContext = {
  id: string;
  org_id: string;
  program_id: string;
  employment_id: string;
  value: string;
  currency: string;
  status: string;
  period_from: string;
  period_to: string | null;
  created_by: string | null;
  submitted_by: string | null;
  flow_run_id: string | null;
  program_snapshot: Record<string, unknown>;
  legal_entity_id: string;
  department_id: string | null;
};

async function loadAward(id: string): Promise<AwardContext | null> {
  if (!isUuid(id)) return null;
  // Gate preflight resolves subject identity before entering its organization
  // transaction. RLS controls visibility there; the gate's table scope then
  // validates the employer entity before the decision transaction begins.
  const rows = (
    await db.execute<AwardContext>(sql`
    select a.id, a.org_id, a.program_id, a.employment_id, a.value::text,
      a.currency, a.status, a.period_from::text, a.period_to::text,
      a.created_by, a.submitted_by, a.flow_run_id, a.program_snapshot,
      p.legal_entity_id, v.department_id
    from hrm_benefit_awards a
    join hrm_benefit_programs p on p.org_id = a.org_id and p.id = a.program_id
    left join lateral (
      select department_id from employment_assignment_versions
      where org_id = a.org_id and employment_id = a.employment_id
        and recorded_until is null and is_primary and effective_from <= a.period_from
        and (effective_to is null or effective_to > a.period_from)
      order by effective_from desc, id desc limit 1
    ) v on true
    where a.id = ${id}
  `)
  ).rows;
  return rows[0] ?? null;
}

export const benefitAwardsFlowAdapter: FlowSubjectAdapter =
  defineTableSubjectAdapter({
    subjectKind: BENEFIT_AWARD_SUBJECT_KIND,
    permissions: {
      read: "hrm.benefits.read",
      edit: "hrm.benefits.manage",
      approve: "hrm.benefits.manage",
    },
    scope: tableScope("employment", "hrm_benefit_awards", "employment_id"),
    profile: benefitAwardSubjectProfile,
    releaseViaHandler: true,
    selfApprovalPolicy: "configurable",
    async loadContext(id) {
      const award = await loadAward(id);
      if (!award) return null;
      const pinned = award.flow_run_id
        ? (
            await db.execute<{ context: Record<string, unknown> }>(
              sql`select context from flow_runs where org_id = ${award.org_id} and id = ${award.flow_run_id} and subject_kind = ${BENEFIT_AWARD_SUBJECT_KIND} and subject_id = ${id}`,
            )
          ).rows[0]?.context
        : null;
      if (award.flow_run_id && !pinned)
        throw new Error(
          "Benefits reward submission evidence is unavailable; review its workflow execution before deciding.",
        );
      return {
        values: pinned
          ? { ...pinned, status: award.status }
          : {
              id,
              programId: award.program_id,
              programCode: award.program_snapshot.code ?? null,
              programName: award.program_snapshot.name ?? null,
              family: award.program_snapshot.family ?? null,
              value: award.value,
              currency: award.currency,
              employmentId: award.employment_id,
              legalEntityId: award.legal_entity_id,
              departmentId: award.department_id,
              periodFrom: award.period_from,
              periodTo: award.period_to,
              status: award.status,
              createdBy: award.created_by,
            },
        submitterUserId: award.submitted_by ?? award.created_by,
        makerUserId: award.created_by,
      };
    },
    label(id, values) {
      return `${String(values.programName ?? "Benefits reward")} ${id.slice(0, 8)}`;
    },
    deepLink(id) {
      return `/hrm/benefits?view=rewards&award=${id}`;
    },
    async getStatus(id) {
      return (await loadAward(id))?.status ?? null;
    },
    async changeStatus() {
      throw new Error(
        "Benefits reward status is controlled by submission and approval decisions; use its record actions.",
      );
    },
    async setField() {
      throw new Error(
        "Submitted Benefits reward evidence is immutable; create a correcting reward instead.",
      );
    },
    async releaseApproval(subjectId, outcome, ctx, detail) {
      await releaseFlowApproval({
        subjectKind: BENEFIT_AWARD_SUBJECT_KIND,
        subjectId,
        outcome,
        ctx,
        comment: detail?.comment,
      });
    },
    async findCandidateIds(limit) {
      const orgId = ambientTenantOrgId();
      if (!orgId)
        throw new Error(
          "Benefits reward candidates require an ambient organization context.",
        );
      return (
        await db.execute<{ id: string }>(
          sql`select id from hrm_benefit_awards where org_id = ${orgId} and status in ('draft', 'pending') order by created_at desc, id limit ${limit}`,
        )
      ).rows.map((row) => row.id);
    },
  });
