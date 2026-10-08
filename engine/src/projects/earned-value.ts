import { sql, type SQL } from "drizzle-orm";
import { db, orgContext, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { pgTextArrayLiteral } from "../platform/pg-array.ts";
import { signedDocumentAmount } from "../money/money.ts";
import { ProjectProgressError } from "./progress.ts";
import {
  addDecimal,
  BURN_WINDOW_WEEKS,
  computeTaskEarnedValue,
  rollUpProjectEarnedValue,
  suggestTaskForecasts,
  type ForecastMethod,
  type ForecastSuggestion,
  type ProjectEarnedValueTotals,
  type TaskEarnedValue,
  type TaskEarnedValueInput,
  type UnassignedActuals,
} from "./earned-value-math.ts";

/**
 * Earned value per project task and per project, as of a date.
 *
 * Actual cost is the project's operational cost attributed by task:
 *
 *   labor      approved time entries (hours × cost rate) through the as-of
 *              date, attributed by time_entries.project_task_id;
 *   non-labor  lines of posted cost documents (vendor bills and credits,
 *              expense reports, card charges, checks, project charges)
 *              through their posting date, attributed by
 *              document_lines.project_task_id, in functional currency.
 *   internal   primary-book cost legs of internal billing, including the
 *              provider's recovery and dated reversals, at project level.
 *
 * Cost that names no task of the project falls into the project's
 * unassigned bucket. Installed quantities are the net project_progress_entries
 * on or before the date, in the task's budget unit; the governing forecast is
 * the latest on or before the date. The math lives in earned-value-math.ts.
 */

export interface EarnedValueTask extends TaskEarnedValue {
  status: string;
  /** Progress exists in a unit other than the task's current budget unit and is excluded from installed. */
  unitConflict: boolean;
  suggestions: ForecastSuggestion[];
}

export interface ProjectEarnedValue {
  projectId: string;
  projectCode: string | null;
  projectName: string;
  asOf: string;
  tasks: EarnedValueTask[];
  unassigned: UnassignedActuals;
  totals: ProjectEarnedValueTotals;
  /** True when at least one task has a forecast on or before the as-of date. */
  hasForecasts: boolean;
}

export const EARNED_VALUE_COST_DOCUMENT_KINDS = [
  "vendor_bill",
  "vendor_credit",
  "expense_report",
  "card_charge",
  "check",
  "project_charge",
] as const;

type TaskRow = {
  id: string;
  project_id: string;
  code: string | null;
  name: string;
  status: string;
  estimated_cost: string | null;
  estimated_hours: string | null;
  budget_quantity: string | null;
  budget_unit: string | null;
  schedule_progress: string | null;
  scheduled: boolean;
};

type ActualRow = {
  project_id: string;
  task_id: string | null;
  cost: string;
  hours: string;
  trailing_cost: string;
  trailing_hours: string;
};

const uuidList = (ids: readonly string[]): SQL => sql`${pgTextArrayLiteral(ids)}::uuid[]`;

function subsidiaryFilter(allowedSubsidiaryIds: ReadonlySet<string> | null | undefined): SQL {
  if (allowedSubsidiaryIds === null) return sql``;
  // An omitted scope fails closed rather than reading as unrestricted.
  if (!allowedSubsidiaryIds || allowedSubsidiaryIds.size === 0) return sql`and false`;
  return sql`and p.subsidiary_id = any(${uuidList([...allowedSubsidiaryIds])})`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Earned value for the given projects (restricted to the caller's legal
 * entities), on the supplied executor so the caller owns the snapshot.
 */
export async function loadEarnedValue(
  executor: SqlExecutor,
  orgId: string,
  input: {
    asOf: string;
    projectIds?: readonly string[];
    allowedSubsidiaryIds: ReadonlySet<string> | null;
    activeOnly?: boolean;
  },
): Promise<ProjectEarnedValue[]> {
  if (!DATE.test(input.asOf)) throw new Error("earned value as-of date must be YYYY-MM-DD");
  const projectScope = input.projectIds
    ? input.projectIds.length > 0
      ? sql`and p.id = any(${uuidList(input.projectIds)})`
      : sql`and false`
    : sql``;
  const projects = (await executor.execute<{ id: string; code: string | null; name: string }>(sql`
    select p.id, p.code, p.name
      from projects p
     where p.org_id = ${orgId}
       ${projectScope}
       ${input.activeOnly ? sql`and p.is_active` : sql``}
       ${subsidiaryFilter(input.allowedSubsidiaryIds)}
     order by p.code nulls last, p.name, p.id
  `)).rows;
  if (projects.length === 0) return [];
  const ids = uuidList(projects.map((project) => project.id));
  const asOf = input.asOf;
  const windowStart = sql`(${asOf}::date - ${BURN_WINDOW_WEEKS * 7 - 1}::int)`;

  const tasks = (await executor.execute<TaskRow>(sql`
    select t.id, t.project_id, t.code, t.name, t.status,
           t.estimated_cost::text as estimated_cost, t.estimated_hours::text as estimated_hours,
           t.budget_quantity::text as budget_quantity, t.budget_unit,
           t.schedule_progress::text as schedule_progress,
           (t.schedule_start is not null and t.schedule_end is not null) as scheduled
      from project_tasks t
     where t.org_id = ${orgId} and t.project_id = any(${ids})
     order by t.code nulls last, t.name, t.id
  `)).rows;

  const installed = (await executor.execute<{ task_id: string; quantity: string; other_units: string }>(sql`
    select e.project_task_id as task_id,
           coalesce(sum(e.quantity) filter (where e.unit = t.budget_unit), 0)::text as quantity,
           count(*) filter (where t.budget_unit is null or e.unit <> t.budget_unit)::text as other_units
      from project_progress_entries e
      join project_tasks t on t.id = e.project_task_id and t.org_id = e.org_id and t.project_id = e.project_id
     where e.org_id = ${orgId} and e.project_id = any(${ids}) and e.entry_date <= ${asOf}::date
     group by e.project_task_id
  `)).rows;

  // Labor: approved hours at their cost rate. A task of another project
  // never attributes cost here; such time reads as unassigned.
  const labor = (await executor.execute<ActualRow & { missing_rates: number }>(sql`
    select te.project_id, pt.id as task_id,
           coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)), 0)::text as cost,
           coalesce(sum(te.hours), 0)::text as hours,
           coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)) filter (where te.worked_on >= ${windowStart}), 0)::text as trailing_cost,
           coalesce(sum(te.hours) filter (where te.worked_on >= ${windowStart}), 0)::text as trailing_hours,
           count(*) filter (where te.cost_rate is null and te.hours <> 0)::int as missing_rates
      from time_entries te
      left join project_tasks pt
        on pt.id = te.project_task_id and pt.org_id = te.org_id and pt.project_id = te.project_id
     where te.org_id = ${orgId} and te.project_id = any(${ids})
       and te.status = 'approved' and te.worked_on <= ${asOf}::date
     group by te.project_id, pt.id
  `)).rows;
  if (labor.some((row) => row.missing_rates > 0)) {
    throw new ProjectProgressError(
      "Earned value cannot be calculated because approved time entries have no cost rate",
      422,
      "invalid",
      "Review the affected approved time entries and their cost rates",
    );
  }

  const kinds = sql.join(EARNED_VALUE_COST_DOCUMENT_KINDS.map((kind) => sql`${kind}`), sql`, `);
  const lineAmount = signedDocumentAmount(sql`d.kind`, sql`round(dl.amount * coalesce(d.fx_rate, 1), 4)`);
  const lineDate = sql`coalesce(d.posting_date, d.document_date)`;
  const nonLabor = (await executor.execute<ActualRow>(sql`
    select coalesce(dl.project_id, d.project_id) as project_id, pt.id as task_id,
           coalesce(sum(${lineAmount}), 0)::text as cost,
           '0'::text as hours,
           coalesce(sum(${lineAmount}) filter (where ${lineDate} >= ${windowStart}), 0)::text as trailing_cost,
           '0'::text as trailing_hours
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
      left join project_tasks pt
        on pt.id = dl.project_task_id and pt.org_id = dl.org_id
       and pt.project_id = coalesce(dl.project_id, d.project_id)
     where dl.org_id = ${orgId}
       and coalesce(dl.project_id, d.project_id) = any(${ids})
       and d.status = 'posted' and d.kind in (${kinds})
       and ${lineDate} <= ${asOf}::date
     group by coalesce(dl.project_id, d.project_id), pt.id
  `)).rows;

  // Internal billing has two project sides. Its posted cost legs are the
  // authority: line/header fallback would lose the provider recovery and
  // department revenue credits must never become job cost. Include reversal
  // legs by posting date so historical earned value retains the original cost.
  const internalCost = (await executor.execute<ActualRow>(sql`
    select l.project_id, null::uuid as task_id,
           sum(l.amount)::text as cost, '0'::text as hours,
           coalesce(sum(l.amount) filter (where e.posting_date >= ${windowStart}), 0)::text as trailing_cost,
           '0'::text as trailing_hours
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join accounting_books b on b.id = e.book_id and b.org_id = e.org_id
     where l.org_id = ${orgId} and l.project_id = any(${ids})
       and d.kind = 'internal_billing' and e.status in ('posted', 'reversed')
       and b.is_primary and b.is_active and b.posts_gl
       and a.type in ('cogs', 'expense', 'expense_other')
       and e.posting_date <= ${asOf}::date
     group by l.project_id
  `)).rows;

  const forecasts = (await executor.execute<{
    task_id: string;
    method: ForecastMethod;
    as_of_date: string;
    cost_to_complete: string;
    hours_to_complete: string | null;
  }>(sql`
    select distinct on (f.project_task_id)
           f.project_task_id as task_id, f.method, f.as_of_date::text as as_of_date,
           f.cost_to_complete::text as cost_to_complete, f.hours_to_complete::text as hours_to_complete
      from project_forecasts f
     where f.org_id = ${orgId} and f.project_id = any(${ids}) and f.as_of_date <= ${asOf}::date
     order by f.project_task_id, f.as_of_date desc, f.created_at desc, f.id desc
  `)).rows;

  const installedByTask = new Map(installed.map((row) => [row.task_id, row]));
  const forecastByTask = new Map(forecasts.map((row) => [row.task_id, row]));
  const actualKey = (projectId: string, taskId: string | null) => `${projectId}:${taskId ?? ""}`;
  const actuals = new Map<string, UnassignedActuals>();
  for (const row of [...labor, ...nonLabor, ...internalCost]) {
    const key = actualKey(row.project_id, row.task_id);
    const prior = actuals.get(key);
    actuals.set(key, prior
      ? {
          actualCost: addDecimal(prior.actualCost, row.cost, 8),
          actualHours: addDecimal(prior.actualHours, row.hours, 8),
          trailingCost: addDecimal(prior.trailingCost, row.trailing_cost, 8),
          trailingHours: addDecimal(prior.trailingHours, row.trailing_hours, 8),
        }
      : { actualCost: row.cost, actualHours: row.hours, trailingCost: row.trailing_cost, trailingHours: row.trailing_hours });
  }
  const none: UnassignedActuals = { actualCost: "0", actualHours: "0", trailingCost: "0", trailingHours: "0" };

  return projects.map((project) => {
    const projectTasks = tasks.filter((task) => task.project_id === project.id);
    const evTasks = projectTasks.map((task): EarnedValueTask => {
      const actual = actuals.get(actualKey(project.id, task.id)) ?? none;
      const forecast = forecastByTask.get(task.id);
      const inputs: TaskEarnedValueInput = {
        taskId: task.id,
        code: task.code,
        name: task.name,
        budgetCost: task.estimated_cost,
        budgetHours: task.estimated_hours,
        budgetQuantity: task.budget_quantity,
        budgetUnit: task.budget_unit,
        installedQuantity: installedByTask.get(task.id)?.quantity ?? "0",
        scheduleProgress: task.scheduled ? task.schedule_progress ?? "0" : null,
        actualCost: actual.actualCost,
        actualHours: actual.actualHours,
        trailingCost: actual.trailingCost,
        trailingHours: actual.trailingHours,
        forecast: forecast
          ? {
              method: forecast.method,
              asOfDate: forecast.as_of_date,
              costToComplete: forecast.cost_to_complete,
              hoursToComplete: forecast.hours_to_complete,
            }
          : null,
      };
      return {
        ...computeTaskEarnedValue(inputs),
        status: task.status,
        unitConflict: Number(installedByTask.get(task.id)?.other_units ?? "0") > 0,
        suggestions: suggestTaskForecasts(inputs),
      };
    });
    const unassigned = actuals.get(actualKey(project.id, null)) ?? none;
    return {
      projectId: project.id,
      projectCode: project.code,
      projectName: project.name,
      asOf,
      tasks: evTasks,
      unassigned,
      totals: rollUpProjectEarnedValue(evTasks, unassigned),
      hasForecasts: evTasks.some((task) => task.estimateSource === "forecast"),
    };
  });
}

/**
 * One project's earned value as one committed generation: every statement
 * reads the same REPEATABLE READ snapshot, or the caller's own transaction
 * when one is already open. Null when the project is missing or outside the
 * caller's legal entities.
 */
export async function projectEarnedValue(
  orgId: string,
  projectId: string,
  asOf: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ProjectEarnedValue | null> {
  const run = async () =>
    (await loadEarnedValue(db, orgId, { asOf, projectIds: [projectId], allowedSubsidiaryIds }))[0] ?? null;
  const active = orgContext.getStore();
  if (active?.txDb && !active.bypass) {
    if (orgId !== active.orgId) throw new Error("cannot change organization inside an active tenant transaction");
    return run();
  }
  return withOrgTransaction(orgId, run, { isolationLevel: "REPEATABLE READ", readOnly: true });
}

/** Earned value for many projects (the report), as one committed generation. */
export async function earnedValueByProject(
  orgId: string,
  input: { asOf: string; projectIds?: readonly string[]; allowedSubsidiaryIds: ReadonlySet<string> | null; activeOnly?: boolean },
): Promise<ProjectEarnedValue[]> {
  const active = orgContext.getStore();
  if (active?.txDb && !active.bypass) {
    if (orgId !== active.orgId) throw new Error("cannot change organization inside an active tenant transaction");
    return loadEarnedValue(db, orgId, input);
  }
  return withOrgTransaction(orgId, () => loadEarnedValue(db, orgId, input), {
    isolationLevel: "REPEATABLE READ",
    readOnly: true,
  });
}
