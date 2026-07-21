import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../db.ts";
import { BUILT_IN_ROLE_NAMES, EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";

export const CLOSE_RUN_SUBJECT_KIND = "close_run";

const CLOSE_RUN_STATUSES = [
  { value: "in_progress", label: "In progress" },
  { value: "review", label: "In review" },
  { value: "approved", label: "Approved" },
  { value: "closed", label: "Closed" },
  { value: "published", label: "Published" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const closeRunSubjectProfile: FlowSubjectProfile = {
  subjectKind: CLOSE_RUN_SUBJECT_KIND,
  label: "Period close run",
  triggers: ["on_submit"],
  actions: ["send_email", "notify"],
  statuses: [...CLOSE_RUN_STATUSES],
  fields: [
    { key: "periodName", label: "Accounting period", type: "text" },
    { key: "fiscalYear", label: "Fiscal year", type: "number" },
    { key: "periodType", label: "Period type", type: "enum", options: [
      { value: "month", label: "Month-end" },
      { value: "quarter", label: "Quarter-end" },
      { value: "year", label: "Year-end" },
      { value: "adjustment", label: "Adjustment" },
    ] },
    { key: "bookId", label: "Accounting book", type: "text" },
    { key: "bookName", label: "Accounting book name", type: "text" },
    { key: "blueprintName", label: "Close blueprint", type: "text" },
    { key: "status", label: "Status", type: "enum", options: CLOSE_RUN_STATUSES.map((status) => ({ ...status })) },
    { key: "readinessScore", label: "Readiness score", type: "number" },
    { key: "targetCloseDate", label: "Target close date", type: "date" },
    { key: "openExceptionCount", label: "Open exceptions", type: "number" },
    { key: "startedBy", label: "Run initiator", type: "user" },
    { key: "event_source", label: "Event source", type: "enum", options: [...EVENT_SOURCE_OPTIONS] },
  ],
  roles: [...BUILT_IN_ROLE_NAMES],
};

type CloseRunRow = {
  id: string;
  org_id: string;
  period_name: string;
  fiscal_year: number;
  period_number: number;
  is_adjustment: boolean;
  book_id: string;
  book_name: string;
  blueprint_name: string;
  status: string;
  readiness_score: number;
  target_close_date: string;
  started_by: string | null;
  open_exception_count: number;
};

async function loadCloseRun(subjectId: string): Promise<CloseRunRow | null> {
  const result = (await db.execute(sql`
    select r.id, r.org_id, p.name as period_name, p.fiscal_year, p.period_number,
           p.is_adjustment, r.book_id, b.name as book_name, bp.name as blueprint_name,
           r.status, r.readiness_score, r.target_close_date, r.started_by,
           (select count(*)::int from close_exceptions x
             where x.run_id = r.id and x.status = 'open') as open_exception_count
      from close_runs r
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
      join close_blueprints bp on bp.id = r.blueprint_id and bp.org_id = r.org_id
     where r.id = ${subjectId}
  `)) as unknown as { rows: CloseRunRow[] };
  return result.rows[0] ?? null;
}

function periodType(row: CloseRunRow): "month" | "quarter" | "year" | "adjustment" {
  if (row.is_adjustment) return "adjustment";
  if (row.period_number === 12 || row.period_number === 13) return "year";
  if (row.period_number % 3 === 0) return "quarter";
  return "month";
}

export const closeRunsFlowAdapter: FlowSubjectAdapter = {
  subjectKind: CLOSE_RUN_SUBJECT_KIND,
  profile: closeRunSubjectProfile,
  writableFields: new Set<string>(),
  selfApprovalPolicy: "forbidden",

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const run = await loadCloseRun(subjectId);
    if (!run) return null;
    return {
      values: {
        id: run.id,
        periodName: run.period_name,
        fiscalYear: run.fiscal_year,
        periodType: periodType(run),
        bookId: run.book_id,
        bookName: run.book_name,
        blueprintName: run.blueprint_name,
        status: run.status,
        readinessScore: run.readiness_score,
        targetCloseDate: run.target_close_date,
        openExceptionCount: run.open_exception_count,
        startedBy: run.started_by,
      },
      submitterUserId: run.started_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    return `${String(values.periodName ?? subjectId)} close · ${String(values.bookName ?? "")}`.trim();
  },

  deepLink(subjectId: string): string {
    return `/close?run=${subjectId}&stage=lock`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadCloseRun(subjectId))?.status ?? null;
  },

  async changeStatus(): Promise<void> {
    throw new Error("close lifecycle transitions are controlled by the close engine");
  },

  async releaseApproval(
    subjectId: string,
    outcome: "approved" | "rejected",
    ctx: FlowExecCtx,
  ): Promise<void> {
    const { finalizeCloseFlowApproval } = await import("../close.ts");
    await finalizeCloseFlowApproval({
      orgId: ctx.orgId,
      runId: subjectId,
      actorId: ctx.userId ?? null,
      outcome,
    });
  },

  async setField(): Promise<void> {
    throw new Error("close run fields are not writable by flows");
  },
};
