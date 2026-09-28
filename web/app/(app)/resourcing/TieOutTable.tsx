'use client'

import Link from 'next/link'
import { Badge } from '@openbooks/ui'
import { PagedTable } from '../../../components/paged-table'
import type { PlanVsActualRow } from '../../../lib/resourcing/tie-out'

/**
 * Plan-vs-actual tie-out grid shared by the resourcing cockpit and the
 * widget registry: one row per person-week with planned hours against
 * approved time and net capacity. Every figure drills to the rows behind
 * it on an existing route.
 */
export interface TieOutLabels {
  person: string
  week: string
  planned: string
  approved: string
  variance: string
  capacity: string
  evidence: string
  empty: string
  noCapacity: string
  overallocated: string
  assignments: string
  absences: string
  leaveRequest: string
  holidays: string
  scheduleTier: string
}

const fmtHours = (value: string) => `${value} h`
const shortId = (id: string) => id.slice(0, 8)

export function TieOutTable({ rows, labels }: { rows: PlanVsActualRow[]; labels: TieOutLabels }) {
  return (
    <PagedTable
      rows={rows}
      rowKey={(row) => `${row.employeePartyId}:${row.weekStart}:${row.projectId ?? ''}`}
      searchable
      pageSize={10}
      empty={<p className="text-sm text-slate-500 dark:text-slate-400">{labels.empty}</p>}
      columns={[
        {
          key: 'person',
          header: labels.person,
          cell: (row) => <span className="font-medium">{row.employeeName}</span>,
          search: (row) => row.employeeName,
        },
        { key: 'week', header: labels.week, cell: (row) => <span className="tabular-nums">{row.weekStart}</span> },
        {
          key: 'planned',
          header: labels.planned,
          align: 'right',
          cell: (row) => (
            row.assignmentIds.length > 0 ? (
              <Link
                href={(`/resourcing/assignments?assignment=${row.assignmentIds[0]}` as never)}
                className="font-medium tabular-nums text-teal-700 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
              >
                {fmtHours(row.plannedHours)}
              </Link>
            ) : (
              <span className="tabular-nums">{fmtHours(row.plannedHours)}</span>
            )
          ),
        },
        {
          key: 'approved',
          header: labels.approved,
          align: 'right',
          cell: (row) => (
            <Link
              href={(`/timesheets?timesheet=${row.employeePartyId}:${row.weekStart}` as never)}
              className="font-medium tabular-nums text-teal-700 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
            >
              {fmtHours(row.approvedHours)}
            </Link>
          ),
        },
        {
          key: 'variance',
          header: labels.variance,
          align: 'right',
          cell: (row) => <span className="tabular-nums">{fmtHours(row.varianceHours)}</span>,
        },
        {
          key: 'capacity',
          header: labels.capacity,
          align: 'right',
          cell: (row) => (
            <span className="inline-flex items-center gap-1.5">
              {row.overallocated === true ? <Badge variant="destructive">{labels.overallocated}</Badge> : null}
              <span className="tabular-nums">{row.netCapacity ?? labels.noCapacity}</span>
            </span>
          ),
        },
        {
          key: 'evidence',
          header: labels.evidence,
          cell: (row) => (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <Link
                href={('/admin/setup/payroll?tab=workSchedules' as never)}
                className="text-teal-700 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
                title={row.scheduleIds.join(', ')}
              >
                {labels.scheduleTier}: {row.capacityTier}
              </Link>
              {row.assignmentIds.map((id) => (
                <Link
                  key={id}
                  href={(`/resourcing/assignments?assignment=${id}` as never)}
                  className="text-teal-700 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
                  title={id}
                >
                  {labels.assignments}: {shortId(id)}
                </Link>
              ))}
              {row.absences
                .filter((absence) => absence.leaveRequestId !== null)
                .map((absence) => (
                  <Link
                    key={absence.absenceId}
                    href={(`/hrm/leave?request=${absence.leaveRequestId}` as never)}
                    className="text-teal-700 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
                    title={absence.absenceId}
                  >
                    {labels.leaveRequest}: {shortId(absence.leaveRequestId!)}
                  </Link>
                ))}
              {row.absences.some((absence) => absence.leaveRequestId === null) ? (
                <Link
                  href={('/hrm/leave' as never)}
                  className="text-teal-700 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
                  title={row.absences.filter((absence) => absence.leaveRequestId === null).map((absence) => absence.absenceId).join(', ')}
                >
                  {labels.absences} ({row.absences.filter((absence) => absence.leaveRequestId === null).length})
                </Link>
              ) : null}
              {row.holidayDates.length > 0 ? (
                <Link
                  href={('/admin/setup/payroll?tab=holidayCalendar' as never)}
                  className="text-teal-700 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
                  title={row.holidayDates.join(', ')}
                >
                  {labels.holidays} ({row.holidayDates.length})
                </Link>
              ) : null}
            </span>
          ),
        },
      ]}
    />
  )
}
