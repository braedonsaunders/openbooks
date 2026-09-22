import { reportEntityCatalog, validateCatalogReportQuery } from './custom-record-report-catalog'
import 'server-only'
import { trueCostExportData } from './analytics/true-cost-report'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  applyBuiltInUrlFilters,
  BUILT_IN_REPORT_DEFINITION_MAP,
  REPORT_ENTITY_MAP,
  type ReportCustomQuery,
  type ReportRuleGroup,
} from '@openbooks/reports'
import {
  agingByParty,
  cashFlow,
  cashFlowIndirect,
  generalLedger,
  journalReport,
  partnerBalances,
  partnerStatement,
  partyRegister,
  projectProfitability,
  resolveAgingAsOf,
  trialBalance,
  type AgingSide,
  type DimFilter,
} from './reports'
import { balanceSheetView, profitAndLossView, type StatementView } from './statement-matrix'
import { budgetVsActualView } from './budget-report'
import {
  agingExportData,
  cashFlowExportData,
  cashFlowIndirectExportData,
  generalLedgerExportData,
  journalExportData,
  partnersExportData,
  partnerStatementExportData,
  projectProfitabilityExportData,
  registerExportData,
  runResultToExportData,
  statementViewToExportData,
  trialBalanceExportData,
  type ExportData,
  type Translator,
} from './report-pdf'
import {
  applyPeriodOverride,
  executeReportAllPages,
  mergeReportFilters,
  reportPeriodField,
  streamPagedReportCsv,
  streamPagedReportXlsx,
} from './custom-reports'
import { isReportUuidParam, type ReportQuery } from './report-filters'
import { isFeatureEnabled } from './features'
import { requireReportAuthz, canAccessReportDefinition, type ReportAuthorization } from './report-execution-context'
import { resolveSubsidiaryView } from './consolidation'
import { resolvePeriod } from './periods'
import { STATEMENT_KIND_FEATURE } from './report-authz'
import { reportBookSelection } from './report-books'

/**
 * The single catalog of built-in report "kinds" and the one place that turns
 * any of them + params into a common content contract. This is the unification
 * substrate: the export route, the on-screen paper preview, and (later) the
 * scheduler all call `resolveReport()` so every report — standard or custom —
 * flows through the same basis. Statement-grade reports (P&L, Balance Sheet,
 * Budget) resolve to a rich `StatementView` (kept for the multi-column PDF and
 * drill-through); everything else resolves to the flat `ExportData` shape that
 * BOTH engines already emit for PDF/XLSX/CSV.
 */
export const REPORT_KINDS = [
  'pnl',
  'balance-sheet',
  'trial-balance',
  'partners',
  'aging',
  'cash-flow',
  'cash-flow-indirect',
  'general-ledger',
  'journal',
  'registers',
  'budget',
  'partner-statement',
  'project-profitability',
  'true-cost',
] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

/** Kinds that render through the multi-column statement engine (StatementView). */
export const VIEW_KINDS = new Set<ReportKind>(['pnl', 'balance-sheet', 'budget'])

export function isReportKind(k: string): k is ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(k)
}

export type ResolvedPeriod = { from: string; to: string; label: string }

/**
 * The rich, drill-through page for a seeded statement definition. Statement
 * reports keep their bespoke matrix pages (compare columns, breakouts, drill),
 * so the query-builder/runner redirect statement definitions here rather than
 * flattening them. Reverse of the seed catalog's kind→page mapping.
 */
export function statementPageHref(statement: { kind?: string; params?: Record<string, string> } | null): string {
  const kind = statement?.kind
  const p = statement?.params ?? {}
  switch (kind) {
    case 'pnl':
      return '/reports/pnl'
    case 'balance-sheet':
      return '/reports/balance-sheet'
    case 'cash-flow':
      return '/reports/cash-flow'
    case 'cash-flow-indirect':
      return '/reports/cash-flow-indirect'
    case 'trial-balance':
      return '/reports/trial-balance'
    case 'general-ledger':
      return '/reports/general-ledger'
    case 'journal':
      return '/reports/journal'
    case 'project-profitability':
      return '/reports/project-profitability'
    case 'true-cost':
      return '/reports/true-cost'
    case 'aging':
      return `/reports/aging?side=${p.side ?? 'ar'}`
    case 'registers':
      return `/reports/registers?side=${p.side ?? 'ar'}`
    case 'partners':
      return `/reports/partners?kind=${p.kind ?? 'receivable'}`
    default:
      return '/reports'
  }
}

