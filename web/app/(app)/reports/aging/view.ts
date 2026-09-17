import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  column,
  drill,
  field,
  filterBar,
  money,
  page,
  pageHeader,
  paper,
  ref,
  rootRef,
  table,
  text,
  txn,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
  type TableSpanRow,
} from '@braedonsaunders/appkit-viewspec'
import { getMoneyFormatter } from '@/lib/money-server'
import { agingByParty, agingCurrenciesInScope, agingDetail, AgingRatesUnavailableError, dimensionOptions, type AgingCurrencyBasis, type AgingSide } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { MissingRatesError, reportSubsidiaryView, type RatesBlockedNotice } from '../../../../lib/consolidation'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, resolveAgingCurrencyParams } from '../../../../lib/report-filters'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { reportTotalRowClass } from '../ReportTable'
import { decimalCmp, decimalIsZero } from '../../../../lib/statement-format'
import type { ReportDrillTarget } from '../../../../lib/report-drill'

/**
 * Aging (AR / AP), split into a loader and a spec.
 *
 * This is the page that generalized `when` to every block. It renders one of
 * TWO tables — detail or summary — and the spec expresses that with two
 * independent loader flags rather than a negation, so the language still has
 * no conditional operator. Each table simply declares when it is present.
 */

const BUCKETS = ['current', 'b1', 'b2', 'b3', 'b4'] as const

// Aging reads as of a POINT IN TIME, never a window: only presets whose end
// date is a meaningful as-of instant (today, yesterday, end of last month)
// plus the explicit custom date. Range presets like "this fiscal year" or
// "next month" would file every open item as "current".
const AS_OF_PERIOD_PRESETS = ['today', 'yesterday', 'last_month', 'custom']

type DimensionOptions = Awaited<ReturnType<typeof dimensionOptions>>
type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']

interface BucketCell {
  value: string
  isZero: boolean
  tone: 'default' | 'negative'
  drill: ReportDrillTarget
}

export interface AgingSummaryRow {
  key: string
  partyId: string | null
  partyName: string
  partyHref: string
  current: BucketCell
  b1: BucketCell
  b2: BucketCell
  b3: BucketCell
  b4: BucketCell
  total: string
  totalDrill: ReportDrillTarget
}

export interface AgingDetailRow {
  key: string
  partyId: string | null
  partyName: string
  partyHref: string
  reference: string
  /** Open items without terms carry no due date. */
  dueDate: string | null
  ageDays: string
  bucketLabel: string
  open: string
  /** The document's own currency code — always shown, whatever basis converts. */
  currency: string
  /** The open in the document's own currency (unconverted). Summary rows
   * cannot carry this: one party may owe in several currencies, so the
   * txn leg lives at document grain only. */
  txnOpen: string
  txn: { kind: 'transaction'; entryId: string; docKind: string | null; docId: string | null }
}

export interface AgingData {
  title: string
  backHref: string
  backLabel: string
  company: string
  periodPhrase: string
  isDetail: boolean
  isSummary: boolean
  hasSummaryRows: boolean
  emptyLabel: string
  labelParty: string
  labelEntry: string
  labelDue: string
  labelAge: string
  labelBucket: string
  labelTotal: string
  labelTotals: string
  labelDocCurrency: string
  labelTxnOpen: string
  /** Reporting-currency selector options: base first, then in-scope txn codes. */
  currencyOptions: { value: string; label: string }[]
  currencyValue: string
  currencyBasisValue: 'base' | 'transaction'
  labelCurrency: string
  labelConvertFrom: string
  labelBase: string
  labelTransaction: string
  bucketLabels: Record<(typeof BUCKETS)[number], string>
  dashPlaceholder: string
  /** Set when underived consolidated rates block the report (F-t06-027):
   * the page renders a typed banner with a derive link instead of numbers. */
  ratesBlocked: RatesBlockedNotice | null
  /** False exactly when ratesBlocked is set; the paper hides with it. */
  ratesReady: boolean
  summaryRows: AgingSummaryRow[]
  detailRows: AgingDetailRow[]
  totals: Record<(typeof BUCKETS)[number], string> & { total: string }
  totalsDrill: Record<(typeof BUCKETS)[number], ReportDrillTarget> & { total: ReportDrillTarget }
  dimensions: DimensionOptions
  subsidiaries: SubsidiaryPicker
  periodPresets: string[]
  scheduleDefId: string | null
  scheduleParams: Record<string, string>
  exportParams: Record<string, string>
}

