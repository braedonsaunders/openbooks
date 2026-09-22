'use client'

import { useMoney } from '@/components/money-provider'
import { JournalEntryLink } from '@/components/journal-entry-link'
import { PagedTable } from '@/components/paged-table'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, Label, Select, TableCell, TableRow } from '@openbooks/ui'

export interface RecognitionBook {
  id: string
  name: string
  is_primary?: boolean
}

export interface RecognitionPeriod {
  id: string
  name: string
  startsOn: string
  endsOn: string
}

/** One obligation with due work, as the scope picker lists it. */
export interface RecognitionCandidate {
  obligationId: string
  contractId: string
  contractNumber: string
  description: string
}

type SkipReason = 'period_closed' | 'not_configured' | 'credit_capped' | 'negative_floor' | 'zero'

interface PreviewRow {
  lineId: string
  amount: string
  periodId: string
  bookId: string
  debitAccountId: string | null
  creditAccountId: string | null
  subsidiaryId: string | null
  departmentId: string | null
  projectId: string | null
  locationId: string | null
  obligationId: string
  obligationDescription: string
  contractNumber: string
  periodName: string
  periodEndsOn: string
  recognitionOn: string | null
  method: string
  bookName: string
  subsidiaryName: string | null
  departmentName: string | null
  projectName: string | null
  plannedAmount: string
  currency: string | null
  baseCurrency: string | null
  fxRate: string
  debitAccountNumber: string | null
  debitAccountName: string | null
  creditAccountNumber: string | null
  creditAccountName: string | null
  skipReason: SkipReason | null
  skipDetail: string | null
}

interface RecognitionPreview {
  asOfDate: string
  obligationId: string | null
  contractId: string | null
  bookId: string | null
  periodId: string | null
  rows: PreviewRow[]
  postableCount: number
  skippedCount: number
  totalAmount: string
  totalDebits: string
  totalCredits: string
  balanced: boolean
  projectSyncPending: boolean
  warnings: string[]
  fingerprint: string
}

interface RunResult {
  posted?: number
  skipped?: number
  totalAmount?: string
  entries?: { contract: string; obligation: string; period: string; amount: string; entryId: string }[]
  problems?: unknown
}

/**
 * Review/confirm drawer for revenue recognition — the only UI path that
 * posts it. Preview is a zero-write read of the exact balanced entries
 * (as-of date, book and period all fingerprinted), showing per line both
 * what will post and what will NOT, with the reason. Confirm carries the
 * preview fingerprint back and the server refuses on drift, so the run can
 * never post something the operator did not review.
 */
