'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Button } from '@openbooks/ui'
import { useAppAction } from '@/lib/use-app-action'

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
}

/**
 * Approve or reject one pending reopen request through the native close
 * command. The Approve control mirrors the engine's decision before the
 * click: a conflict the engine will refuse disables Approve with the
 * reason, and a sole eligible approver deciding their own request gets the
 * attestation form (required reason plus checkbox) instead of a refusal.
 * The engine re-resolves eligibility inside the decision transaction, so a
 * refusal that still lands surfaces pinned with its reason.
 */
export function ReopenDecision({ requestId, ownRequest }: { requestId: string; ownRequest: boolean }) {
  const t = useTranslations('accounting.reopenRequests')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const [preview, setPreview] = useState<DecisionPreview | null>(null)
  const [attestation, setAttestation] = useState('')
  const [attested, setAttested] = useState(false)
  useEffect(() => {
    let live = true
    void fetchAction('/api/admin/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reopen-conflicts', requestId }),
    }).then((result) => {
      if (!live || !result.ok) return
      const data = result.data as Partial<DecisionPreview> | null
      if (!data || !Array.isArray(data.conflicts)) return
      setPreview({
        conflicts: data.conflicts,
        ownRequest: data.ownRequest === true,
        independenceRequired: data.independenceRequired === true,
        selfApprovalAllowed: data.selfApprovalAllowed === true,
      })
    })
    return () => {
      live = false
    }
  }, [requestId])
  const isOwn = preview?.ownRequest ?? ownRequest
  const conflicts = preview?.conflicts ?? []
  const conflictTotal = conflicts.reduce((sum, item) => sum + item.count, 0)
  const conflictExamples = conflicts.flatMap((item) => item.examples).slice(0, 3).join(', ')
  const approveBlocked = !isOwn && conflictTotal > 0 && (preview?.independenceRequired ?? false)
  const selfApproval = isOwn && (preview?.selfApprovalAllowed ?? false)
  const attestationReady = attested && attestation.trim().length >= 10
  const decide = (approve: boolean) =>
    execute(
      () =>
        fetchAction('/api/admin/close', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'decide-reopen',
            requestId,
            approve,
            ...(approve && selfApproval ? { attestation: attestation.trim() } : {}),
          }),
        }),
      {
        fallbackMessage: t('decideFailed'),
        successMessage: approve ? t('approved') : t('rejected'),
        onOk: () => router.refresh(),
      },
    )
  if (isOwn && !selfApproval)
    return <span className="text-xs text-slate-500 dark:text-slate-400">{t('ownRequest')}</span>
  if (selfApproval)
    return (
      <div className="flex max-w-xs flex-col items-end gap-2">
        <p role="note" className="text-xs text-slate-600 dark:text-slate-300">{t('selfApprovalNotice')}</p>
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
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>{t('reject')}</Button>
          <Button size="sm" disabled={busy || !attestationReady} title={attestationReady ? undefined : t('selfAttestationNeeded')} onClick={() => void decide(true)}>{t('approve')}</Button>
        </div>
        <ActionAlert error={refusal} fallbackMessage={t('decideFailed')} />
      </div>
    )
  return (
    <div className="flex flex-col items-end gap-1">
      {approveBlocked ? (
        <p role="note" className="max-w-xs text-xs text-amber-800 dark:text-amber-200">
          {t('conflictNotice', { count: conflictTotal, examples: conflictExamples })}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>{t('reject')}</Button>
        <Button
          size="sm"
          disabled={busy || approveBlocked}
          title={approveBlocked ? t('conflictNotice', { count: conflictTotal, examples: conflictExamples }) : undefined}
          onClick={() => void decide(true)}
        >{t('approve')}</Button>
      </div>
      <ActionAlert error={refusal} fallbackMessage={t('decideFailed')} />
    </div>
  )
}
