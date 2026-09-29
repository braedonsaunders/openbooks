'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Skeleton, UrlDrawer } from '@openbooks/ui'
import { useReportOverlay } from '../../../components/navigation-provider'
import { hrefWithoutKeys } from '../../../lib/report-overlay'
import type { EntryData } from '../reports/EntryFlyout'
import { entryTotals } from '../reports/entry-totals'
import { JournalDrawer } from './JournalDrawer'

type JournalProps = Parameters<typeof JournalDrawer>[0]
type PostedJournal = EntryData & { sourceJournal: JournalProps['journal'] | null; canPost: boolean }

/** Posted rows load independently of the paginated list, into its native drawer. */
export function JournalEntryDrawer() {
  const overlay = useReportOverlay()
  const params = useMemo(() => new URLSearchParams(overlay.search), [overlay.search])
  const t = useTranslations('journal')
  const tc = useTranslations('common')
  // Old txn links remain journal links; a draft/create selector takes precedence.
  const id = params.has('entry') || params.has('entryNew') ? null : params.get('journalEntry') ?? params.get('txn')
  const closeHref = hrefWithoutKeys('/journal', overlay.search,
    ['journalEntry', 'txn', 'reportRecord', 'reportRecordKind', 'drawerReturn', 'form', 'mode', 'transactionTab'])
  const [result, setResult] = useState<{ id: string; data?: PostedJournal; error?: string } | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    fetch(`/api/reports/entry/${encodeURIComponent(id)}?journal=1`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(tc('feedback.loadFailed'))
        return response.json() as Promise<PostedJournal>
      })
      .then((data) => { if (!controller.signal.aborted) setResult({ id, data }) })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setResult({ id, error: error instanceof Error ? error.message : tc('feedback.loadFailed') })
      })
    return () => controller.abort()
  }, [id, tc, refreshVersion])
  if (!id) return null
  const data = result?.id === id ? result.data : undefined
  if (!data) return (
    <UrlDrawer open openKey={id} closeHref={closeHref} title={t('list.title')} size="2xl" contextualReturn={false}>
      {result?.id === id && result.error
        ? <p role="alert" className="text-sm text-destructive">{result.error}</p>
        : <div className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>}
    </UrlDrawer>
  )
  const { entry, lines, sourceJournal } = data
  const currencies = [...new Set(lines.map((line) => line.functional_currency))]
  const journal = {
    doc: {
      ...sourceJournal?.doc,
      id: sourceJournal?.doc.id ?? entry.id,
      status: entry.status,
      document_number: entry.entry_number,
      document_date: entry.date,
      memo: entry.memo,
      subsidiary_id: entry.subsidiary_id,
      currency: currencies.length === 1 ? currencies[0] : sourceJournal?.doc.currency,
      entry_id: entry.id,
    },
    lines: lines.map((line) => ({
      ...line,
      description: line.memo,
      // Label-only references are confined to this immutable presentation.
      party_id: line.party ? `party:${line.line_number}` : null,
      department_id: line.department ? `department:${line.line_number}` : null,
      project_id: line.project ? `project:${line.line_number}` : null,
    })),
  }
  const origin = t.has(`origins.${entry.origin}`) ? t(`origins.${entry.origin}`) : entry.origin
  return <JournalDrawer
    journal={journal} ledgerSnapshot sourceDocument={Boolean(sourceJournal)}
    onLedgerRefresh={() => setRefreshVersion((version) => version + 1)}
    ledgerTotals={currencies.map((currency) => ({ currency, ...entryTotals(lines.filter((line) => line.functional_currency === currency)) }))}
    ledgerDescription={[origin, entry.reverses_number ? t('detail.reverses', { number: entry.reverses_number }) : null].filter(Boolean).join(' · ')}
    parties={lines.filter((line) => line.party).map((line) => ({ id: `party:${line.line_number}`, display_name: line.party! }))}
    accounts={lines.map((line) => ({ id: line.account_id, number: line.account_number ?? undefined, name: line.account_name }))}
    departments={lines.filter((line) => line.department).map((line) => ({ id: `department:${line.line_number}`, name: line.department! }))}
    projects={lines.filter((line) => line.project).map((line) => ({ id: `project:${line.line_number}`, name: line.project! }))}
    subsidiaries={[...new Map(lines.map((line) => [line.subsidiary_id, { id: line.subsidiary_id, name: line.subsidiary, depth: 0 }])).values()]}
    headerDefs={[]} lineDefs={[]} canPost={data.canPost} closeHref={closeHref}
  />
}
