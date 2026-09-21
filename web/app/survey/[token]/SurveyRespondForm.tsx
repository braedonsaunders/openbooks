'use client'

import { useState } from 'react'

/**
 * The response capture half of the public survey page. Deliberately
 * does not use the app's i18n provider (public route, no session):
 * plain English strings. One response per invitation — the token is
 * consumed on submit and replays are refused by name.
 */

export interface RespondQuestion {
  id: string
  kind: string
  prompt: string
  options: string[]
}

export function SurveyRespondForm({ token, questions }: { token: string; questions: RespondQuestion[] }) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')

  function set(questionId: string, value: unknown) {
    setValues((prev) => ({ ...prev, [questionId]: value }))
  }

  function toggleMulti(questionId: string, option: string) {
    setValues((prev) => {
      const current = Array.isArray(prev[questionId]) ? (prev[questionId] as string[]) : []
      return {
        ...prev,
        [questionId]: current.includes(option) ? current.filter((o) => o !== option) : [...current, option],
      }
    })
  }

  async function submit() {
    setState('busy')
    setError('')
    const res = await fetch(`/api/surveys/respond/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: questions.map((q) => ({ questionId: q.id, value: values[q.id] ?? null })),
      }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setError(body?.error ?? 'Your response was not counted — the message above explains why.')
      setState('error')
      return
    }
    setState('done')
  }

  if (state === 'done') {
    return (
      <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-center dark:border-teal-800 dark:bg-teal-950/40">
        <p className="text-sm font-medium text-teal-800 dark:text-teal-200">Thank you — your response is counted.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {questions.map((question) => (
        <fieldset key={question.id} className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <legend className="px-1 text-sm font-medium text-slate-900 dark:text-slate-100">{question.prompt}</legend>
          {(question.kind === 'scale' || question.kind === 'enps') && (
            <div className="mt-2 flex flex-wrap gap-2">
              {Array.from(
                { length: question.kind === 'enps' ? 11 : 5 },
                (_, i) => (question.kind === 'enps' ? i : i + 1),
              ).map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={values[question.id] === n}
                  onClick={() => set(question.id, n)}
                  className={`h-9 w-9 rounded-md border text-sm tabular-nums ${
                    values[question.id] === n
                      ? 'border-teal-600 bg-teal-600 text-white'
                      : 'border-slate-300 dark:border-slate-600'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          {question.kind === 'single' &&
            question.options.map((option) => (
              <label key={option} className="mt-1 flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={question.id}
                  checked={values[question.id] === option}
                  onChange={() => set(question.id, option)}
                />
                {option}
              </label>
            ))}
          {question.kind === 'multi' &&
            question.options.map((option) => (
              <label key={option} className="mt-1 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={((values[question.id] as string[] | undefined) ?? []).includes(option)}
                  onChange={() => toggleMulti(question.id, option)}
                />
                {option}
              </label>
            ))}
          {question.kind === 'text' && (
            <textarea
              rows={3}
              aria-label={question.prompt}
              className="mt-2 w-full rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              value={(values[question.id] as string | undefined) ?? ''}
              onChange={(e) => set(question.id, e.target.value)}
            />
          )}
        </fieldset>
      ))}
      {state === 'error' && <p className="text-sm text-rose-600">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={state === 'busy'}
        className="w-full rounded-md bg-teal-600 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {state === 'busy' ? 'Submitting…' : 'Submit response'}
      </button>
    </div>
  )
}