export async function loadAging(sp: Record<string, string | undefined>): Promise<AgingData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('reports.aging')
  const tr = await getTranslations('reports')
  const tc = await getTranslations('common')
  const side: AgingSide = sp.side === 'ap' ? 'ap' : 'ar'
  const scheduleDefId = await reportScheduleAnchor('aging', { side })
  const detail = sp.view === 'detail'
  const q = parseReportQuery(sp)
  // Aging is inherently "as of a date" — default to TODAY, not the fiscal year.
  // The URL is untrusted: a hand-edited preset outside the as-of whitelist
  // (say ?period=this_fiscal_year) must not compute a future as-of, so coerce
  // it to today instead of resolving it.
  const requestedPeriod = sp.period && AS_OF_PERIOD_PRESETS.includes(sp.period) ? sp.period : 'today'
  const period = await resolvePeriod(requestedPeriod, { customFrom: q.from, customTo: q.to })
  const asOf = period.to
  // Legal-entity scope is enforced here, not by the picker: a restricted
  // reader's view resolves to the subsidiaries they may see (empty = no rows)
  // and every query below carries it — the same contract as the export path.
  // Underived consolidated rates must not throw out of SSR (F-t06-027):
  // the page renders a typed banner with a derive link instead of any
  // numbers. Anything else is a real defect and still throws. Builders run
  // only with a resolved subsidiary scope — never scope-less (fail-closed).
  let subView: Awaited<ReturnType<typeof reportSubsidiaryView>> | undefined
  let ratesBlocked: RatesBlockedNotice | null = null
  try {
    subView = await reportSubsidiaryView(q.subsidiaryId, asOf)
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
  const dims = {
    ...q.dims,
    subsidiaryIds: subView?.subsidiary?.ids,
    // Unrestricted root-covering views read root-owned (null subsidiary)
    // documents alongside attributed ones; restricted views stay fail-closed.
    includeNullSubsidiary: subView?.subsidiary?.includeNullSubsidiary === true,
  }
  // Currency basis is opt-in and URL-driven (never component state) so the
  // screen, its export, and its drill-downs all read the same selection.
  // Never the shared filter bar's `basis`: that word means accrual/cash.
  // The currency scope resolves before the readers: the validated target is
  // an input to both rebuilds, not a display concern applied after them.
  const [scope, opts, org] = subView
    ? await Promise.all([
        agingCurrenciesInScope(side, asOf, dims),
        dimensionOptions(),
        orgInfo(),
      ])
    : [null, await dimensionOptions(), await orgInfo()] as const
  // One shared resolver with the export (report-filters): the screen and the
  // CSV can never disagree on what a URL means. A hand-edited currency
  // outside the in-scope list falls back to base (ruling 1).
  const { basis: currencyBasis, currency: target } = scope
    ? resolveAgingCurrencyParams(sp, scope)
    : { basis: 'base' as AgingCurrencyBasis, currency: '' }
  let summary: Awaited<ReturnType<typeof agingByParty>> | null = null
  let detailResult: Awaited<ReturnType<typeof agingDetail>> | null = null
  if (subView && scope) {
    const runOpts = { basis: currencyBasis, reportingCurrency: target }
    try {
      ;[summary, detailResult] = await Promise.all([
        agingByParty(side, asOf, dims, undefined, runOpts),
        detail ? agingDetail(side, asOf, dims, undefined, runOpts) : null,
      ])
    } catch (e) {
      // Same banner contract as underived consolidated rates (F-t06-027): a
      // txn-basis report whose spots are underived renders the derive link,
      // never numbers, and never a throw out of SSR.
      if (!(e instanceof AgingRatesUnavailableError)) throw e
      ratesBlocked = {
        code: 'rates-not-derived',
        title: tr('statement.ratesBlockedTitle'),
        description: (e as Error).message,
        deriveLabel: tr('statement.ratesBlockedAction'),
        deriveHref: '/close',
      }
      summary = null
      detailResult = null
    }
  }
  const m = (v: string | number) => formatMoney(v, { currency: target || org?.base_currency })
  // The txn leg formats in the DOCUMENT's currency. Registry codes are ISO
  // by construction, but a hand-entered code must never crash the render —
  // fall back to the raw amount with its code.
  const mt = (v: string | number, ccy: string) => {
    try {
      return formatMoney(v, { currency: ccy })
    } catch {
      return `${v} ${ccy}`
    }
  }
  const noParty = t('noParty')

  const bucketLabels: Record<(typeof BUCKETS)[number], string> = {
    current: t('buckets.current'),
    b1: t('buckets.b1'),
    b2: t('buckets.b2'),
    b3: t('buckets.b3'),
    b4: t('buckets.b4'),
  }

  const bucketDrill = (
    label: string,
    partyId?: string,
    bucket?: (typeof BUCKETS)[number],
  ): ReportDrillTarget => ({
    kind: 'aging',
    subsidiaryId: q.subsidiaryId,
    label,
    side,
    asOf,
    dims,
    // The drawer must reproduce the screen's selection, not the defaults.
    currencyBasis,
    currency: target || undefined,
    ...(partyId ? { partyId } : {}),
    ...(bucket ? { bucket } : {}),
  })

  const bucketCell = (
    row: Record<string, string>,
    b: (typeof BUCKETS)[number],
    name: string,
    partyId: string | null,
  ): BucketCell => ({
    value: decimalIsZero(row[b]!) ? '' : m(row[b]!),
    isZero: decimalIsZero(row[b]!),
    tone: decimalCmp(row[b]!, '0') < 0 ? 'negative' : 'default',
    drill: bucketDrill(`${name} · ${bucketLabels[b]}`, partyId ?? undefined, b),
  })

  // Every open-balance surface states BOTH facts: the denomination (and, on
  // the txn basis, which leg converted) and whether the figure is live or
  // as-of. The aging rebuild is always as-of; the list cache is live — the
  // two disagree on FX documents, and the label is what makes that legitimate.
  const basisPhrase = currencyBasis === 'transaction' ? t('fromTransaction') : t('fromBase')
  return {
    title: `${side === 'ap' ? t('payablesTitle') : t('receivablesTitle')} · ${detail ? t('detail') : t('summary')}`,
    backHref: '/reports',
    backLabel: tr('hub.title'),
    company: org?.name ?? '',
    periodPhrase: `${t('asOf', { date: asOf })} · ${basisPhrase} · ${t('inCurrency', { currency: target || org?.base_currency || '' })}`,
    isDetail: Boolean(detailResult),
    isSummary: !detailResult,
    hasSummaryRows: (summary?.rows.length ?? 0) > 0,
    ratesBlocked,
    ratesReady: ratesBlocked === null,
    emptyLabel: t('empty'),
    labelParty: tc('labels.party'),
    labelEntry: tr('generalLedger.columns.entry'),
    labelDue: t('columns.due'),
    labelAge: t('columns.age'),
    labelBucket: t('columns.bucket'),
    labelTotal: t('columns.total'),
    labelTotals: tr('trialBalance.totals'),
    labelDocCurrency: t('columns.currency'),
    labelTxnOpen: t('columns.txnOpen'),
    currencyOptions: (scope?.currencies ?? []).map((c) => ({ value: c, label: c })),
    currencyValue: target,
    currencyBasisValue: currencyBasis,
    labelCurrency: t('currency'),
    labelConvertFrom: t('convertFrom'),
    labelBase: t('baseOption'),
    labelTransaction: t('transactionOption'),
    bucketLabels,
    dashPlaceholder: '—',
    summaryRows: (summary?.rows ?? []).map((r, i) => {
      const name = r.partyName ?? noParty
      const row = r as unknown as Record<string, string>
      return {
        key: r.partyId ?? `none-${i}`,
        partyId: r.partyId,
        partyName: name,
        partyHref: `/reports/statements/${r.partyId}?side=${side}`,
        current: bucketCell(row, 'current', name, r.partyId),
        b1: bucketCell(row, 'b1', name, r.partyId),
        b2: bucketCell(row, 'b2', name, r.partyId),
        b3: bucketCell(row, 'b3', name, r.partyId),
        b4: bucketCell(row, 'b4', name, r.partyId),
        total: m(r.total),
        totalDrill: bucketDrill(name, r.partyId ?? undefined),
      }
    }),
    detailRows: (detailResult?.rows ?? []).map((r, i) => ({
      key: `${r.reference ?? 'x'}-${i}`,
      partyId: r.partyId,
      partyName: r.partyName ?? noParty,
      partyHref: `/reports/statements/${r.partyId}?side=${side}`,
      reference: r.reference ?? '',
      dueDate: r.dueDate,
      ageDays: String(r.ageDays),
      bucketLabel: bucketLabels[r.bucket],
      open: m(r.open),
      currency: r.docCurrency,
      txnOpen: mt(r.txnOpen, r.docCurrency),
      txn: { kind: 'transaction', entryId: r.docId, docKind: r.docKind, docId: r.docId },
    })),
    totals: {
      current: m(summary?.totals.current ?? '0'),
      b1: m(summary?.totals.b1 ?? '0'),
      b2: m(summary?.totals.b2 ?? '0'),
      b3: m(summary?.totals.b3 ?? '0'),
      b4: m(summary?.totals.b4 ?? '0'),
      total: m(summary?.totals.total ?? '0'),
    },
    totalsDrill: {
      current: bucketDrill(bucketLabels.current, undefined, 'current'),
      b1: bucketDrill(bucketLabels.b1, undefined, 'b1'),
      b2: bucketDrill(bucketLabels.b2, undefined, 'b2'),
      b3: bucketDrill(bucketLabels.b3, undefined, 'b3'),
      b4: bucketDrill(bucketLabels.b4, undefined, 'b4'),
      total: bucketDrill(tr('trialBalance.totals')),
    },
    dimensions: opts,
    subsidiaries: subView?.picker ?? [],
    periodPresets: AS_OF_PERIOD_PRESETS,
    scheduleDefId: scheduleDefId ?? null,
    scheduleParams: scheduleParamsFrom({ ...sp, period: requestedPeriod }),
    // The export must age as of the date on the screen it leaves from
    // (F-t07-011): without the resolved as-of the endpoint falls back to the
    // fiscal year end and every bucket is wrong.
    exportParams: stringParams({ ...sp, asOf }),
  }
}

