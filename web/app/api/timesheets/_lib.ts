import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add } from '@openbooks/engine/src/money.ts'
import {
  lockReasonsFor,
  weekLockReasons,
  type EntryProvenance,
  type LockReason,
} from '../../../lib/time-lifecycle'

/**
 * Weekly-timesheet server helpers. A "timesheet" is not a table — it's the set
 * of `time_entries` for one employee across one Sunday→Saturday week. These
 * helpers turn that flat set of per-day rows into the grid shape the editor
 * wants (one line per distinct project+item+timeType+department+memo+billable,
 * with seven day columns) and back, plus the pickers the editor needs.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** True for a well-formed ISO date string (YYYY-MM-DD). */
export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v)
}

/** Format a UTC-noon Date as an ISO date string (YYYY-MM-DD). */
function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Parse an ISO date as a UTC-noon Date (noon avoids any TZ day-shift). */
function parseIso(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
}

/**
 * Normalize any ISO date to the Sunday that starts its week. Weeks run
 * Sunday→Saturday. Given a non-Sunday, walk back to Sunday.
 */
export function weekStart(iso: string): string {
  const d = parseIso(iso)
  const dow = d.getUTCDay() // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - dow)
  return toIso(d)
}

/** The current week's Sunday, as an ISO date string. */
export function currentWeekStart(): string {
  const now = new Date()
  return weekStart(toIso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12))))
}

/** The seven ISO dates Sun…Sat for the week that `sundayIso` starts. */
export function weekWindow(sundayIso: string): string[] {
  const sunday = weekStart(sundayIso)
  const base = parseIso(sunday)
  const out: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(base)
    d.setUTCDate(d.getUTCDate() + i)
    out.push(toIso(d))
  }
  return out
}

export type WeekStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'empty'

/** A single grid line: a distinct time key + its seven day-hour cells. */
/** Stable key for a line's custom values — key order must not split a row. */
export function customKey(custom: Record<string, unknown> | null | undefined): string {
  if (!custom) return ''
  const keys = Object.keys(custom).filter((k) => custom[k] !== null && custom[k] !== '').sort()
  if (keys.length === 0) return ''
  return JSON.stringify(keys.map((k) => [k, custom[k]]))
}

export interface WeekRow {
  projectId: string | null
  itemId: string | null
  timeTypeId: string | null
  departmentId: string | null
  isBillable: boolean
  memo: string | null
  /** hours[0]=Sunday … hours[6]=Saturday, as decimal strings ('' = none). */
  hours: string[]
  /** The most locked status among this line's entries (blocks editing). */
  entryStatuses: string[]
  /** Org-defined line field values (time_entries.custom). Part of the row's
   * identity: two entries alike but for a custom value are different lines. */
  custom: Record<string, unknown>
}

export interface WeekPayload {
  employeeId: string | null
  week: string
  days: string[]
  rows: WeekRow[]
  status: WeekStatus
  /** True when any entry in the week is approved (those must not be overwritten). */
  hasApproved: boolean
  /** Downstream consumers pinning this week (empty when nothing holds it). */
  lockReasons: LockReason[]
  /** How many entries are pinned — drives "3 of 12 entries" style messages. */
  lockedCount: number
  /** The approver's note when the week was bounced back. */
  rejectionReason: string | null
  /** The header row's id — what an approval flow names as its subject. */
  weekId: string | null
}

/**
 * Aggregate the week's entries into a single status: any approved-and-nothing-
 * looser reads "approved"; any submitted reads "submitted"; any rejected reads
 * "rejected"; else "draft"; no entries → "empty". Mirrors the spec's aggregate
 * rule (all approved → approved; any submitted → submitted; else draft) with
 * rejected surfaced so the user sees a bounce-back.
 */
export function aggregateStatus(statuses: string[]): WeekStatus {
  if (statuses.length === 0) return 'empty'
  if (statuses.every((s) => s === 'approved')) return 'approved'
  if (statuses.some((s) => s === 'submitted')) return 'submitted'
  if (statuses.some((s) => s === 'rejected')) return 'rejected'
  return 'draft'
}

/**
 * Load one employee's week as grid rows. Groups the flat entries by the time
 * key (project+item+timeType+department+memo+billable) and spreads each entry's
 * hours into the matching day column.
 */
