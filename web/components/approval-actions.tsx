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
import { Users } from 'lucide-react'
import { promptDialog } from '../lib/prompt'
import type { RecordApprovalState } from '../app/api/flows/record-state/route'

export type { RecordApprovalState }

// --- shared record-state store ----------------------------------------------

const listeners = new Set<() => void>()

/** Re-fetch every mounted useRecordApprovalState hook (post-decision). */
export function refreshApprovalState() {
  for (const l of listeners) l()
}

export function useRecordApprovalState(
  subjectKind: string,
  subjectId: string,
): RecordApprovalState | null {
  const [state, setState] = useState<RecordApprovalState | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch(
        `/api/flows/record-state?subjectKind=${encodeURIComponent(subjectKind)}&subjectId=${encodeURIComponent(subjectId)}`,
      )
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data) setState(data as RecordApprovalState)
        })
        .catch(() => {})
    }
    load()
    listeners.add(load)
    return () => {
      cancelled = true
      listeners.delete(load)
    }
  }, [subjectKind, subjectId])

  return state
}

// --- header controls ----------------------------------------------------------

export function ApprovalActions({
  subjectKind,
  subjectId,
}: {
  subjectKind: string
  subjectId: string
}) {
  const t = useTranslations('common')
  const router = useRouter()
  const state = useRecordApprovalState(subjectKind, subjectId)
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

  if (
    !state ||
    (!state.approvalState.myActions && state.approvalState.pendingWith.length === 0)
  ) return null

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
      <span
        className="inline-flex max-w-64 items-center gap-1.5 truncate rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
        title={t('approvalFlow.pendingWith', { names })}
      >
        <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t('approvalFlow.pendingWith', { names })}</span>
      </span>
    )
  }

  return null
}