/**
 * The common content contract every report resolves to. `view` carries the
 * hierarchical statement (multi-column, drillable) for VIEW_KINDS; `data` is
 * the flat paper/export shape for the rest. A caller picks its representation
 * per output format.
 */
export type ResolvedReport =
  | { render: 'view'; view: StatementView; title: string; periodPhrase: string }
  | { render: 'data'; data: ExportData }

export type ResolveReportCtx = {
  orgId: string
  t: Translator
  period: ResolvedPeriod
  query: ReportQuery
}

/**
 * Turn one built-in report kind + its request params into the common content
 * contract. Extracted verbatim from the statement export route so exports, the
 * on-screen paper view, and scheduling share exactly one implementation.
 */
export async function resolveReport(kind: ReportKind, p: URLSearchParams, ctx: ResolveReportCtx): Promise<ResolvedReport> {
  const { orgId, t, period, query: q } = ctx
  const featureKey = STATEMENT_KIND_FEATURE[kind]
  if (featureKey && !(await isFeatureEnabled(orgId, featureKey))) {
    throw new Error(`${featureKey} feature is disabled`)
  }
  // Subsidiary context: exports and scheduled runs honor the same picker value
  // as the on-screen report (consolidated subtree + translation included).
  const authz = await requireReportAuthz(orgId)
  const subView = await resolveSubsidiaryView(q.subsidiaryId, period.to, authz.allowedSubsidiaryIds)
  const dims: DimFilter = {
    departmentId: q.dims.departmentId,
    projectId: q.dims.projectId,
    locationId: q.dims.locationId,
    classId: q.dims.classId,
    segments: q.dims.segments,
    subsidiaryIds: subView.subsidiary?.ids,
    // Unrestricted root-covering views read root-owned (null subsidiary)
    // documents alongside attributed ones; restricted views stay fail-closed.
    includeNullSubsidiary: subView.subsidiary?.includeNullSubsidiary === true,
  }
  const secTotal = (section: string) => t('statement.sectionTotal', { section })

  // --- Multi-column statement views (P&L, Balance Sheet, Budget) -------------
  if (VIEW_KINDS.has(kind)) {
    let view: StatementView | null = null
    let title = ''
    let periodPhrase = ''
    const selectedBook = kind === 'budget' ? undefined : (await reportBookSelection(orgId, p.get('book'))).selectedBook
    const matrixOpts = { orgId, bookId: selectedBook?.id, breakout: q.breakout, compare: q.compare, basis: q.basis, dims: q.dims, subsidiary: subView.subsidiary, showZero: q.showZero }
    if (kind === 'pnl') {
      title = t('pnl.title')
      periodPhrase = t('pnl.dateRange', { from: period.from, to: period.to })
      view = await profitAndLossView(
        { from: period.from, to: period.to },
        period.label,
        {
          revenue: t('pnl.revenue'),
          costOfGoodsSold: t('pnl.costOfGoodsSold'),
          grossProfit: t('pnl.grossProfit'),
          expenses: t('pnl.expenses'),
          netIncome: t('pnl.netIncome'),
          totalOf: secTotal,
        },
        matrixOpts,
      )
    } else if (kind === 'balance-sheet') {
      title = t('balanceSheet.title')
      periodPhrase = t('balanceSheet.asOf', { date: period.to })
      view = await balanceSheetView(
        { from: period.from, to: period.to },
        period.label,
        {
          assets: t('balanceSheet.assets'),
          liabilities: t('balanceSheet.liabilities'),
          equity: t('balanceSheet.equity'),
          totalAssets: secTotal(t('balanceSheet.assets')),
          totalLiabilities: secTotal(t('balanceSheet.liabilities')),
          totalEquity: secTotal(t('balanceSheet.equity')),
          retainedEarningsPrior: t('statement.retainedEarningsPrior'),
          currentYearEarnings: t('statement.currentYearEarnings'),
          translationAdjustment: t('statement.translationAdjustment'),
          liabilitiesAndEquity: t('balanceSheet.liabilitiesAndEquity'),
          totalOf: secTotal,
        },
        matrixOpts,
      )
    } else {
      title = t('budget.title')
      periodPhrase = `${t('budget.description')} · ${t('pnl.dateRange', { from: period.from, to: period.to })}`
      const scenario = p.get('scenario')
      if (scenario) {
        view = await budgetVsActualView(scenario, orgId, {
          actual: t('budget.actual'),
          budget: t('budget.budget'),
          variance: t('budget.variance'),
          variancePct: t('budget.variancePct'),
          revenue: t('pnl.revenue'),
          costOfGoodsSold: t('pnl.costOfGoodsSold'),
          grossProfit: t('pnl.grossProfit'),
          expenses: t('pnl.expenses'),
          netIncome: t('pnl.netIncome'),
          totalOf: secTotal,
        }, q.dims, dims.subsidiaryIds, { from: period.from, to: period.to })
      }
    }
    if (!view) throw new Error('no data')
    if (selectedBook) periodPhrase = `${selectedBook.name} · ${periodPhrase}`
    return { render: 'view', view, title, periodPhrase }
  }

  // --- Detail reports (flat tables) -----------------------------------------
  // Every journal-backed detail path reads the same validated book as the
  // statement views (stale/foreign ids throw via reportBookSelection), so an
  // explicit secondary-book export cannot silently return primary-book data
  // while the book-aware drill disagrees. When ?book= is absent the readers
  // keep their primary-book default. Aging rebuilds opens from posted journal
  // lines rather than the documents.open_balance cache, and documents carry
  // no book column, so it stays unscoped by design.
  const bookParam = p.get('book')
  const detailBookId = bookParam == null
    ? undefined
    : (await reportBookSelection(orgId, bookParam)).selectedBook.id
  const side: AgingSide = p.get('side') === 'ap' ? 'ap' : 'ar'
  switch (kind) {
    case 'general-ledger':
      return {
        render: 'data',
        data: generalLedgerExportData(
          await generalLedger(period.from, period.to, { accountId: isReportUuidParam(p.get('account')) ? p.get('account')! : undefined, dims, orgId, bookId: detailBookId }),
          t('generalLedger.title'),
          t,
        ),
      }
    case 'journal':
      return { render: 'data', data: journalExportData(await journalReport(period.from, period.to, { dims, orgId, bookId: detailBookId }), t('journal.title'), t) }
    case 'registers':
      return {
        render: 'data',
        data: registerExportData(
          await partyRegister(side, { from: period.from, to: period.to, dims, orgId, bookId: detailBookId }),
          side === 'ap' ? t('registers.apTitle') : t('registers.arTitle'),
          t,
        ),
      }
    case 'partner-statement': {
      const partyId = p.get('party')
      if (!partyId) throw new Error('party required')
      return { render: 'data', data: partnerStatementExportData(await partnerStatement(partyId, orgId, { from: period.from, to: period.to, side, dims, bookId: detailBookId }), t) }
    }
    case 'true-cost':
      return { render: 'data', data: await trueCostExportData(orgId, period) }
    case 'project-profitability':
      return {
        render: 'data',
        data: projectProfitabilityExportData(
          await projectProfitability(period.from, period.to, {
            dims,
            customerId: q.customerId,
            search: p.get('q') ?? undefined,
            projectScope: q.projectScope,
            orgId,
            bookId: detailBookId,
          }),
          t,
        ),
      }
  }

  // --- Standard scalar statements --------------------------------------------
  const asOf = p.get('asOf') ?? period.to
  const from = p.get('from') ?? period.from
  const to = p.get('to') ?? period.to
  switch (kind) {
    case 'trial-balance':
      return { render: 'data', data: trialBalanceExportData(await trialBalance(asOf, dims, orgId, detailBookId), asOf, t) }
    case 'partners': {
      const s = (p.get('side') === 'receivable' ? 'receivable' : 'payable') as 'receivable' | 'payable'
      return { render: 'data', data: partnersExportData(s, await partnerBalances(s, orgId, asOf, detailBookId, dims), t) }
    }
    case 'aging': {
      // Bare export hits default to the screen's as-of (today) through the
      // shared rule — never the fiscal year end (F-t07-011). The today
      // lookup runs only when neither as-of nor period was supplied.
      const asOfParam = p.get('asOf')
      const periodParam = p.get('period')
      const agingAsOf = resolveAgingAsOf({
        asOf: asOfParam,
        periodParam,
        periodTo: period.to,
        today: asOfParam ?? periodParam ? period.to : (await resolvePeriod('today', { orgId })).to,
      })
      return { render: 'data', data: agingExportData(side, await agingByParty(side, agingAsOf, dims, orgId), t) }
    }
    case 'cash-flow':
      return { render: 'data', data: cashFlowExportData(await cashFlow(from, to, dims, orgId, detailBookId), from, to, t) }
    case 'cash-flow-indirect':
      return { render: 'data', data: cashFlowIndirectExportData(await cashFlowIndirect(from, to, dims, orgId, detailBookId), from, to, t) }
  }

  throw new Error('unknown statement')
}

