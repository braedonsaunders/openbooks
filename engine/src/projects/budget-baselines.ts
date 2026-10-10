import { sql } from "drizzle-orm";
import { db, orgContext, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessTodayInTx, isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { add, cmp, neg, normalizeMoney, signedDocumentAmount, sum } from "../money/money.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { decimal8ToFour, decimal8Units, sumDecimal8 } from "./budget-decimal.ts";
import { resolveProjectFinancials } from "./financials.ts";
import { loadProjectType } from "./type.ts";

/**
 * Project budget baselines and the budget-versus-actual comparison.
 *
 * The working budget is the project_tasks row (estimated hours, cost and
 * price). A baseline is an immutable snapshot of that budget: sequence 1 is
 * the original — the budget the job was sold at — and every later capture is
 * a revised baseline. The storage refuses any change to a recorded baseline,
 * so the original stays exactly what was sold however the working budget
 * moves afterwards.
 */

export class BudgetBaselineError extends Error {
  readonly name = "BudgetBaselineError";
  constructor(
    message: string,
    readonly status: 404 | 409 | 422 = 422,
    readonly field?: string,
  ) {
    super(message);
  }
}

export interface BudgetBaselineContext {
  orgId: string;
  actorId: string;
  /** Subsidiary scope the caller was granted; null is unrestricted. */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

/** One component of a baseline; explicit lines come from a quote award. */
export interface BaselineLineInput {
  projectTaskId: string;
  taskCode: string | null;
  taskName: string;
  sourceLineId?: string | null;
  itemId?: string | null;
  description?: string | null;
  /** Eight-decimal hours. */
  hours: string;
  quantity?: string | null;
  unit?: string | null;
  cost: string;
  price: string;
}

export interface CaptureBaselineInput {
  projectId: string;
  /** Why the budget is being baselined (at least 8 characters). */
  reason: string;
  label?: string | null;
  /** The quote the baseline was sold from, for award captures. */
  sourceDocumentId?: string | null;
  /** Explicit components; omitted snapshots the current work breakdown. */
  lines?: BaselineLineInput[];
}

export interface BudgetBaselineSummary {
  id: string;
  kind: "original" | "revised";
  sequence: number;
  label: string;
  reason: string;
  sourceDocumentId: string | null;
  sourceDocumentNumber: string | null;
  totalHours: string;
  totalCost: string;
  totalPrice: string;
  createdAt: string;
  createdBy: string | null;
}

export interface BudgetBaselineLine {
  id: string;
  sequence: number;
  projectTaskId: string;
  taskCode: string | null;
  taskName: string;
  sourceLineId: string | null;
  itemId: string | null;
  description: string | null;
  hours: string;
  quantity: string | null;
  unit: string | null;
  cost: string;
  price: string;
}

type SummaryRow = {
  id: string;
  kind: "original" | "revised";
  sequence: number;
  label: string;
  reason: string;
  source_document_id: string | null;
  source_document_number: string | null;
  total_hours: string;
  total_cost: string;
  total_price: string;
  created_at: string;
  created_by: string | null;
};

const SUMMARY_COLUMNS = sql`
  b.id, b.kind, b.sequence, b.label, b.reason, b.source_document_id,
  d.document_number as source_document_number,
  b.total_hours::text as total_hours, b.total_cost::text as total_cost, b.total_price::text as total_price,
  to_char(b.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at, b.created_by`;

function summary(row: SummaryRow): BudgetBaselineSummary {
  return {
    id: row.id,
    kind: row.kind,
    sequence: Number(row.sequence),
    label: row.label,
    reason: row.reason,
    sourceDocumentId: row.source_document_id,
    sourceDocumentNumber: row.source_document_number,
    totalHours: row.total_hours,
    totalCost: normalizeMoney(row.total_cost),
    totalPrice: normalizeMoney(row.total_price),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

async function requireProjectsOn(runner: SqlExecutor, orgId: string, lock: boolean): Promise<void> {
  const on = lock
    ? await lockAndCheckOrgFeature(runner, orgId, "projects")
    : await orgFeatureEnabled(orgId, "projects", runner);
  if (!on) {
    throw new BudgetBaselineError("Projects are turned off — turn them on in Company Settings → Features", 404);
  }
}

async function requireProject(
  runner: SqlExecutor,
  orgId: string,
  projectId: string,
  scope: ReadonlySet<string> | null,
  lock: "none" | "update",
): Promise<{ id: string; name: string; contract_value: string | null }> {
  if (!isUuid(projectId)) throw new BudgetBaselineError("Project not found", 404);
  const row = (
    await runner.execute<{ id: string; name: string; contract_value: string | null }>(sql`
      select id, name, contract_value::text as contract_value from projects
       where id = ${projectId} and org_id = ${orgId}
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope)}
       ${lock === "update" ? sql`for update` : sql``}`)
  ).rows[0];
  if (!row) throw new BudgetBaselineError("Project not found", 404);
  return row;
}

function nonNegativeMoney(value: string, what: string): string {
  let normalized: string;
  try {
    normalized = normalizeMoney(value);
  } catch {
    throw new BudgetBaselineError(`${what} is not an amount`, 422, "lines");
  }
  if (cmp(normalized, "0") < 0) throw new BudgetBaselineError(`${what} cannot be negative`, 422, "lines");
  return normalized;
}

/** The current work breakdown as baseline components, one per task. */
async function snapshotTaskLines(runner: SqlExecutor, orgId: string, projectId: string): Promise<BaselineLineInput[]> {
  const rows = (
    await runner.execute<{
      id: string; code: string | null; name: string;
      estimated_hours: string | null; estimated_cost: string | null; estimated_price: string | null;
      budget_quantity: string | null; budget_unit: string | null;
    }>(sql`
      select id, code, name,
             estimated_hours::text as estimated_hours, estimated_cost::text as estimated_cost,
             estimated_price::text as estimated_price,
             budget_quantity::text as budget_quantity, budget_unit
        from project_tasks
       where org_id = ${orgId} and project_id = ${projectId}
       order by code nulls last, name, id
       for share`)
  ).rows;
  return rows.map((row) => ({
    projectTaskId: row.id,
    taskCode: row.code,
    taskName: row.name,
    hours: row.estimated_hours ?? "0",
    quantity: row.budget_quantity,
    unit: row.budget_unit,
    cost: row.estimated_cost ?? "0",
    price: row.estimated_price ?? "0",
  }));
}

/**
 * Capture a baseline inside the caller's tenant transaction. The project row
 * lock serializes captures, so sequence numbers never collide and exactly one
 * capture becomes the original.
 */
export async function captureBudgetBaselineInTransaction(
  runner: SqlExecutor,
  ctx: BudgetBaselineContext,
  input: CaptureBaselineInput,
): Promise<BudgetBaselineSummary> {
  await requireProjectsOn(runner, ctx.orgId, true);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 8) {
    throw new BudgetBaselineError("Give a reason of at least 8 characters for this baseline", 422, "reason");
  }
  if (reason.length > 1000) throw new BudgetBaselineError("The reason must be 1,000 characters or fewer", 422, "reason");
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label.length > 120) throw new BudgetBaselineError("The label must be 120 characters or fewer", 422, "label");
  await requireProject(runner, ctx.orgId, input.projectId, ctx.allowedSubsidiaryIds, "update");

  const sequence = Number(
    (
      await runner.execute<{ next: number }>(sql`
        select coalesce(max(sequence), 0) + 1 as next from project_budget_baselines
         where org_id = ${ctx.orgId} and project_id = ${input.projectId}`)
    ).rows[0]?.next ?? 1,
  );
  const kind = sequence === 1 ? "original" : "revised";

  const lines = input.lines ?? (await snapshotTaskLines(runner, ctx.orgId, input.projectId));
  if (lines.length === 0) {
    throw new BudgetBaselineError("Add tasks to the work breakdown before setting a baseline", 422, "lines");
  }
  const taskIds = [...new Set(lines.map((line) => line.projectTaskId))];
  if (taskIds.some((id) => !isUuid(id))) throw new BudgetBaselineError("A baseline line names an unknown task", 422, "lines");
  const owned = (
    await runner.execute<{ id: string }>(sql`
      select id from project_tasks
       where org_id = ${ctx.orgId} and project_id = ${input.projectId}
         and id = any(${`{${taskIds.join(",")}}`}::uuid[])`)
  ).rows.length;
  if (owned !== taskIds.length) throw new BudgetBaselineError("A baseline line names a task outside this project", 422, "lines");

  const normalized = lines.map((line, index) => {
    const what = `Baseline line ${index + 1}`;
    const hours = decimal8Units(line.hours);
    if (hours < 0n) throw new BudgetBaselineError(`${what} hours cannot be negative`, 422, "lines");
    const hasQuantity = line.quantity != null && line.quantity !== "";
    if (hasQuantity !== (line.unit != null && line.unit !== "")) {
      throw new BudgetBaselineError(`${what} needs both a production quantity and its unit, or neither`, 422, "lines");
    }
    if (hasQuantity && decimal8Units(line.quantity!) <= 0n) {
      throw new BudgetBaselineError(`${what} production quantity must be more than zero`, 422, "lines");
    }
    return {
      ...line,
      hours: sumDecimal8([line.hours]),
      quantity: hasQuantity ? sumDecimal8([line.quantity!]) : null,
      unit: hasQuantity ? line.unit!.trim() : null,
      cost: nonNegativeMoney(line.cost, `${what} cost`),
      price: nonNegativeMoney(line.price, `${what} price`),
    };
  });
  const totals = {
    hours: sumDecimal8(normalized.map((line) => line.hours)),
    cost: sum(normalized.map((line) => line.cost)),
    price: sum(normalized.map((line) => line.price)),
  };
  const resolvedLabel = label || (kind === "original" ? "Original budget" : `Revision ${sequence - 1}`);
  const sourceDocumentId = input.sourceDocumentId ?? null;
  if (sourceDocumentId !== null) {
    const source = await runner.execute(sql`
      select 1 from documents where id = ${sourceDocumentId} and org_id = ${ctx.orgId}`);
    if (!source.rows[0]) throw new BudgetBaselineError("The source quote was not found", 404);
  }

  const header = (
    await runner.execute<{ id: string }>(sql`
      insert into project_budget_baselines
        (org_id, project_id, kind, sequence, label, reason, source_document_id,
         total_hours, total_cost, total_price, created_by, updated_by)
      values (${ctx.orgId}, ${input.projectId}, ${kind}, ${sequence}, ${resolvedLabel}, ${reason},
              ${sourceDocumentId}, ${totals.hours}, ${totals.cost}, ${totals.price}, ${ctx.actorId}, ${ctx.actorId})
      returning id`)
  ).rows[0];
  if (!header) throw new BudgetBaselineError("The baseline was not recorded", 409);
  const inserted = await runner.execute(sql`
    insert into project_budget_baseline_lines
      (org_id, baseline_id, project_id, project_task_id, sequence, task_code, task_name,
       source_line_id, item_id, description, hours, quantity, unit, cost, price, created_by)
    values ${sql.join(
      normalized.map((line, index) => sql`(
        ${ctx.orgId}, ${header.id}, ${input.projectId}, ${line.projectTaskId}, ${index + 1},
        ${line.taskCode}, ${line.taskName}, ${line.sourceLineId ?? null}, ${line.itemId ?? null},
        ${line.description ?? null}, ${line.hours}, ${line.quantity}, ${line.unit}, ${line.cost}, ${line.price},
        ${ctx.actorId})`),
      sql`, `,
    )}`);
  if ((inserted.rowCount ?? 0) !== normalized.length) {
    throw new BudgetBaselineError("The baseline lines were not all recorded", 409);
  }
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${ctx.orgId}, 'project_budget_baselines', ${header.id}, 'insert',
            ${JSON.stringify({
              before: null,
              after: {
                projectId: input.projectId,
                kind,
                sequence,
                label: resolvedLabel,
                sourceDocumentId,
                totalHours: totals.hours,
                totalCost: totals.cost,
                totalPrice: totals.price,
                lineCount: normalized.length,
              },
              reason,
            })}::jsonb, ${ctx.actorId})`);

  const row = (
    await runner.execute<SummaryRow>(sql`
      select ${SUMMARY_COLUMNS}
        from project_budget_baselines b
        left join documents d on d.id = b.source_document_id and d.org_id = b.org_id
       where b.org_id = ${ctx.orgId} and b.id = ${header.id}`)
  ).rows[0];
  if (!row) throw new BudgetBaselineError("The baseline was not recorded", 409);
  return summary(row);
}

/** Capture a baseline in its own tenant transaction. */
export async function captureBudgetBaseline(
  ctx: BudgetBaselineContext,
  input: CaptureBaselineInput,
): Promise<BudgetBaselineSummary> {
  return withOrgTransaction(ctx.orgId, () => captureBudgetBaselineInTransaction(db, ctx, input));
}

async function baselineSummaries(runner: SqlExecutor, orgId: string, projectId: string): Promise<BudgetBaselineSummary[]> {
  return (
    await runner.execute<SummaryRow>(sql`
      select ${SUMMARY_COLUMNS}
        from project_budget_baselines b
        left join documents d on d.id = b.source_document_id and d.org_id = b.org_id
       where b.org_id = ${orgId} and b.project_id = ${projectId}
       order by b.sequence`)
  ).rows.map(summary);
}

/**
 * Run a multi-statement project read in one consistent view. Inside a tenant
 * transaction the read joins it, so a caller holding the project header lock
 * (the project page) keeps that guarantee; otherwise it opens its own
 * read-only repeatable-read snapshot.
 */
async function projectReadSnapshot<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const active = orgContext.getStore();
  if (active?.txDb && !active.bypass) {
    if (orgId !== active.orgId) throw new Error("cannot change organization inside an active tenant transaction");
    return fn();
  }
  return withOrgTransaction(orgId, fn, { isolationLevel: "REPEATABLE READ", readOnly: true });
}

/** Every baseline of a project, oldest first. */
export async function listBudgetBaselines(
  orgId: string,
  projectId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<BudgetBaselineSummary[]> {
  return projectReadSnapshot(orgId, async () => {
    await requireProjectsOn(db, orgId, false);
    await requireProject(db, orgId, projectId, allowedSubsidiaryIds, "none");
    return baselineSummaries(db, orgId, projectId);
  });
}

/** One baseline with its components. */
export async function readBudgetBaseline(
  orgId: string,
  projectId: string,
  baselineId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ baseline: BudgetBaselineSummary; lines: BudgetBaselineLine[] }> {
  if (!isUuid(baselineId)) throw new BudgetBaselineError("Baseline not found", 404);
  return projectReadSnapshot(orgId, async () => {
    await requireProjectsOn(db, orgId, false);
    await requireProject(db, orgId, projectId, allowedSubsidiaryIds, "none");
    const header = (await baselineSummaries(db, orgId, projectId)).find((b) => b.id === baselineId);
    if (!header) throw new BudgetBaselineError("Baseline not found", 404);
    const lines = (
      await db.execute<{
        id: string; sequence: number; project_task_id: string; task_code: string | null; task_name: string;
        source_line_id: string | null; item_id: string | null; description: string | null;
        hours: string; quantity: string | null; unit: string | null; cost: string; price: string;
      }>(sql`
        select id, sequence, project_task_id, task_code, task_name, source_line_id, item_id, description,
               hours::text as hours, quantity::text as quantity, unit, cost::text as cost, price::text as price
          from project_budget_baseline_lines
         where org_id = ${orgId} and baseline_id = ${baselineId}
         order by sequence`)
    ).rows;
    return {
      baseline: header,
      lines: lines.map((line) => ({
        id: line.id,
        sequence: Number(line.sequence),
        projectTaskId: line.project_task_id,
        taskCode: line.task_code,
        taskName: line.task_name,
        sourceLineId: line.source_line_id,
        itemId: line.item_id,
        description: line.description,
        hours: line.hours,
        quantity: line.quantity,
        unit: line.unit,
        cost: normalizeMoney(line.cost),
        price: normalizeMoney(line.price),
      })),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Budget versus actual                                                */
/* ------------------------------------------------------------------ */

export interface BudgetFigures {
  /** Four-decimal hours. */
  hours: string;
  cost: string;
  price: string;
}

export interface ActualFigures {
  hours: string;
  laborCost: string;
  otherCost: string;
  cost: string;
}

export interface BudgetComparisonRow {
  /** Null for the bucket of actuals recorded without a task. */
  taskId: string | null;
  code: string | null;
  name: string;
  status: string | null;
  /** Null when the task is not part of the original baseline. */
  original: BudgetFigures | null;
  current: BudgetFigures;
  actual: ActualFigures;
  /** Budget minus actual: positive is budget remaining, negative is overrun. */
  variance: {
    hoursToOriginal: string | null;
    costToOriginal: string | null;
    hoursToCurrent: string;
    costToCurrent: string;
  };
}

export interface BudgetComparison {
  projectId: string;
  projectName: string;
  /** Actual hours and cost are counted through this date. */
  asOf: string;
  original: BudgetBaselineSummary | null;
  latest: BudgetBaselineSummary | null;
  baselineCount: number;
  rows: BudgetComparisonRow[];
  /** Actuals recorded on the project without a task. */
  unassigned: ActualFigures;
  totals: {
    original: BudgetFigures | null;
    current: BudgetFigures;
    actual: ActualFigures;
    variance: BudgetComparisonRow["variance"];
  };
  price: {
    original: string | null;
    current: string;
    contractValue: string | null;
    /** Invoiced to date per the project's financial profile (all dates); null when not requested. */
    invoicedToDate: string | null;
  };
}

/** Posted document kinds whose project lines are job cost; a vendor credit subtracts. */
const COST_DOCUMENT_KINDS = ["vendor_bill", "vendor_credit", "expense_report", "card_charge", "check", "project_charge"];

const ZERO_ACTUAL: ActualFigures = { hours: "0.0000", laborCost: "0.0000", otherCost: "0.0000", cost: "0.0000" };

function hours4(value: string | null | undefined): string {
  return decimal8ToFour(decimal8Units(value ?? "0"));
}

function addActual(a: ActualFigures, b: ActualFigures): ActualFigures {
  return {
    hours: add(a.hours, b.hours),
    laborCost: add(a.laborCost, b.laborCost),
    otherCost: add(a.otherCost, b.otherCost),
    cost: add(a.cost, b.cost),
  };
}

function addBudget(a: BudgetFigures, b: BudgetFigures): BudgetFigures {
  return { hours: add(a.hours, b.hours), cost: add(a.cost, b.cost), price: add(a.price, b.price) };
}

function variance(original: BudgetFigures | null, current: BudgetFigures, actual: ActualFigures): BudgetComparisonRow["variance"] {
  return {
    hoursToOriginal: original ? add(original.hours, neg(actual.hours)) : null,
    costToOriginal: original ? add(original.cost, neg(actual.cost)) : null,
    hoursToCurrent: add(current.hours, neg(actual.hours)),
    costToCurrent: add(current.cost, neg(actual.cost)),
  };
}

/**
 * Budget versus actual for one project, by task: the original (sold)
 * baseline, the current working budget, and actual hours and cost through
 * `asOf`. Labor is approved time at its cost rate; other cost is posted
 * job-cost document lines (converted at each document's rate). Actuals
 * recorded without a task, or against a task of another project, land in
 * the unassigned bucket so the totals still tie to everything recorded.
 * One read-only snapshot covers the whole comparison.
 */
export async function projectBudgetComparison(
  orgId: string,
  projectId: string,
  options: {
    asOf?: string | null;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
    /** Resolve invoiced to date through the native financials (default true). */
    includeInvoiced?: boolean;
  },
): Promise<BudgetComparison> {
  if (options.asOf != null && options.asOf !== "" && !isIsoCalendarDate(options.asOf)) {
    throw new BudgetBaselineError("The as-of date must be a calendar date (YYYY-MM-DD)", 422, "asOf");
  }
  return projectReadSnapshot(orgId, async () => {
    await requireProjectsOn(db, orgId, false);
    const project = await requireProject(db, orgId, projectId, options.allowedSubsidiaryIds, "none");
    const asOf = options.asOf || (await businessTodayInTx(db, orgId));
    const baselines = await baselineSummaries(db, orgId, projectId);
    const original = baselines.find((b) => b.sequence === 1) ?? null;
    const latest = baselines.length > 1 ? baselines[baselines.length - 1]! : null;

    const tasks = (
      await db.execute<{
        id: string; code: string | null; name: string; status: string;
        estimated_hours: string | null; estimated_cost: string | null; estimated_price: string | null;
      }>(sql`
        select id, code, name, status, estimated_hours::text as estimated_hours,
               estimated_cost::text as estimated_cost, estimated_price::text as estimated_price
          from project_tasks
         where org_id = ${orgId} and project_id = ${projectId}
         order by code nulls last, name, id`)
    ).rows;
    const originalByTask = new Map<string, BudgetFigures>();
    if (original) {
      const rows = (
        await db.execute<{ task_id: string; hours: string; cost: string; price: string }>(sql`
          select project_task_id as task_id, sum(hours)::text as hours,
                 sum(cost)::text as cost, sum(price)::text as price
            from project_budget_baseline_lines
           where org_id = ${orgId} and baseline_id = ${original.id}
           group by project_task_id`)
      ).rows;
      for (const row of rows) {
        originalByTask.set(row.task_id, { hours: hours4(row.hours), cost: normalizeMoney(row.cost), price: normalizeMoney(row.price) });
      }
    }
    const labor = (
      await db.execute<{ task_id: string | null; hours: string; cost: string }>(sql`
        select te.project_task_id as task_id,
               coalesce(sum(te.hours), 0)::text as hours,
               coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)), 0)::text as cost
          from time_entries te
         where te.org_id = ${orgId} and te.project_id = ${projectId}
           and te.status = 'approved' and te.worked_on <= ${asOf}::date
         group by te.project_task_id`)
    ).rows;
    const other = (
      await db.execute<{ task_id: string | null; cost: string }>(sql`
        select dl.project_task_id as task_id,
               coalesce(sum(round(
                 (case when d.kind = 'project_charge' then coalesce(dl.cost_amount, dl.amount)
                       else ${signedDocumentAmount(sql`d.kind`, sql`dl.amount`)} end) * d.fx_rate, 4)), 0)::text as cost
          from document_lines dl
          join documents d on d.id = dl.document_id and d.org_id = dl.org_id
         where dl.org_id = ${orgId}
           and coalesce(dl.project_id, d.project_id) = ${projectId}
           and d.status = 'posted'
           and d.kind in (${sql.join(COST_DOCUMENT_KINDS.map((kind) => sql`${kind}`), sql`, `)})
           and dl.time_entry_id is null
           and coalesce(d.posting_date, d.document_date) <= ${asOf}::date
         group by dl.project_task_id`)
    ).rows;

    const taskIds = new Set(tasks.map((task) => task.id));
    const actualByTask = new Map<string, ActualFigures>();
    let unassigned: ActualFigures = { ...ZERO_ACTUAL };
    const credit = (taskId: string | null, figures: ActualFigures) => {
      if (taskId && taskIds.has(taskId)) actualByTask.set(taskId, addActual(actualByTask.get(taskId) ?? ZERO_ACTUAL, figures));
      else unassigned = addActual(unassigned, figures);
    };
    for (const row of labor) {
      const cost = normalizeMoney(row.cost);
      credit(row.task_id, { hours: hours4(row.hours), laborCost: cost, otherCost: "0.0000", cost });
    }
    for (const row of other) {
      const cost = normalizeMoney(row.cost);
      credit(row.task_id, { hours: "0.0000", laborCost: "0.0000", otherCost: cost, cost });
    }

    const rows: BudgetComparisonRow[] = tasks.map((task) => {
      const current: BudgetFigures = {
        hours: hours4(task.estimated_hours),
        cost: normalizeMoney(task.estimated_cost ?? "0"),
        price: normalizeMoney(task.estimated_price ?? "0"),
      };
      const originalFigures = original ? originalByTask.get(task.id) ?? null : null;
      const actual = actualByTask.get(task.id) ?? { ...ZERO_ACTUAL };
      return {
        taskId: task.id,
        code: task.code,
        name: task.name,
        status: task.status,
        original: originalFigures,
        current,
        actual,
        variance: variance(originalFigures, current, actual),
      };
    });

    const zeroBudget: BudgetFigures = { hours: "0.0000", cost: "0.0000", price: "0.0000" };
    const currentTotal = rows.reduce((acc, row) => addBudget(acc, row.current), zeroBudget);
    const originalTotal = original
      ? [...originalByTask.values()].reduce((acc, figures) => addBudget(acc, figures), zeroBudget)
      : null;
    const actualTotal = rows.reduce((acc, row) => addActual(acc, row.actual), unassigned);

    // Invoiced to date is the native financials measure: one definition of
    // what counts as invoiced, governed by the project type's profile.
    let invoicedToDate: string | null = null;
    if (options.includeInvoiced !== false) {
      const projectType = await loadProjectType(orgId, projectId, asOf);
      const financials = await resolveProjectFinancials(orgId, projectId, projectType.financialProfile);
      invoicedToDate = normalizeMoney(String(financials.measures.invoiced_to_date ?? "0"));
    }

    return {
      projectId,
      projectName: project.name,
      asOf,
      original,
      latest,
      baselineCount: baselines.length,
      rows,
      unassigned,
      totals: {
        original: originalTotal,
        current: currentTotal,
        actual: actualTotal,
        variance: variance(originalTotal, currentTotal, actualTotal),
      },
      price: {
        original: original ? original.totalPrice : null,
        current: currentTotal.price,
        contractValue: project.contract_value === null ? null : normalizeMoney(project.contract_value),
        invoicedToDate,
      },
    };
  });
}
