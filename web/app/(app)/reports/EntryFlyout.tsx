'use client'

import { useMoney } from '@/components/money-provider'
import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowUpRight } from 'lucide-react'
import { Badge, Button, Drawer, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { TxnLink } from './TxnLink'
import { AccountRegisterLink } from '../../../components/account-register-link'
import { ContributorGroupHeading, groupEntryLinesByContributor } from '../../../components/journal-entry-link'
import { entryTotals } from './entry-totals'
import { decimalCmp, decimalNeg } from '../../../lib/statement-format'

type EntryData = {
  entry: {
    id: string
    entry_number: string
    date: string
    memo: string | null
    origin: string
    status: string
    source_document_id: string | null
    reverses_number: string | null
    doc_id: string | null
    doc_kind: string | null
    doc_number: string | null
  }
  lines: {
    line_number: number
    amount: string
    memo: string | null
    is_open_item: boolean
    contributor_kind: string | null
    contributor_ref: string | null
    contributor_name: string | null
    account_id: string
    account_number: string | null
    account_name: string
    party: string | null
    department: string | null
    project: string | null
  }[]
}

/**
 * Reports-wide transaction flyout. Any report link can open a journal entry as a
 * right-side drawer by adding `?txn=<entryId>` to the current URL; closing just
 * removes the param, so the underlying report (and its scroll/filters) is
 * preserved and the drill "back" chain never breaks. Mounted once in the reports
 * layout. For entries created from a subledger document (bill/invoice/manual
 * journal) it offers "Open full transaction" → that record's editable drawer.
 */
export function EntryFlyout() {
  const { money } = useMoney()
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const t = useTranslations('journal')
  const tc = useTranslations('common')
  const tr = useTranslations('reports')
  const txn = params.get('txn')

  const [data, setData] = useState<EntryData | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  // Reset while reloading for another entry, during render (same committed
  // values, no extra render). Like the fetch below, a cleared `txn` resets
  // nothing — the flyout simply closes over the retained payload.
  const [prevTxn, setPrevTxn] = useState(txn)
  if (prevTxn !== txn) {
    setPrevTxn(txn)
    if (txn) {
      setLoading(true)
      setFailed(false)
      setData(null)
    }
  }

  useEffect(() => {
    if (!txn) return
    let active = true
    fetch(`/api/reports/entry/${txn}`)
      .then((r) => {
        if (!r.ok) throw new Error('entry load failed')
        return r.json()
      })
      .then((d) => active && (setData(d), setLoading(false)))
      .catch(() => { if (active) { setFailed(true); setLoading(false) } })
    return () => {
      active = false
    }
  }, [txn])

  const close = () => {
    const next = new URLSearchParams(params.toString())
    next.delete('txn')
    router.replace(`${pathname}${next.toString() ? `?${next}` : ''}`, { scroll: false })
  }

  const entry = data?.entry
  const origin = entry?.origin ? (t.has(`origins.${entry.origin}`) ? t(`origins.${entry.origin}`) : entry.origin) : ''

  const { debit: totalDebit, credit: totalCredit } = entryTotals(data?.lines ?? [])
  const groups = groupEntryLinesByContributor(data?.lines ?? [])
  const grouped = groups.length > 1 || (groups.length === 1 && groups[0]!.kind !== null)

  const groupTitle = (group: (typeof groups)[number]) => {
    if (group.kind === null) return t('detail.contributors.standardLines')
    const name = group.name ?? group.ref ?? group.kind
    if (group.kind === 'rule') return t('detail.contributors.ruleGroup', { name })
    if (group.kind === 'script') return t('detail.contributors.scriptGroup', { name })
    return t('detail.contributors.otherGroup', { kind: group.kind, name })
  }

  const lineRow = (l: NonNullable<EntryData['lines']>[number]) => {
    const isDebit = decimalCmp(l.amount, '0') > 0
    const isCredit = decimalCmp(l.amount, '0') < 0
    return (
      <TableRow key={l.line_number}>
        <TableCell className="text-slate-400">{l.line_number}</TableCell>
        <TableCell>
          <AccountRegisterLink accountId={l.account_id} className="hover:text-teal-700 dark:hover:text-teal-300">
            <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{l.account_number}</span>
            {l.account_name}
          </AccountRegisterLink>
          {(l.memo || l.project) && (
            <span className="mt-0.5 block text-xs text-slate-400 dark:text-slate-500">
              {[l.project, l.memo].filter(Boolean).join(' · ')}
            </span>
          )}
          {l.is_open_item && (
            <Badge variant="outline" className="ml-0 mt-0.5">
              {t('detail.openItemBadge')}
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-slate-500 dark:text-slate-400">{l.party}</TableCell>
        <TableCell className="text-slate-500 dark:text-slate-400">{l.department}</TableCell>
        <TableCell className="text-right tabular-nums">{isDebit ? money(l.amount) : ''}</TableCell>
        <TableCell className="text-right tabular-nums">{isCredit ? money(decimalNeg(l.amount)) : ''}</TableCell>
      </TableRow>
    )
  }

  const tableHead = (
    <TableHeader>
      <TableRow>
        <TableHead className="w-8">#</TableHead>
        <TableHead>{tc('labels.account')}</TableHead>
        <TableHead>{tc('labels.party')}</TableHead>
        <TableHead>{tc('labels.department')}</TableHead>
        <TableHead className="text-right">{t('detail.columns.debit')}</TableHead>
        <TableHead className="text-right">{t('detail.columns.credit')}</TableHead>
      </TableRow>
    </TableHeader>
  )

  return (
    <Drawer
      open={!!txn}
      onClose={close}
      size="xl"
      title={
        entry ? (
          <span className="flex items-center gap-2">
            <span className="font-mono">{entry.entry_number}</span>
            <Badge variant={entry.status === 'posted' ? 'success' : 'destructive'}>
              {tc.has(`status.${entry.status}`) ? tc(`status.${entry.status}`) : entry.status}
            </Badge>
          </span>
        ) : (
          tr('flyout.title')
        )
      }
      description={
        entry
          ? [entry.date, origin, entry.memo, entry.reverses_number ? t('detail.reverses', { number: entry.reverses_number }) : null]
              .filter(Boolean)
              .join(' · ')
          : undefined
      }
      stacked={[
        'reportDrill', 'accountRegister', 'reportRecord', 'doc', 'entry',
        'payment', 'expense', 'order', 'estimate', 'party', 'project', 'asset',
      ].some((key) => params.has(key))}
      headerActions={
        entry?.doc_kind && entry.doc_id ? (
          <Button asChild variant="outline" size="sm">
            <TxnLink entryId={entry.id} docKind={entry.doc_kind} docId={entry.doc_id}>
              {tr('flyout.openTransaction')} <ArrowUpRight size={14} />
            </TxnLink>
          </Button>
        ) : undefined
      }
    >
      {failed ? (
        <p role="alert" className="text-sm text-destructive">{tc('feedback.loadFailed')}</p>
      ) : loading || !data ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : !grouped ? (
        <Table>
          {tableHead}
          <TableBody>
            {data.lines.map(lineRow)}
            <TableRow className="border-t border-slate-300 dark:border-slate-600">
              <TableCell colSpan={4} className="font-semibold">
                {t('detail.totals')}
              </TableCell>
              <TableCell className={cn('text-right font-semibold tabular-nums')}>{money(totalDebit)}</TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{money(totalCredit)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      ) : (
        <div>
          {groups.map((group) => (
            <section key={group.key}>
              <ContributorGroupHeading
                title={groupTitle(group)}
                lockedLabel={group.kind === null ? t('detail.contributors.locked') : undefined}
              />
              <Table>
                {tableHead}
                <TableBody>{group.lines.map(lineRow)}</TableBody>
              </Table>
            </section>
          ))}
          <Table>
            <TableBody>
              <TableRow className="border-t border-slate-300 dark:border-slate-600">
                <TableCell colSpan={4} className="font-semibold">
                  {t('detail.totals')}
                </TableCell>
                <TableCell className={cn('text-right font-semibold tabular-nums')}>{money(totalDebit)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{money(totalCredit)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </Drawer>
  )
}