/**
 * Run ANY saved report_definition — standard (`statement`) or custom (`query`) —
 * through the one pipeline, returning the common `ExportData` paper shape. This
 * is the unification's run primitive: the (future) unified viewer, the editor's
 * saved-report preview, and the scheduler all call this so every report shares
 * exactly one execution + render basis.
 *
 *  - statement: merge the definition's fixed params under the request params,
 *    then route through `resolveReport` (flattening a StatementView to ExportData).
 *  - query: execute the entity plan and shape it to ExportData.
 */
type ReportDefinitionRecord = {
  kind: string
  slug: string
  report_type: string
  name: string
  description: string | null
  query: Record<string, unknown> | null
  statement: { kind?: string; params?: Record<string, string> } | null
}

/**
 * Load one definition as SAVED NOW — never a copy captured at scheduling
 * time — and enforce the execution principal's access to that current
 * definition (a schedule's authorization snapshot only pins who runs it and
 * their subsidiary scope). Shared by the buffered and streaming runners so a
 * scheduled delivery reflects the report's current columns and filters,
 * exactly like an on-demand run, on both paths.
 */
async function loadAuthorizedDefinition(orgId: string, id: string): Promise<{
  row: ReportDefinitionRecord
  authz: Awaited<ReturnType<typeof requireReportAuthz>>
}> {
  const r = (await db.execute<ReportDefinitionRecord>(sql`
    select kind, slug, report_type, name, description, query, statement
      from report_definitions
     where id = ${id} and org_id = ${orgId}
  `))
  const row = r.rows[0]
  if (!row) throw new Error('report not found')

  const authz = await requireReportAuthz(orgId)
  if (!(await canAccessReportDefinition(authz, row as ReportAuthorization['definition']))) throw new Error('Report access denied')
  return { row, authz }
}

