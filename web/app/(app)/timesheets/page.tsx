import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { FilterChips } from '../../../components/filter-bar'
import { can, requirePermission } from '../../../lib/authz'
import { pickString } from '../../../lib/list-params'
import { currentWeekStart, userEmployeeId } from '../../api/timesheets/_lib'

export const dynamic = 'force-dynamic'

// A week's aggregate status is derived in SQL from its entries:
//   all approved → approved · any submitted → submitted · any rejected →
//   rejected · else draft. Ordered so "most locked wins".
const STATUSES = ['draft', 'submitted', 'approved', 'rejected'] as const
const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
}
const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'outline' | 'destructive'> = {
  draft: 'secondary',
  submitted: 'warning',
  approved: 'success',
  rejected: 'destructive',
}

/** "Jul 13 – 19, 2026" from the week's Sunday ISO date. */
function weekLabel(sundayIso: string): string {
  const [y, m, d] = sundayIso.split('-').map(Number)
  const sun = new Date(Date.UTC(y, m - 1, d, 12))
  const sat = new Date(sun)
  sat.setUTCDate(sat.getUTCDate() + 6)
  const mon = (dt: Date) => dt.toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' })
  const day = (dt: Date) => dt.getUTCDate()
  const yr = sat.getUTCFullYear()
  if (sun.getUTCMonth() === sat.getUTCMonth()) {
    return `${mon(sun)} ${day(sun)} – ${day(sat)}, ${yr}`
  }
  return `${mon(sun)} ${day(sun)} – ${mon(sat)} ${day(sat)}, ${yr}`
}

