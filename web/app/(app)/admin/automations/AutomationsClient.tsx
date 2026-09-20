'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { toast } from 'sonner'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * Client islands for the automations list: the New-automation dialog (name
 * + trigger kind, creating a draft recipe and landing on its builder) and
 * per-row enable/disable/run-now controls. Every refusal renders with its
 * message intact — res.ok is checked before any body is parsed.
 */

const TRIGGER_KINDS = ['schedule', 'date_relative', 'field_change', 'event', 'document', 'manual'] as const

function defaultTrigger(kind: string): Record<string, unknown> {
  switch (kind) {
    case 'schedule':
      return { kind, cron: '0 9 * * MON', timezone: 'UTC' }
    case 'date_relative':
      return { kind, entity: 'employment', dateField: 'service_start', offsetDays: 3, direction: 'before', atTime: '09:00' }
    case 'field_change':
      return { kind, entity: 'employment', field: 'status' }
    case 'event':
      return { kind, subjectKind: 'hrm_employment_change_request', eventKind: 'approved' }
    case 'document':
      return { kind, event: 'signed' }
    default:
      return { kind: 'manual' }
  }
}

export function NewAutomationButton({ label }: { label: string }) {
  const t = useTranslations('admin.automations')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<string>('schedule')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    if (!name.trim()) {
      setError(t('list.nameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/automations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          trigger: defaultTrigger(kind),
          rules: {},
          conditions: {},
          actions: [{ kind: 'send_notification', to: 'manager', body: '' }],
        }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t('list.createFailed')))
        return
      }
      const payload = (await res.json().catch(() => ({}))) as { automation?: { id?: string } }
      const id = payload.automation?.id
      setOpen(false)
      if (typeof id === 'string') router.push(`/admin/automations/${id}` as never)
      else router.refresh()
    } catch {
      setError(t('list.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{label}</Button>
      <Drawer open={open} onClose={() => setOpen(false)} title={t('list.newTitle')} footer={<><Button variant="outline" onClick={() => setOpen(false)}>{t('list.cancel')}</Button><Button disabled={busy} onClick={create}>{t('list.create')}</Button></>}>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="automation-name">{t('list.nameLabel')}</Label>
            <Input id="automation-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('list.namePlaceholder')} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="automation-trigger">{t('list.triggerLabel')}</Label>
            <Select id="automation-trigger" value={kind} onChange={(e) => setKind(e.target.value)}>
              {TRIGGER_KINDS.map((k) => (
                <option key={k} value={k}>{t(`triggerKinds.${k}`)}</option>
              ))}
            </Select>
          </div>
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        </div>
      </Drawer>
    </>
  )
}

export function AutomationRowActions({
  id,
  status,
  runLabel,
  enableLabel,
  disableLabel,
  actionFailed,
}: {
  id: string
  status: string
  runLabel: string
  enableLabel: string
  disableLabel: string
  actionFailed: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function call(url: string, body?: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch(url, {
        method: 'POST',
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      if (!res.ok) toast.error(await readApiErrorMessage(res, actionFailed))
      router.refresh()
    } catch {
      toast.error(actionFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {status === 'enabled' ? (
        <Button variant="outline" disabled={busy} onClick={() => call(`/api/automations/${id}/status`, { status: 'disabled' })}>
          {disableLabel}
        </Button>
      ) : (
        <Button variant="outline" disabled={busy} onClick={() => call(`/api/automations/${id}/status`, { status: 'enabled' })}>
          {enableLabel}
        </Button>
      )}
      <Button variant="outline" disabled={busy || status !== 'enabled'} onClick={() => call(`/api/automations/${id}/run`, {})}>
        {runLabel}
      </Button>
    </span>
  )
}
