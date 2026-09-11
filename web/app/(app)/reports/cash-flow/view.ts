import 'server-only'

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
} from '@braedonsaunders/appkit-viewspec'
import { getMoneyFormatter } from '@/lib/money-server'
import { cashFlow, dimensionOptions, type CashFlowSection } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { reportSubtotalRowClass, reportTotalRowClass } from '../ReportTable'
import type { StatementRow } from '../StatementRows'
import { decimalCmp, decimalIsMaterial, type ExactDecimal } from '../../../../lib/statement-format'

/**
 * Direct cash flow, split into a loader and a spec.
 *
 * The statement body is heterogeneous — section headings, indented lines,
 * subtotals, a net change, opening and closing cash — so the loader flattens
 * it into an ordered `StatementRow[]` and the shared StatementRows component
 * renders it. The spec composes the page around that: header, filter bar,
 * reconciliation note, paper.
 *
 * Every tone and class is decided here. A row is "negative" because the loader
 * compared it; the renderer only maps that name to the red treatment.
 */

const SECTION_ORDER: CashFlowSection[] = ['operating', 'investing', 'financing']

type DimensionOptions = Awaited<ReturnType<typeof dimensionOptions>>
type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']

export interface CashFlowData {
  title: string
  backHref: string
  backLabel: string
  company: string
  periodPhrase: string
  reconciliationLabel: string
  reconciliationStatus: string
  reconciled: boolean
  rows: StatementRow[]
  dimensions: DimensionOptions
  subsidiaries: SubsidiaryPicker
  scheduleDefId: string | null
  scheduleParams: Record<string, string>
  exportParams: Record<string, string>
}

