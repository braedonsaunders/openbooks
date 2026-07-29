'use client'

import { useMoney } from '@/components/money-provider'
import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  UrlDrawer,
} from '@openbooks/ui'
import { DocTypeBadge } from './doc-type-badge'
import { Pagination } from './pagination'
import { TxnLink } from '../app/(app)/reports/TxnLink'
import { accountRegisterCloseHref } from '../lib/account-register-navigation'

interface RegisterResponse {
  account: { id: string; number: string | null; name: string; type: string }
  lines: {
    entry_id: string
    entry_number: string | null
    posting_date: string
    entry_memo: string | null
    line_number: number
    amount: string
    memo: string | null
    party: string | null
    doc_id: string | null
    doc_kind: string | null
    doc_number: string | null
  }[]
  total: number
  balance: string
  page: number
  perPage: number
}

export function AccountRegisterDrawer() {
  const { money } = useMoney()
  const pathname = usePathname() ?? '/'
  const params = useSearchParams()
  const router = useRouter()
  const t = useTranslations('accounts')
  const tc = useTranslations('common')
  const accountId = params.get('accountRegister')
  const page = Math.max(1, Number(params.get('accountRegisterPage')) || 1)
  const from = params.get('accountRegisterFrom')
  const to = params.get('accountRegisterTo')
  const query = params.toString()
  const [data, setData] = useState<RegisterResponse | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  const closeHref = useMemo(() => accountRegisterCloseHref(pathname, query), [pathname, query])
  const requestKey = `${accountId ?? ''}:${page}:${from ?? ''}:${to ?? ''}`

  useEffect(() => {
    if (!accountId) {
      setData(null)
      setLoadedKey(null)
      return
    }
    const controller = new AbortController()
    const search = new URLSearchParams({ page: String(page) })
    if (from) search.set('from', from)
    if (to) search.set('to', to)
    setData(null)
    setLoadedKey(null)
    fetch(`/api/accounts/${accountId}/register?${search}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(tc('feedback.loadFailed'))
        return response.json() as Promise<RegisterResponse>
      })
      .then((body) => {
        setData(body)
        setLoadedKey(requestKey)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        toast.error(error instanceof Error ? error.message : tc('feedback.loadFailed'))
        router.replace(closeHref as never, { scroll: false })
      })
    return () => controller.abort()
  }, [accountId, closeHref, from, page, requestKey, router, tc, to])

  const ready = data && loadedKey === requestKey
  const periodLabel = from || to ? `${from ?? ''} → ${to ?? ''}` : null
  const currentParams = Object.fromEntries(params.entries())

  return (
    <UrlDrawer
      open={!!accountId}
      closeHref={closeHref}
      title={ready ? `${data.account.number ?? ''} ${data.account.name}`.trim() : t('list.title')}
      description={ready
        ? [
            t('register.subtitle', { count: data.total, balance: money(data.balance) }),
            periodLabel ? t('register.periodFilter', { label: periodLabel }) : null,
          ].filter(Boolean).join(' · ')
        : undefined}
      size="2xl"
      stacked={params.has('reportDrill') || params.has('account')}
      contextualReturn={false}
    >
      {!ready ? (
        <div className="space-y-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : (
        <div className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tc('labels.date')}</TableHead>
                <TableHead>{tc('labels.type')}</TableHead>
                <TableHead>{tc('labels.number')}</TableHead>
                <TableHead>{tc('labels.party')}</TableHead>
                <TableHead>{tc('labels.memo')}</TableHead>
                <TableHead className="text-right">{t('register.columns.debit')}</TableHead>
                <TableHead className="text-right">{t('register.columns.credit')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.lines.map((line, index) => {
                const isCredit = line.amount.startsWith('-')
                const isZero = /^0(?:\.0*)?$/.test(line.amount)
                return (
                  <TableRow key={`${line.entry_id}-${line.line_number}-${index}`}>
                    <TableCell className="whitespace-nowrap tabular-nums">{line.posting_date}</TableCell>
                    <TableCell><DocTypeBadge kind={line.doc_kind ?? 'journal'} /></TableCell>
                    <TableCell className="font-mono text-[13px]">
                      <TxnLink
                        entryId={line.entry_id}
                        docKind={line.doc_kind}
                        docId={line.doc_id}
                        className="font-semibold text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {line.doc_number || line.entry_number}
                      </TxnLink>
                    </TableCell>
                    <TableCell className="text-slate-500 dark:text-slate-400">{line.party}</TableCell>
                    <TableCell className="max-w-xs truncate text-slate-500 dark:text-slate-400">
                      {line.memo ?? line.entry_memo}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{!isCredit && !isZero ? money(line.amount) : ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{isCredit ? money(line.amount.slice(1)) : ''}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <Pagination
            basePath={pathname}
            currentParams={currentParams}
            total={data.total}
            page={data.page}
            perPage={data.perPage}
            pageParamKey="accountRegisterPage"
          />
        </div>
      )}
    </UrlDrawer>
  )
}
