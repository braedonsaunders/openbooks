'use client'

// Per-row decision controls for the unified approvals worklist. One component
// serves both engines: flow gates (POST /api/flows/gates/decide|delegate) and
// legacy policy steps (POST /api/approvals/decide). Reject collects a reason
// via the shared promptDialog; Delegate (flow rows only — the legacy engine
// has no delegation) shows an inline user picker for the row's direct
// assignee or an admin.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button, Select } from '@openbooks/ui'
import { promptDialog } from '../../../lib/prompt'

export interface DelegateOption {
  id: string
  name: string
}

/** Which engine's endpoint a row's decision goes to. */
export type ApprovalTarget =
  | { source: 'flow'; gateId: string }
  | { source: 'legacy'; requestId: string; stepNumber: number }

export function GateActions({
  target,
  canDelegate,
  users,
}: {
  target: ApprovalTarget
  /** Current assignee or admin — shows the delegate picker (flow rows only). */
  canDelegate: boolean
  users: DelegateOption[]
}) {
  const t = useTranslations('approvals')
  const tc = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const [delegating, setDelegating] = useState(false)
  const router = useRouter()

  async function decide(decision: 'approved' | 'rejected') {
    let comment: string | undefined
    if (decision === 'rejected') {
      const reason = await promptDialog({
        title: t('gates.rejectTitle'),
        label: t('decide.rejectionReason'),
        confirmLabel: tc('actions.reject'),
      })
      if (!reason) return
      comment = reason
    }
    setBusy(true)
    const res =
      target.source === 'flow'
        ? await fetch('/api/flows/gates/decide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gateId: target.gateId, decision, comment }),
          })
        : await fetch('/api/approvals/decide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestId: target.requestId,
              stepNumber: target.stepNumber,
              decision,
              note: comment,
            }),
          })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.error ?? t('decide.decisionFailed'))
    } else if (target.source === 'flow' && data.resumed === null) {
      toast.success(t('gates.waitingOthers'))
    } else {
      toast.success(decision === 'approved' ? tc('status.approved') : tc('status.rejected'))
    }
    setBusy(false)
    router.refresh()
  }

  async function delegate(toUserId: string) {
    if (!toUserId || target.source !== 'flow') return
    setBusy(true)
    const res = await fetch('/api/flows/gates/delegate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateId: target.gateId, toUserId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) toast.error(data.error ?? t('decide.decisionFailed'))
    else toast.success(t('gates.delegated'))
    setBusy(false)
    setDelegating(false)
    router.refresh()
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => decide('approved')}>
        {tc('actions.approve')}
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('rejected')}>
        {tc('actions.reject')}
      </Button>
      {target.source === 'flow' && canDelegate && users.length > 0 ? (
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
  )
}