export async function loadCashFlow(sp: Record<string, string | undefined>): Promise<CashFlowData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('reports.cashFlow')
  const tr = await getTranslations('reports')
  const scheduleDefId = await reportScheduleAnchor('cash-flow')
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const from = period.from
  const to = period.to
  // Legal-entity scope is enforced here, not by the picker: a restricted
  // reader's view resolves to the subsidiaries they may see (empty = no rows)
  // and every query below carries it — the same contract as the export path.
  const subView = await reportSubsidiaryView(q.subsidiaryId, period.to)
  const dims = { ...q.dims, subsidiaryIds: subView.subsidiary?.ids }
  const [cf, opts, org] = await Promise.all([cashFlow(from, to, dims), dimensionOptions(), orgInfo()])
  const m = (v: ExactDecimal) => formatMoney(v, { currency: org?.base_currency })
  const openingTo = new Date(`${from}T00:00:00Z`)
  openingTo.setUTCDate(openingTo.getUTCDate() - 1)
  const openingDate = openingTo.toISOString().slice(0, 10)

  const sectionLabels: Record<CashFlowSection, string> = {
    operating: t('sections.operating'),
    investing: t('sections.investing'),
    financing: t('sections.financing'),
  }
  const reconciled = !decimalIsMaterial(cf.reconciliationGap, '0.0100')
  const hasMovements = cf.sections.some((s) => s.lines.length > 0)
  const toneOf = (v: ExactDecimal) => (decimalCmp(v, '0') < 0 ? ('negative' as const) : ('default' as const))

  const rows: StatementRow[] = []
  if (!hasMovements) {
    rows.push({
      key: 'empty',
      span: true,
      label: t('empty'),
      labelClassName: 'text-center text-slate-400 italic',
    })
  } else {
    for (const section of SECTION_ORDER) {
      const s = cf.sections.find((x) => x.section === section)!
      const title = sectionLabels[section]
      const subtotalLabel = t('subtotal', { section: title.toLowerCase() })
      rows.push({
        key: `${section}-heading`,
        span: true,
        label: title,
        labelClassName: 'pt-4 pb-1 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300',
      })
      if (s.lines.length === 0) {
        rows.push({
          key: `${section}-none`,
          span: true,
          label: '—',
          labelClassName: 'pl-8 text-slate-300 italic dark:text-slate-600',
        })
      } else {
        for (const l of s.lines) {
          rows.push({
            key: `${section}-${l.type}`,
            label: l.label,
            labelClassName: 'pl-8',
            value: m(l.amount),
            valueClassName: 'text-right tabular-nums',
            tone: toneOf(l.amount),
            drill: {
              kind: 'ledger',
              label: l.label,
              accountTypes: [l.type],
              from,
              to,
              mode: 'flow',
              dims,
              cashOnly: true,
            },
          })
        }
      }
      rows.push({
        key: `${section}-subtotal`,
        label: subtotalLabel,
        labelClassName: 'font-semibold',
        value: m(s.subtotal),
        valueClassName: 'text-right font-semibold tabular-nums',
        tone: toneOf(s.subtotal),
        rowClassName: reportSubtotalRowClass,
        drill: {
          kind: 'ledger',
          label: subtotalLabel,
          accountTypes: s.lines.map((line) => line.type),
          from,
          to,
          mode: 'flow',
          dims,
          cashOnly: true,
        },
      })
    }
    rows.push({
      key: 'net-change',
      label: t('netChange'),
      labelClassName: 'font-bold',
      value: m(cf.netChange),
      valueClassName: 'text-right font-bold tabular-nums',
      tone: toneOf(cf.netChange),
      rowClassName: reportSubtotalRowClass,
      drill: {
        kind: 'ledger',
        label: t('netChange'),
        accountTypes: cf.sections.flatMap((s) => s.lines.map((line) => line.type)),
        from,
        to,
        mode: 'flow',
        dims,
        cashOnly: true,
      },
    })
    rows.push({
      key: 'opening-cash',
      label: t('openingCash'),
      labelClassName: 'pl-8 text-slate-500 dark:text-slate-400',
      value: m(cf.openingCash),
      valueClassName: 'text-right tabular-nums text-slate-500 dark:text-slate-400',
      drill: {
        kind: 'ledger',
        label: t('openingCash'),
        accountTypes: ['asset_bank'],
        to: openingDate,
        mode: 'balance',
        dims,
      },
    })
    rows.push({
      key: 'closing-cash',
      label: t('closingCash'),
      labelClassName: 'font-semibold',
      value: m(cf.closingCash),
      valueClassName: 'text-right font-semibold tabular-nums',
      tone: toneOf(cf.closingCash),
      rowClassName: reportTotalRowClass,
      drill: {
        kind: 'ledger',
        label: t('closingCash'),
        accountTypes: ['asset_bank'],
        to,
        mode: 'balance',
        dims,
      },
    })
  }

  return {
    title: t('title'),
    backHref: '/reports',
    backLabel: tr('hub.title'),
    company: org?.name ?? '',
    periodPhrase: t('dateRange', { from, to }),
    reconciliationLabel: t('reconciliation'),
    reconciliationStatus: reconciled ? t('reconciled') : t('offBy', { amount: m(cf.reconciliationGap) }),
    reconciled,
    rows,
    dimensions: opts,
    subsidiaries: subView.picker,
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

const f = ref<CashFlowData>()

export function cashFlowSpec(data: CashFlowData): PageSpec {
  return page({
    route: '/reports/cash-flow',
    layout: 'list',
    header: [
      pageHeader({ title: f('title'), back: { href: f('backHref'), label: f('backLabel') } }),
      filterBar(
        { period: true, dimensions: true, subsidiary: true },
        {
          dimensions: f('dimensions'),
          subsidiaries: f('subsidiaries'),
          actions: [
            widget('schedule-report', {
              definitionId: data.scheduleDefId ?? '',
              statementParams: data.scheduleParams,
            }, f('scheduleDefId')),
            widget('save-view'),
            widget('export-menu', { kind: 'cash-flow', params: data.exportParams }),
          ],
        },
      ),
      widgetBlock('reconciliation-note', {
        label: data.reconciliationLabel,
        status: data.reconciliationStatus,
        reconciled: data.reconciled,
      }),
    ],
    body: [
      paper({
        company: f('company'),
        title: f('title'),
        periodPhrase: f('periodPhrase'),
        blocks: [widgetBlock('statement-rows', { rows: data.rows })],
      }),
    ],
  })
}
