// Pure fiscal-calendar math — no DB, no `server-only`. This is the single
// source of truth for fiscal-year / quarter / half / period boundaries, shared
// by the web app's async fiscal helpers (web/lib/fiscal.ts re-exports these)
// and by the period-preset resolver (period-presets.ts).
//
// The fiscal year is NAMED BY THE CALENDAR YEAR IT ENDS IN. The fiscal start
// month (1 = January … 12 = December) is always supplied by the caller — it's
// an org setting (orgs.settings.fiscalYearStartMonth) read elsewhere, never
// hardcoded here. With a January start the fiscal year equals the calendar
// year; otherwise months at/after the start month belong to the year that ends
// next calendar year.

/** A resolved date window: inclusive ISO `from`/`to` plus a display label. */
export type DateRange = { from: string; to: string; label: string }

const pad = (n: number) => String(n).padStart(2, '0')
// Year zero-padded so the YYYY-MM-DD contract holds below year 1000 too.
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`

/**
 * UTC-midnight Date for civil (year, monthIndex, day) parts — the package's
 * single civil-date constructor. Same `new Date(0)` + setUTCFullYear idiom as
 * the engine's platform/business-date.ts utcDateFromParts (which keeps
 * literal years 0001-0099 that Date.UTC would remap onto 1900-1999): this
 * package sits below the engine and must not import it.
 */
export function utcCivilDate(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  // Year/month/day first, time second: an out-of-range time carries into the
  // date (hour 24 is the next day), and the reverse order would overwrite it.
  const date = new Date(0)
  date.setUTCFullYear(year, monthIndex, day)
  date.setUTCHours(hour, minute, second, ms)
  return date
}

/** [year, month(1-12), day] from an ISO `yyyy-mm-dd` string. */
function parts(dateIso: string): [number, number, number] {
  return [Number(dateIso.slice(0, 4)), Number(dateIso.slice(5, 7)), Number(dateIso.slice(8, 10))]
}

/** Last calendar day of month `m` (1-12) in year `y`. */
export function lastDayOfMonth(y: number, m: number): number {
  // Month arg is 0-based, so month `m` day 0 == last day of month m.
  return utcCivilDate(y, m, 0).getUTCDate()
}

export function startOfMonth(y: number, m: number): string {
  return iso(y, m, 1)
}
export function endOfMonth(y: number, m: number): string {
  return iso(y, m, lastDayOfMonth(y, m))
}

/** Add `n` months to a (year, month 1-12) pair, normalising into a new pair. */
export function addMonths(y: number, m: number, n: number): [number, number] {
  const total = y * 12 + (m - 1) + n
  return [Math.floor(total / 12), (total % 12) + 1]
}

/** Add `n` days to an ISO date (UTC-safe; crosses month/year boundaries). */
export function addDays(dateIso: string, n: number): string {
  const [y, m, d] = parts(dateIso)
  const dt = utcCivilDate(y, m - 1, d + n)
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

/** Add `n` months to a full ISO date, clamping the day to the target month. */
export function addMonthsIso(dateIso: string, n: number): string {
  const [y, m, d] = parts(dateIso)
  const [ny, nm] = addMonths(y, m, n)
  return iso(ny, nm, Math.min(d, lastDayOfMonth(ny, nm)))
}

/** The fiscal year (named by its END calendar year) that a date falls in. */
export function fiscalYearOf(dateIso: string, startMonth: number): number {
  const [y, m] = parts(dateIso)
  if (startMonth === 1) return y
  return m >= startMonth ? y + 1 : y
}

/** First calendar (year, month) of the fiscal year ending in `fyEndYear`. */
function fyStartYM(fyEndYear: number, startMonth: number): [number, number] {
  return startMonth === 1 ? [fyEndYear, 1] : [fyEndYear - 1, startMonth]
}

/** Start/end ISO dates + label for a whole fiscal year (named by end year). */
export function fiscalYearRangeFor(fyEndYear: number, startMonth: number): DateRange {
  const [sy, sm] = fyStartYM(fyEndYear, startMonth)
  const [ey, em] = addMonths(sy, sm, 11)
  return { from: startOfMonth(sy, sm), to: endOfMonth(ey, em), label: `FY ${fyEndYear}` }
}

/** Inclusive first day of the fiscal year that contains `asOf`. */
export function fiscalYearStartOn(asOf: string, startMonth: number): string {
  return fiscalYearRangeFor(fiscalYearOf(asOf, startMonth), startMonth).from
}

/** Inclusive last day of the fiscal year that ended before the year of `asOf`. */
export function priorFiscalYearEndOn(asOf: string, startMonth: number): string {
  return addDays(fiscalYearStartOn(asOf, startMonth), -1)
}

/** Months elapsed from the fiscal-year start to `dateIso` (0-based, 0…11). */
export function fiscalMonthOffset(dateIso: string, startMonth: number): number {
  const [sy, sm] = fyStartYM(fiscalYearOf(dateIso, startMonth), startMonth)
  const [y, m] = parts(dateIso)
  return y * 12 + (m - 1) - (sy * 12 + (sm - 1))
}

/** Fiscal quarter `q` (1-4) of the fiscal year ending `fyEndYear`. */
export function fiscalQuarterRange(fyEndYear: number, q: number, startMonth: number): DateRange {
  const [sy, sm] = fyStartYM(fyEndYear, startMonth)
  const [qy, qm] = addMonths(sy, sm, (q - 1) * 3)
  const [ey, em] = addMonths(qy, qm, 2)
  return { from: startOfMonth(qy, qm), to: endOfMonth(ey, em), label: `Q${q} FY ${fyEndYear}` }
}

/** Fiscal half `h` (1-2) of the fiscal year ending `fyEndYear`. */
export function fiscalHalfRange(fyEndYear: number, h: number, startMonth: number): DateRange {
  const [sy, sm] = fyStartYM(fyEndYear, startMonth)
  const [hy, hm] = addMonths(sy, sm, (h - 1) * 6)
  const [ey, em] = addMonths(hy, hm, 5)
  return { from: startOfMonth(hy, hm), to: endOfMonth(ey, em), label: `H${h} FY ${fyEndYear}` }
}

/** Fiscal period/month `p` (1-12) of the fiscal year ending `fyEndYear`. The
 *  label is the calendar month it maps to (e.g. `2026-07`). */
export function fiscalPeriodRange(fyEndYear: number, p: number, startMonth: number): DateRange {
  const [sy, sm] = fyStartYM(fyEndYear, startMonth)
  const [py, pm] = addMonths(sy, sm, p - 1)
  return { from: startOfMonth(py, pm), to: endOfMonth(py, pm), label: `${py}-${pad(pm)}` }
}

/** Enumerate the fiscal months (as ranges) overlapping an inclusive window —
 *  drives per-month breakout columns. Capped defensively at 60. */
export function fiscalMonthsBetween(from: string, to: string): DateRange[] {
  const out: DateRange[] = []
  let [y, m] = parts(from)
  const [ty, tm] = parts(to)
  for (let guard = 0; guard < 60; guard++) {
    if (y * 12 + m > ty * 12 + tm) break
    out.push({ from: startOfMonth(y, m), to: endOfMonth(y, m), label: `${y}-${pad(m)}` })
    ;[y, m] = addMonths(y, m, 1)
  }
  return out
}

/** Enumerate the fiscal quarters overlapping an inclusive window. */
export function fiscalQuartersBetween(from: string, to: string, startMonth: number): DateRange[] {
  const startFy = fiscalYearOf(from, startMonth)
  const startQ = Math.floor(fiscalMonthOffset(from, startMonth) / 3) + 1
  const out: DateRange[] = []
  let fy = startFy
  let q = startQ
  for (let guard = 0; guard < 40; guard++) {
    const r = fiscalQuarterRange(fy, q, startMonth)
    if (r.from > to) break
    out.push(r)
    q += 1
    if (q > 4) {
      q = 1
      fy += 1
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Declared-period helpers — retail/custom fiscal calendars
// ---------------------------------------------------------------------------
//
// Calendar math above assumes every fiscal period is a calendar month. Orgs on
// a week-based retail calendar (four_four_five / four_five_four /
// five_four_four / thirteen_period) or a custom calendar declare their real
// periods in `accounting_periods` instead: 4- and 5-week spans whose
// boundaries never align to month ends. These pure helpers derive breakout
// columns and preset windows from those DECLARED periods. Callers load the
// rows (default active calendar, non-adjustment only) and pass them in; with
// no rows every consumer falls back to calendar math, so monthly-cadence orgs
// are unaffected.

/**
 * One declared fiscal period (an `accounting_periods` row minus its ids):
 * inclusive ISO bounds plus the stored fiscal year / period number / name.
 */
export type FiscalPeriod = {
  fiscalYear: number
  periodNumber: number
  name: string
  from: string
  to: string
}

/** Quarter (1-4) a declared period belongs to within its fiscal year: three
 *  periods per quarter (Q1 = P1–P3); a trailing remainder (e.g. P13 of a
 *  thirteen-period year, or extra custom periods) joins Q4 rather than
 *  opening a phantom Q5. Matches `close.ts` quarter applicability
 *  (`periodNumber % 3 === 0` closes Q1 at P3, Q2 at P6, …). */
export function declaredPeriodQuarter(periodNumber: number): number {
  return Math.min(3, Math.floor((periodNumber - 1) / 3)) + 1
}

function declaredOverlaps(p: FiscalPeriod, from: string, to: string): boolean {
  return p.from <= to && p.to >= from
}

/** The declared period holding `date`, or null when no declared period covers it. */
export function declaredPeriodContaining(periods: FiscalPeriod[], date: string): FiscalPeriod | null {
  const sorted = [...periods].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  return sorted.find((p) => p.from <= date && date <= p.to) ?? null
}

/**
 * Month-breakout columns from declared periods: every declared period
 * overlapping `[from, to]` is ONE column at its full bounds labelled with the
 * fiscal period name — so a 5-week period never splits across two calendar
 * columns. Capped defensively at 60 like `fiscalMonthsBetween`.
 */
export function declaredPeriodColumns(periods: FiscalPeriod[], from: string, to: string): DateRange[] {
  const sorted = [...periods].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  return sorted
    .filter((p) => declaredOverlaps(p, from, to))
    .slice(0, 60)
    .map((p) => ({ from: p.from, to: p.to, label: p.name }))
}

/**
 * Quarter-breakout columns group the calendar's declared periods: each
 * `(fiscalYear, quarter)` group with at least one period overlapping
 * `[from, to]` is one column spanning the group's full bounds, labelled
 * `Q{q} FY {fy}` exactly like `fiscalQuarterRange`.
 */
export function declaredQuarterColumns(periods: FiscalPeriod[], from: string, to: string): DateRange[] {
  const groups = new Map<string, { fy: number; q: number; from: string; to: string; overlaps: boolean }>()
  for (const p of periods) {
    const q = declaredPeriodQuarter(p.periodNumber)
    const key = `${p.fiscalYear}:${q}`
    const g = groups.get(key)
    // Bounds span the whole known group (like calendar quarters span the
    // full quarter even for a mid-quarter window); the group becomes a
    // column when at least one member overlaps the window.
    if (!g) groups.set(key, { fy: p.fiscalYear, q, from: p.from, to: p.to, overlaps: declaredOverlaps(p, from, to) })
    else {
      if (p.from < g.from) g.from = p.from
      if (p.to > g.to) g.to = p.to
      g.overlaps = g.overlaps || declaredOverlaps(p, from, to)
    }
  }
  return [...groups.values()]
    .filter((g) => g.overlaps)
    .sort((a, b) => a.from.localeCompare(b.from))
    .slice(0, 40)
    .map((g) => ({ from: g.from, to: g.to, label: `Q${g.q} FY ${g.fy}` }))
}

/** True when the declared periods fully cover `[from, to]` with no gaps — the
 *  precondition for using declared columns instead of calendar math (which
 *  would otherwise silently drop activity dated outside generated periods). */
export function declaredPeriodsCover(periods: FiscalPeriod[], from: string, to: string): boolean {
  const overlapping = [...periods].filter((p) => declaredOverlaps(p, from, to)).sort((a, b) => a.from.localeCompare(b.from))
  if (!overlapping.length || overlapping[0]!.from > from) return false
  let covered = overlapping[0]!.to
  if (covered >= to) return true
  for (const p of overlapping.slice(1)) {
    if (p.from > addDays(covered, 1)) return false
    if (p.to > covered) covered = p.to
    if (covered >= to) return true
  }
  return false
}

/** Whole declared fiscal year holding `date`: P1's start through the year's
 *  last declared period's end. Null when the year has no declared periods. */
export function declaredFiscalYearRange(periods: FiscalPeriod[], date: string): (DateRange & { fiscalYear: number }) | null {
  const holding = declaredPeriodContaining(periods, date)
  if (!holding) return null
  const year = periods.filter((p) => p.fiscalYear === holding.fiscalYear)
  if (!year.length) return null
  const from = year.reduce((a, b) => (a < b.from ? a : b.from), year[0]!.from)
  const to = year.reduce((a, b) => (a > b.to ? a : b.to), year[0]!.to)
  return { from, to, label: `FY ${holding.fiscalYear}`, fiscalYear: holding.fiscalYear }
}

/** Declared quarter holding `date` (same grouping as `declaredQuarterColumns`). */
export function declaredQuarterContaining(periods: FiscalPeriod[], date: string): DateRange | null {
  const holding = declaredPeriodContaining(periods, date)
  if (!holding) return null
  const q = declaredPeriodQuarter(holding.periodNumber)
  const group = periods.filter((p) => p.fiscalYear === holding.fiscalYear && declaredPeriodQuarter(p.periodNumber) === q)
  if (!group.length) return null
  const from = group.reduce((a, b) => (a < b.from ? a : b.from), group[0]!.from)
  const to = group.reduce((a, b) => (a > b.to ? a : b.to), group[0]!.to)
  return { from, to, label: `Q${q} FY ${holding.fiscalYear}` }
}
