import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { tableScope } from "./subject-scope.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

/**
 * Shift requests as Flow subjects.
 *
 * Approval is optional: an organization that authors a Shift request Flow
 * with approval gates routes every request awaiting a decision through it;
 * without one, the request is applied when submitted and records that no
 * approval applied. The Flow decides only — the
 * outcome (release, new times, an exchange of shifts) is applied by the
 * scheduling service through the registered release handler, inside the
 * gate decision's transaction, so the booking ledger's guards and the
 * decider's independence are enforced exactly as for a direct decision.
 */
export const SCHEDULE_REQUEST_SUBJECT_KIND = "schedule_entry_request";

const STATUSES = [
  { value: "awaiting_counterpart", label: "Awaiting colleague" },
  { value: "pending", label: "Awaiting decision" },
  { value: "approved", label: "Approved" },
  { value: "declined", label: "Declined" },
  { value: "withdrawn", label: "Withdrawn" },
] as const;

export const scheduleRequestSubjectProfile: FlowSubjectProfile = {
  subjectKind: SCHEDULE_REQUEST_SUBJECT_KIND,
  pinsSubmissionPolicy: true,
  label: "Shift request",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...STATUSES],
  fields: [
    { key: "status", label: "Status", type: "enum" },
    {
      key: "kind",
      label: "Request",
      type: "enum",
      options: [
        { value: "release", label: "Release shift" },
        { value: "change", label: "Change times" },
        { value: "swap", label: "Swap shifts" },
      ],
    },
    { key: "boardId", label: "Board identity", type: "text" },
    { key: "boardCode", label: "Board code", type: "text" },
    { key: "boardName", label: "Board", type: "text" },
    { key: "workerName", label: "Employee", type: "text" },
    { key: "counterpartName", label: "Swap colleague", type: "text" },
    { key: "shiftDate", label: "Shift date", type: "date" },
    { key: "reason", label: "Reason", type: "text" },
    { key: "createdBy", label: "Requested by", type: "user" },
  ],
};

type RequestRow = {
  id: string;
  status: string;
  kind: string;
  board_id: string;
  board_code: string;
  board_name: string;
  worker_name: string;
  counterpart_name: string | null;
  shift_date: string;
  reason: string;
  created_by: string;
  counterpart_responded_by: string | null;
};

async function loadRequest(subjectId: string): Promise<RequestRow | null> {
  const orgId = ambientTenantOrgId();
  if (!orgId) throw new Error("Shift requests require a native tenant context.");
  return (
    (
      await db.execute<RequestRow>(
        sql`
    select r.id, r.status, r.kind, r.board_id, b.code as board_code, b.name as board_name, w.display_name as worker_name,
           cp.display_name as counterpart_name, e.starts_on::text as shift_date, r.reason, r.created_by, r.counterpart_responded_by
      from schedule_entry_requests r
      join schedule_boards b on b.org_id = r.org_id and b.id = r.board_id
      join schedule_entries e on e.org_id = r.org_id and e.id = r.entry_id
      join parties w on w.org_id = r.org_id and w.id = r.worker_party_id
      left join parties cp on cp.org_id = r.org_id and cp.id = r.counterpart_party_id
     where r.org_id = ${orgId} and r.id = ${subjectId}`,
        "objects",
      )
    )[0] ?? null
  );
}

export const scheduleRequestsFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: SCHEDULE_REQUEST_SUBJECT_KIND,
  permissions: {
    read: "hrm.shifts.read",
    edit: "hrm.shifts.manage",
    approve: "hrm.shifts.approve",
  },
  scope: tableScope("column", "schedule_entry_requests", "subsidiary_id"),
  profile: scheduleRequestSubjectProfile,
  releaseViaHandler: true,

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const row = await loadRequest(subjectId);
    if (!row) return null;
    return {
      values: {
        id: row.id,
        status: row.status,
        kind: row.kind,
        boardId: row.board_id,
        boardCode: row.board_code,
        boardName: row.board_name,
        workerName: row.worker_name,
        counterpartName: row.counterpart_name,
        shiftDate: row.shift_date,
        reason: row.reason,
        createdBy: row.created_by,
      },
      // The colleague who accepted a swap submits it; neither they nor the
      // requester may decide it.
      submitterUserId: row.counterpart_responded_by ?? row.created_by,
      makerUserId: row.created_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const who = values.workerName ? ` — ${String(values.workerName)}` : "";
    return `Shift request ${String(values.shiftDate ?? subjectId)}${who}`;
  },

  deepLink(subjectId: string): string {
    return `/scheduling?request=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadRequest(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error("shift request status is released by the approval engine, not a flow action");
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
    run?: { id: string },
  ): Promise<void> {
    await releaseFlowApproval({
      subjectKind: SCHEDULE_REQUEST_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
      approvalRunId: run?.id,
    });
  },

  /** A retried run that now gates leaves the request awaiting its decision; anything else fails closed. */
  async markAwaitingApproval(subjectId: string): Promise<void> {
    const status = (await loadRequest(subjectId))?.status ?? null;
    if (status !== "pending")
      throw new Error(
        `shift request is ${status ?? "missing"}; only a request awaiting a decision can await approval`,
      );
  },

  async setField(): Promise<void> {
    throw new Error("shift request fields are not writable by flows");
  },

  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId)
      throw new Error(
        `findCandidateIds for "${SCHEDULE_REQUEST_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    return (
      await db.execute<{
        id: string;
      }>(
        sql`select id::text as id from schedule_entry_requests
      where org_id = ${orgId} and status = 'pending' order by created_at desc limit ${limit}`,
        "objects",
      )
    ).map((row) => row.id);
  },
});
