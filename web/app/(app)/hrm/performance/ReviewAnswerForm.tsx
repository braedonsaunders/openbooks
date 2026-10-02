'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import type { PerformanceAnswer } from './view'
import { useDirtyUrlDrawer } from '../../../../components/dirty-url-drawer'

/**
 * The snapshot answer form in the review drawer: one rating/text input per
 * snapshot row, submitted with the optional overall rating through PATCH
 * /api/hrm/reviews/[id]. Required answers are refused by name (the service
 * names the question); the message renders as the error.
 */
export function ReviewAnswerForm({
  reviewId,
  revision: initialRevision = 1,
  overallRating = null,
  ratingScale,
  cycleId: _cycleId,
  answers,
  submitLabel,
  ratingLabel,
  textLabel,
  requiredLabel,
  failed,
  draft,
}: {
  reviewId: string
  revision?: number
  ratingScale?: { min: string; max: string; labels: readonly string[] } | null
  overallRating?: string | null
  cycleId: string
  answers: PerformanceAnswer[]
  submitLabel: string
  ratingLabel: string
  textLabel: string
  requiredLabel: string
  failed: string
  /** "Draft from evidence" link: absent without assistant access, while the
   *  review is not pending, or for a peer review (no draft kind). */
  draft: { href: string; label: string } | null
}) {
  const router = useRouter()
  const [ratings, setRatings] = useState<Record<string, string>>(() =>
    Object.fromEntries(answers.map((a) => [a.id, a.rating ?? ''])),
  )
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(answers.map((a) => [a.id, a.text ?? ''])),
  )
  const t = useTranslations('hrm.talentWorkspace')
  const [revision, setRevision] = useState(initialRevision)
  const [overall, setOverall] = useState(overallRating ?? '')
  const [saveStatus, setSaveStatus] = useState('')
  const values = JSON.stringify({ ratings, texts, overall })
  const [baseline, setBaseline] = useState(values)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = useDirtyUrlDrawer(values !== baseline, busy)
  const persist = useCallback(
    async (action: 'submit' | 'save-draft') => {
      if (busy) return
      setBusy(true)
      setError(null)
      setSaveStatus(t('saving'))
      const captured = values
      try {
        const res = await fetch(`/api/hrm/reviews/${reviewId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            revision,
            answers: answers.map((a) => ({
              answerId: a.id,
              rating: ratings[a.id]?.trim() || null,
              text: texts[a.id] || null,
            })),
            overallRating: overall.trim() || null,
          }),
        })
        if (!res.ok) {
          setError(await readApiErrorMessage(res, failed))
          setSaveStatus(t('notSaved'))
          return
        }
        const payload = (await res.json()) as {
          review?: { id: string; revision: number }
        }
        if (payload.review?.id !== reviewId || !payload.review.revision) {
          setError(failed)
          setSaveStatus(t('notSaved'))
          return
        }
        setRevision(payload.review.revision)
        setBaseline(captured)
        setSaveStatus(t('draftSaved'))
        if (action === 'submit') router.refresh()
      } catch {
        setError(failed)
        setSaveStatus(t('notSaved'))
      } finally {
        setBusy(false)
      }
    },
    [
      busy,
      values,
      reviewId,
      revision,
      answers,
      ratings,
      texts,
      overall,
      failed,
      t,
      router,
    ],
  )
  useEffect(() => {
    if (values === baseline || busy || error) return
    const timer = setTimeout(() => void persist('save-draft'), 1200)
    return () => clearTimeout(timer)
  }, [values, baseline, busy, error, persist])
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void persist('submit')
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {ratingScale && (
        <p className="text-sm text-slate-500">
          {ratingLabel}: {ratingScale.min}–{ratingScale.max}
          {ratingScale.labels.length
            ? ' · ' + ratingScale.labels.join(' · ')
            : ''}
        </p>
      )}
      {answers.map((answer) => (
        <div key={answer.id} className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {answer.sectionTitle}
            {answer.questionPrompt ? ` — ${answer.questionPrompt}` : null}
            {answer.required ? ` · ${requiredLabel}` : null}
          </h4>
          {answer.answerKind === 'rating' ||
          answer.answerKind === 'rating_and_text' ? (
            <div>
              <Label htmlFor={`rating-${answer.id}`}>{ratingLabel}</Label>
              <Input
                id={`rating-${answer.id}`}
                value={ratings[answer.id] ?? ''}
                onChange={(e) =>
                  setRatings((prev) => ({
                    ...prev,
                    [answer.id]: e.target.value,
                  }))
                }
                required={answer.required}
              />
            </div>
          ) : null}
          {answer.answerKind === 'text' ||
          answer.answerKind === 'rating_and_text' ? (
            <div>
              <Label htmlFor={`text-${answer.id}`}>{textLabel}</Label>
              <Textarea
                id={`text-${answer.id}`}
                value={texts[answer.id] ?? ''}
                onChange={(e) =>
                  setTexts((prev) => ({ ...prev, [answer.id]: e.target.value }))
                }
                required={answer.required}
              />
            </div>
          ) : null}
        </div>
      ))}
      <div>
        <Label htmlFor="overall-rating">{ratingLabel}</Label>
        <Input
          id="overall-rating"
          value={overall}
          onChange={(e) => setOverall(e.target.value)}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <p role="status" className="text-xs text-slate-500">
        {saveStatus ||
          (values !== baseline
            ? t('unsaved')
            : answers.some((a) => a.rating !== null || a.text !== null)
              ? t('draftSaved')
              : '')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void persist('save-draft')}
        >
          {t('saveDraft')}
        </Button>
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
        {draft ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void close(draft.href)}
          >
            {draft.label}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
