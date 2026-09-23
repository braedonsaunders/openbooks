'use client'

// Per-row decision controls for the approvals worklist. Flow gates decide
// through POST /api/flows/gates/decide|delegate. Reject collects a reason via
// the shared promptDialog; Delegate shows an inline user picker for the row's
// direct assignee or an admin.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button, Select } from '@openbooks/ui'
import { promptDialog } from '../../../lib/prompt'

export type DelegateOption = {
  id: string
  name: string
};

export function GateActions({
  gateId,
  canDelegate,
  users,
  signatureRequired,
}: {
  gateId: string
  /** Current assignee or admin — shows the delegate picker. */
  canDelegate: boolean
  users: DelegateOption[]
  /** Gate demands a typed e-signature to approve. */
  signatureRequired?: boolean
}) {
  const t = useTranslations('approvals')
  const tc = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const [delegating, setDelegating] = useState(false)
  // A refused decision pins to the row until the next action — a toast
  // alone vanishes, and a refresh would wipe the explanation away.
  const [refusal, setRefusal] = useState<string | null>(null)
  const router = useRouter()

  async function decide(decision: 'approved' | 'rejected') {
    let comment: string | undefined
    let signature: string | undefined
    if (decision === 'rejected') {
      const reason = await promptDialog({
        title: t('gates.rejectTitle'),
        label: t('decide.rejectionReason'),
        confirmLabel: tc('actions.reject'),
      })
      if (!reason) return
      comment = reason
    } else if (signatureRequired) {
      const signed = await promptDialog({
        title: t('gates.signTitle'),
        label: t('gates.signLabel'),
        confirmLabel: tc('actions.approve'),
      })
      if (!signed?.trim()) return
      signature = signed.trim()
    }
    setBusy(true)
    setRefusal(null)
    const res = await fetch('/api/flows/gates/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateId, decision, comment, signature }),
    })
    // Error bodies are checked before they are parsed: a refusal is a
    // message for the operator, never a parse error.
    if (!res.ok) {
      const data = await res.json().catch(() => ({} as { error?: unknown }))
      const message = typeof data.error === 'string' && data.error
        ? data.error
        : t('decide.decisionFailed')
      // Pin the refusal beside the row's actions and do NOT refresh: the
      // decision was not recorded and the approval is still pending, so
      // the explanation must stay where the next attempt happens. It is
      // never turned into an approval — only the ok branch toasts one.
      setRefusal(message)
      toast.error(message)
    } else {
      const data = await res.json().catch(() => ({} as { resumed?: unknown }))
      if (data.resumed === null) {
        toast.success(t('gates.waitingOthers'))
      } else {
        toast.success(decision === 'approved' ? tc('status.approved') : tc('status.rejected'))
      }
      router.refresh()
    }
    setBusy(false)
  }

  async function delegate(toUserId: string) {
    if (!toUserId) return
    setBusy(true)
    setRefusal(null)
    const res = await fetch('/api/flows/gates/delegate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateId, toUserId }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({} as { error?: unknown }))
      const message = typeof data.error === 'string' && data.error
        ? data.error
        : t('decide.decisionFailed')
      setRefusal(message)
      toast.error(message)
    } else {
      toast.success(t('gates.delegated'))
      router.refresh()
    }
    setBusy(false)
    setDelegating(false)
  }

  return (
    <span className="inline-flex flex-col items-start gap-2">
      <span className="inline-flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => decide('approved')}>
          {tc('actions.approve')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('rejected')}>
          {tc('actions.reject')}
        </Button>
        {canDelegate && users.length > 0 ? (
          delegating ? (
            <span className="inline-flex items-center gap-1">
              <span className="w-44">
                <Select disabled={busy} defaultValue="" onChange={(e) => delegate(e.target.value)}>
                  <option value="">{t('gates.delegatePlaceholder')}</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDelegating(false)}>
                {tc('actions.cancel')}
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDelegating(true)}>
              {t('gates.delegate')}
            </Button>
          )
        ) : null}
      </span>
      {refusal ? (
        <span role="alert" className="max-w-md rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {refusal}
        </span>
      ) : null}
    </span>
  )
}
