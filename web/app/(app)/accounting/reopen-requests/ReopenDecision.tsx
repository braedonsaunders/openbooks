'use client'

import { useIdentityState } from '@/lib/use-identity-state'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ActionError, fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Button } from '@openbooks/ui'
import { useAppAction } from '@/lib/use-app-action'
import { promptDialog } from '@/lib/prompt'

interface ConflictPreview {
  kind: string
  count: number
  examples: string[]
}

interface DecisionPreview {
  conflicts: ConflictPreview[]
  ownRequest: boolean
  independenceRequired: boolean
  selfApprovalAllowed: boolean
  eligibleApprovers: string[]
  unconflictedApprovers: string[]
  conflictAcknowledgementAllowed: boolean
}

function decisionPreview(value: unknown): DecisionPreview | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  const names = (items: unknown): items is string[] =>
    Array.isArray(items) && items.every((item) => typeof item === 'string')
  if (!Array.isArray(data.conflicts) || !data.conflicts.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false
    const conflict = item as Record<string, unknown>
    return typeof conflict.kind === 'string'
      && Number.isSafeInteger(conflict.count) && Number(conflict.count) >= 0
      && names(conflict.examples)
  }) || !['ownRequest', 'independenceRequired', 'selfApprovalAllowed', 'conflictAcknowledgementAllowed']
    .every((key) => typeof data[key] === 'boolean')
    || !names(data.eligibleApprovers) || !names(data.unconflictedApprovers)) return null
  return data as unknown as DecisionPreview
}

/**
 * Approve or reject one pending reopen request through the native close
 * command. The Approve control mirrors the engine's decision before the
 * click: a conflict the engine will refuse disables Approve with the
 * reason, and a sole eligible approver deciding their own request gets the
 * attestation form (required reason plus checkbox) instead of a refusal.
 * The engine re-resolves eligibility inside the decision transaction, so a
 * refusal that still lands surfaces pinned with its reason. A rejection
 * records the approver's reason, and the requester withdraws their own
 * request (with its own reason) instead of rejecting it.
 */
