'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FileDown, History } from 'lucide-react'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Drawer,
  EmptyState,
  FieldLabel,
  Input,
  Skeleton,
  Textarea,
} from '@openbooks/ui'
import type { YearEndFilingSection } from '@openbooks/engine/src/payroll-yearend.ts'
import type { PayrollFilingSlipData } from '@openbooks/engine/src/payroll-filing-registry.ts'
import { useMoney } from '../../../../components/money-provider'
import { confirmDialog } from '../../../../lib/confirm'
import { payrollSlipFacsimile } from '../../../../lib/payroll-slip-facsimile'
import { renderTaxFormFacsimileBody } from '../../../../lib/tax-form-facsimile-html'

/**
 * The AMENDED / CANCELLED filing lifecycle, on screen.
 *
 * Three things the operator needs and nothing else: what has been ISSUED for
 * this filing-year, WHICH slips have moved since, and EXACTLY which boxes
 * moved on each one — old value beside new, in the form's own vocabulary.
 *
 * Everything statutory on this surface is the pack's own words: the correction
 * vehicle ("Form W-2c"), the transmission caveat, and above all the REFUSALS.
 * Where an agency's correction format cannot be produced correctly (Revenu
 * Québec's RL-1, an ROE whose Service Canada serial number this product never
 * held) the pack's sentence is what is shown, and there is no action to take.
 *
 * This is deliberately NOT rendered on the Separations surface: separation
 * documents are not year-end artifacts and were moved off that surface on
 * purpose. `FilingWorkspace` takes `amendments` and only the year-end cockpit
 * passes it.
 */

export type FilingRevision = 'original' | 'amended' | 'cancelled'

export type FilingRowStatus =
  | 'unfiled' | 'unchanged' | 'changed' | 'absent' | 'withdrawn' | 'resurrected'

export interface FilingFieldChange {
  code: string | null
  label: string
  previous: string | null
  current: string | null
  redacted: boolean
}

export interface FilingRowReview {
  rowId: string
  label: string
  status: FilingRowStatus
  lastRevision: FilingRevision | null
  lastIssuedAt: string | null
  changes: FilingFieldChange[]
}

export interface FilingSubmissionSummary {
  id: string
  revision: FilingRevision
  revisionNumber: number
  supersedesId: string | null
  issuedAt: string
  note: string | null
  slipCount: number
  artifact: { filename: string; contentType: string; bytes: number } | null
  slips: { rowId: string; label: string; revision: FilingRevision }[]
}

export interface FilingLifecycle {
  country: string
  filingKey: string
  label: string
  taxYear: number
  amendment:
  | { supported: false; refusal: string }
  | {
    supported: true
    revisions: FilingRevision[]
    vehicle: 'same_form' | 'correction_form'
    formLabel: string | null
    download: { label: string; note: string | null } | null
    downloadRefusal: string | null
    hasSlip: boolean
  }
  submissions: FilingSubmissionSummary[]
  rows: FilingRowReview[]
  populationRefusal: string | null
}

/**
 * Message keys land in web/messages/**, which this slice does not own — see
 * .local/handoff-amendments.md for the paste-ready block. Until it is pasted
 * these fall back to the English sentence rather than rendering a raw key
 * path, which is the pattern the projects cockpit already uses.
 */
export function useFilingText() {
  const t = useTranslations('payroll.filings')
  return useCallback(
    (key: string, english: string) => (t.has(key as never) ? t(key as never) : english),
    [t],
  )
}

const STATUS_TEXT: Record<FilingRowStatus, { english: string; variant: 'default' | 'secondary' | 'outline' | 'warning' | 'destructive' | 'success' }> = {
  unfiled: { english: 'Not filed', variant: 'outline' },
  unchanged: { english: 'Filed', variant: 'success' },
  changed: { english: 'Changed since filing', variant: 'warning' },
  absent: { english: 'No longer in the ledger', variant: 'destructive' },
  withdrawn: { english: 'Cancelled', variant: 'secondary' },
  resurrected: { english: 'Cancelled but still in the ledger', variant: 'destructive' },
}

