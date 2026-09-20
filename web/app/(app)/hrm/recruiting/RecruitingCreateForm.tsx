'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

export interface RecruitingCreateOption {
  value: string
  label: string
}

export interface RecruitingCreateProps {
  /** Where a successful create navigates: the list with the new row's drawer open. */
  basePath: string
  /** Visible employer subsidiaries; one entry renders as a fixed value, never a picker. */
  employers: RecruitingCreateOption[]
  departments: RecruitingCreateOption[]
  labels: {
    title: string
    employer: string
    department: string
    noDepartment: string
    headcount: string
    targetStart: string
    submit: string
    failed: string
  }
}

/**
 * The create form inside the recruiting drawer. Every field is one of the
 * house form primitives, every string arrives loader-resolved, and the
 * request goes through the same POST /api/hrm/recruiting/requisitions the
 * API clients use — with its refusals rendered as the error, never
 * swallowed. On success the URL moves to the new requisition's own drawer.
 */
export function RecruitingCreateForm({ basePath, employers, departments, labels }: RecruitingCreateProps) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [employer, setEmployer] = useState(employers[0]?.value ?? '')
  const [department, setDepartment] = useState('')
  const [headcount, setHeadcount] = useState('1')
  const [targetStart, setTargetStart] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/hrm/recruiting/requisitions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          employerSubsidiaryId: employer,
          departmentId: department || null,
          headcount: Number.parseInt(headcount, 10),
          targetStartOn: targetStart || null,
        }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, labels.failed))
        setBusy(false)
        return
      }
      const payload = (await res.json().catch(() => ({}))) as { requisition?: { id?: unknown } }
      const id = typeof payload.requisition?.id === 'string' ? payload.requisition.id : null
      if (id === null) {
        setError(labels.failed)
        setBusy(false)
        return
      }
      router.push(`${basePath}?requisition=${id}`)
      router.refresh()
    } catch {
      setError(labels.failed)
      setBusy(false)
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <Label htmlFor="recruiting-title">{labels.title}</Label>
        <Input id="recruiting-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
      </div>
      <div>
        <Label htmlFor="recruiting-employer">{labels.employer}</Label>
        {employers.length === 1 ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{employers[0]?.label || employers[0]?.value}</p>
        ) : (
          <Select id="recruiting-employer" value={employer} onChange={(event) => setEmployer(event.target.value)}>
            {employers.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div>
        <Label htmlFor="recruiting-department">{labels.department}</Label>
        <Select id="recruiting-department" value={department} onChange={(event) => setDepartment(event.target.value)}>
          <option value="">{labels.noDepartment}</option>
          {departments.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="recruiting-headcount">{labels.headcount}</Label>
        <Input
          id="recruiting-headcount"
          inputMode="numeric"
          value={headcount}
          onChange={(event) => setHeadcount(event.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="recruiting-target">{labels.targetStart}</Label>
        <Input id="recruiting-target" type="date" value={targetStart} onChange={(event) => setTargetStart(event.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {labels.submit}
      </Button>
    </form>
  )
}
