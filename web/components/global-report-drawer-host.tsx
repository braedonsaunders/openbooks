'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
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
import { Pagination } from './pagination'
import { RelatedTransactionDrawerClient, type RelatedTransactionDrawerData } from './related-transaction-drawer-client'
import { EntryFlyout } from '../app/(app)/reports/EntryFlyout'
import { ReportFilterBar } from '../app/(app)/reports/ReportFilterBar'
import { TxnLink } from '../app/(app)/reports/TxnLink'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../app/(app)/reports/ReportTable'
import { AccountRegisterDrawer } from './account-register-drawer'

function hrefWithout(pathname: string, query: string, keys: string[]): string {
  const params = new URLSearchParams(query)
  for (const key of keys) params.delete(key)
  const next = params.toString()
  return next ? `${pathname}?${next}` : pathname
}

/** Shell-level report drill stack: result rows over the report, native record over rows. */
export function GlobalReportDrawerHost() {
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const params = useSearchParams()
  const query = params.toString()
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

  const closeHref = useMemo(() => hrefWithout(pathname, query, [
    'reportDrill', 'reportDrillPage', REPORT_DRILL_PERIOD_PARAM, REPORT_DRILL_FROM_PARAM, REPORT_DRILL_TO_PARAM,
    'reportRecord', 'reportRecordKind', 'txn', 'drawerReturn', 'form', 'transactionTab',
  ]), [pathname, query])
  const recordCloseHref = useMemo(() => hrefWithout(pathname, query, [
    'reportRecord', 'reportRecordKind', 'drawerReturn', 'form', 'transactionTab',
  ]), [pathname, query])

  // Clear the drill while (re)loading, during render (same committed values,
  // no extra render). The snapshot mirrors the fetch inputs below exactly.
  const [prevDrillRequest, setPrevDrillRequest] = useState(() => ({
    closeHref, drillFrom, drillPeriod, drillTo, page, router, t, target,
  }))
  if (
    prevDrillRequest.closeHref !== closeHref || prevDrillRequest.page !== page ||
    prevDrillRequest.router !== router || prevDrillRequest.t !== t || prevDrillRequest.target !== target ||
    prevDrillRequest.drillPeriod !== drillPeriod || prevDrillRequest.drillFrom !== drillFrom ||
    prevDrillRequest.drillTo !== drillTo
  ) {
    setPrevDrillRequest({ closeHref, drillFrom, drillPeriod, drillTo, page, router, t, target })
    setData(null)
    setLoadedTarget(null)
  }

  useEffect(() => {
    if (!target) return
    const selection = `${target}:${page}:${drillPeriod ?? ''}:${drillFrom ?? ''}:${drillTo ?? ''}`
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
        setLoadedTarget(selection)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        toast.error(error instanceof Error ? error.message : t('drillDrawer.loadFailed'))
        router.replace(closeHref as never, { scroll: false })
      })
    return () => controller.abort()
  }, [closeHref, drillFrom, drillPeriod, drillTo, page, router, t, target])

  // Same render-time reset for the nested record drawer. Keyed on the query
  // string (not the search-params object, whose identity is not stable across
  // renders) plus the other fetch inputs.
  const [prevRecordRequest, setPrevRecordRequest] = useState(() => ({
    query, recordCloseHref, recordId, recordKind, router, t,
  }))
  if (
    prevRecordRequest.query !== query || prevRecordRequest.recordCloseHref !== recordCloseHref ||
    prevRecordRequest.recordId !== recordId || prevRecordRequest.recordKind !== recordKind ||
    prevRecordRequest.router !== router || prevRecordRequest.t !== t
  ) {
    setPrevRecordRequest({ query, recordCloseHref, recordId, recordKind, router, t })
    setRecordData(null)
    setLoadedRecord(null)
  }

  useEffect(() => {
    if (!recordId || !recordKind) return
    const selection = `${recordKind}:${recordId}`
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
        setLoadedRecord(selection)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        toast.error(error instanceof Error ? error.message : t('drillDrawer.recordLoadFailed'))
        router.replace(recordCloseHref as never, { scroll: false })
      })
    return () => controller.abort()
  }, [params, recordCloseHref, recordId, recordKind, router, t])

  const ready = data && loadedTarget === `${target}:${page}:${drillPeriod ?? ''}:${drillFrom ?? ''}:${drillTo ?? ''}`
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
      {recordData && loadedRecord === `${recordKind}:${recordId}` ? <RelatedTransactionDrawerClient data={recordData} /> : null}
      <EntryFlyout />
    </>
  )
}