export function FilingStatusBadge({ status }: { status: FilingRowStatus }) {
  const text = useFilingText()
  const meta = STATUS_TEXT[status]
  return <Badge variant={meta.variant}>{text(`lifecycle.status.${status}`, meta.english)}</Badge>
}

/** Fetches and caches one filing-year's lifecycle. */
export function useFilingLifecycle(section: YearEndFilingSection | null, year: number, enabled: boolean) {
  const [state, setState] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string }
    | { status: 'ready'; lifecycle: FilingLifecycle }
  >({ status: 'idle' })
  const [nonce, setNonce] = useState(0)
  const country = section?.country ?? ''
  const key = section?.key ?? ''

  useEffect(() => {
    if (!enabled || !country || !key) {
      setState({ status: 'idle' })
      return
    }
    let alive = true
    setState({ status: 'loading' })
    void fetch(
      `/api/payroll/year-end/amendments?country=${encodeURIComponent(country)}`
      + `&filing=${encodeURIComponent(key)}&year=${year}`,
    )
      .then(async (res) => {
        const body = (await res.json()) as FilingLifecycle & { error?: string }
        if (!alive) return
        if (!res.ok) {
          setState({ status: 'error', message: body.error ?? res.statusText })
          return
        }
        setState({ status: 'ready', lifecycle: body })
      })
      .catch((e: Error) => {
        if (alive) setState({ status: 'error', message: e.message })
      })
    return () => {
      alive = false
    }
  }, [country, key, year, enabled, nonce])

  const reviewByRow = useMemo(() => {
    if (state.status !== 'ready') return new Map<string, FilingRowReview>()
    return new Map(state.lifecycle.rows.map((row) => [row.rowId, row]))
  }, [state])

  return { state, reviewByRow, refresh: () => setNonce((n) => n + 1) }
}

/**
 * The filing-year's lifecycle bar: what has been issued, and the one explicit
 * act that starts the trail.
 *
 * Recording an issue is deliberately explicit and separate from downloading
 * the file. Downloading is not transmitting, and a history that started itself
 * the first time somebody previewed an XML would be full of filings that never
 * happened.
 */
