'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import Link from 'next/link'
import { Button, Drawer, Input, Label, SearchSelect } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useDirtyClose } from '../../../../lib/use-dirty-close'

export interface ProcessCreateData {
  closeHref: string
  effectiveDate: string
  templatesHref: string
}

/** Employee and date scope the eligible templates. The chosen template owns
 * the checklist kind; the operator never enters the same classification twice. */
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
  const [effectiveDate, setEffectiveDate] = useState(create?.effectiveDate ?? '')
  const [templateId, setTemplateId] = useState('')
  const [templateOptions, setTemplateOptions] = useState<{ value: string; label: string; kind: 'onboarding' | 'offboarding' | 'transfer' }[]>([])
  const selectedTemplate = templateOptions.find((template) => template.value === templateId)
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templateStatus, setTemplateStatus] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  const dirty = create !== null && (
    employmentId !== '' || effectiveDate !== create.effectiveDate || templateId !== ''
  )
  const discard = useCallback(() => {
    if (!create) return
    router.push(create.closeHref as never)
    router.refresh()
  }, [create, router])
  const { close: guardedClose, beforeClose } = useDirtyClose({
    dirty,
    busy: saving,
    onClose: discard,
    message: tc('feedback.unsavedChanges'),
    confirmLabel: tc('confirm.discardChanges'),
  })

  useEffect(() => {
    if (!create) return
    const requestId = (optionRequest.current += 1)
    const params = new URLSearchParams({ source: 'employments', limit: '25', active: 'true' })
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
        const payload = (await response.json()) as {
          options?: { employmentId?: unknown; label?: unknown }[]
        }
        if (requestId !== optionRequest.current) return
        const options = (Array.isArray(payload.options) ? payload.options : []).flatMap((option) =>
            typeof option.employmentId === 'string' && typeof option.label === 'string'
              ? [{ value: option.employmentId, label: option.label }]
              : [],
          )
        setEmploymentOptions(options)
        setOptionStatus(employmentId && !options.some((option) => option.value === employmentId) ? t('processes.employeeUnavailable') : undefined)
        setLoadingOptions(false)
      })
      .catch(() => {
        if (requestId !== optionRequest.current) return
        setOptionStatus(t('processes.actionFailed'))
        setLoadingOptions(false)
      })
  }, [create, employmentId, query, t])

  useEffect(() => {
    // The whole block runs async so the reset and the gate-off branch below
    // never set state synchronously in the effect body (cascading renders).
    // Staleness is already handled by the requestId fence, not by unmounting.
    const run = async (): Promise<void> => {
      const requestId = (templateRequest.current += 1)
      setTemplateId('')
      setTemplateOptions([])
      if (!create || !employmentId || !effectiveDate) {
        setTemplateOptions([])
        setTemplateStatus(undefined)
        setTemplatesLoading(false)
        return
      }
      const params = new URLSearchParams({
        active: 'true',
        employment: employmentId,
        effectiveDate,
      })
      setTemplatesLoading(true)
      await fetch(`/api/hrm/process-templates?${params.toString()}`, { method: 'GET' })
        .then(async (response) => {
          if (requestId !== templateRequest.current) return
          if (!response.ok) {
            setTemplateStatus(await readApiErrorMessage(response, t('processes.templates.loadFailed')))
            setTemplateOptions([])
            setTemplatesLoading(false)
            return
          }
          const payload = (await response.json()) as {
            templates?: { id?: unknown; name?: unknown; kind?: unknown; stepCount?: unknown }[]
          }
          if (requestId !== templateRequest.current) return
          const ready = (payload.templates ?? []).flatMap((template): { value: string; label: string; kind: 'onboarding' | 'offboarding' | 'transfer' }[] =>
            typeof template.id === 'string' && typeof template.name === 'string' && (template.kind === 'onboarding' || template.kind === 'offboarding' || template.kind === 'transfer') && Number(template.stepCount) > 0
              ? [{ value: template.id, label: `${template.name} · ${t(`processes.kinds.${template.kind}`)}`, kind: template.kind }]
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
    }
    void run()
  }, [create, effectiveDate, employmentId, t])

  if (!create) return null

  const close = () => void guardedClose()

  async function save() {
    if (!employmentId || !employmentOptions.some((option) => option.value === employmentId) || optionStatus || loadingOptions || !effectiveDate || !selectedTemplate || templatesLoading) return
    // A transport failure rejects instead of resolving: without the
    // finally the drawer strands busy (and unclosable through the dirty
    // guard) with no error shown.
    setSaving(true)
    try {
      const response = await fetch('/api/hrm/processes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ employmentId, kind: selectedTemplate.kind, effectiveDate, templateId: selectedTemplate.value }),
      })
      if (!response.ok) {
        toast.error(await readApiErrorMessage(response, t('processes.actionFailed')))
        return
      }
      const payload = (await response.json()) as { process?: { id?: string } }
      if (!payload.process?.id) {
        toast.error(t('processes.actionFailed'))
        return
      }
      const next = new URL(create!.closeHref, window.location.origin)
      next.searchParams.delete('new')
      next.searchParams.set('segment', 'open')
      next.searchParams.set('process', payload.process.id)
      router.push(`${next.pathname}${next.search}` as never)
      router.refresh()
    } catch {
      toast.error(t('processes.actionFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer open onClose={close} title={t('processes.newChecklist')} size="md">
      <div className="flex flex-col gap-4 p-4">
        <div>
          <Label htmlFor="process-employment">{t('processes.columns.employee')}</Label>
          <SearchSelect
            id="process-employment"
            value={employmentId}
            onChange={(value) => { setEmploymentId(value); setLoadingOptions(true); setOptionStatus(undefined) }}
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
            disabled={!employmentId || !effectiveDate || templatesLoading}
            loading={templatesLoading}
            statusMessage={templateStatus}
            statusTone={templateStatus ? 'muted' : undefined}
          />
          {templateStatus ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {templateStatus}{' '}
              <Link href={create.templatesHref} onClick={(event) => {
                event.preventDefault()
                void beforeClose().then((allowed) => { if (allowed) router.push(create.templatesHref as never) })
              }} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                {t('processes.templates.createTemplate')}
              </Link>
            </p>
          ) : null}
        </div>
        {selectedTemplate ? <div>
          <Label htmlFor="process-kind">{t('processes.columns.kind')}</Label>
          <Input id="process-kind" readOnly value={t(`processes.kinds.${selectedTemplate.kind}`)} />
        </div> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>
            {tc('actions.cancel')}
          </Button>
          <Button disabled={saving || loadingOptions || !!optionStatus || templatesLoading || !employmentOptions.some((option) => option.value === employmentId) || !effectiveDate || !selectedTemplate} onClick={save}>
            {saving ? tc('actions.creating') : tc('actions.create')}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