function stringParams(sp: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

const f = ref<AgingData>()
const item = field
const rootF = rootRef<AgingData>()

const DASH = 'text-slate-300 dark:text-slate-600'
const EMPTY_ROW_CLASS = 'text-center text-slate-400 italic'

function partyCell() {
  return widgetCell('party-link-cell', {
    partyId: item('partyId'),
    partyName: item('partyName'),
    href: item('partyHref'),
  })
}

/** Bucket amount: drilled, dimmed em-dash when zero, red when negative. */
function bucketColumn(b: (typeof BUCKETS)[number]) {
  return column(
    rootF(`bucketLabels.${b}`),
    drill(
      item(`${b}.drill`),
      text(item(`${b}.value`), {
        fallback: rootF('dashPlaceholder'),
        fallbackClassName: DASH,
        tone: item(`${b}.tone`),
      }),
    ),
    { align: 'right', className: 'tabular-nums' },
  )
}

const totalsRow: TableSpanRow = {
  label: rootF('labelTotals'),
  labelColSpan: 1,
  labelClassName: 'font-bold',
  className: reportTotalRowClass,
  cells: [
    ...BUCKETS.map((b) => ({
      cell: drill(rootF(`totalsDrill.${b}`), money(rootF(`totals.${b}`))),
      align: 'right' as const,
      className: 'font-bold tabular-nums',
    })),
    {
      cell: drill(rootF('totalsDrill.total'), money(rootF('totals.total'))),
      align: 'right' as const,
      className: 'font-bold tabular-nums',
    },
  ],
}

export function agingSpec(data: AgingData): PageSpec {
  return page({
    route: '/reports/aging',
    layout: 'list',
    header: [
      pageHeader({ title: f('title'), back: { href: f('backHref'), label: f('backLabel') } }),
      filterBar(
        { period: true, asOf: true, dimensions: true, subsidiary: true },
        {
          dimensions: f('dimensions'),
          subsidiaries: f('subsidiaries'),
          defaultPeriod: 'today',
          periodPresets: f('periodPresets'),
          actions: [
            widget('currency-basis', {
              currencies: data.currencyOptions,
              currency: data.currencyValue,
              currencyBasis: data.currencyBasisValue,
              currencyLabel: data.labelCurrency,
              basisLabel: data.labelConvertFrom,
              baseLabel: data.labelBase,
              transactionLabel: data.labelTransaction,
            }, f('ratesReady')),
            widget('schedule-report', {
              definitionId: data.scheduleDefId ?? '',
              statementParams: data.scheduleParams,
            }, f('scheduleDefId')),
            widget('save-view'),
            widget('export-menu', { kind: 'aging', params: data.exportParams }),
          ],
        },
      ),
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
        wide: true,
        when: f('ratesReady'),
        blocks: [
          // Two independent presence flags, not a negation.
          {
            ...table({
              variant: 'report',
              rows: f('detailRows'),
              rowKey: item('key'),
              emptyRow: { text: f('emptyLabel'), colSpan: 8, className: EMPTY_ROW_CLASS },
              columns: [
                column(rootF('labelParty'), partyCell()),
                column(rootF('labelEntry'), txn(item('txn'), text(item('reference'))), {
                  className: 'font-mono text-xs',
                }),
                column(rootF('labelDue'), text(item('dueDate')), { className: 'tabular-nums' }),
                column(rootF('labelAge'), txn(item('txn'), text(item('ageDays'))), {
                  align: 'right',
                  className: 'tabular-nums',
                }),
                column(rootF('labelBucket'), text(item('bucketLabel'))),
                column(rootF('labelTotal'), txn(item('txn'), money(item('open'))), {
                  align: 'right',
                  className: 'font-medium tabular-nums',
                }),
                column(rootF('labelDocCurrency'), text(item('currency')), {
                  className: 'font-mono text-xs',
                }),
                column(rootF('labelTxnOpen'), txn(item('txn'), money(item('txnOpen'))), {
                  align: 'right',
                  className: 'tabular-nums',
                }),
              ],
            }),
            when: f('isDetail'),
          },
          {
            ...table({
              variant: 'report',
              rows: f('summaryRows'),
              rowKey: item('key'),
              emptyRow: { text: f('emptyLabel'), colSpan: BUCKETS.length + 2, className: EMPTY_ROW_CLASS },
              trailing: data.hasSummaryRows ? [totalsRow] : [],
              columns: [
                column(rootF('labelParty'), partyCell()),
                ...BUCKETS.map(bucketColumn),
                column(rootF('labelTotal'), drill(item('totalDrill'), money(item('total'))), {
                  align: 'right',
                  className: 'font-semibold tabular-nums',
                }),
              ],
            }),
            when: f('isSummary'),
          },
        ],
      }),
    ],
  })
}
