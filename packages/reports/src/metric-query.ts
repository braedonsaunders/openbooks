import { REPORT_ENTITY_MAP } from './entities'
import { isBaseMoneyMeasure, isTxnCurrencyMeasure, REPORT_BOOK_KEYS } from './custom-query'
import { validateCustomQuery, ReportQueryValidationError } from './validate'
import type { ReportCustomQuery, ReportFormulaExpr } from './types'

/** Project a native report onto a small metric band. Financial measures,
 * filters, formula guards and denomination controls stay with the report
 * engine; additive metrics aggregate in SQL instead of transferring and
 * totalling thousands of customer/item groups in the application. */
export function reportMetricQuery(source: ReportCustomQuery, visibleLimit = 4): ReportCustomQuery {
  const query = validateCustomQuery(source)
  if (query.mode !== 'summarize') throw new ReportQueryValidationError('This analytics card requires a summary report. Open Reports to configure summarized measures.')
  const entity = REPORT_ENTITY_MAP[query.entity]!
  const measures = query.measures ?? []
  const selected = new Set(measures.filter((measure) => !measure.hidden).slice(0, visibleLimit))
  const needed = new Set(selected)
  const byKey = new Map(measures.flatMap((measure) => measure.key ? [[measure.key, measure] as const] : []))
  const include = (key: string) => {
    const measure = byKey.get(key)
    if (!measure || needed.has(measure)) return
    needed.add(measure)
    if (measure.expr) walk(measure.expr)
    for (const guard of measure.guards ?? []) include(guard.measure)
  }
  const walk = (expr: ReportFormulaExpr): void => {
    if ('ref' in expr) include(expr.ref)
    else if ('op' in expr) { walk(expr.left); walk(expr.right) }
  }
  for (const measure of selected) {
    if (measure.expr) walk(measure.expr)
    for (const guard of measure.guards ?? []) include(guard.measure)
  }
  const projected = measures.filter((measure) => needed.has(measure)).map((measure) => selected.has(measure) ? measure : { ...measure, hidden: true })
  // Opening/closing/latest depend on the original bucket partition. Preserve
  // it rather than turning per-program balances into one global latest row.
  const temporal = projected.some((measure) => ['opening', 'closing', 'latest'].includes(measure.fn))
  const denominations = new Set<string>([
    ...(projected.some((measure) => isBaseMoneyMeasure(entity, measure)) && entity.baseCurrencyColumn ? [entity.baseCurrencyColumn] : []),
    ...(projected.some((measure) => isTxnCurrencyMeasure(entity, measure)) && entity.currencyColumn ? [entity.currencyColumn] : []),
  ])
  const breakouts = (query.breakouts ?? []).filter((breakout) => temporal || denominations.has(breakout.column) || REPORT_BOOK_KEYS.some((key) => key === breakout.column))
  if (query.groupBy && REPORT_BOOK_KEYS.some((key) => key === query.groupBy) && !breakouts.some((breakout) => breakout.column === query.groupBy)) breakouts.push({ column: query.groupBy })
  for (const column of denominations) if (!breakouts.some((breakout) => breakout.column === column)) breakouts.push({ column })
  return validateCustomQuery({ ...query, columns: [], measures: projected, breakouts, sorts: [], groupBy: null, totals: null, limit: 10_000 })
}
