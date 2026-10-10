'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { readApiErrorMessage } from '../../../lib/api-error'
import { confirmDialog } from '@/lib/confirm'
import type { FieldTicketDrawerProps } from './FieldTicketDrawer'

const PERIODS = ['shift', 'daily', 'weekly'] as const
type Period = (typeof PERIODS)[number]

export interface FieldTicketCreateDrawerProps {
  createMode: true
  /** Active projects in the caller's legal-entity scope, with each one's effective ticket period. */
  projects: FieldTicketDrawerProps['projects']
  /** The organization's business date, the ticket's default anchor date. */
  today: string
}

/**
 * Unsaved New-ticket drawer. Opening it writes nothing: the project, period
 * and date live only in this drawer until Save, which POSTs the collection
 * once under a per-session Idempotency-Key (a retried Save returns the same
 * ticket) and opens the persisted ticket's editor. Closing or cancelling
 * writes nothing, so an abandoned create leaves no numbered draft behind.
 */
export function FieldTicketCreateDrawer({ projects, today }: FieldTicketCreateDrawerProps) {
  const t = useTranslations('fieldTickets')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const fieldId = useId()
  const [requestId] = useState(() => crypto.randomUUID())
  const [projectId, setProjectId] = useState('')
  const [period, setPeriod] = useState<Period | ''>('')
  const [date, setDate] = useState(today)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = projectId !== '' || period !== '' || date !== today

  function chooseProject(next: string) {
    setProjectId(next)
    setError(null)
    // The project's effective policy proposes the period; the operator may
    // still choose another before saving.
    const policyPeriod = projects.find((project) => project.id === next)?.period
    setPeriod(PERIODS.includes(policyPeriod as Period) ? (policyPeriod as Period) : '')
  }

  async function confirmLeave(): Promise<boolean> {
    if (busy) return false
    if (!dirty) return true
    return confirmDialog({
      message: tCommon('feedback.unsavedChanges'),
      confirmLabel: tCommon('confirm.discardChanges'),
      tone: 'danger',
    })
  }

  async function cancel() {
    if (!(await confirmLeave())) return
    router.push('/field-tickets')
  }

  async function save() {
    if (busy) return
    if (!projectId) {
      setError(t('list.projectRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/field-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
        body: JSON.stringify({ projectId, date, ...(period ? { period } : {}) }),
      })
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t('list.createFailed')))
        return
      }
      const created = (await response.json().catch(() => null)) as { id?: unknown } | null
      if (typeof created?.id !== 'string') {
        setError(t('list.createFailed'))
        return
      }
      // Replace the unsaved-create URL so Back never reopens a create that
      // has already been saved.
      router.replace(`/field-tickets?ticket=${encodeURIComponent(created.id)}&mode=edit`)
      router.refresh()
    } catch {
      setError(t('list.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TransactionDrawer
      closeHref="/field-tickets"
      beforeClose={confirmLeave}
      recordId="new"
      showEvidenceTabs={false}
      title={t('list.createTitle')}
      description={t('list.createHint')}
      primaryAction={
        <>
          <Button size="sm" className="h-8 px-2.5 text-xs" disabled={busy} onClick={() => void save()}>
            {busy ? tCommon('actions.saving') : tCommon('actions.save')}
          </Button>
          <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" disabled={busy} onClick={() => void cancel()}>
            {tCommon('actions.cancel')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label id={`${fieldId}-project-label`}>
            {tCommon('labels.project')}
            <span className="text-red-500"> *</span>
          </Label>
          <SearchSelect
            id={`${fieldId}-project`}
            ariaLabelledBy={`${fieldId}-project-label`}
            options={projects.map((project) => ({
              value: project.id,
              label: project.customerName ? `${project.name} · ${project.customerName}` : project.name,
            }))}
            value={projectId}
            onChange={(value) => chooseProject(value ?? '')}
            placeholder={t('list.pickProject')}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-period`}>{t('list.period')}</Label>
          <Select
            id={`${fieldId}-period`}
            value={period}
            onChange={(event) => setPeriod(event.target.value as Period | '')}
          >
            <option value="">{t('list.periodPolicy')}</option>
            {PERIODS.map((value) => (
              <option key={value} value={value}>{t(`period.${value}`)}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-date`}>{tCommon('labels.date')}</Label>
          <Input id={`${fieldId}-date`} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600 sm:col-span-2 dark:text-red-400">{error}</p>
        ) : null}
      </div>
    </TransactionDrawer>
  )
}
