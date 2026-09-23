import 'server-only'
import { reportBookSelection } from '../../../../lib/report-books'
import { resolveOrgId } from '../../../../lib/org-scope'


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
  repeat,
  rootRef,
  table,
  text,
  textBlock,
  toggleLinks,
  txn,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
  type TableSpanRow,
} from '@braedonsaunders/appkit-viewspec'
import { getMoneyFormatter } from '@/lib/money-server'
import { dimensionOptions, partyRegister, type AgingSide } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { MissingRatesError, reportSubsidiaryView, type RatesBlockedNotice } from '../../../../lib/consolidation'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery, toSearchParams } from '../../../../lib/report-filters'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { decimalCmp, decimalIsZero } from '../../../../lib/statement-format'
import type { ReportDrillTarget } from '../../../../lib/report-drill'

/**
 * Party registers (AR / AP), split into a loader and a spec.
 *
 * Structurally the general ledger with parties in place of accounts, so it
 * reused `repeat`, the spanning opening row and the `entry-cell` widget as-is.
 * The only new surface was the filter bar's hairline divider after its mode
 * toggles, which is a house idiom rather than a page detail.
 */

type DimensionOptions = Awaited<ReturnType<typeof dimensionOptions>>
type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']

interface TxnTarget {
  kind: 'transaction'
  entryId: string
  docKind: string | null
  docId: string | null
}

export interface RegisterLine {
  key: string
  date: string
  entryId: string
  entryNumber: string | null
  docKind: string | null
  docId: string | null
  memo: string | null
  debit: string
  credit: string
  balance: string
  balanceTone: 'default' | 'negative'
  txn: TxnTarget
}

export interface RegisterParty {
  key: string
  partyId: string | null
  partyName: string
  statementHref: string
  opening: string
  openingDrill: ReportDrillTarget
  closing: string
  closingDrill: ReportDrillTarget
  lines: RegisterLine[]
}

export interface RegistersData {
  primaryFilter: { paramKey: string; label: string; value: string; options: { value: string; label: string }[] } | null
  title: string
  backHref: string
  backLabel: string
  company: string
  periodPhrase: string
  truncated: boolean
  truncatedLabel: string
  emptyLabel: string
  openingLabel: string
  closingLabel: string
  receivablesHref: string
  payablesHref: string
  receivablesLabel: string
  payablesLabel: string
  isReceivable: boolean
  isPayable: boolean
  columnDate: string
  columnEntry: string
  columnMemo: string
  columnDebits: string
  columnCredits: string
  columnBalance: string
  /** Set when underived consolidated rates block the report (F-t06-027):
   * the page renders a typed banner with a derive link instead of numbers. */
  ratesBlocked: RatesBlockedNotice | null
  /** False exactly when ratesBlocked is set; the paper hides with it. */
  ratesReady: boolean
  parties: RegisterParty[]
  dimensions: DimensionOptions
  subsidiaries: SubsidiaryPicker
  scheduleDefId: string | null
  scheduleParams: Record<string, string>
  exportParams: Record<string, string>
}

