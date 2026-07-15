// Shared URL-search-param codec for the financial-statement filter bar. Every
// statement page and export route parses its filters through here so the
// controls, the on-screen report, and the PDF/XLSX export all agree. Kept free
// of `server-only` and of runtime imports from the (server-only) matrix engine
// — the value unions are imported type-only so this module is safe to bundle
// into the client filter bar too.

import { DEFAULT_PERIOD_PRESET, isPeriodPreset } from '@openbooks/reports'
import type {
  StatementBasis,
  StatementBreakout,
  StatementColumnKind,
  StatementCompare,
  StatementDimFilter,
  StatementMode,
} from './statement-matrix'

export type ReportScale = 'actual' | 'thousands' | 'millions'

export type ReportQuery = {
  /** Period preset id (see PERIOD_PRESETS); `custom` uses `from`/`to`. */
  period: string
  from?: string
  to?: string
  breakout: StatementBreakout
  compare: StatementCompare
  basis: StatementBasis
  dims: StatementDimFilter
  showZero: boolean
  scale: ReportScale
}

const BREAKOUTS: StatementBreakout[] = ['none', 'department', 'project', 'location', 'class', 'month', 'quarter']
const COMPARES: StatementCompare[] = ['none', 'prior_period', 'prior_year']
const BASES: StatementBasis[] = ['accrual', 'cash']
const SCALES: ReportScale[] = ['actual', 'thousands', 'millions']

/** URL param keys — stable; persisted in saved views. */
export const REPORT_PARAM_KEYS = {
  period: 'period',
  from: 'from',
  to: 'to',
  breakout: 'breakout',
  compare: 'compare',
  basis: 'basis',
  dept: 'dept',
  project: 'project',
  location: 'location',
  class: 'class',
  zero: 'zero',
  scale: 'scale',
} as const

type ParamSource = URLSearchParams | Record<string, string | undefined>

function read(sp: ParamSource, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined
  return sp[key]
}

function oneOf<T extends string>(v: string | undefined, allowed: T[], fallback: T): T {
  return v && (allowed as string[]).includes(v) ? (v as T) : fallback
}

/** Parse a filter query from search params, applying safe defaults. */
export function parseReportQuery(sp: ParamSource): ReportQuery {
  const periodRaw = read(sp, REPORT_PARAM_KEYS.period)
  return {
    period: isPeriodPreset(periodRaw) ? periodRaw! : DEFAULT_PERIOD_PRESET,
    from: read(sp, REPORT_PARAM_KEYS.from) || undefined,
    to: read(sp, REPORT_PARAM_KEYS.to) || undefined,
    breakout: oneOf(read(sp, REPORT_PARAM_KEYS.breakout), BREAKOUTS, 'none'),
    compare: oneOf(read(sp, REPORT_PARAM_KEYS.compare), COMPARES, 'none'),
    basis: oneOf(read(sp, REPORT_PARAM_KEYS.basis), BASES, 'accrual'),
    dims: {
      departmentId: read(sp, REPORT_PARAM_KEYS.dept) || undefined,
      projectId: read(sp, REPORT_PARAM_KEYS.project) || undefined,
      locationId: read(sp, REPORT_PARAM_KEYS.location) || undefined,
      classId: read(sp, REPORT_PARAM_KEYS.class) || undefined,
    },
    showZero: read(sp, REPORT_PARAM_KEYS.zero) === '1',
    scale: oneOf(read(sp, REPORT_PARAM_KEYS.scale), SCALES, 'actual'),
  }
}

/** Serialize a query back to URLSearchParams (omitting defaults for clean URLs). */
export function toSearchParams(q: ReportQuery): URLSearchParams {
  const p = new URLSearchParams()
  const k = REPORT_PARAM_KEYS
  if (q.period && q.period !== DEFAULT_PERIOD_PRESET) p.set(k.period, q.period)
  if (q.period === 'custom') {
    if (q.from) p.set(k.from, q.from)
    if (q.to) p.set(k.to, q.to)
  }
  if (q.breakout !== 'none') p.set(k.breakout, q.breakout)
  if (q.compare !== 'none') p.set(k.compare, q.compare)
  if (q.basis !== 'accrual') p.set(k.basis, q.basis)
  if (q.dims.departmentId) p.set(k.dept, q.dims.departmentId)
  if (q.dims.projectId) p.set(k.project, q.dims.projectId)
  if (q.dims.locationId) p.set(k.location, q.dims.locationId)
  if (q.dims.classId) p.set(k.class, q.dims.classId)
  if (q.showZero) p.set(k.zero, '1')
  if (q.scale !== 'actual') p.set(k.scale, q.scale)
  return p
}

