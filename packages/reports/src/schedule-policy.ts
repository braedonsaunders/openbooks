// Schedule policy for reports — next-run computation plus recipient/filter
// validation limits. Merged port of beaconhs packages/reports/src/cadence.ts
// (the next-run math) and schedule-policy.ts (recipient/filter bounds).
//
// Next-run computation works in the schedule's local timezone (IANA, e.g.
// 'America/Toronto'), pins the hour/minute, and rolls forward to the next
// matching day-of-week (weekly) or day-of-month (monthly). Daily simply rolls
// forward by 24h. We use Intl.DateTimeFormat with the target timezone to read
// out local Y/M/D/h/m/dow, then construct UTC instants by iterating the
// timezone offset (a 3-step iteration nails accuracy for any
// non-pathological zone).

export type ReportCadence = 'daily' | 'weekly' | 'monthly'
export const REPORT_CADENCES: ReportCadence[] = ['daily', 'weekly', 'monthly']

export type CadenceInput = {
  cadence: ReportCadence
  /** 0 = Sunday … 6 = Saturday. Required for weekly. */
  dayOfWeek?: number | null
  /** 1..31. Required for monthly. */
  dayOfMonth?: number | null
  hour: number
  minute: number
  /** IANA zone (e.g. 'America/Toronto'). */
  timezone: string
}

/**
 * Returns the next future UTC Date matching the cadence (strictly > `from`).
 */
export function computeNextRunAt(input: CadenceInput, from: Date = new Date()): Date {
  const tz = input.timezone || 'UTC'
  // Probe candidate days starting from `from` (in tz). For weekly/monthly we
  // may need to walk forward up to ~60 days; 366 is a safe upper bound for
  // edge cases like Feb-29 monthly schedules.
  const start = startOfTzDay(from, tz)
  for (let i = 0; i < 366; i++) {
    const dayLocal = addDays(start, i)
    if (!matchesDay(dayLocal, input, tz)) continue
    const candidate = zonedDateTimeToUtc(
      tzYear(dayLocal, tz),
      tzMonth(dayLocal, tz),
      tzDay(dayLocal, tz),
      input.hour,
      input.minute,
      tz,
    )
    if (candidate.getTime() > from.getTime()) return candidate
  }
  // Shouldn't happen for any realistic schedule.
  throw new Error('computeNextRunAt: no match within a year')
}

/** Human description of a cadence, e.g. "Weekly on Monday at 07:00 (UTC)". */
export function describeCadence(input: CadenceInput): string {
  const time = `${String(input.hour).padStart(2, '0')}:${String(input.minute).padStart(2, '0')}`
  const zone = input.timezone || 'UTC'
  if (input.cadence === 'weekly') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    return `Weekly on ${days[input.dayOfWeek ?? 1] ?? 'Monday'} at ${time} (${zone})`
  }
  if (input.cadence === 'monthly') {
    return `Monthly on day ${input.dayOfMonth ?? 1} at ${time} (${zone})`
  }
  return `Daily at ${time} (${zone})`
}

/** Whitelist/clamp an untrusted cadence payload. Throws on nonsense. */
export function validateCadenceInput(raw: {
  cadence?: unknown
  dayOfWeek?: unknown
  dayOfMonth?: unknown
  hour?: unknown
  minute?: unknown
  timezone?: unknown
}): CadenceInput {
  const cadence = String(raw.cadence ?? '')
  if (!REPORT_CADENCES.includes(cadence as ReportCadence)) {
    throw new Error(`Invalid cadence: ${cadence}`)
  }
  const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.min(Math.max(Math.trunc(n), min), max)
  }
  const timezone = String(raw.timezone ?? 'UTC').trim() || 'UTC'
  if (timezone.length > REPORT_SCHEDULE_LIMITS.timezoneChars) {
    throw new Error('Timezone is too long')
  }
  // Probe the IANA zone — Intl throws on unknown zones.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  } catch {
    throw new Error(`Unknown timezone: ${timezone}`)
  }
  return {
    cadence: cadence as ReportCadence,
    dayOfWeek: cadence === 'weekly' ? clampInt(raw.dayOfWeek, 0, 6, 1) : null,
    dayOfMonth: cadence === 'monthly' ? clampInt(raw.dayOfMonth, 1, 31, 1) : null,
    hour: clampInt(raw.hour, 0, 23, 7),
    minute: clampInt(raw.minute, 0, 59, 0),
    timezone,
  }
}