function hours(v: unknown): string {
  const n = Number(v ?? 0)
  return (Number.isNaN(n) ? 0 : n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default async function Timesheets({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('time.read')
  const canManage = can(authz, 'time.manage')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const statusParam = pickString(sp.status)
  const status = statusParam && (STATUSES as readonly string[]).includes(statusParam) ? statusParam : undefined
  const employeeParam = pickString(sp.employee)
  const employee = employeeParam && /^[0-9a-f-]{36}$/i.test(employeeParam) ? employeeParam : undefined

  // Group time_entries into employee-week timesheets. week_start = the Sunday
  // of each entry's worked_on (date_trunc('week') is Monday-based in Postgres,
  // so shift by the day-of-week to land on Sunday).
  const rows = (await db.execute(sql`
    with weekly as (
      select
        t.employee_party_id,
        (t.worked_on - ((extract(dow from t.worked_on))::int) * interval '1 day')::date as week_start,
        sum(t.hours) as total_hours,
        sum(t.hours) filter (where t.is_billable) as billable_hours,
        bool_or(t.status = 'submitted') as any_submitted,
        bool_or(t.status = 'rejected') as any_rejected,
        bool_and(t.status = 'approved') as all_approved
      from time_entries t
      where t.org_id = ${orgId}
        ${employee ? sql`and t.employee_party_id = ${employee}` : sql``}
      group by t.employee_party_id, week_start
    )
    select
      w.employee_party_id,
      w.week_start,
      w.total_hours,
      coalesce(w.billable_hours, 0) as billable_hours,
      coalesce(p.display_name, '(unnamed)') as employee_name,
      case
        when w.all_approved then 'approved'
        when w.any_submitted then 'submitted'
        when w.any_rejected then 'rejected'
        else 'draft'
      end as status
    from weekly w
    left join parties p on p.id = w.employee_party_id and p.org_id = ${orgId}
    ${status ? sql`where (case
        when w.all_approved then 'approved'
        when w.any_submitted then 'submitted'
        when w.any_rejected then 'rejected'
        else 'draft' end) = ${status}` : sql``}
    order by w.week_start desc, employee_name
    limit 500
  `)) as unknown as {
    rows: {
      employee_party_id: string
      week_start: string
      total_hours: string
      billable_hours: string
      employee_name: string
      status: string
    }[]
  }

  // Status filter chips carry counts across all weeks (unfiltered by status).
  const countRes = (await db.execute(sql`
    with weekly as (
      select
        t.employee_party_id,
        (t.worked_on - ((extract(dow from t.worked_on))::int) * interval '1 day')::date as week_start,
        bool_or(t.status = 'submitted') as any_submitted,
        bool_or(t.status = 'rejected') as any_rejected,
        bool_and(t.status = 'approved') as all_approved
      from time_entries t
      where t.org_id = ${orgId}
        ${employee ? sql`and t.employee_party_id = ${employee}` : sql``}
      group by t.employee_party_id, week_start
    )
    select
      case
        when all_approved then 'approved'
        when any_submitted then 'submitted'
        when any_rejected then 'rejected'
        else 'draft' end as status,
      count(*) as n
    from weekly
    group by 1
  `)) as unknown as { rows: { status: string; n: string }[] }
  const counts = new Map(countRes.rows.map((r) => [r.status, Number(r.n)]))

  // Employee filter — the same active-employee set the editor uses.
  const employees = (await db.execute(sql`
    select p.id, coalesce(p.display_name, '(unnamed)') as name
      from parties p
     where p.org_id = ${orgId} and p.is_active
       and (
         p.custom->>'nsKind' = 'employee'
         or exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = ${orgId} and r.is_active)
       )
     order by p.display_name`)) as unknown as { rows: { id: string; name: string }[] }

  const statusOptions = (STATUSES as readonly string[]).map((s) => ({
    value: s,
    label: STATUS_LABELS[s] ?? s,
    count: counts.get(s) ?? 0,
  }))
  const employeeOptions = employees.rows.map((e) => ({ value: e.id, label: e.name }))

  // "New timesheet" targets the current user's linked employee (or the first
  // active employee as a fallback picker seed) and the current week.
  const myEmployee = canManage ? await userEmployeeId(orgId, authz.user.id) : null
  const newTarget = myEmployee ?? employees.rows[0]?.id ?? null
  const newHref = newTarget
    ? (`/timesheets/entry?employee=${newTarget}&week=${currentWeekStart()}` as const)
    : ('/timesheets/entry' as const)

  const NewButton = canManage ? (
    <Link
      href={newHref}
      className="inline-flex h-8 items-center gap-2 rounded-md bg-teal-700 px-3 text-sm font-medium text-white shadow-sm hover:bg-teal-800"
    >
      New timesheet
    </Link>
  ) : undefined

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Weekly timesheets"
            description="Employee time by the week — enter, submit, and approve hours across every job."
            actions={NewButton}
          />
          <div className="flex flex-wrap items-center gap-2">
            <FilterChips basePath="/timesheets" currentParams={sp} paramKey="status" label="Status" options={statusOptions} />
            <FilterChips basePath="/timesheets" currentParams={sp} paramKey="employee" label="Employee" options={employeeOptions} />
          </div>
        </>
      }
    >
      {rows.rows.length === 0 ? (
        <EmptyState
          title="No timesheets yet"
          description="Time entries roll up into weekly timesheets here. Create one to log hours against a job."
          action={NewButton}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Week</TableHead>
              <TableHead>Status</TableHead>
              <TableHead align="right" className="text-right">Total hours</TableHead>
              <TableHead align="right" className="text-right">Billable hours</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.rows.map((r) => (
              <TableRow key={`${r.employee_party_id}:${r.week_start}`}>
                <TableCell className="font-semibold">
                  <Link
                    href={`/timesheets/entry?employee=${r.employee_party_id}&week=${r.week_start}`}
                    className="text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {r.employee_name}
                  </Link>
                </TableCell>
                <TableCell className="text-slate-500 dark:text-slate-400">{weekLabel(r.week_start)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[r.status] ?? 'secondary'}>{STATUS_LABELS[r.status] ?? r.status}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{hours(r.total_hours)}</TableCell>
                <TableCell className="text-right tabular-nums">{hours(r.billable_hours)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ListPageLayout>
  )
}