export function ReopenDecision({ requestId, ownRequest }: { requestId: string; ownRequest: boolean }) {
  const t = useTranslations('accounting.reopenRequests')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const { execute: previewExecute, busy: previewBusy, refusal: previewRefusal } = useAppAction()
  const [loadedPreview, setPreview] = useState<{ requestId: string; data: DecisionPreview } | null>(null)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const preview = loadedPreview?.requestId === requestId ? loadedPreview.data : null
  const [attestation, setAttestation] = useIdentityState([requestId, previewAttempt], '')
  const [attested, setAttested] = useIdentityState([requestId, previewAttempt], false)
  useEffect(() => {
    let live = true
    void previewExecute<DecisionPreview | null>(async () => {
      const result = await fetchAction('/api/admin/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reopen-conflicts', requestId }),
      })
      if (!live) return { ok: true, status: 204, data: null }
      if (!result.ok) return result
      const data = decisionPreview(result.data)
      return data
        ? { ...result, data }
        : { ok: false, error: new ActionError({ kind: 'refused', serverMessage: t('previewFailed') }) }
    }, {
      fallbackMessage: t('previewFailed'),
      onOk: (data) => { if (live && data) setPreview({ requestId, data }) },
    })
    return () => {
      live = false
    }
  }, [requestId, previewAttempt, previewExecute, t])
  const isOwn = preview?.ownRequest ?? ownRequest
  const conflicts = preview?.conflicts ?? []
  const conflictTotal = conflicts.reduce((sum, item) => sum + item.count, 0)
  const shownExamples = conflicts.flatMap((item) => item.examples).slice(0, 3)
  const conflictExamples = shownExamples.join(', ') + (conflictTotal > shownExamples.length ? ', …' : '')
  // No unconflicted approver exists: the conflicted approver may decide with
  // a recorded acknowledgement instead of leaving the request stuck.
  const conflictAcknowledgement = !isOwn && (preview?.conflictAcknowledgementAllowed ?? false)
  const approveBlocked = !isOwn && conflictTotal > 0 && (preview?.independenceRequired ?? false) && !conflictAcknowledgement
  const selfApproval = isOwn && (preview?.selfApprovalAllowed ?? false)
  const conflictNotice = preview && preview.unconflictedApprovers.length > 0
    ? t('conflictNoticeNamed', { count: conflictTotal, examples: conflictExamples, approvers: preview.unconflictedApprovers.join(', ') })
    : t('conflictNotice', { count: conflictTotal, examples: conflictExamples })
  const attestationReady = attested && attestation.trim().length >= 10
  const decide = (approve: boolean, decisionReason?: string) =>
    execute(
      () =>
        fetchAction('/api/admin/close', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'decide-reopen',
            requestId,
            approve,
            ...(approve && (selfApproval || conflictAcknowledgement) ? { attestation: attestation.trim() } : {}),
            ...(decisionReason !== undefined ? { decisionReason } : {}),
          }),
        }),
      {
        fallbackMessage: t('decideFailed'),
        successMessage: approve ? t('approved') : t('rejected'),
        onOk: () => router.refresh(),
      },
    )
  // A rejection is an approver's recorded decision, so it needs a reason.
  // Cancelling the prompt posts nothing.
  const reject = async () => {
    const reason = await promptDialog({
      title: t('rejectReasonTitle'),
      message: t('reasonHint'),
      label: t('reasonLabel'),
      multiline: true,
      confirmLabel: t('reject'),
    })
    if (reason === null) return
    await decide(false, reason)
  }
  // The requester withdraws their own pending request with a reason. The
  // engine records it as withdrawn, never as rejected.
  const withdraw = async () => {
    const reason = await promptDialog({
      title: t('withdrawReasonTitle'),
      message: t('reasonHint'),
      label: t('reasonLabel'),
      multiline: true,
      confirmLabel: t('withdraw'),
    })
    if (reason === null) return
    await execute(
      () =>
        fetchAction('/api/admin/close', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'withdraw-reopen', requestId, reason }),
        }),
      {
        fallbackMessage: t('withdrawFailed'),
        successMessage: t('withdrawn'),
        onOk: () => router.refresh(),
      },
    )
  }
  const withdrawButton = (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void withdraw()}>{t('withdraw')}</Button>
  )
  if (!preview)
    return (
      <div className="flex max-w-xs flex-col items-end gap-2">
        <p role="status" className="text-xs text-muted-foreground">{previewBusy ? t('previewLoading') : t('previewRequired')}</p>
        <ActionAlert error={previewRefusal} fallbackMessage={t('previewFailed')} />
        <div className="flex justify-end gap-2">
          {ownRequest ? withdrawButton : null}
          <Button size="sm" variant="outline" disabled={previewBusy} onClick={() => setPreviewAttempt((attempt) => attempt + 1)}>{t('previewRetry')}</Button>
        </div>
      </div>
    )
  if (isOwn && !selfApproval)
    return (
      <div className="flex max-w-xs flex-col items-end gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {preview && preview.eligibleApprovers.length > 0
            ? t('ownRequestNamed', { approvers: preview.eligibleApprovers.join(', ') })
            : t('ownRequest')}
        </span>
        <div className="flex justify-end gap-2">{withdrawButton}</div>
        <ActionAlert error={refusal} fallbackMessage={t('withdrawFailed')} />
      </div>
    )
  if (selfApproval || conflictAcknowledgement)
    return (
      <div className="flex max-w-xs flex-col items-end gap-2">
        <p role="note" className="text-xs text-slate-600 dark:text-slate-300">
          {selfApproval ? t('selfApprovalNotice') : t('conflictAcknowledgementNotice', { count: conflictTotal, examples: conflictExamples })}
        </p>
        <textarea
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900"
          rows={2}
          value={attestation}
          onChange={(event) => setAttestation(event.target.value)}
          placeholder={t('selfAttestationLabel')}
          aria-label={t('selfAttestationLabel')}
        />
        <label className="flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300">
          <input type="checkbox" className="mt-0.5" checked={attested} onChange={(event) => setAttested(event.target.checked)} />
          {t('selfAttestationConfirm')}
        </label>
        {!attestationReady ? <p className="text-xs text-slate-600 dark:text-slate-300">{t('selfAttestationNeeded')}</p> : null}
        <div className="flex justify-end gap-2">
          {isOwn
            ? withdrawButton
            : <Button size="sm" variant="outline" disabled={busy} onClick={() => void reject()}>{t('reject')}</Button>}
          <Button size="sm" disabled={busy || !attestationReady} title={attestationReady ? undefined : t('selfAttestationNeeded')} onClick={() => void decide(true)}>{t('approve')}</Button>
        </div>
        <ActionAlert error={refusal} fallbackMessage={t('decideFailed')} />
      </div>
    )
  return (
    <div className="flex flex-col items-end gap-1">
      {conflictTotal === 0 ? (
        <p role="status" className="max-w-xs text-xs text-muted-foreground">
          {t('reviewNoConflicts')}
        </p>
      ) : null}
      {approveBlocked ? (
        <p role="note" className="max-w-xs text-xs text-amber-800 dark:text-amber-200">
          {conflictNotice}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void reject()}>{t('reject')}</Button>
        <Button
          size="sm"
          disabled={busy || approveBlocked}
          title={approveBlocked ? conflictNotice : undefined}
          onClick={() => void decide(true)}
        >{t('approve')}</Button>
      </div>
      <ActionAlert error={refusal} fallbackMessage={t('decideFailed')} />
    </div>
  )
}
