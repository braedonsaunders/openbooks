'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { RotateCcw } from 'lucide-react'
import { sum, toUnits } from '@openbooks/engine/money/money'
import type { MatchReason } from '@openbooks/engine/banking/match-scoring'
import {
  Button, Drawer, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn,
} from '@openbooks/ui'
import { useMoney } from '@/components/money-provider'
import { readApiErrorMessage } from '@/lib/api-error'
import { MatchReasonBadges } from './MatchReasons'

interface CandidateDocument {
  openLineId: string
  partyId: string
  partyName: string | null
  documentNumber: string | null
  entryNumber: string
  documentKind: string | null
  dueDate: string | null
  transactionOpen: string
  reasons: MatchReason[]
}

interface Proposal {
  openLineIds: string[]
  partyId: string
  partyName: string | null
  total: string
  reasons: MatchReason[]
}

interface Candidates {
  side: 'ar' | 'ap'
  amount: string
  currency: string
  proposals: Proposal[]
  documents: CandidateDocument[]
}

type LoadState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'loaded'; candidates: Candidates }

/** Load the proposals for one line; refusals keep the server's reason and remedy. */
async function requestCandidates(
  lineId: string,
  reconciliationId: string,
  failureMessage: string,
  signal?: AbortSignal,
): Promise<LoadState> {
  try {
    const res = await fetch(
      `/api/banking/statement-lines/${lineId}/open-documents?reconciliationId=${encodeURIComponent(reconciliationId)}`,
      { signal },
    )
    if (!res.ok) return { status: 'failed', message: await readApiErrorMessage(res, failureMessage) }
    return { status: 'loaded', candidates: await res.json() as Candidates }
  } catch {
    return { status: 'failed', message: failureMessage }
  }
}

export interface SettleLine {
  id: string
  label: string
}

/**
 * Open invoices or bills for one unmatched bank line, ranked with reasons,
 * and the one-step "Record payment and match". One drawer shell carries
 * loading, the proposals, refusals and retry; a refused record keeps its
 * reason inline until the next selection. Hosts mount it per line (keyed by
 * the line id), so every line starts from a fresh selection.
 */
