'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, SearchSelect, Select } from '@openbooks/ui'
import { confirmDialog } from '../../../../lib/confirm'
import { readApiErrorMessage } from '../../../../lib/api-error'

type SubjectKind = 'project' | 'equipment' | 'position' | 'classification'

export interface RequirementManagerProps {
  today: string
  types: { value: string; label: string }[]
  labels: {
    title: string
    subjectKind: string
    subject: string
    type: string
    from: string
    to: string
    severity: string
    block: string
    warn: string
    save: string
    remove: string
    removeConfirm: string
    failed: string
    saved: string
    search: string
    searchHint: string
    searchFailed: string
    more: string
    subjects: Record<SubjectKind, string>
  }
}

const KINDS: SubjectKind[] = ['project', 'equipment', 'position', 'classification']

export function QualificationRequirementManager({ today, types, labels }: RequirementManagerProps) {
  const router = useRouter()
  const [kind, setKind] = useState<SubjectKind>('project')
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<{ value: string; label: string }[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [typeId, setTypeId] = useState(types[0]?.value ?? '')
  const [requiredFrom, setRequiredFrom] = useState(today)
  const [requiredTo, setRequiredTo] = useState('')
  const [severity, setSeverity] = useState<'block' | 'warn'>('block')
  const [subjectId, setSubjectId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    const normalized = query.trim()
    if (normalized.length < 2) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/hrm/qualification-requirements/options?subjectKind=${kind}&q=${encodeURIComponent(normalized)}`)
        if (!response.ok) {
          if (!cancelled) setError(await readApiErrorMessage(response, labels.searchFailed))
          return
        }
        const payload = await response.json().catch(() => ({})) as { options?: unknown; hasMore?: unknown }
        if (!Array.isArray(payload.options)) {
          if (!cancelled) setError(labels.searchFailed)
          return
        }
        if (!cancelled) {
          setOptions(payload.options.flatMap((option) => {
            if (!option || typeof option !== 'object') return []
            const row = option as { id?: unknown; label?: unknown }
            return typeof row.id === 'string' && typeof row.label === 'string'
              ? [{ value: row.id, label: row.label }]
              : []
          }))
          setHasMore(payload.hasMore === true)
          setError(null)
        }
      } catch {
        if (!cancelled) setError(labels.searchFailed)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [kind, labels.searchFailed, query])

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const response = await fetch('/api/hrm/qualification-requirements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectKind: kind,
          subjectId,
          typeId,
          requiredFrom: requiredFrom || undefined,
          requiredTo: requiredTo || null,
          severity,
        }),
      })
      if (!response.ok) {
        setError(await readApiErrorMessage(response, labels.failed))
        return
      }
      setSaved(labels.saved)
      router.refresh()
    } catch {
      setError(labels.failed)
    } finally {
      setBusy(false)
    }
  }

  function changeKind(value: string) {
    setKind(value as SubjectKind)
    setSubjectId('')
    setQuery('')
    setOptions([])
    setHasMore(false)
    setError(null)
    setLoading(false)
  }

  function changeQuery(value: string) {
    setQuery(value)
    setOptions([])
    setHasMore(false)
    setError(null)
    setLoading(value.trim().length >= 2)
  }

  return (
    <section className="space-y-3 p-4" aria-label={labels.title}>
      <h3 className="text-sm font-semibold">{labels.title}</h3>
      <form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" onSubmit={save}>
        <div>
          <Label htmlFor="qualification-requirement-kind">{labels.subjectKind}</Label>
          <Select id="qualification-requirement-kind" value={kind} disabled={busy} onChange={(event) => changeKind(event.target.value)}>
            {KINDS.map((value) => <option key={value} value={value}>{labels.subjects[value]}</option>)}
          </Select>
        </div>
        <div>
          <Label htmlFor="qualification-requirement-subject">{labels.subject}</Label>
          <SearchSelect
            id="qualification-requirement-subject"
            ariaLabel={labels.subject}
            value={subjectId}
            onChange={setSubjectId}
            options={options}
            placeholder={labels.search}
            searchPlaceholder={labels.search}
            emptyLabel={labels.searchHint}
            statusMessage={error ?? (query.trim().length < 2 ? labels.searchHint : hasMore ? labels.more : undefined)}
            statusTone={error ? 'error' : 'muted'}
            loading={loading}
            remote
            searchable
            disabled={busy}
            onSearchChange={changeQuery}
          />
        </div>
        <div>
          <Label htmlFor="qualification-requirement-type">{labels.type}</Label>
          <Select id="qualification-requirement-type" value={typeId} disabled={busy} onChange={(event) => setTypeId(event.target.value)}>
            {types.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </Select>
        </div>
        <div>
          <Label htmlFor="qualification-requirement-from">{labels.from}</Label>
          <Input id="qualification-requirement-from" type="date" value={requiredFrom} disabled={busy} onChange={(event) => setRequiredFrom(event.target.value)} />
        </div>
        <div>
          <Label htmlFor="qualification-requirement-to">{labels.to}</Label>
          <Input id="qualification-requirement-to" type="date" value={requiredTo} disabled={busy} onChange={(event) => setRequiredTo(event.target.value)} />
        </div>
        <div>
          <Label htmlFor="qualification-requirement-severity">{labels.severity}</Label>
          <Select id="qualification-requirement-severity" value={severity} disabled={busy} onChange={(event) => setSeverity(event.target.value as 'block' | 'warn')}>
            <option value="block">{labels.block}</option>
            <option value="warn">{labels.warn}</option>
          </Select>
        </div>
        <div className="sm:col-span-2 xl:col-span-3">
          <Button type="submit" size="sm" disabled={busy || !subjectId || !typeId}>{labels.save}</Button>
        </div>
      </form>
      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {saved ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{saved}</p> : null}
    </section>
  )
}

export function QualificationRequirementRemove({ id, label, confirmLabel, failedLabel, canManage }: { id: string; label: string; confirmLabel: string; failedLabel: string; canManage: boolean }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!canManage) return null

  async function remove() {
    if (!(await confirmDialog({ message: confirmLabel, tone: 'danger' }))) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/hrm/qualification-requirements/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        setError(await readApiErrorMessage(response, failedLabel))
        return
      }
      router.refresh()
    } catch {
      setError(failedLabel)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>{label}</Button>
      {error ? <span role="alert" className="ml-2 text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </div>
  )
}
