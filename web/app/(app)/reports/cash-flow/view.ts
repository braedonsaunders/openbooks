import 'server-only'
import { reportBookSelection } from '../../../../lib/report-books'
import { resolveOrgId } from '../../../../lib/org-scope'


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
import { MissingRatesError, reportSubsidiaryView, type RatesBlockedNotice } from '../../../../lib/consolidation'
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
  primaryFilter: { paramKey: string; label: string; value: string; options: { value: string; label: string }[] } | null
  title: string
  backHref: string
  backLabel: string
  company: string
  periodPhrase: string
  reconciliationLabel: string
  reconciliationStatus: string
  reconciled: boolean
  /** Set when underived consolidated rates block the statement (F-t06-025):
   * the page renders a typed banner with a derive link instead of numbers. */
  ratesBlocked: RatesBlockedNotice | null
  /** False exactly when ratesBlocked is set; the paper hides with it. */
  ratesReady: boolean
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
  const tb = await getTranslations('budgets')
  const { books, selectedBook } = await reportBookSelection(await resolveOrgId(), sp.book)
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const from = period.from
  const to = period.to
  // Legal-entity scope is enforced here, not by the picker: a restricted
  // reader's view resolves to the subsidiaries they may see (empty = no rows)
  // and every query below carries it — the same contract as the export path.
  // Underived consolidated rates must not throw out of SSR (F-t06-025):
  // the page renders a typed banner with a derive link instead of any
  // numbers. Anything else is a real defect and still throws.
  let subView: Awaited<ReturnType<typeof reportSubsidiaryView>> | undefined
  let cf: Awaited<ReturnType<typeof cashFlow>> | null = null
  let ratesBlocked: RatesBlockedNotice | null = null
  try {
    subView = await reportSubsidiaryView(q.subsidiaryId, period.to)
    cf = await cashFlow(from, to, { ...q.dims, subsidiaryIds: subView.subsidiary?.ids }, undefined, selectedBook.id)
  } catch (e) {
    if (!(e instanceof MissingRatesError)) throw e
    ratesBlocked = {
      code: 'rates-not-derived',
      title: tr('statement.ratesBlockedTitle'),
      description: (e as Error).message,
      deriveLabel: tr('statement.ratesBlockedAction'),
      deriveHref: '/close',
    }
  }
  const [opts, org] = await Promise.all([dimensionOptions(undefined, undefined, subView?.subsidiary?.ids), orgInfo()])
  // Resolves empty when blocked; drills only render beside the paper.
  const dims = { ...q.dims, subsidiaryIds: subView?.subsidiary?.ids }
  const m = (v: ExactDecimal) => formatMoney(v, { currency: org?.base_currency })
  const openingTo = new Date(`${from}T00:00:00Z`)
  openingTo.setUTCDate(openingTo.getUTCDate() - 1)
  const openingDate = openingTo.toISOString().slice(0, 10)

  const sectionLabels: Record<CashFlowSection, string> = {
    operating: t('sections.operating'),
    investing: t('sections.investing'),
    financing: t('sections.financing'),
  }
  const sections = cf?.sections ?? []
  const reconciled = cf !== null && !decimalIsMaterial(cf.reconciliationGap, '0.0100')
  const hasMovements = sections.some((s) => s.lines.length > 0)
  const toneOf = (v: ExactDecimal) => (decimalCmp(v, '0') < 0 ? ('negative' as const) : ('default' as const))

  const rows: StatementRow[] = []
  if (!hasMovements) {
    rows.push({
      key: 'empty',
      span: true,
      label: t('empty'),
      labelClassName: 'text-center text-slate-400 italic',
    })
  } else if (cf !== null) {
    // The null guard doubles as the rates-blocked gate (F-t06-025): with no
    // derived rates there is nothing to build, and the banner replaces the
    // paper. TypeScript narrows every cf.* access below through this branch.
    for (const section of SECTION_ORDER) {
      const s = sections.find((x) => x.section === section)!
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
              kind: 'ledger', bookId: selectedBook.id,
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
          kind: 'ledger', bookId: selectedBook.id,
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
    if (decimalIsMaterial(cf.fxEffectOnCash)) {
      rows.push({
        key: 'fx-effect',
        label: t('fxEffect'),
        labelClassName: 'pl-8',
        value: m(cf.fxEffectOnCash),
        valueClassName: 'text-right tabular-nums',
        tone: toneOf(cf.fxEffectOnCash),
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
        kind: 'ledger', bookId: selectedBook.id,
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
        kind: 'ledger', bookId: selectedBook.id,
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
        kind: 'ledger', bookId: selectedBook.id,
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
    periodPhrase: `${selectedBook.name} · ${t('dateRange', { from, to })}`,
    reconciliationLabel: t('reconciliation'),
    reconciliationStatus: cf === null
      ? ''
      : reconciled
        ? t('reconciled')
        : t('offBy', { amount: m(cf.reconciliationGap) }),
    reconciled,
    ratesBlocked,
    ratesReady: ratesBlocked === null,
    rows,
    dimensions: opts,
    subsidiaries: subView?.picker ?? [],
    primaryFilter: books.length > 1 ? { paramKey: 'book', label: tb('list.bookFilter'), value: selectedBook.id, options: books.map((book) => ({ value: book.id, label: book.name })) } : null,
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
          primaryFilter: f('primaryFilter'),
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
      {
        ...widgetBlock('reconciliation-note', {
          label: data.reconciliationLabel,
          status: data.reconciliationStatus,
          reconciled: data.reconciled,
        }),
        // No reconciliation to report while rates block the statement.
        when: f('ratesReady'),
      },
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.ratesBlocked?.title ?? '',
          description: data.ratesBlocked?.description,
          action: 'link-button',
          actionProps: {
            href: data.ratesBlocked?.deriveHref ?? '/close',
            label: data.ratesBlocked?.deriveLabel ?? '',
          },
        }),
        when: f('ratesBlocked'),
      },
      paper({
        company: f('company'),
        title: f('title'),
        periodPhrase: f('periodPhrase'),
        when: f('ratesReady'),
        blocks: [widgetBlock('statement-rows', { rows: data.rows })],
      }),
    ],
  })
}
