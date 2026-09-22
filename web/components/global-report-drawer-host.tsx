'use client'

import { useEffect, useMemo, useState } from 'react'
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

/** Shell-level report drill stack: result rows over the report, native record over rows. */
export function GlobalReportDrawerHost() {
  const overlay = useReportOverlay()
  const pathname = overlay.pathname
  const query = overlay.search
  const params = useMemo(() => new URLSearchParams(query), [query])
  const t = useTranslations('reports')
  const target = params.get('reportDrill')
  const page = Math.max(1, Number(params.get('reportDrillPage') ?? 1) || 1)
  const drillPeriod = params.get(REPORT_DRILL_PERIOD_PARAM)
  const drillFrom = params.get(REPORT_DRILL_FROM_PARAM)
  const drillTo = params.get(REPORT_DRILL_TO_PARAM)
  const recordId = params.get('reportRecord')
  const recordKind = params.get('reportRecordKind')
  const parsed = useMemo(() => parseReportDrillTarget(target), [target])
  const periodBrowsable = parsed?.kind === 'ledger' && Boolean(parsed.period)
  const [data, setData] = useState<ReportDrillResponse | null>(null)
  const [loadedTarget, setLoadedTarget] = useState<string | null>(null)
  const [recordData, setRecordData] = useState<RelatedTransactionDrawerData | null>(null)
  const [loadedRecord, setLoadedRecord] = useState<string | null>(null)

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

  // Fetch identity is the drill target and its window — not the close href
  // or a nested record. Opening a transaction over the drill must not
  // discard rows the operator is still looking at.
  const drillRequest = `${target ?? ''}:${page}:${drillPeriod ?? ''}:${drillFrom ?? ''}:${drillTo ?? ''}`
  const [prevDrillRequest, setPrevDrillRequest] = useState(drillRequest)
  if (prevDrillRequest !== drillRequest) {
    setPrevDrillRequest(drillRequest)
    setData(null)
    setLoadedTarget(null)
  }

  useEffect(() => {
    if (!target) return
    const controller = new AbortController()
    const search = new URLSearchParams({ target, page: String(page) })
    if (drillPeriod) search.set('period', drillPeriod)
    if (drillFrom) search.set('from', drillFrom)
    if (drillTo) search.set('to', drillTo)
    fetch(`/api/reports/drill?${search}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(t('drillDrawer.loadFailed'))
        return response.json() as Promise<ReportDrillResponse>
      })
      .then((body) => {
        setData(body)
        setLoadedTarget(drillRequest)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        toast.error(error instanceof Error ? error.message : t('drillDrawer.loadFailed'))
        overlay.replace(closeHref)
      })
    return () => controller.abort()
  }, [closeHref, drillFrom, drillPeriod, drillRequest, drillTo, overlay, page, t, target])

  const recordRequest = `${recordKind ?? ''}:${recordId ?? ''}:${params.get('form') ?? ''}`
  const [prevRecordRequest, setPrevRecordRequest] = useState(recordRequest)
  if (prevRecordRequest !== recordRequest) {
    setPrevRecordRequest(recordRequest)
    setRecordData(null)
    setLoadedRecord(null)
  }

  useEffect(() => {
    if (!recordId || !recordKind) return
    const controller = new AbortController()
    const search = new URLSearchParams({ id: recordId, kind: recordKind })
    const form = params.get('form')
    if (form) search.set('form', form)
    fetch(`/api/reports/transaction-drawer?${search}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(t('drillDrawer.recordLoadFailed'))
        return response.json() as Promise<RelatedTransactionDrawerData>
      })
      .then((body) => {
        setRecordData(body)
        setLoadedRecord(recordRequest)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        toast.error(error instanceof Error ? error.message : t('drillDrawer.recordLoadFailed'))
        overlay.replace(recordCloseHref)
      })
    return () => controller.abort()
  }, [overlay, params, recordCloseHref, recordId, recordKind, recordRequest, t])

  const ready = data && loadedTarget === drillRequest
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
      <AccountRegisterDrawer />
      {recordData && loadedRecord === recordRequest ? <RelatedTransactionDrawerClient data={recordData} /> : null}
      <EntryFlyout />
    </>
  )
}
