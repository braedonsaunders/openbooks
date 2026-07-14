import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

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
 * Sunday→Saturday (matches adminapp2). Given a non-Sunday, walk back to Sunday.
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
}

export interface WeekPayload {
  employeeId: string | null
  week: string
  days: string[]
  rows: WeekRow[]
  status: WeekStatus
  /** True when any entry in the week is approved (those must not be overwritten). */
  hasApproved: boolean
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
  const dayIndex = new Map(days.map((d, i) => [d, i]))

  const res = (await db.execute(sql`
    select id, worked_on, hours, time_type_id, item_id, project_id,
           department_id, memo, is_billable, status
      from time_entries
     where org_id = ${orgId}
       and employee_party_id = ${employeeId}
       and worked_on >= ${days[0]} and worked_on <= ${days[6]}
     order by created_at, id
  `)) as unknown as {
    rows: {
      worked_on: string
      hours: string
      time_type_id: string | null
      item_id: string | null
      project_id: string | null
      department_id: string | null
      memo: string | null
      is_billable: boolean
      status: string
    }[]
  }

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
      }
      byKey.set(key, row)
    }
    const idx = dayIndex.get(r.worked_on)
    if (idx != null) {
      const existing = row.hours[idx] === '' ? 0 : Number(row.hours[idx])
      row.hours[idx] = (existing + Number(r.hours)).toString()
    }
    row.entryStatuses.push(r.status)
  }

  return {
    employeeId,
    week,
    days,
    rows: Array.from(byKey.values()),
    status: aggregateStatus(allStatuses),
    hasApproved: allStatuses.some((s) => s === 'approved'),
  }
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

/** Load every picker the weekly editor needs, for one org. */
export async function loadPickers(orgId: string): Promise<TimesheetPickers> {
  const [employees, projects, items, timeTypes, departments] = (await Promise.all([
    db.execute(sql`
      select p.id, coalesce(p.display_name, '') as label
        from parties p
       where p.org_id = ${orgId}
         and p.is_active
         and (
           p.custom->>'nsKind' = 'employee'
           or exists (
             select 1 from employee_roles r
              where r.party_id = p.id and r.org_id = ${orgId} and r.is_active
           )
         )
       order by p.display_name`),
    db.execute(sql`
      select id, code, name from projects
       where org_id = ${orgId} and is_active order by name`),
    db.execute(sql`
      select id, code, name from items
       where org_id = ${orgId} and is_active
         and kind in ('service', 'labor', 'other_charge')
       order by name`),
    db.execute(sql`
      select id, name, cost_multiplier, is_billable_default from time_types
       where org_id = ${orgId} and is_active order by cost_multiplier`),
    db.execute(sql`
      select id, code, name from departments
       where org_id = ${orgId} and is_active order by name`),
  ])) as unknown as { rows: Record<string, unknown>[] }[]

  const withCode = (r: Record<string, unknown>): PickerOption => ({
    value: String(r.id),
    label: r.code ? `${r.code} · ${r.name as string}` : (r.name as string),
  })

  return {
    employees: employees.rows.map((r) => ({ value: String(r.id), label: (r.label as string) || '(unnamed)' })),
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
  const r = (await db.execute(sql`
    select party_id from users where id = ${userId} and org_id = ${orgId}
  `)) as unknown as { rows: { party_id: string | null }[] }
  return r.rows[0]?.party_id ?? null
}
