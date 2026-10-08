import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { normalizeMoney } from "../money/money.ts";
import { loadEarnedValue } from "./earned-value.ts";
import type { ForecastMethod, ForecastSuggestion } from "./earned-value-math.ts";
import { assertProgressEnabled, lockProgressTask, ProjectProgressError } from "./progress.ts";

/**
 * Estimate-to-complete forecasts per project task.
 *
 * project_forecasts is append-only evidence: a new estimate appends a row and
 * the latest row on or before a date governs that date, so a historical
 * report re-runs with the estimate that was current then. An estimate is
 * either entered manually or accepted from a suggestion; an accepted
 * suggestion is recomputed on the server and recorded with its method, so the
 * recorded figure is always the one the method yields for that date.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 500;
const FORECAST_METHODS = new Set<ForecastMethod>(["manual", "remaining_budget", "units_productivity", "cost_performance"]);

export interface ProjectForecast {
  id: string;
  taskId: string;
  asOfDate: string;
  method: ForecastMethod;
  costToComplete: string;
  hoursToComplete: string | null;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

function exactNonNegative(value: unknown, scale: number, label: string): string {
  const exact = typeof value === "string" ? canonicalDecimal(value.trim(), scale) : null;
  if (exact === null || compareDecimal(exact, "0") < 0) {
    throw new ProjectProgressError(
      `${label} must be zero or a positive number with at most ${scale} decimal places`,
      422,
      "invalid",
    );
  }
  return exact;
}

/**
 * Suggested estimates for every task of a project as of a date. Read-only;
 * null when the project is missing or outside the caller's legal entities.
 */
export async function suggestForecasts(input: {
  orgId: string;
  projectId: string;
  asOf: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ taskId: string; suggestions: ForecastSuggestion[] }[] | null> {
  if (!DATE.test(input.asOf)) throw new ProjectProgressError("Date must be YYYY-MM-DD", 422, "invalid");
  const projects = await withOrgTransaction(input.orgId, () => loadEarnedValue(db, input.orgId, {
    asOf: input.asOf,
    projectIds: [input.projectId],
    allowedSubsidiaryIds: input.allowedSubsidiaryIds,
  }), { isolationLevel: "REPEATABLE READ", readOnly: true });
  const project = projects[0];
  if (!project) return null;
  return project.tasks.map((task) => ({ taskId: task.taskId, suggestions: task.suggestions }));
}

/**
 * Record an estimate to complete for one task.
 *
 * `method: 'manual'` records the entered cost (and optional hours). Any other
 * method records the server's suggestion for that method as of the date and
 * refuses when the method has no basis (for example units productivity on a
 * task without installed units). Dates after the business day are refused.
 */
export async function recordForecast(input: {
  orgId: string;
  actorId: string;
  projectId: string;
  taskId: string;
  asOfDate: string;
  method: ForecastMethod;
  costToComplete?: string | null;
  hoursToComplete?: string | null;
  note?: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<ProjectForecast> {
  if (!DATE.test(input.asOfDate)) throw new ProjectProgressError("Date must be YYYY-MM-DD", 422, "invalid");
  if (!FORECAST_METHODS.has(input.method)) {
    throw new ProjectProgressError("Unsupported forecast method", 422, "invalid");
  }
  const note = input.note?.trim() || null;
  if (note && note.length > NOTE_MAX) {
    throw new ProjectProgressError(`Note must be ${NOTE_MAX} characters or fewer`, 422, "invalid");
  }
  const manualCost = input.method === "manual"
    ? normalizeMoney(exactNonNegative(input.costToComplete, 4, "Cost to complete"))
    : null;
  const manualHours = input.method === "manual" && input.hoursToComplete != null && input.hoursToComplete.trim() !== ""
    ? exactNonNegative(input.hoursToComplete, 4, "Hours to complete")
    : null;

  return withOrgTransaction(input.orgId, async () => {
    await assertProgressEnabled(db, input.orgId);
    const task = await lockProgressTask(db, input.orgId, input.projectId, input.taskId, input.allowedSubsidiaryIds);
    const today = await businessTodayInTx(db, input.orgId);
    if (input.asOfDate > today) {
      throw new ProjectProgressError(
        `A forecast cannot be dated after today (${today})`,
        422,
        "future-date",
        "date the estimate on or before today",
      );
    }

    let costToComplete = manualCost;
    let hoursToComplete = manualHours;
    if (input.method !== "manual") {
      const [project] = await loadEarnedValue(db, input.orgId, {
        asOf: input.asOfDate,
        projectIds: [task.projectId],
        allowedSubsidiaryIds: null,
      });
      const suggestion = project?.tasks
        .find((candidate) => candidate.taskId === task.id)
        ?.suggestions.find((candidate) => candidate.method === input.method);
      if (!suggestion) {
        throw new ProjectProgressError(
          "This estimating method has no basis for the task on that date",
          422,
          "invalid",
          input.method === "units_productivity"
            ? "record installed progress on the task first, or enter the estimate manually"
            : "record actual cost on the task first, or enter the estimate manually",
        );
      }
      costToComplete = suggestion.costToComplete;
      hoursToComplete = suggestion.hoursToComplete;
    }

    const inserted = (await db.execute<{ id: string }>(sql`
      insert into project_forecasts
        (org_id, project_id, project_task_id, as_of_date, method, cost_to_complete, hours_to_complete, note, created_by)
      values (${input.orgId}, ${task.projectId}, ${task.id}, ${input.asOfDate}, ${input.method},
              ${costToComplete}, ${hoursToComplete}, ${note}, ${input.actorId})
      returning id
    `)).rows[0];
    if (!inserted) throw new Error("forecast insert returned no row");
    const after = {
      projectId: task.projectId,
      taskId: task.id,
      asOfDate: input.asOfDate,
      method: input.method,
      costToComplete,
      hoursToComplete,
      note,
    };
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'project_forecasts', ${inserted.id}, 'insert',
              ${JSON.stringify({ event: "forecast_recorded", after })}::jsonb, ${input.actorId})
    `);
    const [recorded] = await readForecasts(input.orgId, sql`and f.id = ${inserted.id}`);
    return recorded!;
  });
}

async function readForecasts(orgId: string, filter: ReturnType<typeof sql>): Promise<ProjectForecast[]> {
  const rows = (await db.execute<{
    id: string; task_id: string; as_of_date: string; method: ForecastMethod; cost_to_complete: string;
    hours_to_complete: string | null; note: string | null; created_at: string; created_by_name: string | null;
  }>(sql`
    select f.id, f.project_task_id as task_id, f.as_of_date::text as as_of_date, f.method,
           f.cost_to_complete::text as cost_to_complete, f.hours_to_complete::text as hours_to_complete,
           f.note, f.created_at::text as created_at, u.name as created_by_name
      from project_forecasts f
      left join users u on u.id = f.created_by
     where f.org_id = ${orgId} ${filter}
     order by f.as_of_date desc, f.created_at desc, f.id desc
  `)).rows;
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    asOfDate: row.as_of_date,
    method: row.method,
    costToComplete: row.cost_to_complete,
    hoursToComplete: row.hours_to_complete,
    note: row.note,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
  }));
}

/** Forecast history for one task, newest first. */
export async function listForecasts(input: {
  orgId: string;
  projectId: string;
  taskId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<ProjectForecast[]> {
  return withOrgTransaction(input.orgId, async () => {
    await lockProgressTask(db, input.orgId, input.projectId, input.taskId, input.allowedSubsidiaryIds);
    return readForecasts(input.orgId, sql`and f.project_id = ${input.projectId} and f.project_task_id = ${input.taskId}`);
  });
}
