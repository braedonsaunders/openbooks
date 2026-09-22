'use client'

import { useMoney } from '@/components/money-provider'
import { PagedTable } from '@/components/paged-table'
import { JournalEntryLink } from '@/components/journal-entry-link'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, Label, Select, TableCell, TableRow } from '@openbooks/ui'

export interface DepreciationCandidate {
  id: string
  number: string
  name: string
  status: string
}

export interface DepreciationBook {
  id: string
  name: string
  is_primary?: boolean
}

export interface DepreciationPeriod {
  id: string
  name: string
  startsOn: string
  endsOn: string
}

interface PreviewRow {
  lineId: string
  assetId: string
  assetNumber: string
  assetName: string
  subsidiaryId: string
  subsidiaryName: string | null
  departmentId: string | null
  departmentName: string | null
  projectId: string | null
  projectName: string | null
  locationId: string | null
  locationName: string | null
  bookId: string
  bookName: string
  postsGl: boolean
  periodId: string
  periodName: string
  periodEndsOn: string
  amount: string
  debitAccountId: string
  debitAccountNumber: string | null
  debitAccountName: string | null
  creditAccountId: string
  creditAccountNumber: string | null
  creditAccountName: string | null
  accountsResolved: boolean
  evidence: 'gl-posting' | 'reporting-only'
}

interface DepreciationPreview {
  asOfDate: string
  bookId: string | null
  periodId: string | null
  postingDate: string | null
  rows: PreviewRow[]
  totalAmount: string
  totalDebits: string
  totalCredits: string
  balanced: boolean
  staleAssets: { assetId: string; assetNumber: string; assetName: string }[]
  warnings: string[]
  fingerprint: string
}

interface PostedEntry {
  assetId: string
  assetNumber: string
  period: string
  amount: string
  entryId: string
  lineId: string
}

interface RecordedEntry {
  assetId: string
  assetNumber: string
  period: string
  amount: string
  lineId: string
}

interface RunResult {
  posted?: number
  recorded?: number
  recordedAmount?: string
  skipped?: number
  totalAmount?: string
  entries?: PostedEntry[]
  recordedEntries?: RecordedEntry[]
  skippedAssets?: { assetNumber: string; period: string; reason: string }[]
  problems?: unknown
  asOfDate?: string
  nextDue?: { assetNumber: string; period: string; endsOn: string; amount: string } | null
}

/**
 * Review/confirm drawer for depreciation — the ONLY UI path that posts it.
 * Preview is a zero-write read of the exact balanced entries (through date,
 * posting date, and accounting period all fingerprinted); Confirm carries
 * the preview fingerprint back and the server refuses the whole batch (409)
 * on any drift. While any in-scope schedule is stale, Confirm stays
 * disabled: rebuild the schedules, then preview again.
 */
