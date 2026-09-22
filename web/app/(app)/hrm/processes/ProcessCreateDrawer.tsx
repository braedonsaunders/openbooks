'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

export interface ProcessCreateData {
  closeHref: string
  effectiveDate: string
}

/** New checklist drawer. Template selection remains canonical and automatic:
 * the service resolves the most-specific active template for the employment,
 * kind and effective date, and returns its precise refusal when setup is
 * ambiguous or missing. */
export function ProcessCreateDrawer({ create }: { create: ProcessCreateData | null }) {
  const t = useTranslations('hrm')
  const tc = useTranslations('common')
  const router = useRouter()
  const [employmentId, setEmploymentId] = useState('')
  const [employmentOptions, setEmploymentOptions] = useState<{ value: string; label: string }[]>([])
  const [query, setQuery] = useState('')
  const [loadingOptions, setLoadingOptions] = useState(true)
  const [optionStatus, setOptionStatus] = useState<string | undefined>()
  const optionRequest = useRef(0)
  const [kind, setKind] = useState<'onboarding' | 'offboarding' | 'transfer'>('onboarding')
  const [effectiveDate, setEffectiveDate] = useState(create?.effectiveDate ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!create) return
    const requestId = (optionRequest.current += 1)
    const params = new URLSearchParams({ source: 'employments', limit: '25' })
    if (query.trim()) params.set('q', query.trim())
    if (employmentId) params.set('include', employmentId)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (response) => {
        if (requestId !== optionRequest.current) return
        if (!response.ok) {
          setOptionStatus(await readApiErrorMessage(response, t('processes.actionFailed')))
          setLoadingOptions(false)
          return
        }
        const payload = (await response.json().catch(() => ({}))) as {
          options?: { employmentId?: unknown; label?: unknown }[]
        }
        if (requestId !== optionRequest.current) return
        setEmploymentOptions(
          (Array.isArray(payload.options) ? payload.options : []).flatMap((option) =>
            typeof option.employmentId === 'string' && typeof option.label === 'string'
              ? [{ value: option.employmentId, label: option.label }]
              : [],
          ),
        )
        setOptionStatus(undefined)
        setLoadingOptions(false)
      })
      .catch(() => {
        if (requestId !== optionRequest.current) return
        setOptionStatus(t('processes.actionFailed'))
        setLoadingOptions(false)
      })
  }, [create, employmentId, query, t])

  if (!create) return null

  function close() {
    router.push(create!.closeHref as never)
    router.refresh()
  }

  async function save() {
    if (!employmentId || !effectiveDate) return
    setSaving(true)
    const response = await fetch('/api/hrm/processes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employmentId, kind, effectiveDate }),
    })
    setSaving(false)
    if (!response.ok) {
      toast.error(await readApiErrorMessage(response, t('processes.actionFailed')))
      return
    }
    const payload = (await response.json()) as { process?: { id?: string } }
    if (!payload.process?.id) {
      toast.error(t('processes.actionFailed'))
      return
    }
    router.push(`/hrm/processes?segment=open&process=${payload.process.id}` as never)
    router.refresh()
  }

  return (
    <Drawer open onClose={close} title={t('processes.newProcess')} size="md">
      <div className="flex flex-col gap-4 p-4">
        <div>
          <Label htmlFor="process-employment">{t('processes.columns.employee')}</Label>
          <SearchSelect
            id="process-employment"
            value={employmentId}
            onChange={setEmploymentId}
            options={employmentOptions}
            ariaLabel={t('processes.columns.employee')}
            sheetTitle={t('processes.columns.employee')}
            emptyLabel="—"
            remote
            loading={loadingOptions}
            statusMessage={optionStatus}
            statusTone={optionStatus ? 'error' : 'muted'}
            onSearchChange={(next) => {
              setQuery(next)
              setLoadingOptions(true)
              setOptionStatus(undefined)
            }}
          />
          {optionStatus ? (
            <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
              {optionStatus}
            </p>
          ) : null}
        </div>
        <div>
          <Label htmlFor="process-kind">{t('processes.columns.kind')}</Label>
          <Select id="process-kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="onboarding">{t('processes.kinds.onboarding')}</option>
            <option value="offboarding">{t('processes.kinds.offboarding')}</option>
            <option value="transfer">{t('processes.kinds.transfer')}</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="process-effective">{t('processes.columns.effective')}</Label>
          <Input id="process-effective" type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>
            {tc('actions.cancel')}
          </Button>
          <Button disabled={saving || !employmentId || !effectiveDate} onClick={save}>
            {saving ? tc('actions.creating') : tc('actions.create')}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
