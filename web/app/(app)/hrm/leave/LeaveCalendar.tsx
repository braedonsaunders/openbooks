'use client'

import { useState } from 'react'
import { Button, Input, Label, Select } from '@openbooks/ui'

/**
 * Department leave calendar: absence days in the window, grouped by date.
 * A plain GET form over the department/from/to search params — the loader
 * resolves the days through the attendance service, so the island carries
 * no state and no fetch. An empty window reads empty, never all: without a
 * department nothing resolves.
 */

export function LeaveCalendar({
  basePath,
  currentParams,
  departmentOptions,
  departmentLabel,
  fromLabel,
  toLabel,
  showLabel,
  days,
  empty,
  notAvailable,
}: {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  departmentOptions: { value: string; label: string }[]
  departmentLabel: string
  fromLabel: string
  toLabel: string
  showLabel: string
  days: { date: string; entries: { workerName: string; hours: string; leaveTypeCode: string }[] }[]
  empty: string
  notAvailable: string
}) {
  const text = (value: string | string[] | undefined): string =>
    typeof value === 'string' ? value : ''
  const segment = text(currentParams.segment)
  const [department, setDepartment] = useState(text(currentParams.department))
  return (
    <div>
      <form method="get" action={basePath} className="flex flex-wrap items-end gap-2">
        {segment ? <input type="hidden" name="segment" value={segment} /> : null}
        <div>
          <Label htmlFor="leave-calendar-department">{departmentLabel}</Label>
          <Select
            id="leave-calendar-department"
            name="department"
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
          >
            <option value="">{notAvailable}</option>
            {departmentOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="leave-calendar-from">{fromLabel}</Label>
          <Input id="leave-calendar-from" name="from" type="date" defaultValue={text(currentParams.from)} />
        </div>
        <div>
          <Label htmlFor="leave-calendar-to">{toLabel}</Label>
          <Input id="leave-calendar-to" name="to" type="date" defaultValue={text(currentParams.to)} />
        </div>
        <Button size="sm" type="submit">
          {showLabel}
        </Button>
      </form>
      {days.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{empty}</p>
      ) : (
        <dl className="mt-3 space-y-2">
          {days.map((day) => (
            <div key={day.date} className="flex gap-3 text-sm">
              <dt className="w-24 shrink-0 tabular-nums font-medium text-slate-700 dark:text-slate-200">
                {day.date}
              </dt>
              <dd className="space-y-1">
                {day.entries.map((entry, index) => (
                  <p key={index} className="text-slate-500 dark:text-slate-400">
                    {entry.workerName} · {entry.leaveTypeCode} ·{' '}
                    <span className="tabular-nums">{entry.hours}</span>
                  </p>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
