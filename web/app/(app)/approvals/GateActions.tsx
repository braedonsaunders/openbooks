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
    const res = await fetch('/api/flows/gates/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateId, decision, comment, signature }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.error ?? t('decide.decisionFailed'))
    } else if (data.resumed === null) {
      toast.success(t('gates.waitingOthers'))
    } else {
      toast.success(decision === 'approved' ? tc('status.approved') : tc('status.rejected'))
    }
    setBusy(false)
    router.refresh()
  }

  async function delegate(toUserId: string) {
    if (!toUserId) return
    setBusy(true)
    const res = await fetch('/api/flows/gates/delegate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateId, toUserId }),
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
  )
}