export async function resolveDefinitionToExportData(
  orgId: string,
  id: string,
  p: URLSearchParams,
  ctx: ResolveReportCtx,
  options: { extraFilters?: ReportRuleGroup | null } = {},
): Promise<ExportData> {
  const { row, authz } = await loadAuthorizedDefinition(orgId, id)

  if (row.report_type === 'statement') {
    const spec = row.statement ?? {}
    if (!spec.kind || !isReportKind(spec.kind)) throw new Error('unknown statement kind')
    // Request params win; the definition supplies fixed defaults (side, kind…).
    const params = new URLSearchParams(p)
    for (const [k, v] of Object.entries(spec.params ?? {})) if (!params.has(k)) params.set(k, v)
    const resolved = await resolveReport(spec.kind, params, ctx)
    if (resolved.render === 'view') {
      return statementViewToExportData(resolved.view, {
        title: resolved.title,
        dateRangeLabel: resolved.periodPhrase,
        accountLabel: ctx.t('export.columns.accountName'),
      })
    }
    return resolved.data
  }

  // query-type definition → entity engine → ExportData. An explicit period in
  // the request replaces the plan's stored date window (same as the report
  // screen's picker); absent params — e.g. scheduled runs — keep the plan.
  const { query, title, dateRangeLabel } = await planDefinitionQuery(row, authz, p, ctx, options)
  // Pageable entity exports deliberately collect every causally stable page;
  // they never inherit the interactive page or the engine's legacy 10k cap.
  const result = await executeReportAllPages(orgId, query)
  return runResultToExportData(result, {
    title,
    dateRangeLabel,
  })
}

