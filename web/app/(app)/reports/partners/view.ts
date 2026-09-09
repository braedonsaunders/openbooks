import 'server-only'

import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import {
  column,
  drill,
  field,
  filterBar,
  money,
  number,
  page,
  pageHeader,
  pagination,
  paper,
  ref,
  rootRef,
  summaryLine,
  table,
  text,
  toggleLinks,
  widget,
  type PageSpec,
} from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import { getMoneyFormatter } from '@/lib/money-server'
import { parseListParams } from '../../../../lib/list-params'
import { partnerBalances } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolveOrgId } from '../../../../lib/org-scope'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { decimalCmp, decimalNeg, decimalSum } from '../../../../lib/statement-format'
import type { ReportDrillTarget } from '../../../../lib/report-drill'

/**
 * The partners report, split into a loader and a spec.
 *
 * This is the reference conversion: everything imperative — permissions,
 * i18n, param parsing, the balance query, filtering, the payable sign flip,
 * pagination, money formatting, drill-target construction — stays here in
 * ordinary TypeScript. What comes out is presentation-ready: every string is
 * already formatted and every conditional has already collapsed into a named
 * tone or a boolean flag.
 *
 * The spec below then only names blocks and binds fields. That division is
 * the whole design: it is what lets the spec be data (serializable, diffable,
 * patchable by an agent) without any of the logic above becoming data too.
 */

const PER_PAGE = 50

export interface PartnersRow {
  /** Null for ledger lines carrying no party — the report still shows them. */
  id: string | null
  rowKey: string
  displayName: string | null
  balance: string
  /** Named presentation state, decided here — the spec never compares numbers. */
  balanceTone: 'default' | 'negative'
  /** Postgres returns count(*) as a string; presented verbatim. */
  lineCount: string
  drill: ReportDrillTarget
}

export interface PartnersData {
  title: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  payableHref: string
  receivableHref: string
  payableLabel: string
  receivableLabel: string
  isPayable: boolean
  isReceivable: boolean
  totalLabel: string
  total: string
  totalDrill: ReportDrillTarget
  noPartyLabel: string
  columnParty: string
  columnOutstanding: string
  columnGlLines: string
  company: string
  periodPhrase: string
  rows: PartnersRow[]
  totalRows: number
  currentPage: number
  perPage: number
  /** Widget inputs: absent definition id omits the schedule button entirely. */
  scheduleDefId: string | null
  scheduleParams: Record<string, string>
  exportParams: Record<string, string>
}

