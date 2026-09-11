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
} from '@openbooks/viewspec'
import { getMoneyFormatter } from '@/lib/money-server'
import { cashFlowIndirect, dimensionOptions } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { reportSubtotalRowClass, reportTotalRowClass } from '../ReportTable'
import type { StatementRow } from '../StatementRows'
import { decimalCmp, decimalIsMaterial, type ExactDecimal } from '../../../../lib/statement-format'
import type { ReportDrillTarget } from '../../../../lib/report-drill'
import { PNL_TYPES } from './pnl-types'

/**
 * Indirect cash flow, split into a loader and a spec.
 *
 * Same shape as the direct statement and it reuses the shared StatementRows
 * component unchanged — the second consumer, which is what justified making it
 * shared rather than per-page. The row list is longer and more nested (net
 * income, adjustments, working capital, three section subtotals, an optional FX
 * effect) but it is still just an ordered list the loader builds.
 */

const HEADING_CLASS =
  'pt-4 pb-1 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300'
const SUBHEADING_CLASS = 'pl-4 pt-2 pb-0.5 text-xs font-medium text-slate-500 italic dark:text-slate-400'
const EMPTY_SECTION_CLASS = 'pl-8 text-slate-300 italic dark:text-slate-600'

type DimensionOptions = Awaited<ReturnType<typeof dimensionOptions>>
type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']

export interface CashFlowIndirectData {
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

export async function loadCashFlowIndirect(
  sp: Record<string, string | undefined>,
): Promise<CashFlowIndirectData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('reports.cashFlowIndirect')
  const tr = await getTranslations('reports')
  const scheduleDefId = await reportScheduleAnchor('cash-flow-indirect')
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const from = period.from
  const to = period.to
  // Legal-entity scope is enforced here, not by the picker: a restricted
  // reader's view resolves to the subsidiaries they may see (empty = no rows)
  // and every query below carries it — the same contract as the export path.
  const subView = await reportSubsidiaryView(q.subsidiaryId, period.to)
  const dims = { ...q.dims, subsidiaryIds: subView.subsidiary?.ids }
  const [cf, opts, org] = await Promise.all([
    cashFlowIndirect(from, to, dims),
    dimensionOptions(),
    orgInfo(),
  ])
  const m = (v: ExactDecimal) => formatMoney(v, { currency: org?.base_currency })
  const openingTo = new Date(`${from}T00:00:00Z`)
  openingTo.setUTCDate(openingTo.getUTCDate() - 1)
  const openingDate = openingTo.toISOString().slice(0, 10)

  const reconciled = !decimalIsMaterial(cf.reconciliationGap, '0.0100')
  const hasMovements =
    decimalIsMaterial(cf.netIncome) ||
    cf.adjustments.length > 0 ||
    cf.workingCapital.length > 0 ||
    cf.investing.length > 0 ||
    cf.financing.length > 0

  const toneOf = (v: ExactDecimal) => (decimalCmp(v, '0') < 0 ? ('negative' as const) : ('default' as const))
  const rows: StatementRow[] = []
  const heading = (key: string, label: string) =>
    rows.push({ key, span: true, label, labelClassName: HEADING_CLASS })
  const subheading = (key: string, label: string) =>
    rows.push({ key, span: true, label, labelClassName: SUBHEADING_CLASS })
  const amount = (key: string, label: string, v: ExactDecimal, drill?: ReportDrillTarget) =>
    rows.push({
      key,
      label,
      labelClassName: 'pl-8',
      value: m(v),
      valueClassName: 'text-right tabular-nums',
      tone: toneOf(v),
      ...(drill ? { drill } : {}),
    })
  const subtotal = (key: string, label: string, v: ExactDecimal, drill?: ReportDrillTarget) =>
    rows.push({
      key,
      label,
      labelClassName: 'font-semibold',
      value: m(v),
      valueClassName: 'text-right font-semibold tabular-nums',
      tone: toneOf(v),
      rowClassName: reportSubtotalRowClass,
      ...(drill ? { drill } : {}),
    })
  const accountLabel = (l: { number?: string | null; name: string }) =>
    `${l.number ? `${l.number} · ` : ''}${l.name}`

