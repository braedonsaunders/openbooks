import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { pgTextArrayLiteral } from "../platform/pg-array.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";

/**
 * Installed-quantity progress per project task.
 *
 * project_progress_entries is an append-only ledger: an entry is never
 * edited or deleted, and a correction appends exactly one reversing entry.
 * Quantities are recorded in the task's budget unit against a task that
 * carries a budgeted quantity, so installed ÷ budget is always a like-for-like
 * ratio. Manual entries are dated no later than the organization's business
 * day; field-ticket production is recorded when the ticket is approved and
 * reversed when the ticket is voided.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QUANTITY_SCALE = 8;
const NOTE_MAX = 500;

export const PROGRESS_FEATURE_REMEDY =
  "turn on Progress tracking under Projects in Company Settings → Features";
export const PROGRESS_BUDGET_REMEDY = "set a budgeted quantity on the task in Work breakdown";

export type ProjectProgressRefusalCode =
  | "feature-disabled"
  | "not-found"
  | "invalid"
  | "no-budget-quantity"
  | "unit-mismatch"
  | "future-date"
  | "already-reversed"
  | "not-reversible";

/** A business refusal with its supported remedy; safe to show the operator. */
export class ProjectProgressError extends Error {
  override readonly name = "ProjectProgressError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: ProjectProgressRefusalCode,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

export interface ProgressEntry {
  id: string;
  projectId: string;
  taskId: string;
  taskCode: string | null;
  taskName: string;
  entryDate: string;
  quantity: string;
  unit: string;
  source: "manual" | "field_ticket";
  sourceDocumentId: string | null;
  sourceDocumentNumber: string | null;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface ProgressTask {
  id: string;
  projectId: string;
  code: string | null;
  name: string;
  budgetQuantity: string | null;
  budgetUnit: string | null;
}

function scopeFilter(allowedSubsidiaryIds: ReadonlySet<string> | null | undefined): SQL {
  if (allowedSubsidiaryIds === null) return sql``;
  if (!allowedSubsidiaryIds || allowedSubsidiaryIds.size === 0) return sql`and false`;
  return sql`and p.subsidiary_id = any(${pgTextArrayLiteral([...allowedSubsidiaryIds])}::uuid[])`;
}

/** Refuse unless Progress tracking (and therefore Projects) is on, ordered against a concurrent disable. */
export async function assertProgressEnabled(executor: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(executor, orgId, "projectProgress"))) {
    throw new ProjectProgressError(
      "Progress tracking is turned off for this organization",
      409,
      "feature-disabled",
      PROGRESS_FEATURE_REMEDY,
    );
  }
}

/**
 * Lock a task of the given project for a progress write. A task of another
 * project, another organization, or outside the caller's legal entities is
 * indistinguishable from a missing one.
 */
export async function lockProgressTask(
  executor: SqlExecutor,
  orgId: string,
  projectId: string,
  taskId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ProgressTask> {
  const row = (await executor.execute<{
    id: string; project_id: string; code: string | null; name: string;
    budget_quantity: string | null; budget_unit: string | null;
  }>(sql`
    select t.id, t.project_id, t.code, t.name, t.budget_quantity::text as budget_quantity, t.budget_unit
      from project_tasks t
      join projects p on p.id = t.project_id and p.org_id = t.org_id
     where t.org_id = ${orgId} and t.id = ${taskId} and t.project_id = ${projectId}
       ${scopeFilter(allowedSubsidiaryIds)}
     for share of t, p
  `)).rows[0];
  if (!row) throw new ProjectProgressError("Task not found on this project", 404, "not-found");
  return {
    id: row.id,
    projectId: row.project_id,
    code: row.code,
    name: row.name,
    budgetQuantity: row.budget_quantity,
    budgetUnit: row.budget_unit,
  };
}

const taskLabel = (task: Pick<ProgressTask, "code" | "name">) => (task.code ? `${task.code} ${task.name}` : task.name);

/**
 * The task must measure progress in units, and the quantity must be in that
 * unit. Shared by manual entry and field-ticket production so both refuse
 * the same way.
 */
export function assertQuantityMatchesBudget(task: ProgressTask, unit: string): void {
  if (task.budgetQuantity === null || task.budgetUnit === null) {
    throw new ProjectProgressError(
      `${taskLabel(task)} has no budgeted quantity, so installed progress cannot be measured`,
      422,
      "no-budget-quantity",
      PROGRESS_BUDGET_REMEDY,
    );
  }
  if (unit.trim() !== task.budgetUnit) {
    throw new ProjectProgressError(
      `${taskLabel(task)} is budgeted in ${task.budgetUnit}; record the quantity in ${task.budgetUnit}`,
      422,
      "unit-mismatch",
      `enter the quantity in ${task.budgetUnit}, or change the task's budget unit in Work breakdown`,
    );
  }
}

/** Exact positive quantity at numeric(28,8) precision, or a named refusal. */
export function parsePositiveQuantity(value: unknown, label = "Quantity"): string {
  const exact = typeof value === "string" ? canonicalDecimal(value.trim(), QUANTITY_SCALE) : null;
  if (exact === null || compareDecimal(exact, "0") <= 0) {
    throw new ProjectProgressError(
      `${label} must be a positive number with at most ${QUANTITY_SCALE} decimal places`,
      422,
      "invalid",
    );
  }
  return exact;
}

function cleanNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? "";
  if (trimmed.length > NOTE_MAX) {
    throw new ProjectProgressError(`Note must be ${NOTE_MAX} characters or fewer`, 422, "invalid");
  }
  return trimmed || null;
}

