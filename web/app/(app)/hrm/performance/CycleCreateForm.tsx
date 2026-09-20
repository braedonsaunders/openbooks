'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * The cycle create form inside the cycle dialog. Fields are the house form
 * primitives, the request goes through POST /api/hrm/review-cycles, and
 * refusals render as the error, never swallowed. On success the URL moves
 * to the new cycle's own drawer.
 */
export interface CycleCreateProps {
  closeHref: string
  templates: { value: string; label: string }[]
  templateLabel: string
  nameLabel: string
  startLabel: string
  endLabel: string
  submitLabel: string
  cancelLabel: string
  setupHint: string
  setupHref: string
  failed: string
}

export function CycleCreateForm(props: CycleCreateProps) {
  const { closeHref } = props
  const router = useRouter()
  const [templateId, setTemplateId] = useState(props.templates[0]?.value ?? '')
  const [name, setName] = useState('')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/hrm/review-cycles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          templateId,
          name: name.trim(),
          periodStartOn: periodStart,
          periodEndOn: periodEnd,
        }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, props.failed))
        setBusy(false)
        return
      }
      const payload = (await res.json().catch(() => ({}))) as { cycle?: { id?: unknown } }
      const id = typeof payload.cycle?.id === 'string' ? payload.cycle.id : null
      if (id === null) {
        setError(props.failed)
        setBusy(false)
        return
      }
      router.push(`/hrm/performance?cycle=${id}`)
      router.refresh()
    } catch {
      setError(props.failed)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="cycle-template">{props.templateLabel}</Label>
        <Select
          id="cycle-template"
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          required
        >
          {props.templates.map((tpl) => (
            <option key={tpl.value} value={tpl.value}>
              {tpl.label}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          <a className="underline" href={props.setupHref}>
            {props.setupHint}
          </a>
        </p>
      </div>
      <div>
        <Label htmlFor="cycle-name">{props.nameLabel}</Label>
        <Input id="cycle-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="cycle-start">{props.startLabel}</Label>
        <Input id="cycle-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="cycle-end">{props.endLabel}</Label>
        <Input id="cycle-end" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {props.submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push(closeHref)}>
          {props.cancelLabel}
        </Button>
      </div>
    </form>
  )
}