export async function loadWeek(
  orgId: string,
  employeeId: string,
  sundayIso: string,
): Promise<WeekPayload> {
  const days = weekWindow(sundayIso)
  const week = days[0]
  // The header owns the week's lifecycle. It is created on demand so a week
  // that has never been touched still reads consistently.
  const header = await ensureTimesheetWeek(orgId, employeeId, week)
  const dayIndex = new Map(days.map((d, i) => [d, i]))

  const res = (await db.execute<{
      worked_on: string
      hours: string
      time_type_id: string | null
      item_id: string | null
      project_id: string | null
      department_id: string | null
      memo: string | null
      is_billable: boolean
      status: string
      custom: Record<string, unknown> | null
      rejection_reason: string | null
      invoiced_by_line_id: string | null
      payroll_batch_ref: string | null
      cost_journal_entry_id: string | null
      field_ticket_id: string | null
    }>(sql`
    select id, worked_on, hours, time_type_id, item_id, project_id,
           department_id, memo, is_billable, status, custom, rejection_reason,
           invoiced_by_line_id, payroll_batch_ref, cost_journal_entry_id,
           field_ticket_id
      from time_entries
     where org_id = ${orgId}
       and employee_party_id = ${employeeId}
       and worked_on >= ${days[0]} and worked_on <= ${days[6]}
     order by created_at, id
  `))
  const provenance: EntryProvenance[] = res.rows.map((r) => ({
    invoicedByLineId: r.invoiced_by_line_id,
    payrollBatchRef: r.payroll_batch_ref,
    costJournalEntryId: r.cost_journal_entry_id,
    fieldTicketId: r.field_ticket_id,
  }))

  const byKey = new Map<string, WeekRow>()
  const allStatuses: string[] = []
  for (const r of res.rows) {
    allStatuses.push(r.status)
    const key = [
      r.project_id ?? '',
      r.item_id ?? '',
      r.time_type_id ?? '',
      r.department_id ?? '',
      r.is_billable ? '1' : '0',
      r.memo ?? '',
      customKey(r.custom),
    ].join('|')
    let row = byKey.get(key)
    if (!row) {
      row = {
        projectId: r.project_id,
        itemId: r.item_id,
        timeTypeId: r.time_type_id,
        departmentId: r.department_id,
        isBillable: r.is_billable,
        memo: r.memo,
        hours: ['', '', '', '', '', '', ''],
        entryStatuses: [],
        custom: r.custom ?? {},
      }
      byKey.set(key, row)
    }
    const idx = dayIndex.get(r.worked_on)
    if (idx != null) {
      row.hours[idx] = add(row.hours[idx] === '' ? '0' : row.hours[idx], String(r.hours))
    }
    row.entryStatuses.push(r.status)
  }

  return {
    employeeId,
    week,
    days,
    rows: Array.from(byKey.values()),
    // Status is the header's, not a fold over the entries: a week with no
    // hours yet is 'draft' (a real, submittable record), and 'empty' is
    // reserved for describing that it carries nothing.
    status: allStatuses.length === 0 && header.status === 'draft' ? 'empty' : header.status,
    hasApproved: allStatuses.some((s) => s === 'approved'),
    lockReasons: weekLockReasons(provenance),
    lockedCount: provenance.filter((e) => lockReasonsFor(e).length > 0).length,
    rejectionReason: header.rejectionReason,
    weekId: header.id,
  }
}

/**
 * The week's header row, created on demand.
 *
 * A week becomes a record the first time anyone touches it, so the id an
 * approval flow needs exists before it is needed. Idempotent: concurrent
 * saves race to the same unique (org, employee, week) and the loser reads the
 * winner's row rather than failing.
 *
 * A header created now must inherit the state of the hours it covers, not
 * assume they are new. Time arrives from imports and connectors as well as the
 * editor, so a week can hold approved hours long before anyone opens it — and
 * defaulting such a header to 'draft' would report approved time as unsubmitted
 * and re-offer it for approval.
 */
export async function ensureTimesheetWeek(
  orgId: string,
  employeePartyId: string,
  weekStartIso: string,
  actorId?: string | null,
): Promise<{ id: string; status: WeekStatus; rejectionReason: string | null }> {
  const week = weekStart(weekStartIso)
  const inserted = (await db.execute<{ id: string; status: WeekStatus; rejection_reason: string | null }>(sql`
    insert into timesheet_weeks
      (org_id, employee_party_id, week_start, status,
       approved_by, approved_at, rejection_reason, created_by, updated_by)
    select ${orgId}, ${employeePartyId}, ${week}::date,
           coalesce(seed.status, 'draft'), seed.approved_by, seed.approved_at,
           seed.rejection_reason, ${actorId ?? null}, ${actorId ?? null}
      from (
        select case
                 when count(*) = 0 then null
                 when bool_and(te.status = 'approved') then 'approved'
                 when bool_or(te.status = 'submitted') then 'submitted'
                 when bool_or(te.status = 'rejected') then 'rejected'
                 else 'draft'
               end as status,
               (array_agg(te.approved_by) filter (where te.approved_by is not null))[1] as approved_by,
               max(te.approved_at) as approved_at,
               (array_agg(te.rejection_reason) filter (where te.rejection_reason is not null))[1] as rejection_reason
          from time_entries te
         where te.org_id = ${orgId}
           and te.employee_party_id = ${employeePartyId}
           and te.worked_on >= ${week}::date
           and te.worked_on <= ${week}::date + 6
      ) seed
    on conflict (org_id, employee_party_id, week_start) do nothing
    returning id, status, rejection_reason
  `))
  const row = inserted.rows[0]
    ?? ((await db.execute<{ id: string; status: WeekStatus; rejection_reason: string | null }>(sql`
      select id, status, rejection_reason from timesheet_weeks
       where org_id = ${orgId} and employee_party_id = ${employeePartyId}
         and week_start = ${week}
    `))).rows[0]
  return { id: row.id, status: row.status, rejectionReason: row.rejection_reason }
}

