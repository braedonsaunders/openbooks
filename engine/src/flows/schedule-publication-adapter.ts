import { actorHasPermission } from "../organization/actor-permissions.ts";
import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { releaseFlowApproval } from "./approval-release-hook.ts";
import { tableScope } from "./subject-scope.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

/**
 * Schedule publications as native Flow subjects.
 *
 * Publishing a booking board submits its unpublished changes.
 * An organization that authors a Schedule publication Flow with approval
 * gates has every publication decided there; without one, the publication
 * is applied when submitted and records that no approval applied. The Flow
 * decides only: the scheduling service publishes exactly the submitted
 * changes through the registered release handler, inside the gate decision's
 * transaction, with the booking ledger's guards in force.
 */
export const SCHEDULE_PUBLICATION_SUBJECT_KIND = "schedule_publication";

const STATUSES = [
  { value: "pending", label: "Awaiting decision" },
  { value: "approved", label: "Published" },
  { value: "declined", label: "Declined" },
  { value: "withdrawn", label: "Withdrawn" },
] as const;

export const schedulePublicationSubjectProfile: FlowSubjectProfile = {
  subjectKind: SCHEDULE_PUBLICATION_SUBJECT_KIND,
  pinsSubmissionPolicy: true,
  label: "Schedule publication",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...STATUSES],
  fields: [
    { key: "status", label: "Status", type: "enum" },
    { key: "boardId", label: "Board identity", type: "text" },
    { key: "boardCode", label: "Board code", type: "text" },
    { key: "boardName", label: "Board", type: "text" },
    { key: "fromDate", label: "From date", type: "date" },
    { key: "throughDate", label: "Through date", type: "date" },
    { key: "changeCount", label: "Changes", type: "number" },
    { key: "reason", label: "Reason", type: "text" },
    { key: "createdBy", label: "Submitted by", type: "user" },
  ],
};

type PublicationRow = {
  id: string;
  status: string;
  board_id: string;
  board_code: string;
  board_name: string;
  from_date: string;
  through_date: string;
  change_count: number;
  reason: string;
  created_by: string;
};

async function loadPublication(subjectId: string): Promise<PublicationRow | null> {
  const orgId = ambientTenantOrgId();
  if (!orgId) throw new Error("Schedule publications require a native tenant context.");
  return (
    (
      await db.execute<PublicationRow>(
        sql`
    select p.id, p.status, p.board_id, b.code as board_code, b.name as board_name, p.from_date::text as from_date, p.through_date::text as through_date,
           cardinality(p.entry_ids)::int as change_count, p.reason, p.created_by
      from schedule_publications p join schedule_boards b on b.org_id = p.org_id and b.id = p.board_id
     where p.org_id = ${orgId} and p.id = ${subjectId}`,
        "objects",
      )
    )[0] ?? null
  );
}

export const schedulePublicationsFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: SCHEDULE_PUBLICATION_SUBJECT_KIND,
  permissions: {
    read: "hrm.shifts.read",
    edit: "hrm.shifts.manage",
    approve: "hrm.shifts.approve",
  },
  async readPermission(id, actorId) {
    const row = (
      await db.execute<{
        org_id: string;
        row_kind: string;
        board_type: string;
        resource_kind: string | null;
      }>(
        sql`select p.org_id,b.row_kind,b.board_type,b.resource_kind from schedule_publications p join schedule_boards b on b.org_id=p.org_id and b.id=p.board_id where p.id=${id}`,
        "objects",
      )
    )[0];
    if (
      row?.row_kind === "resources" &&
      row.resource_kind === "equipment" &&
      !(await actorHasPermission(db, row.org_id, actorId, "assets.read"))
    )
      return null;
    return row?.row_kind === "resources"
      ? "projects.read"
      : row?.board_type === "dispatch"
        ? "service.read"
        : row
          ? "hrm.shifts.read"
          : null;
  },
  async decisionPermission(id, actorId) {
    const row = (
      await db.execute<{
        org_id: string;
        row_kind: string;
        board_type: string;
        resource_kind: string | null;
      }>(
        sql`select p.org_id,b.row_kind,b.board_type,b.resource_kind from schedule_publications p join schedule_boards b on b.org_id=p.org_id and b.id=p.board_id where p.id=${id}`,
        "objects",
      )
    )[0];
    if (
      row?.row_kind === "resources" &&
      row.resource_kind === "equipment" &&
      actorId &&
      !(await actorHasPermission(db, row.org_id, actorId, "assets.manage"))
    )
      return null;
    return row?.row_kind === "resources"
      ? "projects.manage"
      : row?.board_type === "dispatch"
        ? "service.dispatch"
        : row
          ? "hrm.shifts.approve"
          : null;
  },
  scope: tableScope("column", "schedule_publications", "subsidiary_id"),
  profile: schedulePublicationSubjectProfile,
  releaseViaHandler: true,

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const row = await loadPublication(subjectId);
    if (!row) return null;
    return {
      values: {
        id: row.id,
        status: row.status,
        boardId: row.board_id,
        boardCode: row.board_code,
        boardName: row.board_name,
        fromDate: row.from_date,
        throughDate: row.through_date,
        changeCount: row.change_count,
        reason: row.reason,
        createdBy: row.created_by,
      },
      submitterUserId: row.created_by,
      makerUserId: row.created_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    return `Schedule publication ${String(values.boardName ?? subjectId)} ${String(values.fromDate ?? "")}–${String(values.throughDate ?? "")}`.trim();
  },

  deepLink(subjectId: string): string {
    return `/scheduling?publication=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadPublication(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error(
      "schedule publication status is released by the approval engine, not a flow action",
    );
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
    detail?: { comment?: string | null },
    run?: { id: string },
  ): Promise<void> {
    await releaseFlowApproval({
      subjectKind: SCHEDULE_PUBLICATION_SUBJECT_KIND,
      subjectId,
      outcome,
      comment: detail?.comment,
      ctx,
      approvalRunId: run?.id,
    });
  },

  /** A retried run that now gates leaves the publication awaiting its decision; anything else fails closed. */
  async markAwaitingApproval(subjectId: string): Promise<void> {
    const status = (await loadPublication(subjectId))?.status ?? null;
    if (status !== "pending")
      throw new Error(
        `schedule publication is ${status ?? "missing"}; only a publication awaiting a decision can await approval`,
      );
  },

  async setField(): Promise<void> {
    throw new Error("schedule publication fields are not writable by flows");
  },

  async findCandidateIds(limit: number): Promise<string[]> {
    const orgId = ambientTenantOrgId();
    if (!orgId)
      throw new Error(
        `findCandidateIds for "${SCHEDULE_PUBLICATION_SUBJECT_KIND}" requires an ambient tenant context (withOrg)`,
      );
    return (
      await db.execute<{
        id: string;
      }>(
        sql`select id::text as id from schedule_publications
      where org_id = ${orgId} and status = 'pending' order by created_at desc limit ${limit}`,
        "objects",
      )
    ).map((row) => row.id);
  },
});
