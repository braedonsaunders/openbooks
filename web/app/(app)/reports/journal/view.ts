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
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { getMoneyFormatter } from '@/lib/money-server'
import { dimensionOptions, journalReport } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { reportSubsidiaryView } from '../../../../lib/consolidation'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { decimalIsZero } from '../../../../lib/statement-format'

/**
 * The journal report, split into a loader and a spec.
 *
 * This is the first page whose content is a repeating GROUP rather than a flat
 * table: one heading plus one line table per entry. It is what motivated the
 * `repeat` block — the same iteration `table` already performs over rows,
 * lifted to a block subtree.
 *
 * Two things are precomputed here that a spec must never do. The origin label
 * resolves its own i18n fallback (`t.has`), and each LINE carries a
 * denormalized `txn` target: the transaction link belongs to the entry, and
 * having the line hold its own copy means the nested table needs no way to
 * reach its parent group's scope. Cheaper than a traversal operator, and it
 * keeps the language smaller.
 */

type DimensionOptions = Awaited<ReturnType<typeof dimensionOptions>>
type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>['picker']

interface TxnTarget {
  kind: 'transaction'
  entryId: string
  docKind: string | null
  docId: string | null
}

export interface JournalLine {
  key: string
  account: string
  /** Not every account carries a number. */
  accountNumber: string | null
  accountName: string
  detail: string
  /** Empty string when the side is zero — the native page renders nothing. */
  debit: string
  credit: string
  txn: TxnTarget
}

export interface JournalEntry {
  id: string
  entryId: string
  docKind: string | null
  docId: string | null
  /** Some system entries have no assigned number. */
  entryNumber: string | null
  date: string
  originLabel: string
  memo: string | null
  lines: JournalLine[]
}

export interface JournalData {
  title: string
  backHref: string
  backLabel: string
  company: string
  periodPhrase: string
  truncated: boolean
  truncatedLabel: string
  emptyLabel: string
  columnAccount: string
  columnDetail: string
  columnDebits: string
  columnCredits: string
  entries: JournalEntry[]
  dimensions: DimensionOptions
  subsidiaries: SubsidiaryPicker
  scheduleDefId: string | null
  scheduleParams: Record<string, string>
  exportParams: Record<string, string>
}

export async function loadJournal(sp: Record<string, string | undefined>): Promise<JournalData> {
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const scheduleDefId = await reportScheduleAnchor('journal')
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  // Legal-entity scope is enforced here, not by the picker: a restricted
  // reader's view resolves to the subsidiaries they may see (empty = no rows)
  // and every query below carries it — the same contract as the export path.
  const subView = await reportSubsidiaryView(q.subsidiaryId, period.to)
  const dims = { ...q.dims, subsidiaryIds: subView.subsidiary?.ids }
  const [journal, opts, org] = await Promise.all([
    journalReport(period.from, period.to, { dims }),
    dimensionOptions(),
    orgInfo(),
  ])
  const m = (v: string) => formatMoney(v, { currency: org?.base_currency })

  return {
    title: t('journal.title'),
    backHref: '/reports',
    backLabel: t('hub.title'),
    company: org?.name ?? '',
    periodPhrase: t('pnl.dateRange', { from: period.from, to: period.to }),
    truncated: journal.truncated,
    truncatedLabel: t('journal.truncated'),
    emptyLabel: t('journal.empty'),
    columnAccount: tc('labels.account'),
    columnDetail: t('journal.columns.detail'),
    columnDebits: t('trialBalance.columns.debits'),
    columnCredits: t('trialBalance.columns.credits'),
    entries: journal.entries.map((e) => {
      const target: TxnTarget = { kind: 'transaction', entryId: e.id, docKind: e.docKind, docId: e.docId }
      return {
        id: e.id,
        entryId: e.id,
        docKind: e.docKind,
        docId: e.docId,
        entryNumber: e.entryNumber,
        date: e.date,
        originLabel: t.has(`journal.origins.${e.origin}`) ? t(`journal.origins.${e.origin}`) : e.origin,
        memo: e.memo,
        lines: e.lines.map((l, i) => ({
          key: String(i),
          account: l.accountName,
          accountNumber: l.accountNumber,
          accountName: l.accountName,
          detail: [l.party, l.memo].filter(Boolean).join(' · '),
          debit: decimalIsZero(l.debit) ? '' : m(l.debit),
          credit: decimalIsZero(l.credit) ? '' : m(l.credit),
          txn: target,
        })),
      }
    }),
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

const f = ref<JournalData>()
const item = field
/**
 * Page-level fields referenced from INSIDE the repeat.
 *
 * Blocks nested in a `repeat` resolve against the item, not the page, so the
 * column headers below — which are page-level labels — must go through
 * `$root`. This is the one sharp edge of nested scopes and it is easy to miss:
 * the symptom is a silently empty header cell, which the conformance harness
 * catches but a casual look at the page would not.
 */
const rootF = rootRef<JournalData>()

export function journalSpec(data: JournalData): PageSpec {
  return page({
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
            widget('export-menu', { kind: 'journal', params: data.exportParams }),
          ],
        },
      ),
      textBlock(f('truncatedLabel'), { tone: 'warning', when: f('truncated') }),
    ],
    body: [
      paper({
        company: f('company'),
        title: f('title'),
        periodPhrase: f('periodPhrase'),
        wide: true,
        blocks: [
          repeat({
            items: f('entries'),
            itemKey: item('id'),
            className: 'space-y-6',
            empty: { text: f('emptyLabel'), className: 'py-8 text-center text-slate-400 italic' },
            blocks: [
              // Props are field refs, resolved against the repeat item.
              widgetBlock('journal-entry-heading', {
                entryId: item('entryId'),
                docKind: item('docKind'),
                docId: item('docId'),
                entryNumber: item('entryNumber'),
                date: item('date'),
                originLabel: item('originLabel'),
                memo: item('memo'),
              }),
              table({
                variant: 'report',
                rows: item('lines'),
                rowKey: item('key'),
                columns: [
                  column(
                    rootF('columnAccount'),
                    text(item('accountName'), {
                      prefix: {
                        field: item('accountNumber'),
                        className: 'mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400',
                      },
                    }),
                  ),
                  column(rootF('columnDetail'), text(item('detail')), {
                    className: 'text-slate-600 dark:text-slate-300',
                  }),
                  column(rootF('columnDebits'), txn(item('txn'), money(item('debit'))), { align: 'right' }),
                  column(rootF('columnCredits'), txn(item('txn'), money(item('credit'))), { align: 'right' }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  })
}