/** Move a week's header to a new status, stamping the matching audit columns. */
export async function setTimesheetWeekStatus(
  orgId: string,
  employeePartyId: string,
  weekStartIso: string,
  status: WeekStatus,
  actorId: string,
  rejectionReason?: string | null,
): Promise<void> {
  const week = weekStart(weekStartIso)
  // Explicit casts: an untyped `null` in a CASE makes postgres infer text for
  // the whole expression, which a uuid column rejects.
  await db.execute(sql`
    update timesheet_weeks
       set status = ${status},
           submitted_by = case when ${status} = 'submitted'
                               then ${actorId}::uuid else submitted_by end,
           submitted_at = case when ${status} = 'submitted'
                               then now() else submitted_at end,
           approved_by = case when ${status} = 'approved'
                              then ${actorId}::uuid else null::uuid end,
           approved_at = case when ${status} = 'approved'
                              then now() else null::timestamptz end,
           rejection_reason = ${rejectionReason ?? null}::text,
           updated_by = ${actorId}::uuid, updated_at = now()
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}
       and week_start = ${week}::date`)
}

export interface PickerOption {
  value: string
  label: string
}
export interface TimeTypeOption extends PickerOption {
  costMultiplier: string
  isBillableDefault: boolean
}

export interface TimesheetPickers {
  employees: PickerOption[]
  projects: PickerOption[]
  items: PickerOption[]
  timeTypes: TimeTypeOption[]
  departments: PickerOption[]
}

/**
 * Load every picker the weekly editor needs, for one org.
 *
 * `includeEmployeeId` keeps a specific employee in the list even when they are
 * inactive or no longer hold an employee role. Their historical weeks are still
 * viewable, and without this the picker would have no option matching the
 * timesheet's own employee and would render blank.
 */
export async function loadPickers(
  orgId: string,
  includeEmployeeId?: string | null,
): Promise<TimesheetPickers> {
  const [employees, projects, items, timeTypes, departments] = (await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select p.id, coalesce(p.display_name, '') as label,
             (p.is_active and exists (
               select 1 from employee_roles r
                where r.party_id = p.id and r.org_id = ${orgId} and r.is_active
             )) as currently_active
        from parties p
       where p.org_id = ${orgId}
         and (
           (p.is_active and exists (
             select 1 from employee_roles r
              where r.party_id = p.id and r.org_id = ${orgId} and r.is_active
           ))
           or p.id = ${includeEmployeeId ?? null}
         )
       order by p.display_name`),
    db.execute<Record<string, unknown>>(sql`
      select id, code, name from projects
       where org_id = ${orgId} and is_active order by name`),
    db.execute<Record<string, unknown>>(sql`
      select id, code, name from items
       where org_id = ${orgId} and is_active
         and kind in ('service', 'labor', 'other_charge')
       order by name`),
    db.execute<Record<string, unknown>>(sql`
      select id, name, cost_multiplier, is_billable_default from time_types
       where org_id = ${orgId} and is_active order by cost_multiplier`),
    db.execute<Record<string, unknown>>(sql`
      select id, code, name from departments
       where org_id = ${orgId} and is_active order by name`),
  ]))

  const withCode = (r: Record<string, unknown>): PickerOption => ({
    value: String(r.id),
    label: r.code ? `${r.code} · ${r.name as string}` : (r.name as string),
  })

  return {
    employees: employees.rows.map((r) => ({
      value: String(r.id),
      label: ((r.label as string) || '(unnamed)') + (r.currently_active ? '' : ' (inactive)'),
    })),
    projects: projects.rows.map(withCode),
    items: items.rows.map(withCode),
    timeTypes: timeTypes.rows.map((r) => ({
      value: String(r.id),
      label: r.name as string,
      costMultiplier: String(r.cost_multiplier),
      isBillableDefault: r.is_billable_default === true,
    })),
    departments: departments.rows.map(withCode),
  }
}

/** Resolve the employee party a user should default to, if any (users.party_id). */
export async function userEmployeeId(orgId: string, userId: string): Promise<string | null> {
  const r = (await db.execute<{ party_id: string | null }>(sql`
    select party_id from users where id = ${userId} and org_id = ${orgId}
  `))
  return r.rows[0]?.party_id ?? null
}
