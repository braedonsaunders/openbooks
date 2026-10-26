'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@openbooks/ui'
import { PagedTable, type PagedColumn } from '@/components/paged-table'
import { ListFilterSelect } from '@/components/list-filter-select'
import { useMoney } from '@/components/money-provider'
import { EquityAsOfControl } from './AsOfControl'
import type { SecuritiesViewData } from './view'
import { CELL, DATE_CELL, HEAD, LINK, NUM_CELL, NUM_HEAD, OpenReport, PendingActions, STATUS_VARIANT, listSort, useCivilDate, usePercent, usePrice, useShares, withParams } from './shared'

const BASE = '/equity'
const KINDS = ['share', 'option', 'rsu', 'warrant', 'safe', 'note'] as const
const STATUSES = ['outstanding', 'exercised', 'settled', 'converted', 'transferred', 'forfeited', 'expired', 'cancelled', 'repurchased', 'repaid', 'void'] as const

type Row = SecuritiesViewData['rows'][number]

/**
 * The securities register: every certificate, award and convertible, in the
 * shared filtered table. Type, status and holder are toolbar filters in the
 * URL beside the native as-of control; SAFEs and notes show their terms on
 * the date. Each row opens the security's drawer.
 */
export function EquitySecuritiesPanel({ view }: { view: SecuritiesViewData | null }) {
  const t = useTranslations('equity')
  const shares = useShares()
  const date = useCivilDate()
  const price = usePrice()
  const percentText = usePercent()
  const { money } = useMoney()
  if (!view) return null
  const { context } = view
  const convertibleView = view.kind === 'safe' || view.kind === 'note'
  const convertibles = new Map(view.convertibles.map((row) => [row.securityId, row]))
  const base: PagedColumn<Row>[] = [
    {
      key: 'number', header: <>{t('securities.columns.number')}</>, headerClassName: HEAD, className: CELL,
      cell: (row) => <Link className={`font-mono ${LINK}`} href={row.href}>{row.securityNumber}</Link>,
      // The search reads what the row shows, never its link or ids.
      search: (row) => row.securityNumber,
      sortKey: 'number', sortValue: (row) => row.securityNumber,
    },
    {
      key: 'kind', header: <>{t('securities.columns.kind')}</>, headerClassName: HEAD, className: CELL,
      search: (row) => {
        const convertible = convertibles.get(row.id)
        return `${t(`kind.${row.kind}`)} ${convertible?.safeType ? t(`safeType.${convertible.safeType}`) : ''}`
      },
      sortKey: 'kind', sortValue: (row) => t(`kind.${row.kind}`),
      cell: (row) => {
        const convertible = convertibles.get(row.id)
        return (
          <>
            {t(`kind.${row.kind}`)}{convertible?.safeType ? ` · ${t(`safeType.${convertible.safeType}`)}` : ''}
            {convertible?.mfn && <Badge variant={convertible.electionId ? 'secondary' : 'outline'} className="ml-2">{convertible.electionId ? t('drawer.mfnAdopted') : t('fields.mfn')}</Badge>}
          </>
        )
      },
    },
    { key: 'holder', header: <>{t('securities.columns.holder')}</>, headerClassName: HEAD, className: CELL, cell: (row) => <>{row.holderName}</>, search: (row) => row.holderName, sortKey: 'holder', sortValue: (row) => row.holderName },
    {
      key: 'class', header: <>{t('securities.columns.class')}</>, headerClassName: HEAD, className: `${CELL} font-mono`, cell: (row) => <>{row.shareClassCode ?? '—'}</>,
      search: (row) => row.shareClassCode ?? '', sortKey: 'class', sortValue: (row) => row.shareClassCode,
    },
    { key: 'issued', header: <>{t('securities.columns.issued')}</>, headerClassName: HEAD, className: DATE_CELL, cell: (row) => <>{date(row.issueDate)}</>, sortKey: 'issued', sortValue: (row) => row.issueDate },
    {
      key: 'status', header: <>{t('securities.columns.status')}</>, headerClassName: HEAD, className: CELL,
      search: (row) => t(`status.${row.status}`), sortKey: 'status', sortValue: (row) => t(`status.${row.status}`),
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={STATUS_VARIANT[row.status] ?? 'secondary'}>{t(`status.${row.status}`)}</Badge>
          {row.election83b && row.election83b.state !== 'filed' && (
            <Badge variant={row.election83b.state === 'open' ? 'warning' : 'outline'} title={t('election83b.deadline', { date: date(row.election83b.deadline) })}>
              {t(`election83b.${row.election83b.state}`)}
            </Badge>
          )}
          {row.resultingSecurityId && (
            <span className="text-xs">
              {t('securities.convertedInto')}{' '}
              <Link className={`font-mono ${LINK}`} href={withParams(BASE, context.params, { view: 'securities', security: row.resultingSecurityId })}>{row.resultingSecurityNumber ?? ''}</Link>
            </span>
          )}
        </span>
      ),
    },
  ]
  const shareColumns: PagedColumn<Row>[] = [
    {
      key: 'outstanding', header: <>{t('securities.columns.outstanding')}</>, headerClassName: NUM_HEAD, className: NUM_CELL,
      sortKey: 'outstanding', sortType: 'decimal', sortValue: (row) => row.outstandingAmount ?? row.outstanding,
      cell: (row) => <>{row.outstandingAmount !== null ? money(row.outstandingAmount, { currency: row.currency }) : shares(row.outstanding)}</>,
    },
    { key: 'vested', header: <>{t('securities.columns.vested')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{row.vested ? shares(row.vested) : '—'}</>, sortKey: 'vested', sortType: 'decimal', sortValue: (row) => row.vested },
    { key: 'price', header: <>{t('securities.columns.price')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{price(row.price, row.currency)}</>, sortKey: 'price', sortType: 'decimal', sortValue: (row) => row.price },
  ]
  const convertibleColumns: PagedColumn<Row>[] = [
    { key: 'principal', header: <>{t('rounds.columns.principal')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{row.principal ? money(row.principal, { currency: row.currency }) : '—'}</>, sortKey: 'principal', sortType: 'decimal', sortValue: (row) => row.principal },
    { key: 'outstandingAmount', header: <>{t('securities.columns.outstanding')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{row.outstandingAmount !== null ? money(row.outstandingAmount, { currency: row.currency }) : '—'}</>, sortKey: 'outstanding', sortType: 'decimal', sortValue: (row) => row.outstandingAmount },
    {
      key: 'interest', header: <>{t('rounds.columns.interest')}</>, headerClassName: NUM_HEAD, className: NUM_CELL,
      cell: (row) => { const value = convertibles.get(row.id)?.accruedInterest; return <>{value ? money(value, { currency: row.currency }) : '—'}</> },
    },
    {
      key: 'cap', header: <>{t('rounds.columns.cap')}</>, headerClassName: NUM_HEAD, className: NUM_CELL,
      cell: (row) => { const value = convertibles.get(row.id)?.valuationCap; return <>{value ? money(value, { currency: row.currency }) : '—'}</> },
    },
    { key: 'discount', header: <>{t('rounds.columns.discount')}</>, headerClassName: NUM_HEAD, className: NUM_CELL, cell: (row) => <>{percentText(convertibles.get(row.id)?.discountPercent)}</> },
  ]
  return (
    <div className="space-y-3">
      <PendingActions context={context} filter={(request) => ['void', 'reverse', 'repurchase', 'repay', 'cancel_convertible', 'mfn_election', 'mfn_reversal'].includes(request.action)} />
      <PagedTable
        prepared
        searchable
        source="equity_securities"
        rows={view.rows}
        rowKey={(row) => row.id}
        empty={t('securities.empty')}
        emptyFiltered={t('securities.emptyFiltered')}
        filtersActive={Boolean(view.kind || view.status || view.holderPartyId)}
        resetPageKey={`${view.kind ?? ''}:${view.status ?? ''}:${view.holderPartyId ?? ''}`}
        urlState={{ pageKey: 'page', page: context.list.page, searchKey: 'q', query: context.list.query }}
        {...listSort(context)}
        toolbarAfter={
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <ListFilterSelect
              basePath={BASE} currentParams={context.params} paramKey="kind" label={t('securities.filters.kind')}
              allLabel={t('securities.filters.allKinds')} options={KINDS.map((value) => ({ value, label: t(`kindPlural.${value}`) }))}
            />
            <ListFilterSelect
              basePath={BASE} currentParams={context.params} paramKey="status" label={t('securities.filters.status')}
              allLabel={t('securities.filters.allStatuses')} options={STATUSES.map((value) => ({ value, label: t(`status.${value}`) }))}
            />
            <ListFilterSelect
              basePath={BASE} currentParams={context.params} paramKey="holder" label={t('securities.filters.holder')}
              allLabel={t('securities.filters.allHolders')} options={view.holders}
            />
            <EquityAsOfControl control={view.asOfControl} />
            <div className="ml-auto flex items-center gap-2">
              <OpenReport href={view.reportHref} label={t('capTable.report')} />
            </div>
          </div>
        }
        columns={[...base, ...(convertibleView ? convertibleColumns : shareColumns)]}
      />
    </div>
  )
}
