import 'server-only'
import { sql } from 'drizzle-orm'
import type { SetupEntityValidationHook } from './types'

const BUSINESS_CALENDARS_PATH = 'Setup → Company → Business calendars'
const AGING_POLICIES_PATH = 'Setup → Company → Aging bucket policies'

/** Request-shaped integer lists (a real array, or its JSON text) as numbers. */
function parseIntegerList(raw: unknown): number[] | null {
  let list: unknown = raw
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      return null
    }
  }
  if (!Array.isArray(list)) return null
  const days: number[] = []
  for (const entry of list) {
    const parsed = typeof entry === 'number' ? entry : typeof entry === 'string' && /^\d+$/.test(entry.trim()) ? Number(entry.trim()) : NaN
    if (!Number.isInteger(parsed)) return null
    days.push(parsed)
  }
  return days
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

const toDayString = (value: string | Date): string => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10))

type CalendarVersion = {
  subsidiary_id: string | null
  week_starts_on: number
  weekend_days: unknown
  holiday_country: string | null
  holiday_region: string | null
  effective_from: string | Date
  effective_to: string | Date | null
}

async function currentCalendarVersion(
  executor: Parameters<SetupEntityValidationHook>[0]['executor'],
  orgId: string,
  rowId: string,
): Promise<CalendarVersion | null> {
  const rows = (await executor.execute<CalendarVersion>(sql`
    select subsidiary_id, week_starts_on, weekend_days, holiday_country, holiday_region, effective_from, effective_to
      from org_business_calendars
     where id = ${rowId} and org_id = ${orgId}
  `)).rows
  return rows[0] ?? null
}

/**
 * Versions are immutable: only the window and activity may move on an edit.
 * The drawer sends the whole form on every save, so presence alone proves
 * nothing — a key refuses only when its normalized value DIFFERS from the
 * stored row ('1' vs 1, JSON text vs array, '' vs null are all unchanged). A
 * key this validator cannot normalize fails closed: it cannot be proven
 * unchanged.
 */
function lifecycleOnly(
  body: Record<string, unknown>,
  contentKeys: readonly string[],
  differs: (key: string) => boolean,
  path: string,
): string | null {
  for (const key of Object.keys(body)) {
    if (key === 'id' || key === 'effectiveTo' || key === 'isActive') continue
    if (!contentKeys.includes(key) || differs(key)) {
      return `Versions are immutable; close the window (set its effective-to) and create a new version in ${path}`
    }
  }
  return null
}

const normalizeCode = (value: unknown): string | null =>
  (value === null || value === undefined || value === '' ? null : String(value).trim().toUpperCase())

function sameIntegerList(next: unknown, stored: unknown): boolean {
  const nextDays = parseIntegerList(next)
  const storedDays = parseIntegerList(stored)
  if (!nextDays || !storedDays) return false
  const order = (days: number[]): string => [...days].sort((a, b) => a - b).join(',')
  return order(nextDays) === order(storedDays)
}

/** Content keys the calendar drawer sends (SetupDrawer posts the whole form). */
const CALENDAR_CONTENT_KEYS = ['weekStartsOn', 'weekendDays', 'subsidiaryId', 'holidayCountry', 'holidayRegion', 'effectiveFrom'] as const

function calendarDiffers(body: Record<string, unknown>, current: CalendarVersion): (key: string) => boolean {
  return (key: string): boolean => {
    switch (key) {
      case 'weekStartsOn':
        return Number(body.weekStartsOn) !== Number(current.week_starts_on)
      case 'weekendDays':
        return !sameIntegerList(body.weekendDays, current.weekend_days)
      case 'subsidiaryId': {
        const next = body.subsidiaryId === null || body.subsidiaryId === '' ? null : String(body.subsidiaryId)
        return next !== current.subsidiary_id
      }
      case 'holidayCountry':
        return normalizeCode(body.holidayCountry) !== normalizeCode(current.holiday_country)
      case 'holidayRegion':
        return normalizeCode(body.holidayRegion) !== normalizeCode(current.holiday_region)
      case 'effectiveFrom':
        return String(body.effectiveFrom) !== toDayString(current.effective_from)
      default:
        return true
    }
  }
}

/** Content keys the aging drawer sends. */
const AGING_CONTENT_KEYS = ['boundaries', 'effectiveFrom'] as const

function agingDiffers(
  body: Record<string, unknown>,
  current: { boundaries: unknown; effective_from: string | Date },
): (key: string) => boolean {
  return (key: string): boolean => {
    switch (key) {
      case 'boundaries':
        return !sameIntegerList(body.boundaries, current.boundaries)
      case 'effectiveFrom':
        return String(body.effectiveFrom) !== toDayString(current.effective_from)
      default:
        return true
    }
  }
}

async function statutoryKeyOrRefusal(
  country: unknown,
  region: unknown,
): Promise<{ jurisdiction: string } | { refusal: string }> {
  const { statutoryJurisdictionKey, StatutoryCoverageError } = await import(
    '@openbooks/engine/payroll/business-calendars'
  )
  try {
    const code = typeof country === 'string' ? country : ''
    const qualifier = region === null || region === undefined || region === '' ? null : String(region)
    return { jurisdiction: statutoryJurisdictionKey(code, qualifier) }
  } catch (error) {
    if (error instanceof StatutoryCoverageError) return { refusal: error.message }
    throw error
  }
}

