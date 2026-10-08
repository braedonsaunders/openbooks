/**
 * Fill a weekly timesheet from the person's published bookings. A booking
 * fills an empty day on the row for its project (or, for work that is not a
 * project, the row whose memo names it); a day already holding hours is left
 * alone. Locked rows are never touched. The editor still saves through its
 * own command, so the week's lifecycle and approval rules apply unchanged.
 */
export interface FillableRow {
  projectId: string
  memo: string
  hours: string[]
  immutable: boolean
}

export interface ScheduledDay {
  readonly onDate: string
  readonly hours: string
  readonly projectId: string | null
  readonly targetLabel: string
}

/** Grid cells show hours without trailing zeros. */
function cellHours(hours: string): string {
  const [whole = '0', fraction = ''] = hours.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole
}

export function fillFromSchedule<Row extends FillableRow>(
  rows: readonly Row[],
  scheduled: readonly ScheduledDay[],
  days: readonly string[],
  options: { projectIds: ReadonlySet<string>; blank: () => Row },
): { rows: Row[]; filled: number; skipped: number } {
  const next = rows.map((row) => ({ ...row, hours: [...row.hours] }))
  let filled = 0
  let skipped = 0
  for (const booking of scheduled) {
    const day = days.indexOf(booking.onDate)
    if (day < 0 || Number(booking.hours) <= 0) continue
    const projectId = booking.projectId && options.projectIds.has(booking.projectId) ? booking.projectId : ''
    const memo = projectId ? '' : booking.targetLabel
    const same = (row: Row) => row.projectId === projectId && (projectId !== '' || row.memo === memo)
    // Hours already recorded for this work on this day, locked or not, win.
    if (next.some((row) => same(row) && row.hours[day] !== '')) {
      skipped++
      continue
    }
    let index = next.findIndex((row) => !row.immutable && same(row))
    if (index < 0) {
      // An untouched blank row is reused before a new line is added.
      index = next.findIndex((row) => !row.immutable && row.projectId === '' && row.memo === '' && row.hours.every((hours) => hours === ''))
      if (index < 0) {
        next.push({ ...options.blank(), hours: ['', '', '', '', '', '', ''] })
        index = next.length - 1
      }
      next[index] = { ...next[index]!, projectId, memo }
    }
    next[index]!.hours[day] = cellHours(booking.hours)
    filled++
  }
  return { rows: next, filled, skipped }
}
