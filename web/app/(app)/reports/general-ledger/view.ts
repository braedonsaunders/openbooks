import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  column,
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
  txn,
  drill,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
  type TableSpanRow,
} from '@braedonsaunders/appkit-viewspec'
import { getMoneyFormatter } from '@/lib/money-server'
import { dimensionOptions, generalLedger } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolveOrgId } from '../../../../lib/org-scope'
import { reportBookSelection } from '../../../../lib/report-books'
import { MissingRatesError, reportSubsidiaryView, type RatesBlockedNotice } from '../../../../lib/consolidation'
import { resolvePeriod } from '../../../../lib/periods'
import { isReportUuidParam, parseReportQuery } from '../../../../lib/report-filters'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { reportTotalRowClass } from '../ReportTable'
import { decimalCmp, decimalIsZero } from '../../../../lib/statement-format'
import type { ReportDrillTarget } from '../../../../lib/report-drill'

/**
 * The general ledger, split into a loader and a spec.
 *
 * Shape-wise this is the journal plus per-account opening and closing
 * balances — spanning summary rows above and below each table's lines. Those
 * are what motivated `table.leading` / `table.trailing`: an accounting idiom
 * shared by ledgers, registers, aging and trial balance, so worth naming
 * rather than making each page a bespoke widget.
 *
 * As in the journal, every line carries its own denormalized `txn` target so
 * the nested table never needs to reach its parent account's scope.
 */

type DimensionOptions = Awaited<ReturnType<typeof dimensionOptions>>
type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']

interface TxnTarget {
  kind: 'transaction'
  entryId: string
  docKind: string | null
  docId: string | null
}

export interface LedgerLine {
  key: string
  date: string
  entryId: string
  entryNumber: string | null
  docKind: string | null
  docId: string | null
  detail: string
  debit: string
  credit: string
  balance: string
  balanceTone: 'default' | 'negative'
  txn: TxnTarget
}

export interface LedgerAccount {
  id: string
  number: string | null
  name: string
  opening: string
  openingDrill: ReportDrillTarget
  closing: string
  closingTone: 'default' | 'negative'
  closingDrill: ReportDrillTarget
  lines: LedgerLine[]
}

export interface GeneralLedgerData {
  title: string
  backHref: string
  backLabel: string
  company: string
  periodPhrase: string
  periodFrom: string
  periodTo: string
  truncated: boolean
  truncatedLabel: string
  emptyLabel: string
  openingLabel: string
  closingLabel: string
  columnDate: string
  columnEntry: string
  columnDetail: string
  columnDebits: string
  columnCredits: string
  columnBalance: string
  /** Set when underived consolidated rates block the report (F-t06-027):
   * the page renders a typed banner with a derive link instead of numbers. */
  ratesBlocked: RatesBlockedNotice | null
  /** False exactly when ratesBlocked is set; the paper hides with it. */
  ratesReady: boolean
  accounts: LedgerAccount[]
  dimensions: DimensionOptions
  subsidiaries: SubsidiaryPicker
  /** Only rendered when the org has more than one book. */
  primaryFilter: { paramKey: string; label: string; value: string; options: { value: string; label: string }[] } | null
  scheduleDefId: string | null
  scheduleParams: Record<string, string>
  exportParams: Record<string, string>
}