export const validateBusinessCalendarWrite: SetupEntityValidationHook = async ({ body, orgId, rowId, executor }) => {
  const current = rowId ? await currentCalendarVersion(executor, orgId, rowId) : null
  if (rowId && !current) return `Business calendar no longer exists; reopen ${BUSINESS_CALENDARS_PATH}`

  const weekStart = Number(body.weekStartsOn ?? (rowId ? undefined : NaN))
  if (body.weekStartsOn !== undefined || !rowId) {
    if (!Number.isInteger(weekStart) || weekStart < 1 || weekStart > 7) {
      return 'Choose the weekday that starts the week: 1 is Monday through 7 is Sunday'
    }
  }

  const weekendRaw = body.weekendDays !== undefined ? body.weekendDays : current ? null : []
  if (body.weekendDays !== undefined || !rowId) {
    const weekend = parseIntegerList(weekendRaw)
    if (!weekend || weekend.some((dayOfWeek) => dayOfWeek < 1 || dayOfWeek > 7) || new Set(weekend).size !== weekend.length) {
      return 'Weekend days are ISO weekdays 1 (Monday) through 7 (Sunday) as a JSON list, for example [6, 7]; an empty list states that no weekday is a weekend day'
    }
    if (weekend.length === 7) {
      return 'Every weekday cannot be the weekend — at least one day must stay a business day'
    }
  }

  const subsidiaryId = body.subsidiaryId !== undefined
    ? (body.subsidiaryId === null || body.subsidiaryId === '' ? null : String(body.subsidiaryId))
    : (current?.subsidiary_id ?? null)
  let subsidiaryCountry: string | null = null
  let subsidiaryName: string | null = null
  if (subsidiaryId) {
    const subsidiary = (await executor.execute<{ name: string; country: string }>(sql`
      select name, country from subsidiaries where id = ${subsidiaryId} and org_id = ${orgId}
    `)).rows[0]
    if (!subsidiary) return 'Select a subsidiary in this organization, or leave it empty for the org-wide calendar'
    subsidiaryCountry = subsidiary.country
    subsidiaryName = subsidiary.name
  }

  const country = body.holidayCountry !== undefined ? body.holidayCountry : (current?.holiday_country ?? null)
  const region = body.holidayRegion !== undefined ? body.holidayRegion : (current?.holiday_region ?? null)
  const countryCode = country === null || country === '' ? null : String(country)
  if (region !== null && region !== '' && !countryCode) {
    return 'Set the holiday country before its region — a region alone selects no calendar'
  }
  if (countryCode) {
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      return 'Holiday country is the ISO alpha-2 code in capitals, for example US'
    }
    // A version names one country's holidays; filing it against a
    // subsidiary domiciled elsewhere prices the subsidiary by the wrong
    // state's table, so the save refuses rather than the read.
    if (subsidiaryCountry && countryCode !== subsidiaryCountry) {
      return `Subsidiary "${subsidiaryName}" is domiciled in ${subsidiaryCountry}, not ${countryCode} — set the holiday country to ${subsidiaryCountry} or leave it empty for weekends only`
    }
    const resolved = await statutoryKeyOrRefusal(countryCode, region)
    if ('refusal' in resolved) return resolved.refusal
  }

  const from = body.effectiveFrom !== undefined ? body.effectiveFrom : current ? toDayString(current.effective_from) : undefined
  const to = body.effectiveTo !== undefined && body.effectiveTo !== '' ? body.effectiveTo : current?.effective_to ? toDayString(current.effective_to) : null
  if ((from !== undefined && !isIsoDate(from)) || (to !== null && to !== undefined && !isIsoDate(to))) {
    return 'Effective dates are calendar dates in YYYY-MM-DD form'
  }
  if (isIsoDate(from) && isIsoDate(to) && to < from) {
    return 'The effective-to date must be on or after the effective-from date'
  }
  // The lifecycle freeze runs last so malformed input hears the format
  // refusal, never the immutability one.
  if (rowId && current) {
    const frozen = lifecycleOnly(body, CALENDAR_CONTENT_KEYS, calendarDiffers(body, current), BUSINESS_CALENDARS_PATH)
    if (frozen) return frozen
  }
  return null
}

export const validateAgingBucketPolicyWrite: SetupEntityValidationHook = async ({ body, orgId, rowId, executor }) => {
  const current = rowId
    ? (await executor.execute<{ boundaries: unknown; effective_from: string | Date; effective_to: string | Date | null }>(sql`
        select boundaries, effective_from, effective_to from aging_bucket_policies where id = ${rowId} and org_id = ${orgId}
      `)).rows[0] ?? null
    : null
  if (rowId && !current) return `Aging bucket policy no longer exists; reopen ${AGING_POLICIES_PATH}`
  if (body.boundaries !== undefined || !rowId) {
    const boundaries = parseIntegerList(body.boundaries)
    if (!boundaries || boundaries.length === 0) {
      return 'Boundaries are ascending day counts as a JSON list, for example [30, 60, 90]'
    }
    for (const [index, boundary] of boundaries.entries()) {
      if (boundary < 1 || boundary > 36500 || (index > 0 && boundary <= boundaries[index - 1]!)) {
        return 'Boundaries are strictly ascending day counts between 1 and 36500, for example [30, 60, 90]'
      }
    }
  }
  const from = body.effectiveFrom !== undefined ? body.effectiveFrom : current ? toDayString(current.effective_from) : undefined
  const to = body.effectiveTo !== undefined && body.effectiveTo !== '' ? body.effectiveTo : current?.effective_to ? toDayString(current.effective_to) : null
  if ((from !== undefined && !isIsoDate(from)) || (to !== null && to !== undefined && !isIsoDate(to))) {
    return 'Effective dates are calendar dates in YYYY-MM-DD form'
  }
  if (isIsoDate(from) && isIsoDate(to) && to < from) {
    return 'The effective-to date must be on or after the effective-from date'
  }
  if (rowId && current) {
    const frozen = lifecycleOnly(body, AGING_CONTENT_KEYS, agingDiffers(body, current), AGING_POLICIES_PATH)
    if (frozen) return frozen
  }
  return null
}
