'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

export interface PositionCreateOption {
  value: string
  label: string
}

export interface PositionCreateProps {
  /** Where a successful create navigates: the list with the new row's drawer open. */
  basePath: string
  effectiveDate: string
  /** Visible employer subsidiaries; one entry renders as a fixed value, never a picker. */
  employers: PositionCreateOption[]
  departments: PositionCreateOption[]
  statuses: PositionCreateOption[]
  labels: {
    code: string
    title: string
    employer: string
    department: string
    noDepartment: string
    plannedFte: string
    status: string
    effectiveFrom: string
    reason: string
    reasonPlaceholder: string
    submit: string
    failed: string
  }
}

/**
 * The create form inside the position drawer. Every field is one of the
 * house form primitives, every string arrives loader-resolved, and the
 * request goes through the same POST /api/hrm/positions the API clients
 * use — with its refusals rendered as the error, never swallowed. On
 * success the URL moves to the new position's own drawer.
 */
export function PositionCreateForm({ basePath, effectiveDate, employers, departments, statuses, labels }: PositionCreateProps) {
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [employer, setEmployer] = useState(employers[0]?.value ?? '')
  const [department, setDepartment] = useState('')
  const [plannedFte, setPlannedFte] = useState('1.0000')
  const [status, setStatus] = useState(statuses[0]?.value ?? 'planned')
  const [effectiveFrom, setEffectiveFrom] = useState(effectiveDate)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/hrm/positions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          positionCode: code.trim(),
          title: title.trim(),
          employerSubsidiaryId: employer,
          departmentId: department || null,
          plannedFte: plannedFte.trim(),
          status,
          effectiveFrom,
          reason: reason.trim(),
        }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, labels.failed))
        setBusy(false)
        return
      }
      const payload = (await res.json().catch(() => ({}))) as { position?: { id?: unknown } }
      const id = typeof payload.position?.id === 'string' ? payload.position.id : null
      if (id === null) {
        setError(labels.failed)
        setBusy(false)
        return
      }
      const params = new URLSearchParams({ effectiveDate, position: id })
      router.push(`${basePath}?${params.toString()}`)
      router.refresh()
    } catch {
      setError(labels.failed)
      setBusy(false)
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="position-code">{labels.code}</Label>
          <Input id="position-code" value={code} required maxLength={255} disabled={busy} onChange={(event) => setCode(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="position-title">{labels.title}</Label>
          <Input id="position-title" value={title} required maxLength={240} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
        </div>
      </div>
      {employers.length > 1 ? (
        <div className="space-y-1.5">
          <Label htmlFor="position-employer">{labels.employer}</Label>
          <Select id="position-employer" value={employer} disabled={busy} onChange={(event) => setEmployer(event.target.value)}>
            {employers.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="position-department">{labels.department}</Label>
          <Select id="position-department" value={department} disabled={busy} onChange={(event) => setDepartment(event.target.value)}>
            <option value="">{labels.noDepartment}</option>
            {departments.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="position-status">{labels.status}</Label>
          <Select id="position-status" value={status} disabled={busy} onChange={(event) => setStatus(event.target.value)}>
            {statuses.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="position-fte">{labels.plannedFte}</Label>
          <Input id="position-fte" inputMode="decimal" pattern="^\d+(\.\d{1,4})?$" value={plannedFte} required disabled={busy} onChange={(event) => setPlannedFte(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="position-effective-from">{labels.effectiveFrom}</Label>
          <Input id="position-effective-from" type="date" value={effectiveFrom} required disabled={busy} onChange={(event) => setEffectiveFrom(event.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="position-reason">{labels.reason}</Label>
        <Textarea id="position-reason" value={reason} required maxLength={2000} rows={3} placeholder={labels.reasonPlaceholder} disabled={busy} onChange={(event) => setReason(event.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? tCommon('actions.saving') : labels.submit}
        </Button>
      </div>
    </form>
  )
}
