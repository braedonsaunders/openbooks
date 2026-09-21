'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Input, Label, Select } from '@openbooks/ui'
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
  title: string
  projectLabel: string
  weekLabel: string
  formatLabel: string
  generateLabel: string
  cancelLabel: string
  closeHref: string
}) {
  const router = useRouter()
  const params = useSearchParams()
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
        toast.error(await readApiErrorMessage(res, generateLabel))
        return
      }
      close()
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>{projectLabel}</Label>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((project) => (
                <option key={project.value} value={project.value}>
                  {project.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{weekLabel}</Label>
            <Input type="date" value={weekEnding} onChange={(event) => setWeekEnding(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{formatLabel}</Label>
            <Select value={formatKey} onChange={(e) => setFormatKey(e.target.value)}>
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
      </div>
    </div>
  )
}
