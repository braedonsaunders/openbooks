'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Skeleton, UrlDrawer, cn } from '@openbooks/ui'
import {
  parseReportDrillTarget,
  REPORT_DRILL_FROM_PARAM,
  REPORT_DRILL_PERIOD_PARAM,
  REPORT_DRILL_TO_PARAM,
  type ReportDrillResponse,
} from '../lib/report-drill'
import { hrefWithoutKeys } from '../lib/report-overlay'
import { Pagination } from './pagination'
import { RelatedTransactionDrawerClient, type RelatedTransactionDrawerData } from './related-transaction-drawer-client'
import { EntryFlyout } from '../app/(app)/reports/EntryFlyout'
import { ReportFilterBar } from '../app/(app)/reports/ReportFilterBar'
import { TxnLink } from '../app/(app)/reports/TxnLink'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../app/(app)/reports/ReportTable'
import { AccountRegisterDrawer } from './account-register-drawer'
import { useReportOverlay } from './navigation-provider'
import { useDrawerResource } from './use-drawer-resource'

/** Shell-level report drill stack: result rows over the report, native record over rows. */
export function GlobalReportDrawerHost() {
  const overlay = useReportOverlay()
  const pathname = overlay.pathname
  const query = overlay.search
  const params = useMemo(() => new URLSearchParams(query), [query])
  const t = useTranslations('reports')
  const journalPage = pathname === '/journal'
  const target = journalPage ? null : params.get('reportDrill')
  const page = Math.max(1, Number(params.get('reportDrillPage') ?? 1) || 1)
  const drillPeriod = params.get(REPORT_DRILL_PERIOD_PARAM)
  const drillFrom = params.get(REPORT_DRILL_FROM_PARAM)
  const drillTo = params.get(REPORT_DRILL_TO_PARAM)
  const recordId = journalPage ? null : params.get('reportRecord')
  const recordKind = params.get('reportRecordKind')
  const parsed = useMemo(() => parseReportDrillTarget(target), [target])
  const periodBrowsable = parsed?.kind === 'ledger' && Boolean(parsed.period)

  const closeHref = useMemo(
    () => hrefWithoutKeys(pathname, query, [
      'reportDrill', 'reportDrillPage', REPORT_DRILL_PERIOD_PARAM, REPORT_DRILL_FROM_PARAM, REPORT_DRILL_TO_PARAM,
      'reportRecord', 'reportRecordKind', 'txn', 'drawerReturn', 'form', 'transactionTab',
    ]),
    [pathname, query],
  )
  const recordCloseHref = useMemo(
    () => hrefWithoutKeys(pathname, query, ['reportRecord', 'reportRecordKind', 'drawerReturn', 'form', 'transactionTab']),
    [pathname, query],
  )

  const drillSearch = new URLSearchParams({ target: target ?? '', page: String(page) })
  if (drillPeriod) drillSearch.set('period', drillPeriod)
  if (drillFrom) drillSearch.set('from', drillFrom)
  if (drillTo) drillSearch.set('to', drillTo)
  const data = useDrawerResource<ReportDrillResponse>(target ? `/api/reports/drill?${drillSearch}` : null, (error) => {
    toast.error(error.message || t('drillDrawer.loadFailed'))
    overlay.replace(closeHref)
  })
  const recordSearch = new URLSearchParams({ id: recordId ?? '', kind: recordKind ?? '' })
  const form = params.get('form')
  if (form) recordSearch.set('form', form)
  const recordData = useDrawerResource<RelatedTransactionDrawerData>(recordId && recordKind ? `/api/reports/transaction-drawer?${recordSearch}` : null, (error) => {
    toast.error(error.message || t('drillDrawer.recordLoadFailed'))
    overlay.replace(recordCloseHref)
  })
  const ready = data !== null
  const currentParams = Object.fromEntries(params.entries())
  const periodFilter = periodBrowsable ? (
    <ReportFilterBar
      controls={{ period: true }}
      defaultPeriod={parsed?.kind === 'ledger' && parsed.period ? parsed.period : 'this_period'}
      periodParamKey={REPORT_DRILL_PERIOD_PARAM}
      fromParamKey={REPORT_DRILL_FROM_PARAM}
      toParamKey={REPORT_DRILL_TO_PARAM}
      resetParamKeys={['reportDrillPage']}
    />
  ) : null
  return (
    <>
      <UrlDrawer
        open={!!target}
        openKey={target ?? ''}
        closeHref={closeHref}
        title={ready ? data.title : t('drillDrawer.title')}
        description={ready ? data.description : undefined}
        size="2xl"
        contextualReturn={false}
      >
        <div className="space-y-5">
          {periodFilter}
          {!ready ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : (
          <div className="space-y-5">
            {data.summary.length ? (
              <div className="grid grid-flow-col auto-cols-fr divide-x divide-slate-200 border-y border-slate-200 py-3 dark:divide-slate-700 dark:border-slate-700">
                {data.summary.map((item) => (
                  <div key={item.label} className="min-w-0 px-3 text-center">
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">{item.label}</div>
                    <div className="truncate font-semibold tabular-nums">{item.value}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {data.rows.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    {data.columns.map((column, index) => (
                      <TableHead key={index} className={column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : undefined}>
                        {column.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row) => (
                    <TableRow key={row.key}>
                      {row.cells.map((cell, index) => {
                        const column = data.columns[index]
                        const content = cell == null ? '' : String(cell)
                        return (
                          <TableCell key={index} className={cn(column?.align === 'right' && 'text-right tabular-nums', column?.align === 'center' && 'text-center')}>
                            {row.transaction && data.linkColumn === index ? (
                              <TxnLink {...row.transaction} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{content}</TxnLink>
                            ) : content}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">{t('detail.empty')}</p>
            )}
            <Pagination
              basePath={pathname}
              currentParams={currentParams}
              page={data.page}
              perPage={data.perPage}
              total={data.total}
              pageParamKey="reportDrillPage"
            />
          </div>
          )}
        </div>
      </UrlDrawer>
      {!journalPage ? <AccountRegisterDrawer /> : null}
      {recordData ? <RelatedTransactionDrawerClient data={recordData} /> : null}
      <EntryFlyout />
    </>
  )
}