export function RunRecognitionDrawer({
  books,
  periods,
  candidates,
  lockObligation,
  open,
  onClose,
  stacked,
}: {
  books: RecognitionBook[]
  periods: RecognitionPeriod[]
  candidates: RecognitionCandidate[]
  /** Obligation-level launch from the contract drawer: scope is fixed. */
  lockObligation?: { id: string; description: string }
  open: boolean
  onClose: () => void
  stacked?: boolean
}) {
  const { money } = useMoney()
  const t = useTranslations('revenue')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const [asOfDate, setAsOfDate] = useState('')
  const [bookId, setBookId] = useState('')
  const [periodId, setPeriodId] = useState('')
  const [contractId, setContractId] = useState('')
  const [obligationId, setObligationId] = useState(lockObligation?.id ?? '')
  const [phase, setPhase] = useState<'scope' | 'review' | 'done'>('scope')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<RecognitionPreview | null>(null)
  const [previewScopeKey, setPreviewScopeKey] = useState('')
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)

  const scopeKey = useMemo(
    () => `${asOfDate}|${bookId}|${periodId}|${contractId}|${obligationId}`,
    [asOfDate, bookId, periodId, contractId, obligationId],
  )
  const scopeChanged = preview !== null && previewScopeKey !== scopeKey
  const confirmBlocked = busy || scopeChanged || (preview?.postableCount ?? 0) === 0

  // Obligations narrow with the chosen contract, so the two controls cannot
  // describe a scope that names nothing.
  const scopedCandidates = useMemo(
    () => (contractId ? candidates.filter((c) => c.contractId === contractId) : candidates),
    [candidates, contractId],
  )
  const contracts = useMemo(() => {
    const seen = new Map<string, string>()
    for (const c of candidates) if (!seen.has(c.contractId)) seen.set(c.contractId, c.contractNumber)
    return [...seen].map(([id, number]) => ({ id, number }))
  }, [candidates])

  /**
   * Every refusal this boundary can emit, mapped to a message naming the
   * remedy. An unknown body falls back to the raw code (or the status) so a
   * refusal always reaches the operator instead of dying silent.
   */
  async function refusalText(res: Response, fallback: string): Promise<string> {
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await res.json()
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      body = {}
    }
    const code = typeof body.error === 'string' && body.error.trim() !== '' ? body.error : null
    switch (code) {
      case 'invalid_as_of_date':
        return t('review.errDate')
      case 'stale_preview':
        return t('review.stale')
      case 'fingerprint_required':
        return t('review.confirmFailed')
      case 'book_not_found':
      case 'period_not_found':
      case 'obligation_not_found':
      case 'contract_not_found':
        return t('review.errScope')
      case 'feature disabled':
        return t('review.errScope')
      default:
        return code ?? `${fallback} (status ${res.status})`
    }
  }

  async function runPreview() {
    if (busy) return
    setBusy(true)
    setPreviewError(null)
    try {
      let data: RecognitionPreview
      try {
        const res = await fetch('/api/revenue/recognition-preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            asOfDate: asOfDate || undefined,
            bookId: bookId || undefined,
            periodId: periodId || undefined,
            contractId: contractId || undefined,
            obligationId: obligationId || undefined,
          }),
        })
        if (!res.ok) {
          const message = await refusalText(res, t('review.previewFailed'))
          setPreviewError(message)
          toast.error(message)
          return
        }
        data = await res.json()
      } catch {
        setPreviewError(t('review.previewFailed'))
        toast.error(t('review.previewFailed'))
        return
      }
      setPreview(data)
      setPreviewScopeKey(scopeKey)
      setPhase('review')
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    if (confirmBlocked || !preview) return
    setBusy(true)
    setPreviewError(null)
    try {
      let data: RunResult
      try {
        const res = await fetch('/api/revenue/run-recognition', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            asOfDate: preview.asOfDate,
            bookId: preview.bookId ?? undefined,
            periodId: preview.periodId ?? undefined,
            contractId: preview.contractId ?? undefined,
            obligationId: preview.obligationId ?? undefined,
            fingerprint: preview.fingerprint,
          }),
        })
        if (!res.ok) {
          const message = await refusalText(res, t('review.confirmFailed'))
          setPreviewError(message)
          toast.error(message)
          return
        }
        data = await res.json()
      } catch {
        setPreviewError(t('review.confirmFailed'))
        toast.error(t('review.confirmFailed'))
        return
      }
      setResult(data)
      setPhase('done')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const skipLabel = (row: PreviewRow): string => {
    switch (row.skipReason) {
      case 'period_closed':
        return t('review.skipPeriodClosed', { period: row.skipDetail ?? row.periodName })
      case 'not_configured':
        return t('review.skipNotConfigured')
      case 'credit_capped':
        return t('review.skipCreditCapped', { amount: money(row.skipDetail ?? '0') })
      case 'negative_floor':
        return t('review.skipNegativeFloor', { amount: money(row.skipDetail ?? '0') })
      case 'zero':
        return t('review.skipZero')
      default:
        return ''
    }
  }

  const account = (number: string | null, name: string | null) =>
    [number, name].filter(Boolean).join(' ') || '—'

  return (
    <Drawer
      open={open}
      onClose={onClose}
      stacked={stacked}
      size="2xl"
      title={t('review.title')}
      description={lockObligation ? lockObligation.description : t('review.description')}
    >
      <div className="space-y-5 p-1">
        {phase === 'scope' || phase === 'review' ? (
          <section className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="recognition-as-of">{t('review.asOf')}</Label>
              <Input
                id="recognition-as-of"
                type="date"
                value={asOfDate}
                onChange={(event) => setAsOfDate(event.target.value)}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('review.asOfHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recognition-book">{t('review.book')}</Label>
              <Select
                id="recognition-book"
                value={bookId}
                onChange={(event) => setBookId(event.target.value)}
              >
                <option value="">{t('review.allBooks')}</option>
                {books.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recognition-period">{t('review.period')}</Label>
              <Select
                id="recognition-period"
                value={periodId}
                onChange={(event) => setPeriodId(event.target.value)}
              >
                <option value="">{t('review.allPeriods')}</option>
                {periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.name}
                  </option>
                ))}
              </Select>
            </div>
            {lockObligation ? null : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="recognition-contract">{t('review.contract')}</Label>
                  <Select
                    id="recognition-contract"
                    value={contractId}
                    onChange={(event) => {
                      setContractId(event.target.value)
                      setObligationId('')
                    }}
                  >
                    <option value="">{t('review.allContracts')}</option>
                    {contracts.map((contract) => (
                      <option key={contract.id} value={contract.id}>
                        {contract.number}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="recognition-obligation">{t('review.obligation')}</Label>
                  <Select
                    id="recognition-obligation"
                    value={obligationId}
                    onChange={(event) => setObligationId(event.target.value)}
                  >
                    <option value="">{t('review.allObligations')}</option>
                    {scopedCandidates.map((candidate) => (
                      <option key={candidate.obligationId} value={candidate.obligationId}>
                        {candidate.contractNumber} · {candidate.description}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            )}
          </section>
        ) : null}

        {previewError ? (
          <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {previewError}
          </p>
        ) : null}

        {phase === 'review' && preview ? (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={preview.balanced ? 'success' : 'warning'}>
                {preview.balanced ? t('review.balanced') : t('review.unbalanced')}
              </Badge>
              <span className="text-sm text-slate-600 dark:text-slate-300">
                {t('review.willPost', { count: preview.postableCount })}
              </span>
              {preview.skippedCount > 0 ? (
                <span className="text-sm text-amber-700 dark:text-amber-400">
                  {t('review.willSkip', { count: preview.skippedCount })}
                </span>
              ) : null}
              <span className="flex-1" />
              <span className="text-sm tabular-nums text-slate-900 dark:text-slate-100">
                {t('review.totalDebits')} {money(preview.totalDebits)} ·{' '}
                {t('review.totalCredits')} {money(preview.totalCredits)}
              </span>
            </div>

            {preview.warnings.map((warning) => (
              <p
                key={warning}
                className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
              >
                {warning}
              </p>
            ))}

            {scopeChanged ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">{t('review.scopeChanged')}</p>
            ) : null}

            <PagedTable
              rows={preview.rows}
              columns={[
                {
                  key: 'contract',
                  header: t('review.colContract'),
                  cell: (row) => <span className="font-mono text-sm">{row.contractNumber}</span>,
                  search: (row) => `${row.contractNumber} ${row.obligationDescription} ${row.periodName}`,
                },
                {
                  key: 'obligation',
                  header: t('review.colObligation'),
                  cell: (row) => (
                    <span className="text-sm">
                      {row.obligationDescription}
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {[row.bookName, row.subsidiaryName, row.departmentName, row.projectName]
                          .filter(Boolean)
                          .join(' \u00b7 ')}
                      </span>
                    </span>
                  ),
                  search: (row) => row.obligationDescription,
                },
                {
                  key: 'period',
                  header: t('review.colPeriod'),
                  cell: (row) => (
                    <span className="text-sm">
                      {row.periodName}
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {row.recognitionOn ?? row.periodEndsOn}
                      </span>
                    </span>
                  ),
                  search: (row) => row.periodName,
                },
                {
                  key: 'debit',
                  header: t('review.colDebit'),
                  cell: (row) => (
                    <span className="text-sm">{account(row.debitAccountNumber, row.debitAccountName)}</span>
                  ),
                },
                {
                  key: 'credit',
                  header: t('review.colCredit'),
                  cell: (row) => (
                    <span className="text-sm">{account(row.creditAccountNumber, row.creditAccountName)}</span>
                  ),
                },
                {
                  key: 'amount',
                  header: t('review.colAmount'),
                  align: 'right',
                  cell: (row) =>
                    row.skipReason ? (
                      <span className="text-xs text-amber-700 dark:text-amber-400">{skipLabel(row)}</span>
                    ) : (
                      <span className="text-sm tabular-nums">
                        {money(row.amount)}
                        {row.amount !== row.plannedAmount ? (
                          <span className="block text-xs text-slate-500 dark:text-slate-400">
                            {t('review.cappedFrom', { amount: money(row.plannedAmount) })}
                          </span>
                        ) : null}
                      </span>
                    ),
                },
              ]}
              rowKey={(row) => row.lineId}
              searchable
              pageSize={10}
              empty={t('review.nothingDue', { date: preview.asOfDate })}
              footer={
                <TableRow className="border-t border-slate-200 font-semibold dark:border-slate-800">
                  <TableCell colSpan={5} className="px-4 py-2 text-sm">
                    {t('review.total')}
                  </TableCell>
                  <TableCell className="px-4 py-2 text-right text-sm tabular-nums">
                    {money(preview.totalAmount)}
                  </TableCell>
                </TableRow>
              }
            />
          </section>
        ) : null}

        {phase === 'done' && result ? (
          <section className="space-y-3">
            <p className="text-sm text-slate-700 dark:text-slate-200">
              {t('run.posted', { count: result.posted ?? 0, amount: money(result.totalAmount ?? '0') })}
            </p>
            {(result.entries ?? []).map((entry) => (
              <div
                key={entry.entryId}
                className="flex items-center justify-between gap-3 rounded border border-slate-200 p-2.5 text-sm dark:border-slate-800"
              >
                <span>
                  {entry.contract} · {entry.obligation} · {entry.period}
                </span>
                <span className="flex items-center gap-3 tabular-nums">
                  {money(entry.amount)}
                  <JournalEntryLink entryId={entry.entryId}>
                    <span className="font-mono underline decoration-dotted underline-offset-2">
                      {entry.entryId.slice(0, 8)}
                    </span>
                  </JournalEntryLink>
                </span>
              </div>
            ))}
            {(result.skipped ?? 0) > 0 ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {t('run.someSkipped', { count: result.skipped ?? 0 })}
              </p>
            ) : null}
            {Array.isArray(result.problems)
              ? result.problems.map((problem, index) => (
                  <p key={index} className="text-sm text-amber-700 dark:text-amber-400">
                    {String(problem)}
                  </p>
                ))
              : null}
          </section>
        ) : null}

        <div className="flex items-center gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          {phase === 'done' ? (
            <Button onClick={onClose}>{tCommon('actions.close')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                {tCommon('actions.cancel')}
              </Button>
              <span className="flex-1" />
              <Button variant="outline" onClick={runPreview} disabled={busy}>
                {phase === 'review' ? t('review.refresh') : t('review.preview')}
              </Button>
              {phase === 'review' ? (
                <Button onClick={confirm} disabled={confirmBlocked}>
                  {t('review.confirm')}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Drawer>
  )
}
