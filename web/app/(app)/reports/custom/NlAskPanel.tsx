'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

export interface NlAskLabels {
  title: string
  description: string
  placeholder: string
  ask: string
  draftsTitle: string
  empty: string
  question: string
  entity: string
  status: string
  created: string
  saveAsView: string
  discard: string
  failed: string
  statuses: { drafted: string; saved: string; discarded: string }
}

interface NlDraft {
  id: string
  question: string
  definition: { entity: string; mode: string }
  status: string
  createdAt: string
}

/**
 * HR-21 Ask box on the custom reports page. The question hands off to the
 * assistant (?q=), where the model authors the report-engine definition
 * through the nl_report tool and saves the draft; this panel lists the
 * caller's drafts with Save as view (creates the definition through the
 * existing POST /api/reports/definitions, then opens the builder where
 * the definition preview already lives) and Discard. Nothing here authors
 * SQL or definitions — the model drafts, the routes validate.
 */
export function NlAskPanel({ ask, canCreate }: { ask: NlAskLabels | null; canCreate: boolean }) {
  const router = useRouter()
  const [question, setQuestion] = useState('')
  const [drafts, setDrafts] = useState<NlDraft[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!ask) return
    fetch('/api/reports/nl')
      .then(async (res) => {
        if (!res.ok) {
          setError(await readApiErrorMessage(res, ask.failed))
          return
        }
        const body = (await res.json()) as { drafts: NlDraft[] }
        setDrafts(body.drafts ?? [])
      })
      .catch(() => setError(ask.failed))
  }, [ask])
  if (!ask) return null
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const q = question.trim()
    if (!q) return
    router.push(`/assistant?q=${encodeURIComponent(q)}`)
  }
  const saveAsView = async (draft: NlDraft): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const created = await fetch('/api/reports/definitions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          name: draft.question.slice(0, 120),
          description: draft.question,
          query: draft.definition,
        }),
      })
      if (!created.ok) {
        setError(await readApiErrorMessage(created, ask.failed))
        setBusy(false)
        return
      }
      const body = (await created.json()) as { definition?: { id?: unknown } }
      const id = typeof body.definition?.id === 'string' ? body.definition.id : null
      await fetch('/api/reports/nl', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId: draft.id, status: 'saved' }),
      }).catch(() => undefined)
      setBusy(false)
      if (id) router.push(`/reports/custom/builder/${id}`)
      else setDrafts((current) => (current ?? []).filter((d) => d.id !== draft.id))
    } catch {
      setError(ask.failed)
      setBusy(false)
    }
  }
  const discard = async (draft: NlDraft): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/reports/nl', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId: draft.id, status: 'discarded' }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, ask.failed))
        setBusy(false)
        return
      }
      setDrafts((current) => (current ?? []).filter((d) => d.id !== draft.id))
      setBusy(false)
    } catch {
      setError(ask.failed)
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <Label htmlFor="nl-ask">{ask.title}</Label>
          <Input
            id="nl-ask"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={ask.placeholder}
          />
        </div>
        <Button type="submit" disabled={busy || question.trim().length === 0}>
          {ask.ask}
        </Button>
      </form>
      <p className="text-xs text-slate-500 dark:text-slate-400">{ask.description}</p>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{ask.draftsTitle}</h3>
        {drafts === null ? null : drafts.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{ask.empty}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {drafts.map((draft) => (
              <li
                key={draft.id}
                className="rounded-md border border-slate-200 p-3 dark:border-slate-800"
              >
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{draft.question}</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {ask.entity}: {draft.definition.entity} · {ask.status}: {ask.statuses[draft.status as keyof typeof ask.statuses] ?? draft.status} · {ask.created}: {draft.createdAt.slice(0, 10)}
                </p>
                {draft.status === 'drafted' ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {canCreate ? (
                      <Button size="sm" disabled={busy} onClick={() => void saveAsView(draft)}>
                        {ask.saveAsView}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void discard(draft)}>
                      {ask.discard}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