export function RunDepreciationDrawer({
  books,
  candidates,
  periods,
  lockAsset,
  lockBookId,
  open,
  onClose,
  stacked,
}: {
  books: DepreciationBook[]
  candidates: DepreciationCandidate[]
  periods: DepreciationPeriod[]
  /** Asset-level launch: the asset is preselected and the picker hidden. */
  lockAsset?: { id: string; number: string; name: string }
  /** Asset-level launch: the chosen book is preselected and locked. */
  lockBookId?: string
  open: boolean
  onClose: () => void
  stacked?: boolean
}) {
  const { money } = useMoney()
  const t = useTranslations('assets')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [bookId, setBookId] = useState(
    lockBookId ?? books.find((book) => book.is_primary)?.id ?? books[0]?.id ?? '',
  )
  const [periodId, setPeriodId] = useState('')
  const [throughDate, setThroughDate] = useState('')
  const [postingDate, setPostingDate] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>(
    lockAsset ? [lockAsset.id] : candidates.map((candidate) => candidate.id),
  )
  const [phase, setPhase] = useState<'scope' | 'review' | 'done'>('scope')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<DepreciationPreview | null>(null)
  const [previewScopeKey, setPreviewScopeKey] = useState('')
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)

  const scopeKey = useMemo(() => {
    const ids = [...new Set(selectedIds)].sort()
    return `${bookId}|${periodId}|${throughDate}|${postingDate}|${ids.join(',')}`
  }, [bookId, periodId, throughDate, postingDate, selectedIds])
  const scopeChanged = preview !== null && previewScopeKey !== scopeKey
  const staleBlocked = (preview?.staleAssets.length ?? 0) > 0
  const confirmBlocked =
    busy || scopeChanged || staleBlocked || (preview?.rows.length ?? 0) === 0

  function toggleId(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  function toggleAll(ids: string[]) {
    setSelectedIds((current) => {
      const set = new Set(current)
      const allSelected = ids.length > 0 && ids.every((id) => set.has(id))
      if (allSelected) {
        for (const id of ids) set.delete(id)
      } else {
        for (const id of ids) set.add(id)
      }
      return [...set]
    })
  }

  /**
   * Every refusal the depreciation boundary can emit, mapped to a message
   * that names the remedy. Unknown bodies fall back to the raw code (or the
   * status) so a refusal always reaches the operator instead of dying
   * silent. res.ok is checked by the caller before parsing here.
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
      case 'invalid_through_date':
      case 'invalid_posting_date':
        return t('review.errDate')
      case 'nothing_selected':
        return t('review.emptyScope')
      case 'fingerprint_required':
        return t('review.confirmFailed')
      case 'stale_preview':
        return t('review.stale')
      case 'schedules_stale':
        return t('review.schedulesStale')
      case 'period_closed':
        return t('review.errPeriodClosed', {
          asset: typeof body.asset === 'string' ? body.asset : '?',
          period: typeof body.period === 'string' ? body.period : '?',
        })
      case 'nothing_due':
        return t('run.nothingDue')
      case 'unknown_asset':
      case 'book_not_found':
      case 'period_not_found':
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
      // Transport or parse failure toasts like every other failure — an
      // uncaught rejection would leave the drawer spinning with no feedback.
      let data: DepreciationPreview
      try {
        const res = await fetch('/api/assets/depreciation-preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            bookId: bookId || undefined,
            periodId: periodId || undefined,
            throughDate: throughDate || undefined,
            postingDate: postingDate || undefined,
            assetIds: [...new Set(selectedIds)],
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

  async function rebuildSchedules() {
    if (busy || !preview || preview.staleAssets.length === 0) return
    setBusy(true)
    try {
      let data: { rebuilt?: { assetNumber: string }[]; problems?: unknown }
      try {
        const res = await fetch('/api/assets/rebuild-schedules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            bookId: bookId || undefined,
            assetIds: preview.staleAssets.map((asset) => asset.assetId),
          }),
        })
        if (!res.ok) {
          const message = await refusalText(res, t('review.rebuildFailed'))
          setPreviewError(message)
          toast.error(message)
          return
        }
        data = await res.json()
      } catch {
        setPreviewError(t('review.rebuildFailed'))
        toast.error(t('review.rebuildFailed'))
        return
      }
      const rebuilt = Array.isArray(data.rebuilt) ? data.rebuilt.length : 0
      const problems = Array.isArray(data.problems) ? data.problems : []
      if (problems.length > 0) {
        const message = problems.map(String).join(' · ')
        setPreviewError(message)
        toast.error(message)
        return
      }
      toast.success(t('review.rebuilt', { count: rebuilt }))
      // Re-preview over the rebuilt schedules so Confirm fingerprints the
      // new projection instead of the stale one.
      await runPreview()
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
        const res = await fetch('/api/assets/run-depreciation', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            asOfDate: preview.asOfDate,
            bookId: bookId || undefined,
            periodId: preview.periodId ?? undefined,
            postingDate: preview.postingDate ?? undefined,
            assetIds: [...new Set(selectedIds)],
            fingerprint: preview.fingerprint,
          }),
        })
        if (!res.ok) {
          // A 409 names its remedy and stays in-drawer (plus a toast) so
          // the refusal reaches the operator instead of dying silent.
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

  function backToScope() {
    setPhase('scope')
    setPreviewError(null)
  }

  function runAgain() {
    setPhase('scope')
    setPreview(null)
    setPreviewScopeKey('')
    setPreviewError(null)
    setResult(null)
  }

  const bookName = books.find((book) => book.id === bookId)?.name ?? ''
  const postedCount = result?.posted ?? 0
  const recordedCount = result?.recorded ?? 0
  const skippedCount = result?.skipped ?? 0
  const problems = Array.isArray(result?.problems) ? (result.problems as unknown[]) : []
  const entries = Array.isArray(result?.entries) ? result.entries : []
  const recordedEntries = Array.isArray(result?.recordedEntries) ? result.recordedEntries : []
  const skippedAssets = Array.isArray(result?.skippedAssets) ? result.skippedAssets : []

  function dimensions(row: PreviewRow): string {
    const parts = [
      row.subsidiaryName,
      row.departmentName,
      row.projectName,
      row.locationName,
    ].filter(Boolean)
    return parts.length > 0 ? parts.join(' · ') : '—'
  }

  function account(entry: { number: string | null; name: string | null }): string {
    if (entry.number && entry.name) return `${entry.number} · ${entry.name}`
    return entry.number ?? entry.name ?? '—'
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      stacked={stacked}
      size="2xl"
      title={phase === 'done' ? t('review.resultsTitle') : t('review.title')}
      description={phase === 'done' ? undefined : t('review.description')}
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="flex-1" />
          {phase === 'scope' ? (
            <Button disabled={busy || !bookId || selectedIds.length === 0} onClick={runPreview}>
              {busy ? t('review.previewing') : t('review.preview')}
            </Button>
          ) : null}
          {phase === 'review' ? (
            <>
              <Button variant="outline" disabled={busy} onClick={backToScope}>
                {t('review.backToScope')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={runPreview}>
                {busy ? t('review.previewing') : t('review.previewAgain')}
              </Button>
              {staleBlocked ? (
                <Button disabled={busy} onClick={rebuildSchedules}>
                  {busy ? t('review.rebuilding') : t('review.rebuild')}
                </Button>
              ) : null}
              <Button disabled={confirmBlocked} onClick={confirm}>
                {busy ? t('review.confirming') : t('review.confirm')}
              </Button>
            </>
          ) : null}
          {phase === 'done' ? (
            <>
              <Button variant="outline" onClick={runAgain}>
                {t('review.runAgain')}
              </Button>
              <Button onClick={onClose}>{tCommon('actions.close')}</Button>
            </>
          ) : null}
        </div>
      }
    >
      <div className="space-y-5">
        {phase !== 'done' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="depreciation-review-book">{t('run.book')}</Label>
              <Select
                id="depreciation-review-book"
                value={bookId}
                disabled={!!lockBookId || busy}
                onChange={(event) => setBookId(event.target.value)}
              >
                {books.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="depreciation-review-period">{t('review.columns.period')}</Label>
              <Select
                id="depreciation-review-period"
                value={periodId}
                disabled={busy}
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
            <div className="space-y-1.5">
              <Label htmlFor="depreciation-review-through">{t('run.asOf')}</Label>
              <Input
                id="depreciation-review-through"
                type="date"
                value={throughDate}
                disabled={busy}
                onChange={(event) => setThroughDate(event.target.value)}
                placeholder={t('review.throughHint')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="depreciation-review-posting">{t('review.postingDate')}</Label>
              <Input
                id="depreciation-review-posting"
                type="date"
                value={postingDate}
                disabled={busy}
                onChange={(event) => setPostingDate(event.target.value)}
                placeholder={t('review.postingHint')}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('review.scope')}</Label>
              {lockAsset ? (
                <p className="font-mono text-sm">
                  {lockAsset.number} · {lockAsset.name}
                </p>
              ) : (
                <p className="text-sm tabular-nums">
                  {t('review.selectedCount', { count: selectedIds.length })}
                </p>
              )}
            </div>
          </div>
        ) : null}

        {phase === 'scope' && !lockAsset ? (
          <PagedTable
            rows={candidates}
            columns={[
              {
                key: 'number',
                header: t('labels.number'),
                cell: (row) => <span className="font-mono text-sm">{row.number}</span>,
                search: (row) => `${row.number} ${row.name}`,
              },
              {
                key: 'name',
                header: tCommon('labels.name'),
                cell: (row) => <span className="text-sm">{row.name}</span>,
                search: (row) => `${row.number} ${row.name}`,
              },
              {
                key: 'status',
                header: tCommon('labels.status'),
                cell: (row) => (
                  <Badge variant="secondary">{t(`status.${row.status}`)}</Badge>
                ),
              },
            ]}
            rowKey={(row) => row.id}
            searchable
            pageSize={8}
            empty={t('review.noCandidates')}
            selection={{
              getId: (row) => row.id,
              selectedIds,
              onToggle: toggleId,
              onToggleAll: toggleAll,
              disabled: busy,
            }}
          />
        ) : null}

        {previewError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {previewError}
          </p>
        ) : null}

        {phase === 'review' && preview ? (
          <>
            {scopeChanged ? (
              <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
                {t('review.scopeChanged')}
              </p>
            ) : null}
            {staleBlocked ? (
              <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
                {t('review.staleRefusal', {
                  count: preview.staleAssets.length,
                  assets: preview.staleAssets.map((asset) => asset.assetNumber).join(', '),
                })}
              </p>
            ) : null}
            {preview.rows.length === 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {t('review.nothingDue', { date: preview.asOfDate, book: bookName })}
              </p>
            ) : (
              <PagedTable
                rows={preview.rows}
                columns={[
                  {
                    key: 'asset',
                    header: t('review.columns.asset'),
                    cell: (row) => (
                      <span className="text-sm">
                        <span className="font-mono">{row.assetNumber}</span> · {row.assetName}
                      </span>
                    ),
                    search: (row) => `${row.assetNumber} ${row.assetName} ${row.periodName}`,
                  },
                  {
                    key: 'period',
                    header: t('review.columns.period'),
                    cell: (row) => <span className="text-sm">{row.periodName}</span>,
                    search: (row) => row.periodName,
                  },
                  {
                    key: 'debit',
                    header: t('review.columns.debit'),
                    cell: (row) => (
                      <span className="text-sm">
                        {account({ number: row.debitAccountNumber, name: row.debitAccountName })}
                      </span>
                    ),
                  },
                  {
                    key: 'credit',
                    header: t('review.columns.credit'),
                    cell: (row) => (
                      <span className="text-sm">
                        {account({ number: row.creditAccountNumber, name: row.creditAccountName })}
                      </span>
                    ),
                  },
                  {
                    key: 'dimensions',
                    header: t('review.columns.dimensions'),
                    cell: (row) => <span className="text-sm">{dimensions(row)}</span>,
                  },
                  {
                    key: 'posting',
                    header: t('review.columns.posting'),
                    cell: (row) => (
                      <Badge variant={row.postsGl ? 'default' : 'secondary'}>
                        {row.postsGl ? t('review.glPosting') : t('review.reportingOnly')}
                      </Badge>
                    ),
                  },
                  {
                    key: 'amount',
                    header: t('review.columns.amount'),
                    align: 'right',
                    cell: (row) => (
                      <span className="text-sm tabular-nums">{money(row.amount)}</span>
                    ),
                  },
                ]}
                rowKey={(row) => row.lineId}
                searchable
                pageSize={10}
                empty={t('review.nothingDue', { date: preview.asOfDate, book: bookName })}
                footer={
                  <TableRow className="border-t border-slate-200 font-semibold dark:border-slate-800">
                    <TableCell colSpan={6} className="px-4 py-2 text-sm">
                      {t('review.total')} ·{' '}
                      <span className={preview.balanced ? '' : 'text-red-600 dark:text-red-400'}>
                        {preview.balanced ? t('review.balanced') : t('review.outOfBalance')}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-2 text-right text-sm tabular-nums">
                      {t('review.debitTotal', { amount: money(preview.totalDebits) })}{' · '}
                      {t('review.creditTotal', { amount: money(preview.totalCredits) })}
                    </TableCell>
                  </TableRow>
                }
              />
            )}
            {preview.staleAssets.length > 0 ? (
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {t('review.staleSchedules', {
                  count: preview.staleAssets.length,
                  assets: preview.staleAssets.map((asset) => asset.assetNumber).join(', '),
                })}
              </p>
            ) : null}
            {preview.warnings.map((warning) => (
              <p key={warning} className="text-sm text-amber-700 dark:text-amber-300">
                {warning}
              </p>
            ))}
            <p
              className="font-mono text-xs text-slate-500 dark:text-slate-400"
              title={preview.fingerprint}
            >
              {t('review.fingerprint')}: {preview.fingerprint.slice(0, 16)}…
            </p>
          </>
        ) : null}

        {phase === 'done' && result ? (
          <div className="space-y-4" aria-live="polite">
            {postedCount > 0 || recordedCount > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {postedCount > 0 ? (
                  <li>{t('run.posted', { count: postedCount, amount: money(result.totalAmount ?? '0') })}</li>
                ) : null}
                {recordedCount > 0 ? (
                  <li>{t('run.recorded', { count: recordedCount, amount: money(result.recordedAmount ?? '0') })}</li>
                ) : null}
                {skippedCount > 0 ? (
                  <li>{t('run.someSkipped', { count: skippedCount })}</li>
                ) : null}
              </ul>
            ) : skippedCount === 0 && result.nextDue ? (
              // A zero-post confirm while a planned line waits in the open
              // period names the as-of date and the next due line, so a zero
              // count never misreads the record.
              <p className="text-sm">
                {t('run.nextDue', {
                  date: result.asOfDate ?? '',
                  asset: result.nextDue.assetNumber,
                  period: result.nextDue.period,
                  amount: money(result.nextDue.amount ?? '0'),
                  endsOn: result.nextDue.endsOn,
                })}
              </p>
            ) : (
              <p className="text-sm">
                {t('run.nothingDue')}
                {skippedCount > 0 ? ` · ${t('run.someSkipped', { count: skippedCount })}` : ''}
              </p>
            )}
            {entries.length > 0 ? (
              <section className="space-y-1.5">
                <h3 className="text-sm font-semibold">{t('review.resultsPosted')}</h3>
                <ul className="space-y-1 text-sm">
                  {entries.map((entry) => (
                    <li key={entry.lineId} className="flex flex-wrap items-baseline gap-x-2">
                      <JournalEntryLink entryId={entry.entryId}>
                        <span className="font-mono underline decoration-dotted underline-offset-2">
                          {entry.entryId.slice(0, 8)}
                        </span>
                      </JournalEntryLink>
                      <span className="font-mono">{entry.assetNumber}</span>
                      <span>{entry.period}</span>
                      <span className="tabular-nums">{money(entry.amount)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {recordedEntries.length > 0 ? (
              <section className="space-y-1.5">
                <h3 className="text-sm font-semibold">{t('review.resultsRecorded')}</h3>
                <ul className="space-y-1 text-sm">
                  {recordedEntries.map((entry) => (
                    <li key={entry.lineId} className="flex flex-wrap items-baseline gap-x-2">
                      <Link
                        href={`/assets?asset=${entry.assetId}` as never}
                        className="underline decoration-dotted underline-offset-2"
                      >
                        <span className="font-mono">{entry.assetNumber}</span>
                      </Link>
                      <span>{entry.period}</span>
                      <span className="tabular-nums">{money(entry.amount)}</span>
                      <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                        {t('review.evidenceLine', { line: entry.lineId.slice(0, 8) })}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {skippedAssets.length > 0 ? (
              <section className="space-y-1.5">
                <h3 className="text-sm font-semibold">{t('review.resultsSkipped')}</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {skippedAssets.map((skipped, index) => (
                    <li key={`${skipped.assetNumber}-${skipped.period}-${index}`}>
                      <span className="font-mono">{skipped.assetNumber}</span> {skipped.period}
                      {' — '}
                      {skipped.reason}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {problems.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-300">
                {problems.map((problem, index) => (
                  <li key={index}>{String(problem)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Drawer>
  )
}
