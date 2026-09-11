import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  filterBar,
  page,
  pageHeader,
  paper,
  ref,
  textBlock,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { dimensionOptions } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolveOrgId } from '../../../../lib/org-scope'
import { reportBookSelection } from '../../../../lib/report-books'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
import { profitAndLossView } from '../../../../lib/statement-matrix'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, scaleFactor } from '../../../../lib/report-filters'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'

/**
 * The profit-and-loss statement, split into a loader and a spec.
 *
 * The interesting part of this conversion is what does NOT get decomposed.
 * `StatementMatrixTable` owns variance percentages, scale divisors,
 * hierarchical line rendering and its own drill construction; expressing it as
 * generic `table` columns would reimplement it, badly. It stays whole and the
 * spec places it by name as a `widget` block. ViewSpec composes pages; it does
 * not re-derive components.
 *
 * Everything time-, permission- and money-dependent — period resolution, book
 * and subsidiary selection, the statement query, the composed description
 * string — stays in the loader below.
 */

type StatementView = Awaited<ReturnType<typeof profitAndLossView>>
type DimensionOptions = Awaited<ReturnType<typeof dimensionOptions>>
type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']

export interface PnlData {
  title: string
  description: string
  backHref: string
  backLabel: string
  hubLabel: string
  company: string
  periodPhrase: string
  note: string
  wide: boolean
  truncated: boolean
  truncatedLabel: string
  view: StatementView
  scale: string
  currency: string | undefined
  drill: {
    dims: ReturnType<typeof parseReportQuery>['dims']
    basis: ReturnType<typeof parseReportQuery>['basis']
    subsidiaryId?: string
    bookId?: string
  }
  dimensions: DimensionOptions
  subsidiaries: SubsidiaryPicker
  /** Only rendered when the org has more than one book. */
  primaryFilter: { paramKey: string; label: string; value: string; options: { value: string; label: string }[] } | null
  scheduleDefId: string | null
  scheduleParams: Record<string, string>
  exportParams: Record<string, string>
}

export async function loadPnl(sp: Record<string, string | undefined>): Promise<PnlData> {
  const t = await getTranslations('reports')
  // The book label reuses the budgets list's existing filter copy.
  const tb = await getTranslations('budgets')
  const scheduleDefId = await reportScheduleAnchor('pnl')
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })

  const labels = {
    revenue: t('pnl.revenue'),
    costOfGoodsSold: t('pnl.costOfGoodsSold'),
    grossProfit: t('pnl.grossProfit'),
    expenses: t('pnl.expenses'),
    netIncome: t('pnl.netIncome'),
    totalOf: (section: string) => t('statement.sectionTotal', { section }),
  }

  const orgId = await resolveOrgId()
  const { books, selectedBook } = await reportBookSelection(orgId, sp.book)
  const subView = await reportSubsidiaryView(q.subsidiaryId, period.to)
  const [view, opts, org] = await Promise.all([
    profitAndLossView({ from: period.from, to: period.to }, period.label, labels, {
      breakout: q.breakout,
      compare: q.compare,
      basis: q.basis,
      dims: q.dims,
      subsidiary: subView.subsidiary,
      showZero: q.showZero,
      bookId: selectedBook?.id,
    }),
    dimensionOptions(),
    orgInfo(),
  ])

  const scale = scaleFactor(q.scale)
  const title = t('pnl.title')

  return {
    title,
    description: `${selectedBook ? `${selectedBook.name} · ` : ''}${subView.label ? `${subView.label} · ` : ''}${period.label}${scale.note ? ` · ${scale.note.toLowerCase()}` : ''}`,
    backHref: '/reports',
    backLabel: t('hub.title'),
    hubLabel: t('hub.title'),
    company: org?.name ?? '',
    periodPhrase: `${selectedBook.name} · ${t('pnl.dateRange', { from: period.from, to: period.to })}`,
    note: scale.note || '',
    wide: view.columns.length > 4,
    truncated: view.truncated,
    truncatedLabel: t('filterBar.truncated'),
    view,
    scale: q.scale,
    currency: subView.currency ?? org?.base_currency,
    drill: { dims: q.dims, basis: q.basis, subsidiaryId: q.subsidiaryId, bookId: selectedBook.id },
    dimensions: opts,
    subsidiaries: subView.picker,
    primaryFilter:
      books.length > 1
        ? {
            paramKey: 'book',
            label: tb('list.bookFilter'),
            value: selectedBook?.id ?? '',
            options: books.map((b) => ({ value: b.id, label: b.name })),
          }
        : null,
    scheduleDefId: scheduleDefId ?? null,
    scheduleParams: scheduleParamsFrom(sp),
    exportParams: stringParams(sp),
  }
}

function stringParams(sp: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

const f = ref<PnlData>()

export function pnlSpec(data: PnlData): PageSpec {
  return page({
    route: '/reports/pnl',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
      filterBar(
        {
          period: true,
          breakout: true,
          compare: true,
          basis: true,
          dimensions: true,
          subsidiary: true,
          showZero: true,
          scale: true,
          sections: true,
        },
        {
          dimensions: f('dimensions'),
          subsidiaries: f('subsidiaries'),
          primaryFilter: f('primaryFilter'),
          actions: [
            widget('schedule-report', {
              definitionId: data.scheduleDefId ?? '',
              statementParams: data.scheduleParams,
            }, f('scheduleDefId')),
            widget('save-view'),
            widget('export-menu', { kind: 'pnl', params: data.exportParams }),
          ],
        },
      ),
      // The native page renders this warning only when the statement was
      // truncated. `when` is how a spec expresses that without the language
      // acquiring a conditional operator.
      textBlock(f('truncatedLabel'), { tone: 'warning', when: f('truncated') }),
    ],
    body: [
      paper({
        company: f('company'),
        title: f('title'),
        periodPhrase: f('periodPhrase'),
        note: f('note'),
        wide: f('wide'),
        blocks: [
          widgetBlock('statement-matrix', {
            view: data.view,
            scale: data.scale,
            currency: data.currency,
            drill: data.drill,
          }),
        ],
      }),
    ],
  })
}