  if (!hasMovements) {
    rows.push({
      key: 'empty',
      span: true,
      label: t('empty'),
      labelClassName: 'text-center text-slate-400 italic',
    })
  } else {
    heading('operating-heading', t('sections.operating'))
    amount('net-income', t('netIncome'), cf.netIncome, {
      kind: 'ledger',
      label: t('netIncome'),
      accountTypes: PNL_TYPES,
      from,
      to,
      mode: 'flow',
      dims,
    })
    if (cf.adjustments.length > 0) {
      subheading('adjustments-heading', t('adjustmentsHeader'))
      cf.adjustments.forEach((a, i) => {
        const label = a.label ?? t(`adjustments.${a.key}`)
        amount(`adj-${a.accountId ?? `${a.key}-${i}`}`, label, a.amount, {
          kind: 'ledger',
          label,
          accountTypes: PNL_TYPES,
          from,
          to,
          mode: 'flow',
          dims,
        })
      })
    }
    if (cf.workingCapital.length > 0) {
      subheading('wc-heading', t('wcHeader'))
      for (const l of cf.workingCapital) {
        amount(`wc-${l.accountId}`, accountLabel(l), l.amount, {
          kind: 'ledger',
          label: l.name,
          accountIds: [l.accountId],
          from,
          to,
          mode: 'flow',
          dims,
        })
      }
    }
    subtotal('operating-subtotal', t('subtotals.operating'), cf.operating, {
      kind: 'ledger',
      label: t('subtotals.operating'),
      accountTypes: [...PNL_TYPES, ...cf.workingCapital.map((l) => l.type)],
      from,
      to,
      mode: 'flow',
      dims,
    })

    for (const section of ['investing', 'financing'] as const) {
      const lines = section === 'investing' ? cf.investing : cf.financing
      const total = section === 'investing' ? cf.investingTotal : cf.financingTotal
      heading(`${section}-heading`, t(`sections.${section}`))
      if (lines.length === 0) {
        rows.push({
          key: `${section}-none`,
          span: true,
          label: '—',
          labelClassName: EMPTY_SECTION_CLASS,
        })
      } else {
        for (const l of lines) {
          amount(`${section}-${l.accountId}`, accountLabel(l), l.amount, {
            kind: 'ledger',
            label: l.name,
            accountIds: [l.accountId],
            from,
            to,
            mode: 'flow',
            dims,
            cashOnly: true,
          })
        }
      }
      subtotal(`${section}-subtotal`, t(`subtotals.${section}`), total, {
        kind: 'ledger',
        label: t(`subtotals.${section}`),
        accountTypes: lines.map((l) => l.type),
        from,
        to,
        mode: 'flow',
        dims,
        cashOnly: true,
      })
    }

    if (decimalIsMaterial(cf.fxEffectOnCash)) {
      amount('fx-effect', t('fxEffect'), cf.fxEffectOnCash)
    }

    rows.push({
      key: 'net-change',
      label: t('netChange'),
      labelClassName: 'font-bold',
      value: m(cf.netChange),
      valueClassName: 'text-right font-bold tabular-nums',
      tone: toneOf(cf.netChange),
      rowClassName: reportSubtotalRowClass,
      // No cashOnly here: the indirect statement's net change drills the bank
      // accounts' flow without the cash-only narrowing the section lines use.
      drill: {
        kind: 'ledger',
        label: t('netChange'),
        accountTypes: ['asset_bank'],
        from,
        to,
        mode: 'flow',
        dims,
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

const f = ref<CashFlowIndirectData>()

export function cashFlowIndirectSpec(data: CashFlowIndirectData): PageSpec {
  return page({
    route: '/reports/cash-flow-indirect',
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
            widget('export-menu', { kind: 'cash-flow-indirect', params: data.exportParams }),
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
