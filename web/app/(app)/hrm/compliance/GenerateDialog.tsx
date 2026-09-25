'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Input, Label, Select, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * Certified-payroll generate dialog, opened from the page header through
 * the `generate` search param; closing navigates the param away. The
 * project, week-ending and pack-declared format ride one POST to the
 * generate route; refusals (no posted run, undeclared format, empty
 * week) surface with their message intact.
 */
export function GenerateDialog({
  projects,
  formats,
  formatsEmpty,
  emptyMessage,
  title,
  projectLabel,
  weekLabel,
  formatLabel,
  generateLabel,
  cancelLabel,
  closeHref,
}: {
  projects: Array<{ value: string; label: string }>
  formats: Array<{ value: string; label: string }>
  formatsEmpty: boolean
  emptyMessage: string
  title: string
  projectLabel: string
  weekLabel: string
  formatLabel: string
  generateLabel: string
  cancelLabel: string
  closeHref: string
}) {
  const t = useTranslations('hrm.compliance')
  const router = useRouter()
  const params = useSearchParams()
  const fieldId = useId()
  const [projectId, setProjectId] = useState(projects[0]?.value ?? '')
  const [weekEnding, setWeekEnding] = useState('')
  const [formatKey, setFormatKey] = useState(formats[0]?.value ?? '')
  const [busy, setBusy] = useState(false)
  if (params.get('generate') !== '1') return null

  function close() {
    router.push(closeHref)
  }

  async function generate() {
    if (!projectId || !weekEnding || !formatKey) return
    setBusy(true)
    try {
      const res = await fetch('/api/hrm/compliance/certified-payroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, weekEnding, formatKey }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('actionFailed')))
        return
      }
      close()
      router.refresh()
    } catch {
      // Offline or another transport failure rejects instead of
      // resolving: without the catch the finally releases busy silently
      // and the operator never learns the report was not generated.
      toast.error(t('actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <UrlDrawer open closeHref={closeHref} title={title} size="md">
        <div className="flex flex-col gap-4">
          {formatsEmpty && <p role="status" className="text-sm text-muted-foreground">{emptyMessage}</p>}
          <div className="flex flex-col gap-1.5">
            <Label id={`${fieldId}-project-label`}>{projectLabel}</Label>
            <Select id={`${fieldId}-project`} aria-labelledby={`${fieldId}-project-label`} aria-label={projectLabel} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((project) => (
                <option key={project.value} value={project.value}>
                  {project.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label id={`${fieldId}-week-label`} htmlFor={`${fieldId}-week`}>{weekLabel}</Label>
            <Input id={`${fieldId}-week`} aria-labelledby={`${fieldId}-week-label`} aria-label={weekLabel} type="date" value={weekEnding} onChange={(event) => setWeekEnding(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label id={`${fieldId}-format-label`}>{formatLabel}</Label>
            <Select id={`${fieldId}-format`} aria-labelledby={`${fieldId}-format-label`} aria-label={formatLabel} value={formatKey} onChange={(e) => setFormatKey(e.target.value)}>
              {formats.map((format) => (
                <option key={format.value} value={format.value}>
                  {format.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={close} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button onClick={generate} disabled={busy || !projectId || !weekEnding || !formatKey}>
            {generateLabel}
          </Button>
        </div>
    </UrlDrawer>
  )
}
