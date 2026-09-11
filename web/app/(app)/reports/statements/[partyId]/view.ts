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
  toggleLinks,
  txn,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
  type TableSpanRow,
} from '@braedonsaunders/appkit-viewspec'
import { getMoneyFormatter } from '@/lib/money-server'
import { requirePermission } from '../../../../../lib/authz'
import { partnerStatement, type AgingSide } from '../../../../../lib/reports'
import { orgInfo } from '../../../../../lib/data'
import { resolvePeriod } from '../../../../../lib/periods'
import { parseReportQuery, toSearchParams } from '../../../../../lib/report-filters'
import { reportTotalRowClass } from '../../ReportTable'
import { decimalCmp, decimalIsZero } from '../../../../../lib/statement-format'
import type { ReportDrillTarget } from '../../../../../lib/report-drill'

/**
 * A party statement, split into a loader and a spec.
 *
 * The ledger half reuses the general-ledger vocabulary unchanged: `repeat` is
 * not needed (one party, one table), and the opening/closing balances are the
 * same spanning summary rows. The aging strip above it is a bespoke layout, so
 * it is a component placed as a widget.
 */

const BUCKETS = ['current', 'b1', 'b2', 'b3', 'b4'] as const

interface TxnTarget {
  kind: 'transaction'
  entryId: string
  docKind: string | null
  docId: string | null
}

export interface StatementLine {
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

export interface StatementData {
  title: string
  backHref: string
  backLabel: string
  company: string
  periodPhrase: string
  receivablesHref: string
  payablesHref: string
  receivablesLabel: string
  payablesLabel: string
  isReceivable: boolean
  isPayable: boolean
  agingCells: { key: string; label: string; value: string; drill: ReportDrillTarget }[]
  agingTotalLabel: string
  agingTotal: string
  agingTotalDrill: ReportDrillTarget
  openingLabel: string
  opening: string
  openingDrill: ReportDrillTarget
  closingLabel: string
  closing: string
  closingTone: 'default' | 'negative'
  closingDrill: ReportDrillTarget
  columnDate: string
  columnEntry: string
  columnMemo: string
  columnDebits: string
  columnCredits: string
  columnBalance: string
  lines: StatementLine[]
  exportParams: Record<string, string>
}

export async function loadStatement(
  partyId: string,
  sp: Record<string, string | undefined>,
): Promise<StatementData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const authz = await requirePermission('reports.read')
  const side: AgingSide = sp.side === 'ap' ? 'ap' : 'ar'
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const [st, org] = await Promise.all([
    partnerStatement(partyId, authz.user.orgId, {
      from: period.from,
      to: period.to,
      side,
      dims: {
        subsidiaryIds:
          authz.allowedSubsidiaryIds === null ? undefined : [...authz.allowedSubsidiaryIds],
      },
    }),
    orgInfo(),
  ])
  const m = (v: string) => formatMoney(v, { currency: org?.base_currency })
  const keep = toSearchParams(q).toString()
  const accountTypes = [side === 'ap' ? 'liability_payable' : 'asset_receivable']
  const openingTo = new Date(`${period.from}T00:00:00Z`)
  openingTo.setUTCDate(openingTo.getUTCDate() - 1)
  const openingDate = openingTo.toISOString().slice(0, 10)
  const name = st.party.name ?? t('statements.title')
  const openingLabel = t('statements.opening')
  const closingLabel = t('statements.closing')

  const bucketLabels: Record<(typeof BUCKETS)[number], string> = {
    current: t('aging.buckets.current'),
    b1: t('aging.buckets.b1'),
    b2: t('aging.buckets.b2'),
    b3: t('aging.buckets.b3'),
    b4: t('aging.buckets.b4'),
  }

  return {
    title: name,
    backHref: '/reports/registers',
    backLabel: t('registers.arTitle'),
    company: org?.name ?? '',
    periodPhrase: t('pnl.dateRange', { from: period.from, to: period.to }),
    receivablesHref: `/reports/statements/${partyId}?side=ar&${keep}`,
    payablesHref: `/reports/statements/${partyId}?side=ap&${keep}`,
    receivablesLabel: t('registers.receivables'),
    payablesLabel: t('registers.payables'),
    isReceivable: side === 'ar',
    isPayable: side === 'ap',
    agingCells: BUCKETS.map((b) => ({
      key: b,
      label: bucketLabels[b],
      value: m(st.aging[b]),
      drill: {
        kind: 'aging',
        label: `${name} · ${bucketLabels[b]}`,
        side,
        asOf: period.to,
        partyId,
        bucket: b,
      },
    })),
    agingTotalLabel: t('aging.columns.total'),
    agingTotal: m(st.aging.total),
    agingTotalDrill: { kind: 'aging', label: name, side, asOf: period.to, partyId },
    openingLabel,
    opening: m(st.opening),
    openingDrill: {
      kind: 'ledger',
      label: openingLabel,
      accountTypes,
      partyIds: [partyId],
      to: openingDate,
      mode: 'balance',
    },
    closingLabel,
    closing: m(st.closing),
    closingTone: decimalCmp(st.closing, '0') < 0 ? 'negative' : 'default',
    closingDrill: {
      kind: 'ledger',
      label: closingLabel,
      accountTypes,
      partyIds: [partyId],
      to: period.to,
      mode: 'balance',
    },
    columnDate: t('generalLedger.columns.date'),
    columnEntry: t('generalLedger.columns.entry'),
    columnMemo: tc('labels.memo'),
    columnDebits: t('trialBalance.columns.debits'),
    columnCredits: t('trialBalance.columns.credits'),
    columnBalance: tc('labels.balance'),
    lines: st.lines.map((l, i) => ({
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
    exportParams: { ...stringParams(sp), party: partyId, side },
  }
}

function stringParams(sp: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

const f = ref<StatementData>()
const item = field
const rootF = rootRef<StatementData>()

const openingRow: TableSpanRow = {
  label: rootF('openingLabel'),
  labelColSpan: 5,
  labelClassName: 'text-xs font-medium text-slate-500 dark:text-slate-400',
  cells: [
    {
      cell: drill(rootF('openingDrill'), money(rootF('opening'))),
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
      cell: drill(rootF('closingDrill'), money(rootF('closing'), { tone: rootF('closingTone') })),
      align: 'right',
      className: 'font-semibold tabular-nums',
    },
  ],
}

export function statementSpec(data: StatementData): PageSpec {
  return page({
    route: '/reports/statements/[partyId]',
    layout: 'list',
    header: [
      pageHeader({ title: f('title'), back: { href: f('backHref'), label: f('backLabel') } }),
      filterBar(
        { period: true },
        {
          leading: {
            ...toggleLinks([
              { href: f('receivablesHref'), label: f('receivablesLabel'), activeWhen: f('isReceivable') },
              { href: f('payablesHref'), label: f('payablesLabel'), activeWhen: f('isPayable') },
            ]),
            divider: true,
          },
          actions: [
            widget('save-view'),
            widget('export-menu', { kind: 'partner-statement', params: data.exportParams }),
          ],
        },
      ),
    ],
    body: [
      paper({
        company: f('company'),
        title: f('title'),
        periodPhrase: f('periodPhrase'),
        wide: true,
        blocks: [
          widgetBlock('aging-strip', {
            cells: data.agingCells,
            totalLabel: data.agingTotalLabel,
            total: data.agingTotal,
            totalDrill: data.agingTotalDrill,
          }),
          table({
            variant: 'report',
            rows: f('lines'),
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
  })
}
