import {
  addCalendarDays,
  addMonthsStart,
  endOfMonth,
  inclusiveCalendarDays,
  parseIsoDate,
  startOfMonth,
} from '@openbooks/engine/platform/civil-date'

/** Resolve the displayed window independently of whether there are absences. */
export function leaveCalendarWindow(
  from: string | undefined,
  to: string | undefined,
  today: string,
) {
  const start = from ?? startOfMonth(to ?? today)
  const end = to ?? endOfMonth(start)
  parseIsoDate(start)
  parseIsoDate(end)
  if (end < start)
    throw new RangeError('Choose an end date on or after the start date.')
  if (inclusiveCalendarDays(start, end) > 366)
    throw new RangeError('Choose a calendar date range of 366 days or fewer.')
  return { from: start, to: end }
}

/** Whole calendar months, padded with blank cells to complete each week. */
export function leaveCalendarMonths(
  from: string,
  to: string,
  firstWeekday = 1,
) {
  leaveCalendarWindow(from, to, from)
  const months: { month: string; weeks: (string | null)[][] }[] = []
  let month = startOfMonth(from)
  while (month <= to) {
    const offset = (parseIsoDate(month).getUTCDay() - firstWeekday + 7) % 7
    const cells: (string | null)[] = Array.from({ length: offset }, () => null)
    const last = endOfMonth(month)
    let date = month
    while (true) {
      cells.push(date)
      if (date === last) break
      date = addCalendarDays(date, 1)
    }
    while (cells.length % 7) cells.push(null)
    const weeks = Array.from({ length: cells.length / 7 }, (_, i) =>
      cells.slice(i * 7, i * 7 + 7),
    )
    months.push({ month, weeks })
    if (last >= to) break
    month = addMonthsStart(month, 1)
  }
  return months
}
