'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * The goal form in the review drawer: set a goal on the review's
 * employment for the cycle through POST /api/hrm/goals. Authority stays
 * subject-or-HR in the service; refusals render as the error.
 */
export function GoalForm({ employmentId, cycleId }: { employmentId: string; cycleId: string }) {
  const t = useTranslations('hrm')
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/hrm/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          employmentId,
          cycleId,
          title: title.trim(),
          dueOn: dueOn.length > 0 ? dueOn : null,
        }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t('performance.actionFailed')))
        setBusy(false)
        return
      }
      setTitle('')
      setDueOn('')
      router.refresh()
    } catch {
      setError(t('performance.actionFailed'))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-3">
      <div>
        <Label htmlFor="goal-title">{t('performance.goalTitle')}</Label>
        <Input id="goal-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="goal-due">{t('performance.goalDue')}</Label>
        <Input id="goal-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="outline" disabled={busy}>
        {t('performance.addGoal')}
      </Button>
    </form>
  )
}

/** The goal progress editor: records progress through PATCH /api/hrm/goals/[id]. */
export function GoalProgressForm({ goalId, failed }: { goalId: string; failed: string }) {
  const t = useTranslations('hrm')
  const router = useRouter()
  const [progress, setProgress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hrm/goals/${goalId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'progress', progressPercent: Number(progress) }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, failed))
        setBusy(false)
        return
      }
      router.refresh()
    } catch {
      setError(failed)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <div>
        <Label htmlFor={`goal-progress-${goalId}`}>{t('performance.goalProgress')}</Label>
        <Input
          id={`goal-progress-${goalId}`}
          value={progress}
          onChange={(e) => setProgress(e.target.value)}
          required
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="outline" disabled={busy}>
        {t('performance.saveProgress')}
      </Button>
    </form>
  )
}