async function insertEntry(
  executor: SqlExecutor,
  orgId: string,
  actorId: string | null,
  entry: {
    projectId: string; taskId: string; entryDate: string; quantity: string; unit: string;
    source: "manual" | "field_ticket"; sourceDocumentId: string | null; reversesEntryId: string | null;
    note: string | null;
  },
  audit: Record<string, unknown>,
): Promise<string> {
  const inserted = (await executor.execute<{ id: string }>(sql`
    insert into project_progress_entries
      (org_id, project_id, project_task_id, entry_date, quantity, unit, source,
       source_document_id, reverses_entry_id, note, created_by)
    values (${orgId}, ${entry.projectId}, ${entry.taskId}, ${entry.entryDate}, ${entry.quantity}, ${entry.unit},
            ${entry.source}, ${entry.sourceDocumentId}, ${entry.reversesEntryId}, ${entry.note}, ${actorId})
    returning id
  `)).rows[0];
  if (!inserted) throw new Error("progress entry insert returned no row");
  await executor.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'project_progress_entries', ${inserted.id}, 'insert',
            ${JSON.stringify({ ...audit, after: entry })}::jsonb, ${actorId})
  `);
  return inserted.id;
}

/**
 * Record installed quantity against a task. Refuses when Progress tracking is
 * off, when the task has no budgeted quantity, when the unit differs from the
 * budget unit, and when the date is after the organization's business day.
 */
export async function recordProgress(input: {
  orgId: string;
  actorId: string;
  projectId: string;
  taskId: string;
  entryDate: string;
  quantity: string;
  unit: string;
  note?: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<ProgressEntry> {
  if (!DATE.test(input.entryDate)) {
    throw new ProjectProgressError("Date must be YYYY-MM-DD", 422, "invalid");
  }
  const quantity = parsePositiveQuantity(input.quantity);
  const note = cleanNote(input.note);
  return withOrgTransaction(input.orgId, async () => {
    await assertProgressEnabled(db, input.orgId);
    const task = await lockProgressTask(db, input.orgId, input.projectId, input.taskId, input.allowedSubsidiaryIds);
    assertQuantityMatchesBudget(task, input.unit);
    const today = await businessTodayInTx(db, input.orgId);
    if (input.entryDate > today) {
      throw new ProjectProgressError(
        `Progress cannot be dated after today (${today})`,
        422,
        "future-date",
        "record the work on or before today's date",
      );
    }
    const id = await insertEntry(db, input.orgId, input.actorId, {
      projectId: task.projectId,
      taskId: task.id,
      entryDate: input.entryDate,
      quantity,
      unit: task.budgetUnit!,
      source: "manual",
      sourceDocumentId: null,
      reversesEntryId: null,
      note,
    }, { event: "progress_recorded" });
    return (await readEntries(db, input.orgId, sql`and e.id = ${id}`))[0]!;
  });
}

/**
 * Reverse one manual progress entry by appending its exact negation. An entry
 * reverses at most once (enforced by a unique index as well), a reversal is
 * never itself reversed, and field-ticket production is reversed only by
 * voiding its ticket so the ticket and the progress ledger cannot diverge.
 */
export async function reverseProgress(input: {
  orgId: string;
  actorId: string;
  projectId: string;
  entryId: string;
  reason: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<ProgressEntry> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > NOTE_MAX) {
    throw new ProjectProgressError(`Reason must be 3–${NOTE_MAX} characters`, 422, "invalid");
  }
  return withOrgTransaction(input.orgId, async () => {
    await assertProgressEnabled(db, input.orgId);
    const original = (await db.execute<{
      id: string; project_id: string; project_task_id: string; entry_date: string; quantity: string;
      unit: string; source: "manual" | "field_ticket"; source_document_id: string | null;
      reverses_entry_id: string | null;
    }>(sql`
      select e.id, e.project_id, e.project_task_id, e.entry_date::text as entry_date, e.quantity::text as quantity,
             e.unit, e.source, e.source_document_id, e.reverses_entry_id
        from project_progress_entries e
        join projects p on p.id = e.project_id and p.org_id = e.org_id
       where e.org_id = ${input.orgId} and e.id = ${input.entryId} and e.project_id = ${input.projectId}
         ${scopeFilter(input.allowedSubsidiaryIds)}
       for update of e
    `)).rows[0];
    if (!original) throw new ProjectProgressError("Progress entry not found", 404, "not-found");
    if (original.reverses_entry_id) {
      throw new ProjectProgressError(
        "This entry is itself a reversal and cannot be reversed",
        409,
        "not-reversible",
        "record the quantity again as a new entry",
      );
    }
    if (original.source === "field_ticket") {
      throw new ProjectProgressError(
        "Production recorded from a field ticket is reversed by voiding that ticket",
        409,
        "not-reversible",
        "void the field ticket to reverse its production",
      );
    }
    const prior = (await db.execute<{ id: string }>(sql`
      select id from project_progress_entries
       where org_id = ${input.orgId} and reverses_entry_id = ${original.id}
    `)).rows[0];
    if (prior) {
      throw new ProjectProgressError("This entry has already been reversed", 409, "already-reversed");
    }
    const today = await businessTodayInTx(db, input.orgId);
    const entryDate = today > original.entry_date ? today : original.entry_date;
    const id = await insertEntry(db, input.orgId, input.actorId, {
      projectId: original.project_id,
      taskId: original.project_task_id,
      entryDate,
      quantity: negate(original.quantity),
      unit: original.unit,
      source: original.source,
      sourceDocumentId: original.source_document_id,
      reversesEntryId: original.id,
      note: reason,
    }, { event: "progress_reversed", reason });
    return (await readEntries(db, input.orgId, sql`and e.id = ${id}`))[0]!;
  });
}

function negate(value: string): string {
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

async function readEntries(executor: SqlExecutor, orgId: string, filter: SQL): Promise<ProgressEntry[]> {
  const rows = (await executor.execute<{
    id: string; project_id: string; task_id: string; task_code: string | null; task_name: string;
    entry_date: string; quantity: string; unit: string; source: "manual" | "field_ticket";
    source_document_id: string | null; source_document_number: string | null;
    reverses_entry_id: string | null; reversed_by_entry_id: string | null; note: string | null;
    created_at: string; created_by_name: string | null;
  }>(sql`
    select e.id, e.project_id, e.project_task_id as task_id, t.code as task_code, t.name as task_name,
           e.entry_date::text as entry_date, e.quantity::text as quantity, e.unit, e.source,
           e.source_document_id, d.document_number as source_document_number,
           e.reverses_entry_id, r.id as reversed_by_entry_id, e.note,
           e.created_at::text as created_at, u.name as created_by_name
      from project_progress_entries e
      join project_tasks t on t.id = e.project_task_id and t.org_id = e.org_id
      join projects p on p.id = e.project_id and p.org_id = e.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      left join project_progress_entries r on r.reverses_entry_id = e.id and r.org_id = e.org_id
      left join users u on u.id = e.created_by
     where e.org_id = ${orgId} ${filter}
     order by e.entry_date desc, e.created_at desc, e.id desc
  `)).rows;
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskCode: row.task_code,
    taskName: row.task_name,
    entryDate: row.entry_date,
    quantity: row.quantity,
    unit: row.unit,
    source: row.source,
    sourceDocumentId: row.source_document_id,
    sourceDocumentNumber: row.source_document_number,
    reversesEntryId: row.reverses_entry_id,
    reversedByEntryId: row.reversed_by_entry_id,
    note: row.note,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
  }));
}

/** Progress history for a project (optionally one task), newest first. */
export async function listProgress(input: {
  orgId: string;
  projectId: string;
  taskId?: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<ProgressEntry[]> {
  return withOrgTransaction(input.orgId, () =>
    readEntries(db, input.orgId, sql`
      and e.project_id = ${input.projectId}
      ${input.taskId ? sql`and e.project_task_id = ${input.taskId}` : sql``}
      ${scopeFilter(input.allowedSubsidiaryIds)}
    `), { readOnly: true });
}

/**
 * Record a field ticket's production as progress, inside the approval's
 * transaction. Idempotent per ticket: production already recorded and not
 * reversed is never recorded twice, and production lines cannot change once
 * a ticket leaves draft. A task whose budget no longer matches the reported
 * unit refuses the approval with the remedy instead of recording a ratio
 * that compares different units.
 */
export async function recordFieldTicketProgressInTransaction(
  executor: SqlExecutor,
  input: { orgId: string; actorId: string; ticketId: string; projectId: string | null; entryDate: string },
): Promise<{ recorded: number; alreadyRecorded: boolean }> {
  const lines = (await executor.execute<{
    id: string; project_task_id: string; quantity: string; unit: string; note: string | null;
  }>(sql`
    select id, project_task_id, quantity::text as quantity, unit, note
      from field_ticket_quantities
     where org_id = ${input.orgId} and field_ticket_id = ${input.ticketId}
     order by created_at, id
  `)).rows;
  if (lines.length === 0) return { recorded: 0, alreadyRecorded: false };
  await assertProgressEnabled(executor, input.orgId);
  if (!input.projectId) {
    throw new ProjectProgressError(
      "This ticket reports production but has no project",
      422,
      "invalid",
      "choose the ticket's project, or remove its production lines",
    );
  }
  const live = (await executor.execute<{ count: string }>(sql`
    select count(*)::text as count
      from project_progress_entries e
     where e.org_id = ${input.orgId} and e.source = 'field_ticket'
       and e.source_document_id = ${input.ticketId} and e.reverses_entry_id is null
       and not exists (
         select 1 from project_progress_entries r
          where r.org_id = e.org_id and r.reverses_entry_id = e.id)
  `)).rows[0];
  if (Number(live?.count ?? "0") > 0) return { recorded: 0, alreadyRecorded: true };

  for (const line of lines) {
    const task = await lockProgressTask(executor, input.orgId, input.projectId, line.project_task_id, null);
    assertQuantityMatchesBudget(task, line.unit);
    await insertEntry(executor, input.orgId, input.actorId, {
      projectId: input.projectId,
      taskId: task.id,
      entryDate: input.entryDate,
      quantity: line.quantity,
      unit: line.unit,
      source: "field_ticket",
      sourceDocumentId: input.ticketId,
      reversesEntryId: null,
      note: line.note,
    }, { event: "field_ticket_production_recorded", fieldTicketQuantityId: line.id });
  }
  return { recorded: lines.length, alreadyRecorded: false };
}

/**
 * Append the exact reversal of every live production entry a field ticket
 * recorded, inside the void's transaction. Reversals keep the ledger whole
 * whatever the current Features state: they correct existing evidence and
 * write nothing new. Each reversal is dated no earlier than the entry it
 * reverses, so as-of history before the original is untouched.
 */
export async function reverseFieldTicketProgressInTransaction(
  executor: SqlExecutor,
  input: { orgId: string; actorId: string | null; ticketId: string; entryDate: string; reason: string },
): Promise<number> {
  const live = (await executor.execute<{
    id: string; project_id: string; project_task_id: string; entry_date: string; quantity: string; unit: string;
  }>(sql`
    select e.id, e.project_id, e.project_task_id, e.entry_date::text as entry_date,
           e.quantity::text as quantity, e.unit
      from project_progress_entries e
     where e.org_id = ${input.orgId} and e.source = 'field_ticket'
       and e.source_document_id = ${input.ticketId} and e.reverses_entry_id is null
       and not exists (
         select 1 from project_progress_entries r
          where r.org_id = e.org_id and r.reverses_entry_id = e.id)
     order by e.created_at, e.id
     for update of e
  `)).rows;
  for (const entry of live) {
    await insertEntry(executor, input.orgId, input.actorId, {
      projectId: entry.project_id,
      taskId: entry.project_task_id,
      entryDate: input.entryDate > entry.entry_date ? input.entryDate : entry.entry_date,
      quantity: negate(entry.quantity),
      unit: entry.unit,
      source: "field_ticket",
      sourceDocumentId: input.ticketId,
      reversesEntryId: entry.id,
      note: input.reason.slice(0, NOTE_MAX),
    }, { event: "field_ticket_production_reversed", reason: input.reason });
  }
  return live.length;
}
