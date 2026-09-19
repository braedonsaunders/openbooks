'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Label, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'
import { ChangeRequestDrawer, type DepartmentOption, type EditableChangeRequest } from './ChangeRequestDrawer'

/**
 * Lifecycle actions for one employment change request, following the status
 * rules the service enforces: drafts edit, submit, and withdraw; pending
 * rows withdraw only; approved, rejected, withdrawn, and applied rows are
 * terminal and show no actions. Submit and withdraw carry the required
 * reason the service enforces — a blank reason renders the catalog refusal
 * locally, and the API's own refusal surfaces intact when the server
 * rejects. Approval outcomes stay in native Approvals.
 */

/** Terminal request states: the proposal is frozen and only a new request moves it. */
const TERMINAL = ['approved', 'rejected', 'withdrawn', 'applied'] as const

export type ChangeRequestRow = {
  id: string
  status: string
}

export function ChangeRequestActions({
  request,
  employmentId,
  departmentOptions,
  onChanged,
}: {
  request: ChangeRequestRow
  employmentId: string
  departmentOptions: DepartmentOption[]
  onChanged: () => void
}) {
  const t = useTranslations('hrm')
  const router = useRouter()
  const [editing, setEditing] = useState<EditableChangeRequest | null>(null)
  const [loadingEdit, setLoadingEdit] = useState(false)
  const [lifecycle, setLifecycle] = useState<'submit' | 'withdraw' | null>(null)

  if ((TERMINAL as readonly string[]).includes(request.status)) return null

  async function openEdit() {
    setLoadingEdit(true)
    const res = await fetch(`/api/hrm/change-requests/${request.id}`)
    setLoadingEdit(false)
    if (!res.ok) {
      const message = await readApiErrorMessage(res, t('employment.changeRequests.requestFailed'))
      toast.error(message)
      return
    }
    const data = await res.json().catch(() => ({}))
    const payload = (data as { request?: { payload?: unknown } }).request?.payload
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      const message = t('employment.changeRequests.requestFailed')
      toast.error(message)
      return
    }
    setEditing({ id: request.id, payload: payload as Record<string, unknown> })
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {request.status === 'draft' ? (
        <>
          <Button size="sm" variant="outline" disabled={loadingEdit} onClick={openEdit}>
            {t('employment.changeRequests.editDraft')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setLifecycle('submit')}>
            {t('employment.changeRequests.submitAction')}
          </Button>
        </>
      ) : null}
      {request.status === 'draft' || request.status === 'pending_approval' ? (
        <Button size="sm" variant="outline" onClick={() => setLifecycle('withdraw')}>
          {t('employment.changeRequests.withdrawAction')}
        </Button>
      ) : null}
      {editing ? (
        <ChangeRequestDrawer
          employmentId={employmentId}
          initialRequest={editing}
          departmentOptions={departmentOptions}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            onChanged()
          }}
        />
      ) : null}
      {lifecycle ? (
        <LifecycleReasonDrawer
          requestId={request.id}
          action={lifecycle}
          onClose={() => setLifecycle(null)}
          onDone={() => {
            setLifecycle(null)
            onChanged()
            router.refresh()
          }}
        />
      ) : null}
    </span>
  )
}

function LifecycleReasonDrawer({
  requestId,
  action,
  onClose,
  onDone,
}: {
  requestId: string
  action: 'submit' | 'withdraw'
  onClose: () => void
  onDone: () => void
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function confirm() {
    if (!reason.trim()) {
      setError(t('employment.changeRequests.reasonRequired'))
      return
    }
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/hrm/change-requests/${requestId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() }),
    })
    setBusy(false)
    if (!res.ok) {
      const message = await readApiErrorMessage(res, t('employment.changeRequests.requestFailed'))
      setError(message)
      toast.error(message)
      return
    }
    await res.json().catch(() => ({}))
    toast.success(
      t(action === 'submit' ? 'employment.changeRequests.submittedToast' : 'employment.changeRequests.withdrawnToast'),
    )
    onDone()
  }

  return (
    <Drawer
      open
      onClose={onClose}
      stacked
      size="md"
      title={t(action === 'submit' ? 'employment.changeRequests.submitTitle' : 'employment.changeRequests.withdrawTitle')}
      description={t(
        action === 'submit'
          ? 'employment.changeRequests.submitDescription'
          : 'employment.changeRequests.withdrawDescription',
      )}
      headerActions={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button disabled={busy} onClick={confirm}>
            {t(action === 'submit' ? 'employment.changeRequests.submitConfirm' : 'employment.changeRequests.withdrawConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="cr-lifecycle-reason">{t('employment.changeRequests.reasonLabel')}</Label>
          <Textarea
            id="cr-lifecycle-reason"
            value={reason}
            disabled={busy}
            required
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('employment.changeRequests.reasonPlaceholder')}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    </Drawer>
  )
}