function matchesDay(localDay: Date, input: CadenceInput, tz: string): boolean {
  if (input.cadence === 'daily') return true
  if (input.cadence === 'weekly') {
    const dow = tzWeekday(localDay, tz)
    return dow === (input.dayOfWeek ?? 1)
  }
  if (input.cadence === 'monthly') {
    return tzDay(localDay, tz) === (input.dayOfMonth ?? 1)
  }
  return false
}

// --- Timezone arithmetic -------------------------------------------------

/** A near-noon UTC Date for the day-in-tz that `d` falls on. */
function startOfTzDay(d: Date, tz: string): Date {
  // Build a noon-in-tz to avoid DST shoulders.
  const y = tzYear(d, tz)
  const m = tzMonth(d, tz)
  const day = tzDay(d, tz)
  return zonedDateTimeToUtc(y, m, day, 12, 0, tz)
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 3600 * 1000)
}

/**
 * Construct a UTC Date that, when formatted in tz, reads Y-M-D h:m:00.
 */
function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  for (let i = 0; i < 3; i++) {
    const guess = new Date(utcMs)
    const have = tzReadAll(guess, tz)
    const want = { year, month, day, hour, minute }
    const diff =
      (want.year - have.year) * 365 * 24 * 3600 * 1000 +
      ((want.month - have.month) * 30 + (want.day - have.day)) * 24 * 3600 * 1000 +
      (want.hour - have.hour) * 3600 * 1000 +
      (want.minute - have.minute) * 60 * 1000
    if (diff === 0) break
    utcMs += diff
  }
  return new Date(utcMs)
}

function tzReadAll(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? '0')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

function tzYear(d: Date, tz: string): number {
  return tzReadAll(d, tz).year
}
function tzMonth(d: Date, tz: string): number {
  return tzReadAll(d, tz).month
}
function tzDay(d: Date, tz: string): number {
  return tzReadAll(d, tz).day
}
function tzWeekday(d: Date, tz: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
}

// --- Recipient / filter bounds --------------------------------------------

export const REPORT_SCHEDULE_LIMITS = {
  nameChars: 200,
  timezoneChars: 100,
  recipientCount: 1_000,
  recipientEmailChars: 320,
  filtersChars: 65_536,
  filtersBytes: 131_072,
  filtersDepth: 12,
  filtersNodes: 2_000,
  filterKeyChars: 128,
} as const

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Dedupe, lowercase and validate recipient email addresses. Throws on the
 *  first invalid entry so the caller can surface it verbatim. */
export function normalizeReportRecipientEmails(values: readonly string[]): string[] {
  const normalized = new Set<string>()
  for (const raw of values) {
    const value = raw.trim().toLowerCase()
    if (
      !value ||
      value.length > REPORT_SCHEDULE_LIMITS.recipientEmailChars ||
      !EMAIL_PATTERN.test(value)
    ) {
      throw new Error(`Invalid report recipient email address: ${value || '(blank)'}`)
    }
    normalized.add(value)
    if (normalized.size > REPORT_SCHEDULE_LIMITS.recipientCount) {
      throw new Error(
        `Scheduled reports may have at most ${REPORT_SCHEDULE_LIMITS.recipientCount} recipients.`,
      )
    }
  }
  return [...normalized]
}

/** Bound an untrusted filters JSON object (size / depth / node count / keys). */
export function assertBoundedReportFilters(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Report filters must be a JSON object.')
  }

  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new Error('Report filters must be JSON serializable.')
  }
  if (encoded.length > REPORT_SCHEDULE_LIMITS.filtersChars) {
    throw new Error('Report filters are too large.')
  }
  if (new TextEncoder().encode(encoded).byteLength > REPORT_SCHEDULE_LIMITS.filtersBytes) {
    throw new Error('Report filters are too large.')
  }

  let nodes = 0
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length) {
    const current = stack.pop()!
    nodes += 1
    if (nodes > REPORT_SCHEDULE_LIMITS.filtersNodes) {
      throw new Error('Report filters contain too many values.')
    }
    if (current.depth > REPORT_SCHEDULE_LIMITS.filtersDepth) {
      throw new Error('Report filters are nested too deeply.')
    }
    if (!current.value || typeof current.value !== 'object') continue

    if (Array.isArray(current.value)) {
      for (const entry of current.value) {
        stack.push({ value: entry, depth: current.depth + 1 })
      }
      continue
    }

    for (const [key, entry] of Object.entries(current.value as Record<string, unknown>)) {
      if (key.length > REPORT_SCHEDULE_LIMITS.filterKeyChars || UNSAFE_OBJECT_KEYS.has(key)) {
        throw new Error('Report filters contain an invalid key.')
      }
      stack.push({ value: entry, depth: current.depth + 1 })
    }
  }
}