export async function loadRegisters(sp: Record<string, string | undefined>): Promise<RegistersData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const side: AgingSide = sp.side === 'ap' ? 'ap' : 'ar'
  const scheduleDefId = await reportScheduleAnchor('registers', { side })
  const tb = await getTranslations('budgets')
  const { books, selectedBook } = await reportBookSelection(await resolveOrgId(), sp.book)
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  // Legal-entity scope is enforced here, not by the picker: a restricted
  // reader's view resolves to the subsidiaries they may see (empty = no rows)
  // and every query below carries it — the same contract as the export path.
  // Underived consolidated rates must not throw out of SSR (F-t06-027):
  // the page renders a typed banner with a derive link instead of any
  // numbers. Anything else is a real defect and still throws. The register
  // runs only with a resolved subsidiary scope — never scope-less.
  let subView: Awaited<ReturnType<typeof reportSubsidiaryView>> | undefined
  let ratesBlocked: RatesBlockedNotice | null = null
  try {
    subView = await reportSubsidiaryView(q.subsidiaryId, period.to)
  } catch (e) {
    if (!(e instanceof MissingRatesError)) throw e
    ratesBlocked = {
      code: 'rates-not-derived',
      title: t('statement.ratesBlockedTitle'),
      description: (e as Error).message,
      deriveLabel: t('statement.ratesBlockedAction'),
      deriveHref: '/close',
    }
  }
  const dims = { ...q.dims, subsidiaryIds: subView?.subsidiary?.ids }
  const [reg, opts, org] = subView
    ? await Promise.all([
        partyRegister(side, { bookId: selectedBook.id, from: period.from, to: period.to, dims }),
        dimensionOptions(undefined, undefined, dims.subsidiaryIds),
        orgInfo(),
      ])
    : [null, await dimensionOptions(), await orgInfo()]
  const m = (v: string) => formatMoney(v, { currency: org?.base_currency })
  const keepParams = toSearchParams(q)
  keepParams.set('book', selectedBook.id)
  const keep = keepParams.toString()
  const accountTypes = [side === 'ap' ? 'liability_payable' : 'asset_receivable']
  const openingTo = new Date(`${period.from}T00:00:00Z`)
  openingTo.setUTCDate(openingTo.getUTCDate() - 1)
  const openingDate = openingTo.toISOString().slice(0, 10)
  const noParty = t('aging.noParty')
  const openingLabel = t('generalLedger.opening')

  return {
    title: side === 'ap' ? t('registers.apTitle') : t('registers.arTitle'),
    backHref: '/reports',
    backLabel: t('hub.title'),
    company: org?.name ?? '',
    periodPhrase: `${selectedBook.name} · ${t('pnl.dateRange', { from: period.from, to: period.to })}`,
    truncated: reg?.truncated ?? false,
    truncatedLabel: t('registers.truncated'),
    emptyLabel: t('registers.empty'),
    openingLabel,
    closingLabel: t('registers.closing'),
    receivablesHref: `/reports/registers?side=ar&${keep}`,
    payablesHref: `/reports/registers?side=ap&${keep}`,
    receivablesLabel: t('registers.receivables'),
    payablesLabel: t('registers.payables'),
    isReceivable: side === 'ar',
    isPayable: side === 'ap',
    columnDate: t('generalLedger.columns.date'),
    columnEntry: t('generalLedger.columns.entry'),
    columnMemo: tc('labels.memo'),
    columnDebits: t('trialBalance.columns.debits'),
    columnCredits: t('trialBalance.columns.credits'),
    columnBalance: tc('labels.balance'),
    ratesBlocked,
    ratesReady: ratesBlocked === null,
    parties: (reg?.parties ?? []).map((pt) => {
      const name = pt.partyName ?? noParty
      const partyIds = pt.partyId ? [pt.partyId] : undefined
      return {
        key: pt.partyId ?? 'none',
        partyId: pt.partyId,
        partyName: name,
        statementHref: `/reports/statements/${pt.partyId}?side=${side}&${keep}`,
        opening: m(pt.opening),
        openingDrill: {
          kind: 'ledger', bookId: selectedBook.id,
          label: `${name} · ${openingLabel}`,
          accountTypes,
          partyIds,
          to: openingDate,
          mode: 'balance',
          dims,
        },
        closing: m(pt.closing),
        closingDrill: {
          kind: 'ledger', bookId: selectedBook.id,
          label: name,
          accountTypes,
          partyIds,
          to: period.to,
          mode: 'balance',
          dims,
        },
        lines: pt.lines.map((l, i) => ({
          key: `${l.entryId}-${i}`,
          date: l.date,
          entryId: l.entryId,
          entryNumber: l.entryNumber,
          docKind: l.docKind,
          docId: l.docId,
          memo: l.memo,
          debit: decimalIsZero(l.debit) ? '' : m(l.debit),
          credit: decimalIsZero(l.credit) ? '' : m(l.credit),
          balance: m(l.balance),
          balanceTone: decimalCmp(l.balance, '0') < 0 ? 'negative' : 'default',
          txn: { kind: 'transaction', entryId: l.entryId, docKind: l.docKind, docId: l.docId },
        })),
      }
    }),
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

const f = ref<RegistersData>()
const item = field
const rootF = rootRef<RegistersData>()

const openingRow: TableSpanRow = {
  label: rootF('openingLabel'),
  labelColSpan: 5,
  labelClassName: 'text-xs font-medium text-slate-500 dark:text-slate-400',
  cells: [
    {
      cell: drill(item('openingDrill'), money(item('opening'))),
      align: 'right',
      className: 'font-medium tabular-nums',
    },
  ],
}

export function registersSpec(data: RegistersData): PageSpec {
  return page({
    route: '/reports/registers',
    layout: 'list',
    header: [
      pageHeader({ title: f('title'), back: { href: f('backHref'), label: f('backLabel') } }),
      filterBar(
        { period: true, dimensions: true, subsidiary: true },
        {
          leading: {
            ...toggleLinks([
              { href: f('receivablesHref'), label: f('receivablesLabel'), activeWhen: f('isReceivable') },
              { href: f('payablesHref'), label: f('payablesLabel'), activeWhen: f('isPayable') },
            ]),
            divider: true,
          },
          dimensions: f('dimensions'),
          subsidiaries: f('subsidiaries'),
          primaryFilter: f('primaryFilter'),
          actions: [
            widget('schedule-report', {
              definitionId: data.scheduleDefId ?? '',
              statementParams: data.scheduleParams,
            }, f('scheduleDefId')),
            widget('save-view'),
            widget('export-menu', { kind: 'registers', params: data.exportParams }),
          ],
        },
      ),
      textBlock(f('truncatedLabel'), { tone: 'warning', when: f('truncated') }),
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
          repeat({
            items: f('parties'),
            itemKey: item('key'),
            className: 'space-y-8',
            empty: { text: f('emptyLabel'), className: 'py-8 text-center text-slate-400 italic' },
            blocks: [
              widgetBlock('party-heading', {
                partyId: item('partyId'),
                partyName: item('partyName'),
                statementHref: item('statementHref'),
                closingLabel: rootF('closingLabel'),
                closing: item('closing'),
                closingDrill: item('closingDrill'),
              }),
              table({
                variant: 'report',
                rows: item('lines'),
                rowKey: item('key'),
                leading: [openingRow],
                columns: [
                  column(rootF('columnDate'), text(item('date')), {
                    headerClassName: 'w-28',
                    className: 'tabular-nums',
                  }),
                  column(
                    rootF('columnEntry'),
                    widgetCell('entry-cell', {
                      entryId: item('entryId'),
                      docKind: item('docKind'),
                      docId: item('docId'),
                      entryNumber: item('entryNumber'),
                    }),
                    { headerClassName: 'w-24' },
                  ),
                  column(rootF('columnMemo'), text(item('memo')), {
                    className: 'text-slate-600 dark:text-slate-300',
                  }),
                  column(rootF('columnDebits'), txn(item('txn'), money(item('debit'))), { align: 'right' }),
                  column(rootF('columnCredits'), txn(item('txn'), money(item('credit'))), { align: 'right' }),
                  column(
                    rootF('columnBalance'),
                    txn(item('txn'), money(item('balance'), { tone: item('balanceTone') })),
                    { align: 'right' },
                  ),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  })
}