export async function loadGeneralLedger(
  sp: Record<string, string | undefined>,
): Promise<GeneralLedgerData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  // The book label reuses the budgets list's existing filter copy.
  const tb = await getTranslations('budgets')
  const scheduleDefId = await reportScheduleAnchor('general-ledger')
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  // Legal-entity scope is enforced here, not by the picker: a restricted
  // reader's view resolves to the subsidiaries they may see (empty = no rows)
  // and every query below carries it — the same contract as the export path.
  const orgId = await resolveOrgId()
  const { books, selectedBook } = await reportBookSelection(orgId, sp.book)
  // Underived consolidated rates must not throw out of SSR (F-t06-027):
  // the page renders a typed banner with a derive link instead of any
  // numbers. Anything else is a real defect and still throws. The ledger
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
  const [gl, opts, org] = subView
    ? await Promise.all([
        generalLedger(period.from, period.to, {
          accountId: isReportUuidParam(sp.account) ? sp.account : undefined,
          dims,
          bookId: selectedBook?.id,
        }),
        dimensionOptions(undefined, dims.projectId, dims.subsidiaryIds),
        orgInfo(),
      ])
    : [null, await dimensionOptions(undefined, dims.projectId, dims.subsidiaryIds), await orgInfo()]
  const m = (v: string) => formatMoney(v, { currency: org?.base_currency })
  const openingTo = new Date(`${period.from}T00:00:00Z`)
  openingTo.setUTCDate(openingTo.getUTCDate() - 1)
  const openingDate = openingTo.toISOString().slice(0, 10)
  const openingLabel = t('generalLedger.opening')
  const closingLabel = t('generalLedger.closing')

  return {
    title: t('generalLedger.title'),
    backHref: '/reports',
    backLabel: t('hub.title'),
    company: org?.name ?? '',
    periodPhrase: `${selectedBook.name} · ${t('pnl.dateRange', { from: period.from, to: period.to })}`,
    periodFrom: period.from,
    periodTo: period.to,
    truncated: gl?.truncated ?? false,
    truncatedLabel: t('generalLedger.truncated'),
    emptyLabel: t('generalLedger.empty'),
    openingLabel,
    closingLabel,
    columnDate: t('generalLedger.columns.date'),
    columnEntry: t('generalLedger.columns.entry'),
    columnDetail: t('generalLedger.columns.detail'),
    columnDebits: t('trialBalance.columns.debits'),
    columnCredits: t('trialBalance.columns.credits'),
    columnBalance: tc('labels.balance'),
    ratesBlocked,
    ratesReady: ratesBlocked === null,
    accounts: (gl?.accounts ?? []).map((a) => ({
      id: a.id,
      number: a.number,
      name: a.name,
      opening: m(a.opening),
      openingDrill: {
        kind: 'ledger',
        label: `${a.name} · ${openingLabel}`,
        accountIds: [a.id],
        to: openingDate,
        mode: 'balance',
        dims,
        bookId: selectedBook.id,
      },
      closing: m(a.closing),
      closingTone: decimalCmp(a.closing, '0') < 0 ? 'negative' : 'default',
      closingDrill: {
        kind: 'ledger',
        label: `${a.name} · ${closingLabel}`,
        accountIds: [a.id],
        to: period.to,
        mode: 'balance',
        dims,
        bookId: selectedBook.id,
      },
      lines: a.lines.map((l, i) => ({
        key: `${l.entryId}-${i}`,
        date: l.date,
        entryId: l.entryId,
        entryNumber: l.entryNumber,
        docKind: l.docKind,
        docId: l.docId,
        detail: [l.party, l.memo].filter(Boolean).join(' · '),
        debit: decimalIsZero(l.debit) ? '' : m(l.debit),
        credit: decimalIsZero(l.credit) ? '' : m(l.credit),
        balance: m(l.balance),
        balanceTone: decimalCmp(l.balance, '0') < 0 ? 'negative' : 'default',
        txn: { kind: 'transaction', entryId: l.entryId, docKind: l.docKind, docId: l.docId },
      })),
    })),
    dimensions: opts,
    subsidiaries: subView?.picker ?? [],
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

const f = ref<GeneralLedgerData>()
const item = field
/** Page-level labels referenced from inside the per-account repeat. */
const rootF = rootRef<GeneralLedgerData>()

/** Opening balance — five spanned label columns, then the drilled amount. */
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

const closingRow: TableSpanRow = {
  label: rootF('closingLabel'),
  labelColSpan: 5,
  labelClassName: 'text-xs font-semibold',
  className: reportTotalRowClass,
  cells: [
    {
      cell: drill(item('closingDrill'), money(item('closing'), { tone: item('closingTone') })),
      align: 'right',
      className: 'font-semibold tabular-nums',
    },
  ],
}

export function generalLedgerSpec(data: GeneralLedgerData): PageSpec {
  return page({
    route: '/reports/general-ledger',
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
            widget('export-menu', { kind: 'general-ledger', params: data.exportParams }),
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
            items: f('accounts'),
            itemKey: item('id'),
            className: 'space-y-8',
            empty: { text: f('emptyLabel'), className: 'py-8 text-center text-slate-400 italic' },
            blocks: [
              widgetBlock('account-heading', {
                accountId: item('id'),
                from: rootF('periodFrom'),
                to: rootF('periodTo'),
                number: item('number'),
                name: item('name'),
              }),
              table({
                variant: 'report',
                rows: item('lines'),
                rowKey: item('key'),
                leading: [openingRow],
                trailing: [closingRow],
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
                  column(rootF('columnDetail'), text(item('detail')), {
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
