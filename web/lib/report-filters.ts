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
import type { ReportDrillTarget } from './report-drill'

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
  /** Subsidiary context node; unset = the root (consolidated). */
  subsidiaryId?: string
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
  sub: 'sub',
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

function segmentFilters(sp: ParamSource): Record<string, string> {
  const entries = sp instanceof URLSearchParams ? [...sp.entries()] : Object.entries(sp)
  return Object.fromEntries(
    entries
      .filter(([key, value]) => key.startsWith('seg_') && /^[a-z][a-z0-9_]{0,62}$/.test(key.slice(4)) && typeof value === 'string' && value)
      .map(([key, value]) => [key.slice(4), String(value)]),
  )
}

/** Parse a filter query from search params, applying safe defaults. */
export function parseReportQuery(sp: ParamSource): ReportQuery {
  const periodRaw = read(sp, REPORT_PARAM_KEYS.period)
  return {
    period: isPeriodPreset(periodRaw) ? periodRaw! : DEFAULT_PERIOD_PRESET,
    from: read(sp, REPORT_PARAM_KEYS.from) || undefined,
    to: read(sp, REPORT_PARAM_KEYS.to) || undefined,
    breakout: (() => {
      const value = read(sp, REPORT_PARAM_KEYS.breakout)
      return value?.startsWith('segment:') && /^[a-z][a-z0-9_]{0,62}$/.test(value.slice(8))
        ? value as StatementBreakout
        : oneOf(value, BREAKOUTS, 'none')
    })(),
    compare: oneOf(read(sp, REPORT_PARAM_KEYS.compare), COMPARES, 'none'),
    basis: oneOf(read(sp, REPORT_PARAM_KEYS.basis), BASES, 'accrual'),
    dims: {
      departmentId: read(sp, REPORT_PARAM_KEYS.dept) || undefined,
      projectId: read(sp, REPORT_PARAM_KEYS.project) || undefined,
      locationId: read(sp, REPORT_PARAM_KEYS.location) || undefined,
      classId: read(sp, REPORT_PARAM_KEYS.class) || undefined,
      segments: segmentFilters(sp),
    },
    subsidiaryId: read(sp, REPORT_PARAM_KEYS.sub) || undefined,
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
  for (const [key, value] of Object.entries(q.dims.segments ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    p.set(`seg_${key}`, value)
  }
  if (q.subsidiaryId) p.set(k.sub, q.subsidiaryId)
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

export type DrillColumn = {
  kind: StatementColumnKind
  from?: string | null
  to?: string
  dimField?: 'department' | 'project' | 'location' | 'class'
  dimValue?: string | null
  segmentKey?: string
}

/** Build the typed supporting-detail target for one statement cell. */
export function buildDrillTarget(args: {
  accountId?: string
  drillTypes?: string[]
  column: DrillColumn
  sourceColumns?: DrillColumn[]
  mode: StatementMode
  reportDims: StatementDimFilter
  basis: StatementBasis
  /** Subsidiary context node used by the shared drawer query. */
  subsidiaryId?: string
  label: string
  budgetScenarioId?: string
}): ReportDrillTarget | null {
  const { column } = args
  if (args.budgetScenarioId && (column.kind !== 'amount' || !column.to)) {
    return {
      kind: 'budget',
      label: args.label,
      scenarioId: args.budgetScenarioId,
      scope: column.kind === 'amount' ? 'budget' : 'variance',
      accountIds: args.accountId ? [args.accountId] : undefined,
      accountTypes: args.drillTypes,
      dims: args.reportDims,
    }
  }
  const sourceColumns = column.kind === 'amount'
    ? [column]
    : (args.sourceColumns ?? []).filter((source) => source.kind === 'amount' && source.to)
  const dated = sourceColumns.filter((source): source is DrillColumn & { to: string } => !!source.to)
  if (dated.length === 0) return null
  // Unassigned breakout bucket needs an "is null" filter we don't express in URLs.
  if ((column.dimField || column.segmentKey) && (column.dimValue === null || column.dimValue === undefined)) return null
  if (!args.accountId && !(args.drillTypes && args.drillTypes.length)) return null

  const froms = dated.map((source) => source.from).filter((value): value is string => !!value)
  const tos = dated.map((source) => source.to)
  const from = froms.length ? froms.reduce((a, b) => (a < b ? a : b)) : undefined
  const to = tos.reduce((a, b) => (a > b ? a : b))

  const dims: StatementDimFilter = { ...args.reportDims }
  if (column.dimField && column.dimValue) {
    const key = column.dimField
    if (key === 'department') dims.departmentId = column.dimValue
    else if (key === 'project') dims.projectId = column.dimValue
    else if (key === 'location') dims.locationId = column.dimValue
    else if (key === 'class') dims.classId = column.dimValue
  }
  if (column.segmentKey && column.dimValue) {
    dims.segments = { ...(dims.segments ?? {}), [column.segmentKey]: column.dimValue }
  }
  return {
    kind: 'ledger',
    label: args.label,
    accountIds: args.accountId ? [args.accountId] : undefined,
    accountTypes: args.accountId ? undefined : args.drillTypes,
    mode: args.mode,
    from: args.mode === 'flow' ? from : undefined,
    to,
    dims,
    subsidiaryId: args.subsidiaryId,
    basis: args.basis,
  }
}
