import { releaseBudgetScenario, budgetScenarioScopeOwners } from "./budget-submission.ts";
import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { ambientTenantOrgId, db } from "../platform/db.ts";
import { EVENT_SOURCE_OPTIONS } from "./subject-profiles.ts";
import type { FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { defineTableSubjectAdapter } from "./table-subject-adapter.ts";

export const BUDGET_SCENARIO_SUBJECT_KIND = "budget_scenario";

export const budgetScenarioSubjectProfile: FlowSubjectProfile = {
  subjectKind: BUDGET_SCENARIO_SUBJECT_KIND,
  label: "Budget scenario",
  pinsSubmissionPolicy: true,
  triggers: ["on_submit", "scheduled", "manual"],
  actions: ["send_email", "notify", "lock_record", "unlock_record"],
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
    },
    { key: "total", label: "Total", type: "number" },
    { key: "lineCount", label: "Line count", type: "number" },
    { key: "createdBy", label: "Created by (user)", type: "user" },
    {
      key: "event_source",
      label: "Event source",
      type: "enum",
      options: [...EVENT_SOURCE_OPTIONS],
    },
    {
      key: "current_user_id",
      label: "Current user (manual buttons)",
      type: "user",
    },
    {
      key: "is_submitter",
      label: "Viewer is submitter (manual buttons)",
      type: "bool",
    },
    {
      key: "is_pending_approver",
      label: "Viewer has a pending gate (manual buttons)",
      type: "bool",
    },
  ],
};

type BudgetRow = {
  id: string;
  org_id: string;
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
  const result = await db.execute<BudgetRow>(
    sql`
    select bs.id, bs.org_id, bs.name, bs.description, bs.book_id, b.name as book_name,
           bs.fiscal_year, bs.kind, bs.status, bs.revision, bs.created_by
      from budget_scenarios bs
      join accounting_books b on b.id = bs.book_id and b.org_id = bs.org_id
     where bs.id = ${subjectId}
  `,
    "objects",
  );
  return result[0] ?? null;
}

export const budgetScenariosFlowAdapter: FlowSubjectAdapter = defineTableSubjectAdapter({
  subjectKind: BUDGET_SCENARIO_SUBJECT_KIND,
  // Checker decisions require the tenant approval grant and every line's entity.
  permissions: {
    read: "budgets.read",
    edit: "budgets.manage",
    approve: "budgets.approve",
  },
  scope: { via: "custom", subsidiaryOf: budgetScenarioScopeOwners },
  profile: budgetScenarioSubjectProfile,

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const budget = await loadBudget(subjectId);
    if (!budget) return null;
    const lines = await db.execute<Record<string, unknown>>(
      sql`
      select bl.account_id as "accountId", bl.period_id as "periodId",
             bl.department_id as "departmentId", bl.project_id as "projectId",
             bl.location_id as "locationId", bl.class_id as "classId",
             bl.amount::text as amount, bl.note
        from budget_lines bl
       where bl.scenario_id = ${subjectId} and bl.org_id = ${budget.org_id}
       order by bl.created_at, bl.id
    `,
      "objects",
    );
    const total = await db.execute<{ total: string }>(
      sql`
      select coalesce(sum(case when a.type in ('income', 'income_other') then -bl.amount else bl.amount end), 0)::text as total
        from budget_lines bl
        join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
       where bl.scenario_id = ${subjectId} and bl.org_id = ${budget.org_id}
    `,
      "objects",
    );
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
        total: total[0]?.total ?? "0.0000",
        lineCount: lines.length,
        createdBy: budget.created_by,
      },
      rows: { lines },
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

  async changeStatus(): Promise<void> {
    throw new Error("Use native budget submission and Flow gates to change approval state.");
  },

  async releaseApproval(subjectId, outcome, ctx, detail, run) {
    if (!ctx.userId) throw new Error("A budget release requires a named operator.");
    await releaseBudgetScenario(
      ctx.orgId,
      ctx.userId,
      subjectId,
      outcome,
      run?.id,
      detail?.comment,
    );
  },

  async setField(): Promise<void> {
    throw new Error(
      "budget fields are not writable by flows — draft edits go through the budget API",
    );
  },

  async findCandidateIds(limit: number): Promise<string[]> {
    // Coarse newest-first fetch for scheduled fan-out; the select rule does
    // the real filtering in JS against each record's loaded context. The
    // explicit org_id predicate is the tenant boundary — same contract as the
    // documents adapter. It fails closed when no ambient tenant is active
    // rather than reading unscoped across organizations.
    const orgId = ambientTenantOrgId();
    if (!orgId) {
      throw new Error(
        `findCandidateIds for "budget_scenario" requires an ambient tenant context (withOrg)`,
      );
    }
    const result = await db.execute<{ id: string }>(
      sql`
      select id from budget_scenarios
       where org_id = ${orgId} and status <> 'archived'
       order by created_at desc
       limit ${limit}
    `,
      "objects",
    );
    return result.map((row) => row.id);
  },
});
