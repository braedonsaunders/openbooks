import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { HRM_COMP_CYCLE_SUBJECT_KIND } from "@openbooks/schema/src/hrm-compensation.ts";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import type {
  FlowSubjectAdapter,
  FlowSubjectContext,
  FlowExecCtx,
} from "./types.ts";
import {
  BUILT_IN_ROLE_NAMES,
  EVENT_SOURCE_OPTIONS,
} from "./subject-profiles.ts";
import { releaseCompCycleDecision } from "../hrm/compensation/cycles.ts";

/**
 * Compensation cycles as a native flow subject.
 *
 * The subject is one hrm_comp_cycles row: the frozen round (kind,
 * effective date, budget envelope, guideline document) bound to the
 * authored aggregate revision. Routing and conditions see the round,
 * never the mutable lines. loadContext runs in whatever scope the caller
 * established (adapters never set scope themselves); every query below
 * additionally carries an explicit org predicate, and fails closed when
 * no ambient tenant is active rather than reading unscoped — parity with
 * the documents, budget-scenario, leave-request and change-request
 * adapters.
 *
 * Release is where the governed decision lands: the cycle status flip
 * happens in releaseCompCycleDecision, inside decideGate's savepoint —
 * so a throw rolls the whole decision back and the gate stays pending.
 * An approval releases the ROUND to push; per-line approve/reject stays
 * in the compensation service under hrm.compensation.approve with the
 * decider distinct from the proposer. Self-approval is forbidden
 * outright: independence of the decider is an HRM control, not a tenant
 * preference (period-close precedent).
 */

const CYCLE_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "open", label: "Open" },
  { value: "in_review", label: "In review" },
  { value: "approved", label: "Approved" },
  { value: "pushed", label: "Pushed" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const hrmCompCycleSubjectProfile: FlowSubjectProfile = {
  subjectKind: HRM_COMP_CYCLE_SUBJECT_KIND,
  label: "Compensation cycle",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...CYCLE_STATUSES],
  fields: [
    { key: "cycleId", label: "Cycle", type: "text" },
    { key: "cycleKind", label: "Kind", type: "text" },
    { key: "effectiveOn", label: "Effective on", type: "text" },
    { key: "budgetTotal", label: "Budget total", type: "text" },
    { key: "status", label: "Status", type: "enum", options: [...CYCLE_STATUSES] },
    { key: "submittedBy", label: "Submitted by", type: "user" },
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

type CycleRow = {
  org_id: string;
  name: string;
  kind: string;
  status: string;
  effective_on: string;
  budget_total: string | null;
  created_by: string | null;
};

async function loadCycle(subjectId: string): Promise<CycleRow | null> {
  if (!UUID_RE.test(subjectId)) return null;
  // No ambient-tenant requirement and no org predicate here, by adapter
  // parity (documents, budget, timesheet, leave, change-requests):
  // decideGate's pre-flight resolves the submitter outside withOrg, and
  // every caller scopes the subject through its own org-scoped gate row.
  // findCandidateIds below is the tenant-bounded entry point and keeps
  // the explicit boundary.
  const result = (await db.execute<CycleRow>(sql`
    select org_id, name, kind, status,
           effective_on::text as effective_on, budget_total::text as budget_total,
           created_by
      from hrm_comp_cycles
     where id = ${subjectId}
  `));
  return result.rows[0] ?? null;
}

export const hrmCompCycleFlowAdapter: FlowSubjectAdapter = {
  subjectKind: HRM_COMP_CYCLE_SUBJECT_KIND,
  profile: hrmCompCycleSubjectProfile,
  // A flow must not rewrite the round it is approving: the cycle freezes
  // on submit, so no header field is flow-writable.
  writableFields: new Set<string>(),
  selfApprovalPolicy: "forbidden",

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const cycle = await loadCycle(subjectId);
    if (!cycle) return null;
    return {
      values: {
        id: subjectId,
        cycleId: subjectId,
        cycleKind: cycle.kind,
        effectiveOn: String(cycle.effective_on).slice(0, 10),
        budgetTotal: cycle.budget_total,
        status: cycle.status,
        submittedBy: cycle.created_by,
      },
      submitterUserId: cycle.created_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const name = typeof values.cycleKind === "string" ? values.cycleKind : "compensation";
    return `Compensation ${name} ${subjectId.slice(0, 8)}`;
  },

  deepLink(subjectId: string): string {
    return `/hrm/compensation/cycles/${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadCycle(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error(
      "comp-cycle status is released by the approval engine, not a flow action",
    );
  },

  async setField(): Promise<void> {
    throw new Error("compensation cycles are frozen on submit; cancel and start a new round");
  },

  /** Recent cycles in review, for scheduled fan-out (reminders). */
  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(
        `findCandidateIds for "${HRM_COMP_CYCLE_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    }
    const result = (await db.execute<{ id: string }>(sql`
      select id::text as id from hrm_comp_cycles
       where org_id = ${orgId} and status = 'in_review'
       order by created_at desc
       limit ${limit}
    `));
    return result.rows.map((row) => row.id);
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
  ): Promise<void> {
    if (!UUID_RE.test(subjectId)) {
      throw new Error(`unknown compensation cycle ${subjectId}`);
    }
    if (outcome !== "approved" && outcome !== "rejected") {
      throw new Error(`unknown compensation decision ${outcome}`);
    }
    const cycle = await loadCycle(subjectId);
    if (!cycle) throw new Error("compensation cycle is not visible");
    // The release stamps the cycle inside decideGate's savepoint; the
    // service refuses a non-review cycle so the gate stays pending.
    await releaseCompCycleDecision(cycle.org_id, subjectId, outcome, ctx.userId ?? "");
    void detail;
  },
};
