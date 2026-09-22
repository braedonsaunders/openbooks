'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import Link from 'next/link'
import { Button, Drawer, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

export interface ProcessCreateData {
  closeHref: string
  effectiveDate: string
  templatesHref: string
}

/** New checklist drawer. The template is explicit and is loaded only after
 * the employee, kind and effective date establish which active templates
 * actually cover this checklist. */
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
  const templateRequest = useRef(0)
  const [kind, setKind] = useState<'onboarding' | 'offboarding' | 'transfer'>('onboarding')
  const [effectiveDate, setEffectiveDate] = useState(create?.effectiveDate ?? '')
  const [templateId, setTemplateId] = useState('')
  const [templateOptions, setTemplateOptions] = useState<{ value: string; label: string }[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templateStatus, setTemplateStatus] = useState<string | undefined>()
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

  useEffect(() => {
    setTemplateId('')
    if (!create || !employmentId || !effectiveDate) {
      setTemplateOptions([])
      setTemplateStatus(undefined)
      setTemplatesLoading(false)
      return
    }
    const requestId = (templateRequest.current += 1)
    const params = new URLSearchParams({
      active: 'true',
      employment: employmentId,
      effectiveDate,
      kind,
    })
    setTemplatesLoading(true)
    fetch(`/api/hrm/process-templates?${params.toString()}`, { method: 'GET' })
      .then(async (response) => {
        if (requestId !== templateRequest.current) return
        if (!response.ok) {
          setTemplateStatus(await readApiErrorMessage(response, t('processes.templates.loadFailed')))
          setTemplateOptions([])
          setTemplatesLoading(false)
          return
        }
        const payload = (await response.json()) as {
          templates?: { id?: unknown; name?: unknown; stepCount?: unknown }[]
        }
        if (requestId !== templateRequest.current) return
        const ready = (payload.templates ?? []).flatMap((template) =>
          typeof template.id === 'string' && typeof template.name === 'string' && Number(template.stepCount) > 0
            ? [{ value: template.id, label: template.name }]
            : [],
        )
        setTemplateOptions(ready)
        setTemplateStatus(ready.length === 0 ? t('processes.templates.noneEligible') : undefined)
        setTemplatesLoading(false)
      })
      .catch(() => {
        if (requestId !== templateRequest.current) return
        setTemplateOptions([])
        setTemplateStatus(t('processes.templates.loadFailed'))
        setTemplatesLoading(false)
      })
  }, [create, effectiveDate, employmentId, kind, t])

  if (!create) return null

  function close() {
    router.push(create!.closeHref as never)
    router.refresh()
  }

  async function save() {
    if (!employmentId || !effectiveDate || !templateId) return
    setSaving(true)
    const response = await fetch('/api/hrm/processes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employmentId, kind, effectiveDate, templateId }),
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
    <Drawer open onClose={close} title={t('processes.newChecklist')} size="md">
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
        <div>
          <Label htmlFor="process-template">{t('processes.templates.template')}</Label>
          <SearchSelect
            id="process-template"
            value={templateId}
            onChange={setTemplateId}
            options={templateOptions}
            ariaLabel={t('processes.templates.template')}
            sheetTitle={t('processes.templates.template')}
            emptyLabel="—"
            loading={templatesLoading}
            statusMessage={templateStatus}
            statusTone={templateStatus ? 'muted' : undefined}
          />
          {templateStatus ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {templateStatus}{' '}
              <Link href={create.templatesHref} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                {t('processes.templates.createTemplate')}
              </Link>
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>
            {tc('actions.cancel')}
          </Button>
          <Button disabled={saving || !employmentId || !effectiveDate || !templateId} onClick={save}>
            {saving ? tc('actions.creating') : tc('actions.create')}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
