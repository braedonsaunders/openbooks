'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge, TableCell, TableRow } from '@openbooks/ui'
import { RegisteredListTable } from '@/components/registered-list-table'
import { ListFilterSelect } from '@/components/list-filter-select'
import { SearchInput } from '@/components/search-input'
import { capTableExportHref } from '@/lib/equity-cap-table-export'
import { capTableLayout, CAP_TABLE_INSTRUMENTS, type CapTableColumn, type CapTableLine } from '@/lib/equity-cap-table'
import { ExportMenu } from '../reports/ExportMenu'
import { EquityAsOfControl } from './AsOfControl'
import type { CapTableViewData } from './view'
import { CELL, HEAD, LINK, NUM_CELL, NUM_HEAD, OpenReport, PendingActions, PolicyBanner, TOTAL_ROW, usePercent, useShares, withParams } from './shared'

const BASE = '/equity'

/**
 * The cap table on the as-of date, in the shared filtered table: the
 * search, the dimension (share class or holder) and the instrument are
 * toolbar filters in the URL, beside the native as-of control, and the
 * export carries the same filters. Each holder opens their securities in the
 * register.
 */
export function EquityCapTablePanel({ view }: { view: CapTableViewData | null }) {
  const t = useTranslations('equity')
  const shares = useShares()
  const percentText = usePercent()
  if (!view) return null
  const { table, context } = view
  const filters = { dimension: view.dimension, instrument: view.instrument, query: view.query }
  const layout = capTableLayout(table, filters, view.parties)
  const classById = new Map(table.classes.map((row) => [row.shareClassId, row]))
  const header = (column: CapTableColumn) => ('code' in column
    ? <span className="font-mono">{column.code}</span>
    : <>{t(`capTable.columns.${column.key === 'instrumentOutstanding' ? `${view.instrument}Outstanding` : column.key}`)}</>)
  const cell = (column: CapTableColumn, line: CapTableLine) => {
    const value = line.values[column.key]
    if (column.kind === 'percent') return <>{percentText(value)}</>
    return <>{value && value !== '0' ? shares(value) : '—'}</>
  }
  const total = (column: CapTableColumn) => {
    const value = layout.totals[column.key]
    if (value === undefined) return ''
    return column.kind === 'percent' ? percentText(value) : value !== '0' ? shares(value) : '—'
  }
  const lead = view.dimension === 'class'
    ? {
        key: 'class', header: <>{t('capTable.columns.class')}</>, headerClassName: HEAD, className: CELL,
        cell: (line: CapTableLine) => {
          const row = classById.get(line.shareClassId ?? '')
          return row ? (
            <span>
              <span className="font-mono font-medium">{row.code}</span> <span className="text-slate-500">{row.name}</span>{' '}
              <Badge variant="outline">{t(`classKind.${row.kind}`)}</Badge>
            </span>
          ) : null
        },
      }
    : {
        key: 'holder', header: <>{t('capTable.columns.holder')}</>, headerClassName: HEAD, className: CELL,
        cell: (line: CapTableLine) => line.pool ? (
          <span className="text-slate-600 dark:text-slate-300">{t('overview.ownership.pool')}</span>
        ) : (
          <Link className={LINK} href={withParams(BASE, context.params, { view: 'securities', holder: line.holderPartyId ?? undefined, by: undefined, instrument: undefined })}>
            {view.parties[line.holderPartyId ?? ''] ?? line.holderPartyId}
          </Link>
        ),
      }
  return (
    <div className="space-y-4">
      {!view.hasAccountPolicy && <PolicyBanner href={view.accountsSetupHref} />}
      <PendingActions context={context} filter={(request) => request.action === 'split' || request.action === 'class_amendment'} />
      <RegisteredListTable
        source={view.dimension === 'class' ? 'equity_cap_table_classes' : 'equity_cap_table_holders'}
        rows={layout.lines}
        rowKey={(line) => line.key}
        empty={view.dimension === 'class' ? t('capTable.emptyClasses') : t('capTable.emptyHolders')}
        resetPageKey={`${view.dimension}:${view.instrument}:${view.query}`}
        searchable={false}
        urlState={{ pageKey: 'page', page: context.list.page }}
        toolbarAfter={
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <SearchInput />
            <ListFilterSelect
              basePath={BASE} currentParams={context.params} paramKey="by" label={t('capTable.filters.view')}
              options={[{ value: '', label: t('capTable.by.class') }, { value: 'holder', label: t('capTable.by.holder') }]}
            />
            <ListFilterSelect
              basePath={BASE} currentParams={context.params} paramKey="instrument" label={t('capTable.filters.instrument')}
              allLabel={t('capTable.filters.allInstruments')}
              options={CAP_TABLE_INSTRUMENTS.map((value) => ({ value, label: t(`kindPlural.${value}`) }))}
            />
            <EquityAsOfControl control={view.asOfControl} />
            <div className="ml-auto flex items-center gap-2">
              <OpenReport href={view.asOfReportHref} label={t('capTable.openAsOfReport')} />
              <OpenReport href={view.reportHref} label={t('capTable.report')} />
              <ExportMenu baseHref={capTableExportHref(context.subsidiaryId, context.asOf, filters)} kind="cap-table" />
            </div>
          </div>
        }
        columns={[
          lead,
          ...layout.columns.map((column) => ({
            key: column.key, header: header(column), headerClassName: NUM_HEAD, className: NUM_CELL,
            cell: (line: CapTableLine) => cell(column, line),
          })),
        ]}
        footer={layout.lines.length > 0 && Object.keys(layout.totals).length > 0 ? (
          <TableRow className={TOTAL_ROW}>
            <TableCell className={CELL}>{t('waterfall.columns.total')}</TableCell>
            {layout.columns.map((column) => (
              <TableCell key={column.key} className={NUM_CELL}>{total(column)}</TableCell>
            ))}
          </TableRow>
        ) : undefined}
      />
    </div>
  )
}
