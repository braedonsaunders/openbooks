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
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/** [year, month(1-12), day] from an ISO `yyyy-mm-dd` string. */
function parts(dateIso: string): [number, number, number] {
  return [Number(dateIso.slice(0, 4)), Number(dateIso.slice(5, 7)), Number(dateIso.slice(8, 10))]
}

/** Last calendar day of month `m` (1-12) in year `y`. */
export function lastDayOfMonth(y: number, m: number): number {
  // Date.UTC month arg is 0-based, so month `m` day 0 == last day of month m.
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
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
  const dt = new Date(Date.UTC(y, m - 1, d + n))
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
