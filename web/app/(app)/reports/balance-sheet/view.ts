import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { getTranslations } from 'next-intl/server'
import {
  filterBar,
  page,
  pageHeader,
  paper,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { dimensionOptions } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolveOrgId } from '../../../../lib/org-scope'
import { reportBookSelection } from '../../../../lib/report-books'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
import { balanceSheetView } from '../../../../lib/statement-matrix'
import { decimalAdd, decimalCmp, decimalNeg } from '../../../../lib/statement-format'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, scaleFactor } from '../../../../lib/report-filters'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'

/**
 * The balance sheet, split into a loader and a spec — the same statement
 * archetype as the P&L, with two additions.
 *
 * The accounting-equation check is a conditional PAIR (balanced in green, off
 * by an amount in red), so the loader decides and a small component renders
 * the decision. And the native filter bar names its breakout options
 * explicitly — but the list it names is exactly ReportFilterBar's own default,
 * so the spec omits it rather than teaching the language to carry an option
 * array that would only ever repeat a default.
 */

export interface BalanceSheetData {
  title: string
  description: string
  backHref: string
  backLabel: string
  dimensions: unknown
  subsidiaries: unknown
  primaryFilter: unknown
  scheduleDefId: string | null
  scheduleParams: Record<string, string | undefined>
  exportParams: Record<string, string | undefined>
  equationLabel: string
  balanced: boolean
  balanceLabel: string
  company: string
  periodPhrase: string
  note: string
  wide: boolean
  view: unknown
  scale: unknown
  currency: string | undefined
  drill: unknown
}

export async function loadBalanceSheet(
  sp: Record<string, string | undefined>,
): Promise<BalanceSheetData> {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('reports')
  const tb = await getTranslations('budgets')
  const scheduleDefId = await reportScheduleAnchor('balance-sheet')
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const { books, selectedBook } = await reportBookSelection(await resolveOrgId(), sp.book)

  const secTotal = (section: string) => t('statement.sectionTotal', { section })
  const labels = {
    assets: t('balanceSheet.assets'),
    liabilities: t('balanceSheet.liabilities'),
    equity: t('balanceSheet.equity'),
    totalAssets: secTotal(t('balanceSheet.assets')),
    totalLiabilities: secTotal(t('balanceSheet.liabilities')),
    totalEquity: secTotal(t('balanceSheet.equity')),
    accumulatedEarnings: t('statement.accumulatedEarnings'),
    translationAdjustment: t('statement.translationAdjustment'),
    liabilitiesAndEquity: t('balanceSheet.liabilitiesAndEquity'),
    totalOf: secTotal,
  }

  const subView = await reportSubsidiaryView(q.subsidiaryId, period.to)
  const [view, opts, org] = await Promise.all([
    balanceSheetView({ from: period.from, to: period.to }, period.label, labels, {
      breakout: q.breakout,
      compare: q.compare,
      basis: q.basis,
      dims: q.dims,
      subsidiary: subView.subsidiary,
      showZero: q.showZero,
      bookId: selectedBook.id,
    }),
    dimensionOptions(),
    orgInfo(),
  ])

  const valueOf = (label: string) => view.lines.find((l) => l.label === label)?.values?.[0] ?? '0.0000'
  const totalAssets = valueOf(labels.totalAssets)
  const totalLiabilities = valueOf(labels.totalLiabilities)
  const totalEquity = valueOf(labels.totalEquity)
  const difference = decimalAdd(totalAssets, decimalNeg(decimalAdd(totalLiabilities, totalEquity)))
  const balanced = decimalCmp(difference, '-0.0100') > 0 && decimalCmp(difference, '0.0100') < 0


  return {
    title: t('balanceSheet.title'),
    description: `${selectedBook.name} · ${subView.label ? `${subView.label} · ` : ''}${t('balanceSheet.asOf', { date: period.to })}`,
    backHref: '/reports',
    backLabel: t('hub.title'),
    dimensions: opts,
    subsidiaries: subView.picker,
    primaryFilter:
      books.length > 1
        ? {
            paramKey: 'book',
            label: tb('list.bookFilter'),
            value: selectedBook.id,
            options: books.map((book) => ({ value: book.id, label: book.name })),
          }
        : undefined,
    scheduleDefId,
    scheduleParams: scheduleParamsFrom(sp),
    exportParams: sp,
    equationLabel: t('balanceSheet.equation'),
    balanced,
    balanceLabel: balanced
      ? t('balanceSheet.balanced')
      : t('balanceSheet.offBy', { amount: money(difference) }),
    company: org?.name ?? '',
    periodPhrase: `${selectedBook.name} · ${t('balanceSheet.asOf', { date: period.to })}`,
    note: scaleFactor(q.scale).note || '',
    wide: view.columns.length > 4,
    view,
    scale: q.scale,
    currency: subView.currency ?? org?.base_currency,
    drill: {
      dims: q.dims,
      basis: q.basis,
      subsidiaryId: q.subsidiaryId,
      bookId: selectedBook.id,
    },
  }
}

const f = ref<BalanceSheetData>()

export function balanceSheetSpec(data: BalanceSheetData): PageSpec {
  return page({
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
          asOf: true,
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
            widget(
              'schedule-report',
              {
                definitionId: data.scheduleDefId ?? '',
                statementParams: data.scheduleParams,
              },
              f('scheduleDefId'),
            ),
            widget('save-view'),
            widget('export-menu', { kind: 'balance-sheet', params: data.exportParams }),
          ],
        },
      ),
      widgetBlock('balance-check', {
        equation: data.equationLabel,
        balanced: data.balanced,
        label: data.balanceLabel,
      }),
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
