'use client'

// Contextual approval controls for the record flyout (source platform-parity):
// when a document is pending_approval, the viewer sees green Approve + Reject
// buttons if the record-state API says they can decide the flow gate, or a
// subtle "Pending with {names}" chip when they cannot. Reject always collects a
// reason through the shared promptDialog. A 409 (someone else decided first)
// toasts and refreshes instead of erroring.
//
// The record-state fetch is shared with <ApprovalHistory> via
// useRecordApprovalState below: every mounted hook refetches when
// refreshApprovalState() fires after a decision.

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { TriangleAlert, Users } from 'lucide-react'
import { readApiErrorMessage } from '../lib/api-error'
import { promptDialog } from '../lib/prompt'
import type { RecordApprovalState } from '../app/api/flows/record-state/route'

export type { RecordApprovalState }

// --- shared record-state store ----------------------------------------------

const listeners = new Set<() => void>()

/** Re-fetch every mounted useRecordApprovalState hook (post-decision). */
export function refreshApprovalState() {
  for (const l of listeners) l()
}

export interface RecordApprovalLoad {
  /** Last good record state; null while loading or when no load ever succeeded. */
  state: RecordApprovalState | null
  /**
   * Named load failure (F1-11). Set when the fetch fails AND whenever a
   * refresh fails — but a refresh failure keeps the last good state, so
   * live controls never vanish under the operator. Cleared on success.
   */
  loadError: string | null
  /** Re-run the load (the named remedy for loadError). */
  reload: () => void
}

export function useRecordApprovalState(
  subjectKind: string,
  subjectId: string,
): RecordApprovalLoad {
  const t = useTranslations('common')
  const [state, setState] = useState<RecordApprovalState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(
          `/api/flows/record-state?subjectKind=${encodeURIComponent(subjectKind)}&subjectId=${encodeURIComponent(subjectId)}`,
        )
        // Check the status BEFORE parsing (F1-11): the old shape mapped
        // every refusal to null and swallowed the catch, so state stayed
        // null and the approval UI vanished silently. A non-JSON error
        // body surfaces the translated fallback with its status, never a
        // SyntaxError; a JSON refusal surfaces the server's named message.
        if (!res.ok) {
          if (!cancelled) setLoadError(await readApiErrorMessage(res, t('feedback.loadFailed')))
          return
        }
        const data = (await res.json().catch(() => null)) as RecordApprovalState | null
        if (!cancelled) {
          if (data) {
            setState(data)
            setLoadError(null)
          } else {
            setLoadError(t('feedback.loadFailed'))
          }
        }
      } catch {
        if (!cancelled) setLoadError(t('feedback.loadFailed'))
      }
    }
    load()
    listeners.add(load)
    return () => {
      cancelled = true
      listeners.delete(load)
    }
  }, [subjectKind, subjectId, t])

  const reload = useCallback(() => {
    setLoadError(null)
    refreshApprovalState()
  }, [])

  return { state, loadError, reload }
}

// --- header controls ----------------------------------------------------------

