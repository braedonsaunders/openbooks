import { isIsoCalendarDate } from '@openbooks/engine/src/business-date.ts'

export { isIsoCalendarDate }

// Calendar-date prefix, optional wall-clock time (as sent by
// <input type="datetime-local">, with optional seconds / fraction), optional
// UTC designator or numeric offset. Anything else is refused at the API
// boundary so a Postgres 22P02 cast failure can never surface as a 500.
const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)?)?$/

/**
 * True for a timestamp literal PostgreSQL `timestamptz` accepts unambiguously:
 * a valid calendar date, optionally followed by a valid time and zone.
 */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = TIMESTAMP.exec(value.trim())
  if (!match) return false
  const [, day, hour, minute, second, , offsetHour, offsetMinute] = match
  if (!isIsoCalendarDate(day)) return false
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) return false
  if (second !== undefined && Number(second) > 59) return false
  if (offsetHour !== undefined && (Number(offsetHour) > 14 || Number(offsetMinute ?? 0) > 59)) return false
  return true
}
