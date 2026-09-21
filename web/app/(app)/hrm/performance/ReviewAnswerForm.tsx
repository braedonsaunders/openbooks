'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import type { PerformanceAnswer } from './view'

/**
 * The snapshot answer form in the review drawer: one rating/text input per
 * snapshot row, submitted with the optional overall rating through PATCH
 * /api/hrm/reviews/[id]. Required answers are refused by name (the service
 * names the question); the message renders as the error.
 */
export function ReviewAnswerForm({
  reviewId,
  cycleId,
  answers,
  submitLabel,
  ratingLabel,
  textLabel,
  requiredLabel,
  failed,
  draft,
}: {
  reviewId: string
  cycleId: string
  answers: PerformanceAnswer[]
  submitLabel: string
  ratingLabel: string
  textLabel: string
  requiredLabel: string
  failed: string
  /** HR-21 "Draft from evidence" link: absent while hrmDrafting is off, the
   *  review is not pending, or the review is a peer review (no draft kind). */
  draft: { href: string; label: string } | null
}) {
  const router = useRouter()
  const [ratings, setRatings] = useState<Record<string, string>>(() =>
    Object.fromEntries(answers.map((a) => [a.id, a.rating ?? ''])),
  )
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(answers.map((a) => [a.id, a.text ?? ''])),
  )
  const [overall, setOverall] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hrm/reviews/${reviewId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'submit',
          answers: answers.map((a) => ({
            answerId: a.id,
            rating: (ratings[a.id] ?? '').trim().length > 0 ? (ratings[a.id] ?? '').trim() : null,
            text: (texts[a.id] ?? '').length > 0 ? texts[a.id] : null,
          })),
          overallRating: overall.trim().length > 0 ? overall.trim() : null,
        }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, failed))
        setBusy(false)
        return
      }
      router.push(`/hrm/performance?cycle=${cycleId}&review=${reviewId}`)
      router.refresh()
    } catch {
      setError(failed)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {answers.map((answer) => (
        <div key={answer.id} className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {answer.sectionTitle}
            {answer.questionPrompt ? ` — ${answer.questionPrompt}` : null}
            {answer.required ? ` · ${requiredLabel}` : null}
          </h4>
          {answer.answerKind === 'rating' || answer.answerKind === 'rating_and_text' ? (
            <div>
              <Label htmlFor={`rating-${answer.id}`}>{ratingLabel}</Label>
              <Input
                id={`rating-${answer.id}`}
                value={ratings[answer.id] ?? ''}
                onChange={(e) => setRatings((prev) => ({ ...prev, [answer.id]: e.target.value }))}
                required={answer.required}
              />
            </div>
          ) : null}
          {answer.answerKind === 'text' || answer.answerKind === 'rating_and_text' ? (
            <div>
              <Label htmlFor={`text-${answer.id}`}>{textLabel}</Label>
              <Textarea
                id={`text-${answer.id}`}
                value={texts[answer.id] ?? ''}
                onChange={(e) => setTexts((prev) => ({ ...prev, [answer.id]: e.target.value }))}
                required={answer.required}
              />
            </div>
          ) : null}
        </div>
      ))}
      <div>
        <Label htmlFor="overall-rating">{ratingLabel}</Label>
        <Input id="overall-rating" value={overall} onChange={(e) => setOverall(e.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
        {draft ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => router.push(draft.href)}>
            {draft.label}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
