'use client'

/**
 * Department leave calendar: absence days in the window, grouped by date.
 * The loader resolves the days through the attendance service on the
 * department/from/to search params, so this island carries no state and no
 * fetch. An empty window reads empty, never all: without a department
 * nothing resolves.
 *
 * It renders the DAYS only. Department, from and to are the shared toolbar's
 * controls (see ./view) — this used to carry its own <form> with stacked
 * labels and a Show button, which is why the page had a second,
 * differently-shaped filter bar sitting inside its own content.
 */

export function LeaveCalendar({
  days,
  empty,
}: {
  days: { date: string; entries: { workerName: string; hours: string; leaveTypeCode: string }[] }[]
  empty: string
}) {
  if (days.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">{empty}</p>
    )
  }
  return (
    <dl className="space-y-2">
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
  )
}
