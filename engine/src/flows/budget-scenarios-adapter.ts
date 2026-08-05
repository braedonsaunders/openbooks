import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../db.ts";
import { BUILT_IN_ROLE_NAMES, EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";

export const BUDGET_SCENARIO_SUBJECT_KIND = "budget_scenario";

const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  pending_approval: ["draft"],
  approved: ["pending_approval"],
  draft: ["pending_approval"],
  archived: ["draft", "pending_approval", "approved"],
};

export const budgetScenarioSubjectProfile: FlowSubjectProfile = {
  subjectKind: BUDGET_SCENARIO_SUBJECT_KIND,
  label: "Budget scenario",
  triggers: ["scheduled", "manual"],
  actions: ["send_email", "notify", "change_status", "lock_record", "unlock_record"],
  statuses: [
    { value: "draft", label: "Draft" },
    { value: "pending_approval", label: "Pending approval" },
    { value: "approved", label: "Approved" },
    { value: "archived", label: "Archived" },
  ],
  fields: [
    { key: "name", label: "Name", type: "text" },
    { key: "description", label: "Description", type: "text" },
    { key: "bookId", label: "Accounting book", type: "text" },
    { key: "bookName", label: "Accounting book name", type: "text" },
    { key: "fiscalYear", label: "Fiscal year", type: "number" },
    {
      key: "kind",
      label: "Type",
      type: "enum",
      options: [
        { value: "budget", label: "Budget" },
        { value: "forecast", label: "Forecast" },
      ],
    },
    {
      key: "status",
      label: "Status",
      type: "enum",
      options: [
        { value: "draft", label: "Draft" },
        { value: "pending_approval", label: "Pending approval" },
        { value: "approved", label: "Approved" },
        { value: "archived", label: "Archived" },
      ],
    },
    { key: "total", label: "Total", type: "number" },
    { key: "lineCount", label: "Line count", type: "number" },
    { key: "createdBy", label: "Created by (user)", type: "user" },
    { key: "event_source", label: "Event source", type: "enum", options: [...EVENT_SOURCE_OPTIONS] },
    { key: "current_user_id", label: "Current user (manual buttons)", type: "user" },
    { key: "is_submitter", label: "Viewer is submitter (manual buttons)", type: "bool" },
    { key: "is_pending_approver", label: "Viewer has a pending gate (manual buttons)", type: "bool" },
  ],
  roles: [...BUILT_IN_ROLE_NAMES],
};

type BudgetRow = {
  id: string;
  name: string;
  description: string | null;
  book_id: string;
  book_name: string;
  fiscal_year: number;
  kind: string;
  status: string;
  revision: number;
  created_by: string | null;
};

async function loadBudget(subjectId: string): Promise<BudgetRow | null> {
  const result = (await db.execute(sql`
    select bs.id, bs.name, bs.description, bs.book_id, b.name as book_name,
           bs.fiscal_year, bs.kind, bs.status, bs.revision, bs.created_by
      from budget_scenarios bs
      join accounting_books b on b.id = bs.book_id and b.org_id = bs.org_id
     where bs.id = ${subjectId}
  `)) as unknown as { rows: BudgetRow[] };
  return result.rows[0] ?? null;
}

export const budgetScenariosFlowAdapter: FlowSubjectAdapter = {
  subjectKind: BUDGET_SCENARIO_SUBJECT_KIND,
  profile: budgetScenarioSubjectProfile,
  writableFields: new Set<string>(),

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const budget = await loadBudget(subjectId);
    if (!budget) return null;
    const lines = (await db.execute(sql`
      select bl.account_id as "accountId", bl.period_id as "periodId",
             bl.department_id as "departmentId", bl.project_id as "projectId",
             bl.location_id as "locationId", bl.class_id as "classId",
             bl.amount::text as amount, bl.note
        from budget_lines bl
       where bl.scenario_id = ${subjectId}
       order by bl.created_at, bl.id
    `)) as unknown as { rows: Array<Record<string, unknown>> };
    const total = (await db.execute(sql`
      select coalesce(sum(case when a.type in ('income', 'income_other') then -bl.amount else bl.amount end), 0)::text as total
        from budget_lines bl
        join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
       where bl.scenario_id = ${subjectId}
    `)) as unknown as { rows: { total: string }[] };
    return {
      values: {
        id: budget.id,
        name: budget.name,
        description: budget.description,
        bookId: budget.book_id,
        bookName: budget.book_name,
        fiscalYear: budget.fiscal_year,
        kind: budget.kind,
        status: budget.status,
        revision: budget.revision,
        total: total.rows[0]?.total ?? "0.0000",
        lineCount: lines.rows.length,
        createdBy: budget.created_by,
      },
      rows: { lines: lines.rows },
      submitterUserId: budget.created_by,
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const name = String(values.name ?? subjectId);
    const year = values.fiscalYear ? ` · FY${String(values.fiscalYear)}` : "";
    return `${name}${year}`;
  },

  deepLink(subjectId: string): string {
    return `/budgets?budget=${subjectId}`;
  },

  async getStatus(subjectId: string): Promise<string | null> {
    return (await loadBudget(subjectId))?.status ?? null;
  },

  async changeStatus(subjectId: string, to: string, ctx: FlowExecCtx): Promise<void> {
    await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        select id, name, status, revision from budget_scenarios
         where id = ${subjectId} and org_id = ${ctx.orgId}
         for update
      `)) as unknown as { rows: { id: string; name: string; status: string; revision: number }[] };
      const budget = locked.rows[0];
      if (!budget) throw new Error(`budget scenario ${subjectId} not found`);
      if (budget.status === to) return;
      const legalFrom = STATUS_TRANSITIONS[to];
      if (!legalFrom) throw new Error(`unknown budget status "${to}"`);
      if (!legalFrom.includes(budget.status)) {
        throw new Error(`illegal budget transition ${budget.status} → ${to} for ${budget.name}`);
      }
      const revision = Number(budget.revision) + 1;
      await tx.execute(sql`
        update budget_scenarios set
          status = ${to}, revision = ${revision},
          submitted_at = case when ${to} = 'pending_approval' then now() when ${to} = 'draft' then null else submitted_at end,
          submitted_by = case when ${to} = 'pending_approval' then ${ctx.userId ?? null} when ${to} = 'draft' then null else submitted_by end,
          approved_at = case when ${to} = 'approved' then now() when ${to} = 'draft' then null else approved_at end,
          approved_by = case when ${to} = 'approved' then ${ctx.userId ?? null} when ${to} = 'draft' then null else approved_by end,
          updated_at = now(), updated_by = ${ctx.userId ?? null}
        where id = ${subjectId} and org_id = ${ctx.orgId}
      `);
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${ctx.orgId}, 'budget_scenarios', ${subjectId}, 'update',
          ${JSON.stringify({ source: "flow", from: budget.status, to })}::jsonb, ${ctx.userId ?? null})
      `);
    });
  },

  async setField(): Promise<void> {
    throw new Error("budget fields are not writable by flows — draft edits go through the budget API");
  },

  async findCandidateIds(limit: number): Promise<string[]> {
    const result = (await db.execute(sql`
      select id from budget_scenarios where status <> 'archived' order by created_at desc limit ${limit}
    `)) as unknown as { rows: { id: string }[] };
    return result.rows.map((row) => row.id);
  },
};