export function ApprovalActions({
  subjectKind,
  subjectId,
  submitApprovalHref,
}: {
  subjectKind: string
  subjectId: string
  /**
   * POST endpoint that submits a never-submitted record into its current
   * flow (F-t04-004 residual: pre-flow bank details). Passed only by
   * surfaces that own such a path — the row stays quiet without it.
   */
  submitApprovalHref?: string
}) {
  const t = useTranslations('common')
  const router = useRouter()
  const { state, loadError, reload } = useRecordApprovalState(subjectKind, subjectId)
  const [busy, setBusy] = useState(false)

  const decide = useCallback(
    async (decision: 'approved' | 'rejected') => {
      const my = state?.approvalState.myActions
      if (!my) return
      let comment: string | undefined
      let signature: string | undefined
      if (decision === 'rejected') {
        const reason = await promptDialog({
          title: t('approvalFlow.rejectTitle'),
          label: t('approvalFlow.rejectReasonLabel'),
          confirmLabel: t('actions.reject'),
        })
        if (!reason) return
        comment = reason
      } else if (my.signatureRequired) {
        const signed = await promptDialog({
          title: t('approvalFlow.signTitle'),
          label: t('approvalFlow.signLabel'),
          confirmLabel: t('actions.approve'),
        })
        if (!signed?.trim()) return
        signature = signed.trim()
      }
      if (!my.gateId) return
      setBusy(true)
      const res = await fetch('/api/flows/gates/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateId: my.gateId, decision, comment, signature }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409) {
        toast.info(t('approvalFlow.alreadyDecided'))
      } else if (!res.ok) {
        toast.error(data.error ?? t('approvalFlow.decisionFailed'))
      } else if (data.resumed === null) {
        toast.success(t('approvalFlow.waitingOthers'))
      } else {
        toast.success(decision === 'approved' ? t('status.approved') : t('status.rejected'))
      }
      setBusy(false)
      refreshApprovalState()
      router.refresh()
    },
    [state, router, t],
  )

  const retryRun = useCallback(async () => {
    const run = state?.failedRun
    if (!run) return
    setBusy(true)
    try {
      const res = await fetch(`/api/flows/runs/${run.id}/retry`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(
          typeof data.error === 'string' && data.error ? data.error : t('approvalFlow.retryFailed'),
        )
      } else {
        toast.success(t('approvalFlow.retried'))
      }
    } catch {
      toast.error(t('approvalFlow.retryFailed'))
    } finally {
      setBusy(false)
    }
    refreshApprovalState()
    router.refresh()
  }, [state, router, t])

  const submitForApproval = useCallback(async () => {
    if (!submitApprovalHref) return
    setBusy(true)
    try {
      const res = await fetch(submitApprovalHref, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      // Check the status before parsing: the refusal rides in the body, and
      // parsing an error body first turns refusals into parse errors.
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(
          typeof data.error === 'string' && data.error ? data.error : t('approvalFlow.submitFailed'),
        )
      } else {
        toast.success(t('approvalFlow.submitted'))
      }
    } catch {
      toast.error(t('approvalFlow.submitFailed'))
    } finally {
      setBusy(false)
    }
    refreshApprovalState()
    router.refresh()
  }, [submitApprovalHref, router, t])

  const showRetry = !!state?.failedRun && !!state?.canRetry
  // A record the engine never saw (no run, hence no live gate and no failed
  // run) with a status still claiming it awaits approval: offer the surface's
  // submit path. neverSubmitted already implies the gate/run absences; the
  // status check keeps the button off records that are not awaiting anything.
  const showSubmit =
    !!submitApprovalHref &&
    !!state?.neverSubmitted &&
    state.approvalState.status === 'pending' &&
    !state.approvalState.myActions &&
    state.approvalState.pendingWith.length === 0 &&
    !state.failedRun
  // A failed record-state load with nothing to show (F1-11): name the
  // failure and offer the remedy inline instead of vanishing. A refresh
  // failure over last-good state keeps the live controls above.
  if (!state && loadError) {
    return (
      <span className="inline-flex max-w-72 items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate" title={loadError}>
          {loadError}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            reload()
            setBusy(false)
          }}
          className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
        >
          {t('actions.retry')}
        </button>
      </span>
    )
  }
  if (
    !state ||
    (!state.approvalState.myActions && state.approvalState.pendingWith.length === 0 && !showRetry && !showSubmit)
  ) return null

  // A failed run strands the record with no live gate (F-t04-004): offer a
  // retry that re-drives the stored trigger through the current graph. It
  // renders beside a stale pending chip when one lingers, never instead of
  // live Approve/Reject buttons.
  const retryButton = showRetry ? (
    <Button
      variant="outline"
      disabled={busy}
      onClick={retryRun}
      title={state?.failedRun?.error ?? undefined}
    >
      {t('approvalFlow.retryRun')}
    </Button>
  ) : null

  if (state.approvalState.myActions) {
    return (
      <>
        <Button
          disabled={busy}
          onClick={() => decide('approved')}
          className="bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800"
        >
          {t('actions.approve')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => decide('rejected')}>
          {t('actions.reject')}
        </Button>
      </>
    )
  }

  if (state.approvalState.pendingWith.length > 0) {
    const names = state.approvalState.pendingWith.map((p) => p.name).join(', ')
    return (
      <>
        <span
          className="inline-flex max-w-64 items-center gap-1.5 truncate rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
          title={t('approvalFlow.pendingWith', { names })}
        >
          <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{t('approvalFlow.pendingWith', { names })}</span>
        </span>
        {retryButton}
      </>
    )
  }

  // No live gate and no failed run here (see showSubmit above): the only
  // remaining button is the never-submitted submit, if this surface owns one.
  return (
    <>
      {retryButton}
      {showSubmit ? (
        <Button variant="outline" disabled={busy} onClick={submitForApproval}>
          {t('approvalFlow.submitRun')}
        </Button>
      ) : null}
    </>
  )
}