export function SettleLineDrawer({
  line, reconciliationId, currency, onClose, onRecorded,
}: {
  line: SettleLine
  reconciliationId: string
  currency: string
  onClose: () => void
  onRecorded: () => void
}) {
  const t = useTranslations('banking.match.settle')
  const tCommon = useTranslations('common')
  const tBanking = useTranslations('banking')
  const { money: formatMoney } = useMoney(currency)
  const money = (value: string) => formatMoney(value, { maximumFractionDigits: 4 })
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [view, setView] = useState<'proposals' | 'documents'>('proposals')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [recordError, setRecordError] = useState<string | null>(null)
  const lineId = line.id

  const failureMessage = tBanking('errors.requestFailed')

  useEffect(() => {
    const controller = new AbortController()
    requestCandidates(lineId, reconciliationId, failureMessage, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setState(next) })
    return () => controller.abort()
  }, [lineId, reconciliationId, failureMessage])

  function retry() {
    setState({ status: 'loading' })
    void requestCandidates(lineId, reconciliationId, failureMessage).then(setState)
  }

  const candidates = state.status === 'loaded' ? state.candidates : null
  const documentsById = useMemo(
    () => new Map((candidates?.documents ?? []).map((doc) => [doc.openLineId, doc])),
    [candidates],
  )
  const selectedDocs = [...selected].map((id) => documentsById.get(id)).filter((doc): doc is CandidateDocument => !!doc)
  const selectedTotal = sum(selectedDocs.map((doc) => doc.transactionOpen))
  const selectionParties = new Set(selectedDocs.map((doc) => doc.partyId))
  const selectionSettles = candidates !== null && selectedDocs.length > 0 && selectionParties.size === 1
    && toUnits(selectedTotal) === toUnits(candidates.amount)

  async function record(openLineIds: string[]) {
    if (!candidates) return
    setBusy(true)
    setRecordError(null)
    try {
      const expectedOpen: Record<string, string> = {}
      for (const id of openLineIds) {
        const doc = documentsById.get(id)
        if (doc) expectedOpen[id] = doc.transactionOpen
      }
      const res = await fetch(`/api/banking/statement-lines/${line.id}/record-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reconciliationId, openLineIds, expectedOpen }),
      })
      if (!res.ok) {
        const message = await readApiErrorMessage(res, tBanking('errors.requestFailed'))
        setRecordError(message)
        toast.error(message)
        return
      }
      const result = await res.json().catch(() => null) as { documentNumber?: string; effectsError?: string | null } | null
      toast.success(t('recordedToast', { number: result?.documentNumber ?? '' }))
      if (result?.effectsError) toast.error(t('effectsPending', { reason: result.effectsError }))
      onRecorded()
    } catch {
      const message = tBanking('errors.requestFailed')
      setRecordError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  const docLabel = (doc: CandidateDocument) => doc.documentNumber ?? doc.entryNumber
  const sideTitle = candidates?.side === 'ap' ? t('titleBills') : t('titleInvoices')
  const tabClass = (active: boolean) => cn(
    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
    active ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-200' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
  )

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={candidates ? sideTitle : t('title')}
      description={candidates ? t('description', { line: line.label, amount: money(candidates.amount) }) : line.label}
      subtabs={candidates ? (
        <div className="flex items-center gap-1 px-6 pb-2" role="tablist" aria-label={t('title')}>
          <button type="button" role="tab" aria-selected={view === 'proposals'} className={tabClass(view === 'proposals')} onClick={() => setView('proposals')}>
            {t('tabs.proposals')} <span className="ml-1 text-xs text-slate-400">{candidates.proposals.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={view === 'documents'} className={tabClass(view === 'documents')} onClick={() => setView('documents')}>
            {t('tabs.documents')} <span className="ml-1 text-xs text-slate-400">{candidates.documents.length}</span>
          </button>
        </div>
      ) : undefined}
      headerActions={view === 'documents' && candidates ? (
        <Button disabled={busy || !selectionSettles} onClick={() => record([...selected])}>
          {busy ? tCommon('actions.saving') : t('recordAndMatch')}
        </Button>
      ) : undefined}
    >
      <div className="space-y-3">
        {recordError ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {recordError}
          </p>
        ) : null}
        {state.status === 'loading' ? (
          <p className="text-sm text-slate-500 dark:text-slate-400" role="status">{t('loading')}</p>
        ) : null}
        {state.status === 'failed' ? (
          <div className="space-y-2">
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {state.message}
            </p>
            <Button variant="outline" onClick={retry}><RotateCcw size={14} /> {t('retry')}</Button>
          </div>
        ) : null}
        {candidates && view === 'proposals' ? (
          candidates.proposals.length === 0 ? (
            <EmptyState title={t('noProposalsTitle')} description={t('noProposalsDescription', { currency: candidates.currency })} />
          ) : (
            <>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('proposalsHint')}</p>
              <Table>
                <TableHeader><TableRow>
                  <TableHead>{t('columns.party')}</TableHead>
                  <TableHead>{t('columns.documents')}</TableHead>
                  <TableHead>{t('columns.why')}</TableHead>
                  <TableHead />
                </TableRow></TableHeader>
                <TableBody>
                  {candidates.proposals.map((proposal) => (
                    <TableRow key={proposal.openLineIds.join(',')}>
                      <TableCell className="max-w-[10rem] truncate">{proposal.partyName ?? '—'}</TableCell>
                      <TableCell className="font-mono text-[13px]">
                        {proposal.openLineIds.map((id) => {
                          const doc = documentsById.get(id)
                          return doc ? <div key={id}>{docLabel(doc)} <span className="text-slate-400">{money(doc.transactionOpen)}</span></div> : null
                        })}
                      </TableCell>
                      <TableCell><MatchReasonBadges reasons={proposal.reasons} /></TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" disabled={busy} onClick={() => record(proposal.openLineIds)}>{t('recordAndMatch')}</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )
        ) : null}
        {candidates && view === 'documents' ? (
          candidates.documents.length === 0 ? (
            <EmptyState title={t('noDocumentsTitle')} description={t('noDocumentsDescription', { currency: candidates.currency })} />
          ) : (
            <>
              <p className="text-xs text-slate-600 tabular-nums dark:text-slate-300">
                {t('selectionSummary', { selected: money(selectedTotal), amount: money(candidates.amount) })}
                {selectionParties.size > 1 ? <span className="ml-2 text-amber-700 dark:text-amber-300">{t('oneParty')}</span> : null}
              </p>
              <Table>
                <TableHeader><TableRow>
                  <TableHead className="w-8" />
                  <TableHead>{t('columns.document')}</TableHead>
                  <TableHead>{t('columns.party')}</TableHead>
                  <TableHead>{t('columns.due')}</TableHead>
                  <TableHead className="text-right">{t('columns.open')}</TableHead>
                  <TableHead>{t('columns.why')}</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {candidates.documents.map((doc) => {
                    const checked = selected.has(doc.openLineId)
                    const toggle = () => {
                      setRecordError(null)
                      setSelected((current) => {
                        const next = new Set(current)
                        if (next.has(doc.openLineId)) next.delete(doc.openLineId); else next.add(doc.openLineId)
                        return next
                      })
                    }
                    return (
                      <TableRow key={doc.openLineId} className={cn(checked && 'bg-teal-50 dark:bg-teal-950/40')}>
                        <TableCell className="w-8">
                          <input type="checkbox" checked={checked} onChange={toggle} className="accent-teal-700"
                            aria-label={t('selectDocumentAria', { document: docLabel(doc), amount: money(doc.transactionOpen) })} />
                        </TableCell>
                        <TableCell className="font-mono text-[13px]">{docLabel(doc)}</TableCell>
                        <TableCell className="max-w-[10rem] truncate">{doc.partyName ?? '—'}</TableCell>
                        <TableCell className="whitespace-nowrap">{doc.dueDate ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(doc.transactionOpen)}</TableCell>
                        <TableCell><MatchReasonBadges reasons={doc.reasons} /></TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </>
          )
        ) : null}
        {candidates ? <p className="text-xs text-slate-500 dark:text-slate-400">{t('recordHint')}</p> : null}
      </div>
    </Drawer>
  )
}