export async function loadPartners(
  sp: Record<string, string | string[] | undefined>,
): Promise<PartnersData> {
  const authz = await requirePermission('reports.read')
  const scope = authz.allowedSubsidiaryIds === null ? undefined : [...authz.allowedSubsidiaryIds]
  const { money: formatMoney } = await getMoneyFormatter()
  const t = await getTranslations('reports.partners')
  const tr = await getTranslations('reports')
  const tc = await getTranslations('common')

  const kind = sp.kind === 'receivable' ? 'receivable' : 'payable'
  const scheduleDefId = await reportScheduleAnchor('partners', { kind })
  const params = parseListParams(sp, { sort: 'balance', allowedSorts: ['balance'] as const, perPage: PER_PAGE })
  const [all, org] = await Promise.all([
    partnerBalances(kind, authz.user.orgId, undefined, undefined, { subsidiaryIds: scope }),
    orgInfo(),
  ])

  const m = (value: string) => formatMoney(value, { currency: org?.base_currency })
  const q = params.q?.toLowerCase()
  const filtered = q ? all.filter((r) => (r.display_name ?? '').toLowerCase().includes(q)) : all
  // Payables are stored credit-negative; the report presents them positive.
  const presented = (value: string) => (kind === 'payable' ? decimalNeg(value) : value)
  const total = presented(decimalSum(filtered.map((row) => row.balance)))
  const pageRows = filtered.slice((params.page - 1) * PER_PAGE, params.page * PER_PAGE)
  const asOf = await businessToday(await resolveOrgId())
  const accountTypes = [kind === 'payable' ? 'liability_payable' : 'asset_receivable']
  const noPartyLabel = t('noPartyOnLines')
  const totalLabel = t('totalOutstanding')

  return {
    title: kind === 'payable' ? t('payablesTitle') : t('receivablesTitle'),
    backHref: '/reports',
    backLabel: tr('hub.title'),
    searchPlaceholder: t('searchPlaceholder'),
    payableHref: '/reports/partners?kind=payable',
    receivableHref: '/reports/partners?kind=receivable',
    payableLabel: t('payables'),
    receivableLabel: t('receivables'),
    isPayable: kind === 'payable',
    isReceivable: kind === 'receivable',
    totalLabel,
    total: m(total),
    totalDrill: { kind: 'ledger', label: totalLabel, accountTypes, to: asOf, mode: 'balance' },
    noPartyLabel,
    columnParty: tc('labels.party'),
    columnOutstanding: t('columns.outstanding'),
    columnGlLines: t('columns.glLines'),
    company: org?.name ?? '',
    periodPhrase: t('description'),
    rows: pageRows.map((row, index) => {
      const balance = presented(row.balance)
      return {
        id: row.id,
        rowKey: row.id ?? `none-${index}`,
        displayName: row.display_name,
        balance: m(balance),
        balanceTone: decimalCmp(balance, '0') < 0 ? 'negative' : 'default',
        lineCount: row.line_count,
        drill: {
          kind: 'ledger',
          label: row.display_name ?? noPartyLabel,
          accountTypes,
          partyIds: row.id ? [row.id] : undefined,
          to: asOf,
          mode: 'balance',
        },
      }
    }),
    totalRows: filtered.length,
    currentPage: params.page,
    perPage: PER_PAGE,
    scheduleDefId: scheduleDefId ?? null,
    scheduleParams: scheduleParamsFrom(sp),
    exportParams: { ...stringParams(sp), side: kind },
  }
}

/** searchParams values may be arrays; the export menu takes flat strings. */
function stringParams(sp: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

const f = ref<PartnersData>()
const row = field
/** Page-level constants referenced from inside a row scope. */
const rootF = rootRef<PartnersData>()

export function partnersSpec(data: PartnersData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
      filterBar(
        { search: true, period: false },
        {
          searchPlaceholder: f('searchPlaceholder'),
          leading: toggleLinks([
            { href: f('payableHref'), label: f('payableLabel'), activeWhen: f('isPayable') },
            { href: f('receivableHref'), label: f('receivableLabel'), activeWhen: f('isReceivable') },
          ]),
          actions: [
            widget('schedule-report', {
              definitionId: data.scheduleDefId ?? '',
              statementParams: data.scheduleParams,
            }, f('scheduleDefId')),
            widget('save-view'),
            widget('export-menu', { kind: 'partners', params: data.exportParams }),
          ],
        },
      ),
      summaryLine(f('totalLabel'), drill(f('totalDrill'), money(f('total')))),
    ],
    body: [
      paper({
        company: f('company'),
        title: f('title'),
        periodPhrase: f('periodPhrase'),
        blocks: [
          table({
            variant: 'report',
            rows: f('rows'),
            rowKey: row('rowKey'),
            columns: [
              column(f('columnParty'), text(row('displayName'), { fallback: rootF('noPartyLabel') })),
              column(f('columnOutstanding'), drill(row('drill'), money(row('balance'), { tone: row('balanceTone') })), {
                align: 'right',
              }),
              column(f('columnGlLines'), drill(row('drill'), number(row('lineCount'))), { align: 'right' }),
            ],
          }),
          pagination({
            basePath: '/reports/partners',
            total: f('totalRows'),
            page: f('currentPage'),
            perPage: f('perPage'),
          }),
        ],
      }),
    ],
  })
}