/** Divisor for a scale, plus the "in thousands/millions" note (empty when actual). */
export function scaleFactor(scale: ReportScale): { divisor: number; note: string } {
  if (scale === 'thousands') return { divisor: 1000, note: 'In thousands' }
  if (scale === 'millions') return { divisor: 1_000_000, note: 'In millions' }
  return { divisor: 1, note: '' }
}

// --- drill-through -----------------------------------------------------------
// Every statement value can drill to the journal lines behind it. The URL
// carries the account scope (a single account + its subtree, OR a set of
// account types for a subtotal), the column's date window + dimension slice,
// the report basis, and a `back` link to the exact report.

const DIM_PARAM: Record<'department' | 'project' | 'location' | 'class', keyof typeof REPORT_PARAM_KEYS> = {
  department: 'dept',
  project: 'project',
  location: 'location',
  class: 'class',
}

export type DrillColumn = {
  kind: StatementColumnKind
  from?: string | null
  to?: string
  dimField?: 'department' | 'project' | 'location' | 'class'
  dimValue?: string | null
}

/** Build the `/reports/detail` href for one statement cell, or null if the cell
 *  isn't drillable (variance column, no date window, Unassigned bucket, or a row
 *  with no account scope). */
export function buildDrillHref(args: {
  accountId?: string
  drillTypes?: string[]
  column: DrillColumn
  mode: StatementMode
  reportDims: StatementDimFilter
  basis: StatementBasis
  back: string
  backLabel: string
  label: string
}): string | null {
  const { column } = args
  if (column.kind !== 'amount') return null
  if (!column.to) return null
  // Unassigned breakout bucket needs an "is null" filter we don't express in URLs.
  if (column.dimField && (column.dimValue === null || column.dimValue === undefined)) return null
  if (!args.accountId && !(args.drillTypes && args.drillTypes.length)) return null

  const p = new URLSearchParams()
  if (args.accountId) p.set('accounts', args.accountId)
  else p.set('types', args.drillTypes!.join(','))
  p.set('mode', args.mode)
  p.set('to', column.to)
  if (args.mode === 'flow' && column.from) p.set('from', column.from)

  const dims: StatementDimFilter = { ...args.reportDims }
  if (column.dimField && column.dimValue) {
    const key = column.dimField
    if (key === 'department') dims.departmentId = column.dimValue
    else if (key === 'project') dims.projectId = column.dimValue
    else if (key === 'location') dims.locationId = column.dimValue
    else if (key === 'class') dims.classId = column.dimValue
  }
  if (dims.departmentId) p.set('dept', dims.departmentId)
  if (dims.projectId) p.set('project', dims.projectId)
  if (dims.locationId) p.set('location', dims.locationId)
  if (dims.classId) p.set('class', dims.classId)
  if (args.basis !== 'accrual') p.set('basis', args.basis)
  p.set('label', args.label)
  p.set('backLabel', args.backLabel)
  p.set('back', args.back)
  return `/reports/detail?${p.toString()}`
}

export type DrillQuery = {
  accountIds: string[]
  accountTypes: string[]
  from?: string
  to: string
  mode: StatementMode
  dims: StatementDimFilter
  basis: StatementBasis
  label: string
  backLabel: string
  /** Safe internal back link (only /reports… is honored). */
  back: string
}

/** Parse the drill params on the detail page. */
export function parseDrillQuery(sp: ParamSource): DrillQuery {
  const back = read(sp, 'back') || '/reports'
  return {
    accountIds: (read(sp, 'accounts') || '').split(',').filter(Boolean),
    accountTypes: (read(sp, 'types') || '').split(',').filter(Boolean),
    from: read(sp, 'from') || undefined,
    to: read(sp, 'to') || new Date().toISOString().slice(0, 10),
    mode: read(sp, 'mode') === 'balance' ? 'balance' : 'flow',
    dims: {
      departmentId: read(sp, 'dept') || undefined,
      projectId: read(sp, 'project') || undefined,
      locationId: read(sp, 'location') || undefined,
      classId: read(sp, 'class') || undefined,
    },
    basis: read(sp, 'basis') === 'cash' ? 'cash' : 'accrual',
    label: read(sp, 'label') || '',
    backLabel: read(sp, 'backLabel') || '',
    back: back.startsWith('/reports') ? back : '/reports',
  }
}