/**
 * Build the executable entity plan for a query-type definition: validate the
 * saved plan against the catalog, layer schedule overrides, bind built-in URL
 * filters, and apply an explicit request period. Shared by the buffered and
 * streaming runners so both execute the same plan.
 */
async function planDefinitionQuery(
  row: ReportDefinitionRecord,
  authz: Awaited<ReturnType<typeof requireReportAuthz>>,
  p: URLSearchParams,
  ctx: ResolveReportCtx,
  options: { extraFilters?: ReportRuleGroup | null } = {},
): Promise<{ query: ReportCustomQuery; title: string; dateRangeLabel: string }> {
  if (!row.query) throw new Error('report has no query')
  const entityMap = await reportEntityCatalog(authz)
  let query = mergeReportFilters(validateCatalogReportQuery(row.query, entityMap), options.extraFilters, entityMap)
  const periodTouched = p.has('period') || p.has('from') || p.has('to')
  // Derive the native period field before URL-backed built-in filters land.
  // expiresOnOrBefore is an intentional recall cutoff, not permission to turn
  // the entire recall into an implicit fiscal-period report.
  const periodField = periodTouched ? reportPeriodField(query, entityMap) : null
  const builtIn = row.kind === 'built_in'
    ? BUILT_IN_REPORT_DEFINITION_MAP[row.slug]
    : undefined
  if (builtIn) {
    // The catalog owns URL-binding semantics, while the stored plan remains
    // authoritative: orgs may tune seeded definitions in place.
    query = applyBuiltInUrlFilters({ ...builtIn, query }, p)
  }
  if (periodField) {
    query = applyPeriodOverride(query, periodField, { from: ctx.period.from, to: ctx.period.to })
  }
  return {
    query,
    title: builtIn ? ctx.t(`builtIns.${row.slug}.name`) : row.name,
    dateRangeLabel: periodField ? ctx.period.label ?? '' : '',
  }
}

/**
 * Stream a paged-entity query definition to CSV or XLSX page by page (bounded
 * memory, per-page snapshots, hard row cap with a disclosed footer) — the
 * bounded twin of the executeReportAllPages tail above, executing the same
 * plan. Non-paged and statement definitions keep the buffered path.
 */
export async function streamDefinitionExport(
  orgId: string,
  id: string,
  p: URLSearchParams,
  ctx: ResolveReportCtx,
  opts: {
    format: 'csv' | 'xlsx'
    sectionHeader?: string
    generatedAt?: Date
    rowCap?: number
  },
): Promise<({ format: 'csv'; csv: string } | { format: 'xlsx'; xlsx: Buffer }) & {
  rowCount: number
  totalRows: number
  truncated: boolean
}> {
  const { row, authz } = await loadAuthorizedDefinition(orgId, id)
  if (row.report_type === 'statement') throw new Error('Streaming export needs a query definition')
  const plan = await planDefinitionQuery(row, authz, p, ctx)
  const entity = REPORT_ENTITY_MAP[plan.query.entity]
  if (plan.query.mode !== 'rows' || !entity?.pagination) {
    throw new Error('Streaming export needs a paged rows-mode entity')
  }
  if (opts.format === 'csv') {
    const out = await streamPagedReportCsv(orgId, plan.query, {
      title: plan.title,
      dateRangeLabel: plan.dateRangeLabel,
      sectionHeader: opts.sectionHeader,
      generatedAt: opts.generatedAt,
      rowCap: opts.rowCap,
    })
    return { format: 'csv' as const, ...out }
  }
  const out = await streamPagedReportXlsx(orgId, plan.query, {
    title: plan.title,
    dateRangeLabel: plan.dateRangeLabel,
    generatedAt: opts.generatedAt,
    rowCap: opts.rowCap,
  })
  return { format: 'xlsx' as const, ...out }
}
