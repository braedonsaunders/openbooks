'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select, Textarea, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { confirmDialog } from '../../../../lib/confirm'

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
  /**
   * Set when the caller may see no legal entity: the form names the remedy
   * instead of offering an unauthorized employer. Null in the normal case.
   */
  employerRefusal: string | null
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
  /** Dirty/busy reports for the drawer shell's close guard (server shells
   *  cannot hold the state, so the client form reports it upward). */
  onGuardChange?: (guard: { dirty: boolean; busy: boolean }) => void
}

/**
 * The create form inside the position drawer. Every field is one of the
 * house form primitives, every string arrives loader-resolved, and the
 * request goes through the same POST /api/hrm/positions the API clients
 * use — with its refusals rendered as the error, never swallowed. On
 * success the URL moves to the new position's own drawer.
 */
export function PositionCreateForm({ basePath, effectiveDate, employers, employerRefusal, departments, statuses, labels, onGuardChange }: PositionCreateProps) {
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

  // A half-filled create draft is unsaved work. The URL drawer lives in the
  // server shell, so dirtiness is reported up for its close guard.
  const dirty =
    code !== '' ||
    title !== '' ||
    employer !== (employers[0]?.value ?? '') ||
    department !== '' ||
    plannedFte !== '1.0000' ||
    status !== (statuses[0]?.value ?? 'planned') ||
    effectiveFrom !== effectiveDate ||
    reason !== ''
  useEffect(() => {
    onGuardChange?.({ dirty, busy })
  }, [dirty, busy, onGuardChange])

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
      <div className="space-y-1.5">
        <Label htmlFor="position-employer">{labels.employer}</Label>
        {employerRefusal ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {employerRefusal}
          </p>
        ) : employers.length === 1 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{employers[0]?.label}</p>
        ) : (
          <Select id="position-employer" value={employer} disabled={busy} onChange={(event) => setEmployer(event.target.value)}>
            {employers.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        )}
      </div>
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
        <Button type="submit" disabled={busy || employerRefusal !== null}>
          {busy ? tCommon('actions.saving') : labels.submit}
        </Button>
      </div>
    </form>
  )
}

/**
 * Client shell for the `?position=new` URL drawer. The server sections
 * cannot hold form state, so this shell owns the close guard and the form
 * reports its dirtiness upward — closing with a half-filled draft asks
 * first, and an in-flight create cannot be dismissed.
 */
export function PositionCreateDrawer({
  closeHref,
  title,
  description,
  create,
}: {
  closeHref: string
  title: string
  description: string | null
  create: PositionCreateProps
}) {
  const tCommon = useTranslations('common')
  const [guard, setGuard] = useState({ dirty: false, busy: false })
  const onGuardChange = useCallback((next: { dirty: boolean; busy: boolean }) => setGuard(next), [])

  async function confirmDiscard() {
    if (guard.busy) return false
    if (!guard.dirty) return true
    return confirmDialog({
      message: tCommon('feedback.unsavedChanges'),
      confirmLabel: tCommon('confirm.discardChanges'),
      tone: 'danger',
    })
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      title={title}
      description={description ?? undefined}
      beforeClose={confirmDiscard}
    >
      <PositionCreateForm {...create} onGuardChange={onGuardChange} />
    </UrlDrawer>
  )
}