export function FilingLifecycleBar({
  section,
  year,
  lifecycle,
  busy,
  error,
  onRecordOriginal,
}: {
  section: YearEndFilingSection
  year: number
  lifecycle: FilingLifecycle | null
  busy: boolean
  error: string | null
  onRecordOriginal: (note: string) => void
}) {
  const text = useFilingText()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [note, setNote] = useState('')
  const issued = lifecycle?.submissions.length ?? 0
  const latest = lifecycle?.submissions[issued - 1] ?? null
  const changed = lifecycle?.rows.filter((row) => row.status === 'changed').length ?? 0
  const absent = lifecycle?.rows.filter((row) => row.status === 'absent').length ?? 0
  const resurrected = lifecycle?.rows.filter((row) => row.status === 'resurrected').length ?? 0

  const help = (
    <>
      <p>
        {text(
          'lifecycle.help',
          'An issued filing is evidence of what was declared to the agency, so it is never '
          + 'overwritten: a correction is a new artifact that supersedes it, and the original '
          + 'file stays downloadable. Amounts are always recomputed from committed pay stubs — '
          + 'correct the payroll data, then amend.',
        )}
      </p>
      {lifecycle && !lifecycle.amendment.supported && (
        <p className="mt-2">{lifecycle.amendment.refusal}</p>
      )}
    </>
  )

  return (
    <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel
          help={help}
          fieldName={text('lifecycle.title', 'Filing status')}
          className="text-sm font-semibold text-slate-900 dark:text-slate-100"
        >
          {text('lifecycle.title', 'Filing status')}
        </FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          {issued === 0 && section.data.rows.length > 0 && (
            <>
              <Input
                aria-label={text('lifecycle.note', 'Filing note')}
                placeholder={text('lifecycle.notePlaceholder', 'How it was filed (optional)')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-64"
                maxLength={500}
              />
              <Button variant="outline" disabled={busy} onClick={() => onRecordOriginal(note)}>
                {text('lifecycle.recordOriginal', 'Record as filed')}
              </Button>
            </>
          )}
          {issued > 0 && (
            <Button variant="ghost" onClick={() => setHistoryOpen(true)}>
              <History size={14} aria-hidden />
              {text('lifecycle.history', 'Filing history')}
            </Button>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
        {issued === 0 ? (
          <span>{text('lifecycle.notIssued', 'Not recorded as filed yet.')}</span>
        ) : (
          <>
            <span>
              {text('lifecycle.issuedCount', 'Artifacts issued')}:{' '}
              <span className="font-medium text-slate-800 dark:text-slate-200">{issued}</span>
            </span>
            {latest && (
              <span className="flex items-center gap-1">
                {text('lifecycle.latest', 'Latest')}:
                <Badge variant="outline">
                  #{latest.revisionNumber} · {latest.revision}
                </Badge>
                <span>{new Date(latest.issuedAt).toLocaleDateString()}</span>
              </span>
            )}
            {changed > 0 && (
              <Badge variant="warning">
                {text('lifecycle.changedCount', 'Changed since filing')}: {changed}
              </Badge>
            )}
            {absent > 0 && (
              <Badge variant="destructive">
                {text('lifecycle.absentCount', 'No longer in the ledger')}: {absent}
              </Badge>
            )}
            {resurrected > 0 && (
              <Badge variant="destructive">
                {text('lifecycle.resurrectedCount', 'Cancelled but still in the ledger')}: {resurrected}
              </Badge>
            )}
          </>
        )}
      </div>

      {error && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* The pack's own refusal, verbatim, shown only once anything has been
          filed — before that there is nothing to correct and the sentence is
          noise. */}
      {issued > 0 && lifecycle && !lifecycle.amendment.supported && (
        <Alert variant="info" className="mt-3">
          <AlertDescription>{lifecycle.amendment.refusal}</AlertDescription>
        </Alert>
      )}

      {historyOpen && lifecycle && (
        <FilingHistoryDrawer
          lifecycle={lifecycle}
          label={section.label}
          year={year}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  )
}

/** Everything issued for this filing-year, newest first, with its evidence. */
function FilingHistoryDrawer({
  lifecycle,
  label,
  year,
  onClose,
}: {
  lifecycle: FilingLifecycle
  label: string
  year: number
  onClose: () => void
}) {
  const text = useFilingText()
  const tCommon = useTranslations('common')
  const ordered = [...lifecycle.submissions].reverse()
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={text('lifecycle.history', 'Filing history')}
      description={`${label} · ${year}`}
      footer={
        <div className="flex w-full justify-end">
          <Button variant="ghost" onClick={onClose}>{tCommon('actions.close')}</Button>
        </div>
      }
    >
      {ordered.length === 0 ? (
        <EmptyState title={text('lifecycle.notIssued', 'Not recorded as filed yet.')} />
      ) : (
        <ol className="space-y-3">
          {ordered.map((submission) => (
            <li
              key={submission.id}
              className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={submission.revision === 'original' ? 'secondary' : 'warning'}>
                    #{submission.revisionNumber} · {submission.revision}
                  </Badge>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {new Date(submission.issuedAt).toLocaleString()}
                  </span>
                </div>
                {submission.artifact ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={`/api/payroll/year-end/amendments/artifact?id=${submission.id}`}>
                      <FileDown size={13} aria-hidden />
                      {submission.artifact.filename}
                    </a>
                  </Button>
                ) : (
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {text('lifecycle.noArtifact', 'No electronic file — the slip snapshot below is the record.')}
                  </span>
                )}
              </div>
              {submission.note && (
                <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{submission.note}</p>
              )}
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {text('lifecycle.slipsCovered', 'Slips covered')}: {submission.slipCount}
                {submission.supersedesId
                  ? ` · ${text('lifecycle.supersedes', 'supersedes')} #${
                    lifecycle.submissions.find((s) => s.id === submission.supersedesId)?.revisionNumber ?? '—'
                  }`
                  : ''}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {submission.slips.slice(0, 24).map((slip) => (
                  <Badge key={slip.rowId} variant="outline">{slip.label}</Badge>
                ))}
                {submission.slips.length > 24 && (
                  <Badge variant="outline">+{submission.slips.length - 24}</Badge>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  )
}

const NUMERIC = /^-?\d+(\.\d+)?$/

/**
 * The delta, and the two acts it enables — for ONE row, inside its slip
 * flyout.
 *
 * The delta is the deliverable: which boxes moved, as filed beside now, in
 * the agency's own box numbers. That is what the operator signs off and what
 * the agency's review asks about, and it is also literally what the IRS's
 * correction forms print in two columns.
 */
export function FilingCorrectionSection(props: {
  section: YearEndFilingSection
  year: number
  review: FilingRowReview
  lifecycle: FilingLifecycle
  onIssued: () => void
}) {
  const { review } = props
  // A changed row or revision is a new evidence context. Remounting the
  // stateful body clears its preview, reason, and error together before the
  // next paint, without synchronously setting state from an effect.
  return <FilingCorrectionSectionBody key={`${review.rowId}:${review.lastRevision ?? 'none'}`} {...props} />
}

function FilingCorrectionSectionBody({
  section,
  year,
  review,
  lifecycle,
  onIssued,
}: {
  section: YearEndFilingSection
  year: number
  review: FilingRowReview
  lifecycle: FilingLifecycle
  onIssued: () => void
}) {
  const text = useFilingText()
  const { money } = useMoney()
  const [busy, setBusy] = useState<FilingRevision | null>(null)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string }
    | {
      status: 'ready'
      slip: PayrollFilingSlipData
      orgName: string
      revision: 'amended' | 'cancelled'
      rowId: string
    }
  >({ status: 'idle' })
  const [cancellationReason, setCancellationReason] = useState('')
  const previewRequest = useRef(0)

  const amendment = lifecycle.amendment
  const show = (value: string | null) =>
    value == null ? '—' : NUMERIC.test(value) ? money(value) : value

  const correctionHref = (revision: 'amended' | 'cancelled', format: 'json' | 'pdf') =>
    `/api/payroll/year-end/amendments/slip?country=${encodeURIComponent(section.country)}`
    + `&filing=${encodeURIComponent(section.key)}&year=${year}`
    + `&row=${encodeURIComponent(review.rowId)}&revision=${revision}`
    + (format === 'pdf' ? '&format=pdf' : '')

  async function loadPreview(revision: 'amended' | 'cancelled') {
    const request = ++previewRequest.current
    const rowId = review.rowId
    setPreview({ status: 'loading' })
    // Starting a new revision review invalidates any explanation typed for a
    // previous cancellation preview.
    setCancellationReason('')
    try {
      const res = await fetch(correctionHref(revision, 'json'))
      const body = (await res.json()) as { slip?: PayrollFilingSlipData; orgName?: string; error?: string }
      if (!res.ok || !body.slip) throw new Error(body.error ?? res.statusText)
      if (request !== previewRequest.current) return
      setPreview({
        status: 'ready',
        slip: body.slip,
        orgName: body.orgName ?? '',
        revision,
        rowId,
      })
    } catch (e) {
      if (request !== previewRequest.current) return
      setPreview({ status: 'error', message: (e as Error).message })
    }
  }

  async function issue(revision: 'amended' | 'cancelled') {
    setError('')

    const reason = cancellationReason.trim()
    if (revision === 'cancelled') {
      const cancellationPreviewLoaded = preview.status === 'ready'
        && preview.revision === 'cancelled'
        && preview.rowId === review.rowId
      if (!cancellationPreviewLoaded) {
        setError(text(
          'lifecycle.cancelPreviewRequired',
          'Load the cancellation preview for this slip before cancelling it.',
        ))
        return
      }
      if (!reason) {
        setError(text(
          'lifecycle.cancelReasonRequired',
          'A cancellation reason is required.',
        ))
        return
      }
      const confirmed = await confirmDialog({
        title: text('lifecycle.cancelConfirmTitle', 'Confirm cancellation'),
        message: text(
          'lifecycle.cancelConfirmMessage',
          'This is an irreversible filing-history act. The reviewed slip will be reported as cancelled. Continue?',
        ),
        confirmLabel: text('lifecycle.confirmCancellation', 'Confirm cancellation'),
        tone: 'danger',
      })
      if (!confirmed) return
    }

    setBusy(revision)
    try {
      const payload: Record<string, unknown> = {
        country: section.country,
        filing: section.key,
        year,
        revision,
        rowIds: [review.rowId],
      }
      if (revision === 'cancelled') {
        payload.confirmedCancellation = true
        payload.reason = reason
      }
      const res = await fetch('/api/payroll/year-end/amendments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const responseBody = (await res.json()) as { error?: string; fileRefusal?: string | null }
      if (!res.ok) throw new Error(responseBody.error ?? res.statusText)
      if (responseBody.fileRefusal) setError(responseBody.fileRefusal)
      setPreview({ status: 'idle' })
      if (revision === 'cancelled') setCancellationReason('')
      onIssued()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const facsimileHtml = useMemo(() => {
    if (preview.status !== 'ready') return ''
    const { result, layout } = payrollSlipFacsimile(preview.slip, year)
    return renderTaxFormFacsimileBody(result, { orgName: preview.orgName }, layout)
  }, [preview, year])

  const canAmend = amendment.supported
    && amendment.revisions.includes('amended')
    && review.status === 'changed'
  const canCancel = amendment.supported
    && amendment.revisions.includes('cancelled')
    && (review.status === 'absent' || review.status === 'changed' || review.status === 'unchanged')
  const cancellationPreviewLoaded = preview.status === 'ready'
    && preview.revision === 'cancelled'
    && preview.rowId === review.rowId

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel
          fieldName={text('lifecycle.correction', 'Correction')}
          className="text-sm font-semibold text-slate-900 dark:text-slate-100"
          help={
            <>
              <p>
                {text(
                  'lifecycle.correctionHelp',
                  'Amending restates a slip that should exist; cancelling declares that the '
                  + 'slip should never have existed. The figures are recomputed from committed '
                  + 'pay stubs — they are never typed over — so correct the payroll data first '
                  + 'and the amendment follows.',
                )}
              </p>
              {amendment.supported && amendment.vehicle === 'correction_form' && amendment.formLabel && (
                <p className="mt-2">
                  {text('lifecycle.correctionForm', 'Correction form')}: {amendment.formLabel}
                </p>
              )}
              {amendment.supported && amendment.download?.note && (
                <p className="mt-2">{amendment.download.note}</p>
              )}
            </>
          }
        >
          {text('lifecycle.correction', 'Correction')}
        </FieldLabel>
        <FilingStatusBadge status={review.status} />
      </div>

      {!amendment.supported ? (
        <Alert variant="info">
          <AlertDescription>{amendment.refusal}</AlertDescription>
        </Alert>
      ) : (
        <>
          {review.status === 'unfiled' && lifecycle.submissions.length === 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {text(
                'lifecycle.unfiledHelp',
                'This slip has not been recorded as filed, so there is nothing to correct.',
              )}
            </p>
          )}
          {review.status === 'unfiled' && lifecycle.submissions.length > 0 && (
            // A slip that appeared AFTER the return went out is an additional
            // original, not a correction — a real gap, named rather than
            // offered as an amendment that would misdescribe it.
            <Alert variant="info">
              <AlertDescription>
                {text(
                  'lifecycle.addedHelp',
                  'This slip appeared after the return was filed. A slip discovered later is '
                  + 'filed as an additional original, not as a correction, and that is not '
                  + 'produced here — file it through the agency’s own service.',
                )}
              </AlertDescription>
            </Alert>
          )}

          {review.status === 'resurrected' && (
            <Alert variant="warning">
              <AlertDescription>
                {text(
                  'lifecycle.resurrectedHelp',
                  'This slip was cancelled, but the payroll ledger still produces it. Void or '
                  + 'adjust the underlying run, or the next return will file it again.',
                )}
              </AlertDescription>
            </Alert>
          )}

          {review.status === 'absent' && (
            <Alert variant="warning">
              <AlertDescription>
                {text(
                  'lifecycle.absentHelp',
                  'The payroll ledger no longer produces this slip, so there is nothing to '
                  + 'restate. Cancel it so the agency stops holding it.',
                )}
              </AlertDescription>
            </Alert>
          )}

          {review.changes.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] tracking-wide text-slate-400 uppercase dark:text-slate-500">
                    <th className="py-1 pr-3 font-medium">{text('lifecycle.box', 'Box')}</th>
                    <th className="py-1 pr-3 font-medium">{text('lifecycle.field', 'Field')}</th>
                    <th className="py-1 pr-3 text-right font-medium">{text('lifecycle.asFiled', 'As filed')}</th>
                    <th className="py-1 text-right font-medium">{text('lifecycle.now', 'Now')}</th>
                  </tr>
                </thead>
                <tbody>
                  {review.changes.map((change) => (
                    <tr
                      key={`${change.code ?? ''}:${change.label}`}
                      className="border-t border-slate-100 dark:border-slate-800"
                    >
                      <td className="py-1 pr-3 font-medium tabular-nums">{change.code ?? '—'}</td>
                      <td className="py-1 pr-3">{change.label}</td>
                      {change.redacted ? (
                        <td className="py-1 text-right text-amber-700 dark:text-amber-400" colSpan={2}>
                          {text('lifecycle.redacted', 'Changed — value not displayed')}
                        </td>
                      ) : (
                        <>
                          <td className="py-1 pr-3 text-right tabular-nums text-slate-500 line-through dark:text-slate-400">
                            {show(change.previous)}
                          </td>
                          <td className="py-1 text-right font-semibold tabular-nums">
                            {show(change.current)}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {canAmend && (
              <>
                <Button size="sm" variant="outline" onClick={() => void loadPreview('amended')}>
                  {text('lifecycle.previewAmended', 'Preview correction')}
                </Button>
                <Button size="sm" disabled={busy != null} onClick={() => void issue('amended')}>
                  {text('lifecycle.issueAmended', 'Issue amendment')}
                </Button>
              </>
            )}
            {canCancel && (
              <>
                <Button size="sm" variant="outline" onClick={() => void loadPreview('cancelled')}>
                  {text('lifecycle.previewCancelled', 'Preview cancellation')}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy != null || !cancellationPreviewLoaded || !cancellationReason.trim()}
                  onClick={() => void issue('cancelled')}
                >
                  {text('lifecycle.issueCancelled', 'Cancel this slip')}
                </Button>
              </>
            )}
            {amendment.downloadRefusal && (canAmend || canCancel) && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {amendment.downloadRefusal}
              </span>
            )}
          </div>

          {canCancel && (
            <div className="space-y-1.5">
              <FieldLabel
                htmlFor={`cancellation-reason-${review.rowId}`}
                help={text(
                  'lifecycle.cancelReasonHelp',
                  'Explain why this issued slip should never have existed. The reason is retained in the filing history.',
                )}
              >
                {text('lifecycle.cancelReason', 'Cancellation reason')}
              </FieldLabel>
              <Textarea
                id={`cancellation-reason-${review.rowId}`}
                rows={3}
                value={cancellationReason}
                onChange={(event) => setCancellationReason(event.target.value)}
                placeholder={text(
                  'lifecycle.cancelReasonPlaceholder',
                  'Why should this slip be cancelled?',
                )}
                maxLength={500}
              />
            </div>
          )}

          {preview.status === 'loading' && <Skeleton className="h-40 w-full" />}
          {preview.status === 'error' && (
            <Alert variant="warning">
              <AlertDescription>{preview.message}</AlertDescription>
            </Alert>
          )}
          {preview.status === 'ready' && (
            <div className="space-y-2">
              <div className="flex justify-end">
                <Button asChild size="sm" variant="ghost">
                  <a href={correctionHref(preview.revision, 'pdf')} target="_blank" rel="noreferrer">
                    <FileDown size={13} aria-hidden />
                    {text('slip.downloadPdf', 'Download PDF')}
                  </a>
                </Button>
              </div>
              <div
                className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700"
                // The shared pure facsimile renderer with escaping — the same
                // body the Chromium PDF prints.
                dangerouslySetInnerHTML={{ __html: facsimileHtml }}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
