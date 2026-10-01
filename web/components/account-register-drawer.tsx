'use client'

import { useMoney } from '@/components/money-provider'
import { useMemo } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
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
import { AccountRegisterExportMenu } from './account-register-export-menu'
import { SearchInput } from './search-input'
import { useDrawerResource } from './use-drawer-resource'
import { useReportOverlayOptional } from './navigation-provider'

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
  const nextPath = usePathname() ?? '/'
  const nextParams = useSearchParams()
  const overlay = useReportOverlayOptional()
  const pathname = overlay?.pathname ?? nextPath
  const params = useMemo(
    () => new URLSearchParams(overlay?.search ?? nextParams.toString()),
    [overlay?.search, nextParams],
  )
  const t = useTranslations('accounts')
  const tc = useTranslations('common')
  const accountId = params.get('accountRegister')
  const page = Math.max(1, Number(params.get('accountRegisterPage')) || 1)
  const from = params.get('accountRegisterFrom')
  const to = params.get('accountRegisterTo')
  const book = params.get('book')
  const registerSearch = params.get('accountRegisterQ')
  const query = params.toString()
  const closeHref = useMemo(() => accountRegisterCloseHref(pathname, query), [pathname, query])
  const requestParams = new URLSearchParams({ page: String(page) })
  if (book) requestParams.set('book', book)
  if (from) requestParams.set('from', from)
  if (to) requestParams.set('to', to)
  if (registerSearch) requestParams.set('q', registerSearch)
  const data = useDrawerResource<RegisterResponse>(accountId ? `/api/accounts/${encodeURIComponent(accountId)}/register?${requestParams}` : null, (error) => {
    toast.error(error.message || tc('feedback.loadFailed'))
    if (overlay) overlay.replace(closeHref)
    else window.location.assign(closeHref)
  })
  const ready = data !== null
  const periodLabel = from || to ? `${from ?? ''} → ${to ?? ''}` : null
  const currentParams = Object.fromEntries(params.entries())

  return (
    <UrlDrawer
      open={!!accountId}
      openKey={accountId ?? ''}
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
      headerActions={ready ? (
        <AccountRegisterExportMenu accountId={accountId!} from={from} to={to} search={registerSearch} book={book} />
      ) : undefined}
    >
      <div className="space-y-3">
        <SearchInput
          paramKey="accountRegisterQ"
          pageParamKey="accountRegisterPage"
          placeholder={tc('actions.search')}
          className="max-w-md"
        />
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
      </div>
    </UrlDrawer>
  )
}
