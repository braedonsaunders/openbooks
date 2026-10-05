'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Button, Label } from '@openbooks/ui'
import type {
  TrainingCourse,
  TrainingSession,
  TrainingParticipant,
  TrainingFeedback,
} from '@openbooks/engine/hrm/training'
import { InspectorPanel } from '@/components/builder/builder-kit'
import { CabinetFilePicker } from '@/components/cabinet-file-picker'
import { FieldControl } from '@/app/(app)/admin/setup/[entity]/SetupDrawer'
import { coerceField } from '@/lib/setup/coerce'
import { readApiErrorMessage } from '@/lib/api-error'
import { dateTime } from '@/lib/format'
import type { SetupField } from '@/lib/setup/types'

/** Decision controls use the native fields inside the record's existing drawer shell. */
export function TrainingActions({
  course,
  session,
  participant,
  feedback = [],
  canManage,
}: {
  course: TrainingCourse
  session?: TrainingSession
  participant?: TrainingParticipant
  feedback?: TrainingFeedback[]
  canManage: boolean
}) {
  const t = useTranslations('admin.setup'),
    router = useRouter()
  const record = participant ?? session ?? course
  const [values, setValues] = useState<Record<string, unknown>>({
    reason: '',
    attendanceMinutes: '',
    score: '',
    notes: '',
    rating: '',
    comments: '',
  })
  const [evidence, setEvidence] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const pending = useRef(false),
    feedbackKey = useRef<string | null>(null)
  const base = `/api/hrm/training/${participant ? 'participants' : session ? 'sessions' : 'courses'}/${record.id}`
  const locale = useLocale()
  const actions: string[] = []
  if (canManage) {
    if (participant) {
      if (participant.status === 'invited') actions.push('accept', 'decline')
      if (participant.status === 'invited' || participant.status === 'accepted') {
        actions.push('cancel')
        if (session?.status === 'in_progress') actions.push('result')
      }
      if (participant.status === 'completed' || participant.status === 'failed') actions.push('void', 'feedback')
    } else if (session) {
      if (session.status === 'draft') actions.push('schedule', 'cancel')
      if (session.status === 'scheduled') actions.push('start', 'cancel')
      if (session.status === 'in_progress') actions.push('complete', 'cancel')
    } else {
      if (course.status === 'draft') actions.push('approve', 'cancel')
      if (course.status === 'approved') actions.push('retire')
    }
  }
  const resultFields: SetupField[] = [
    { key: 'attendanceMinutes', kind: 'integer', min: 0, required: true, labelKey: 'training.attendanceMinutes' },
    ...(course.passingScore !== null
      ? [{ key: 'score', kind: 'integer' as const, min: 0, max: 100, required: true, labelKey: 'training.score' }]
      : []),
    { key: 'notes', kind: 'textarea', labelKey: 'training.notes' },
  ]
  const feedbackFields: SetupField[] = [
    { key: 'rating', kind: 'integer', min: 1, max: 5, required: true, labelKey: 'training.rating' },
    { key: 'comments', kind: 'textarea', labelKey: 'training.comments' },
  ]
  function fields(items: SetupField[]) {
    return items.map((field) => (
      <FieldControl
        key={field.key}
        field={field}
        value={values[field.key]}
        onChange={(value) => {
          setValues((current) => ({ ...current, [field.key]: value }))
          setError(null)
        }}
        creating
        forceLocked={busy}
        refOptions={[]}
        formValues={values}
        t={t}
      />
    ))
  }
  async function act(action: string) {
    if (pending.current) return
    const common = coerceField({ key: 'reason', kind: 'textarea', required: true }, values.reason)
    if ('error' in common) {
      setError(t('training.reasonHint'))
      return
    }
    const body: Record<string, unknown> = { expectedRevision: record.revision, reason: common.value }
    let suffix = ''
    if (action === 'result' || action === 'feedback') {
      for (const field of action === 'result' ? resultFields : feedbackFields) {
        const parsed = coerceField(field, values[field.key])
        if ('error' in parsed) {
          setError(parsed.error)
          return
        }
        body[field.key] = parsed.value
      }
      if (action === 'result') {
        const minutes = body.attendanceMinutes as number
        body.attendanceSeconds = minutes * 60
        delete body.attendanceMinutes
        body.score ??= null
        body.evidenceFileId = evidence || null
        body.existingQualificationId = null
        suffix = '/result'
      } else {
        delete body.expectedRevision
        body.supersedesId =
          feedback.find((entry) => !feedback.some((next) => next.supersedesId === entry.id))?.id ?? null
        suffix = '/feedback'
        feedbackKey.current ??= crypto.randomUUID()
      }
    } else if (action === 'void') suffix = '/void'
    else body.action = action
    pending.current = true
    setBusy(true)
    setError(null)
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 30000)
    try {
      const response = await fetch(`${base}${suffix}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(action === 'feedback' ? { 'Idempotency-Key': feedbackKey.current! } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t('training.unconfirmed')))
        return
      }
      feedbackKey.current = null
      setValues((current) => ({ ...current, reason: '' }))
      router.refresh()
    } catch {
      setError(t('training.unconfirmed'))
    } finally {
      clearTimeout(timeout)
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <InspectorPanel
        title={t('training.review')}
        description={participant ? t('training.resultHint') : t('training.reviewHint')}
      >
        <p className="mb-4 text-sm">
          {t('training.status')}: {t(`training.statuses.${record.status}`)}
        </p>
        {actions.length ? (
          <div className="space-y-4">
            {fields([{ key: 'reason', kind: 'textarea', required: true, labelKey: 'training.reason' }])}
            {actions.includes('result') ? (
              <InspectorPanel title={t('training.result')} description={t('training.resultHint')}>
                <div className="grid gap-4 sm:grid-cols-2">{fields(resultFields)}</div>
                {course.qualificationTypeId ? (
                  <div className="mt-4 space-y-1.5">
                    <Label>{t('training.evidence')}</Label>
                    <CabinetFilePicker
                      value={evidence}
                      onChange={setEvidence}
                      label={t('training.evidence')}
                      disabled={busy}
                    />
                  </div>
                ) : null}
                <Button className="mt-4" disabled={busy} onClick={() => void act('result')}>
                  {t('training.actions.result')}
                </Button>
              </InspectorPanel>
            ) : null}
            {actions.includes('feedback') ? (
              <InspectorPanel title={t('training.feedback')} description={t('training.feedbackHint')}>
                <div className="grid gap-4 sm:grid-cols-2">{fields(feedbackFields)}</div>
                <Button className="mt-4" disabled={busy} onClick={() => void act('feedback')}>
                  {t('training.actions.feedback')}
                </Button>
              </InspectorPanel>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {actions
                .filter((action) => action !== 'result' && action !== 'feedback')
                .map((action) => (
                  <Button
                    key={action}
                    variant={['cancel', 'retire', 'void', 'decline'].includes(action) ? 'outline' : 'default'}
                    disabled={busy}
                    onClick={() => void act(action)}
                  >
                    {t(`training.actions.${action}`)}
                  </Button>
                ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">{t('training.noActions')}</p>
        )}
        {participant?.attendanceSeconds != null ? (
          <p className="mt-4 text-sm">
            {t('training.recordedResult', { seconds: participant.attendanceSeconds, score: participant.score ?? '—' })}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </InspectorPanel>
      {feedback.length ? (
        <InspectorPanel title={t('training.feedback')} description={t('training.feedbackHint')}>
          {feedback.map((entry) => (
            <p key={entry.id} className="py-2 text-sm whitespace-pre-wrap">
              {t('training.feedbackEntry', { rating: entry.rating, at: dateTime(entry.createdAt, locale) })}
              {entry.comments ? ` · ${entry.comments}` : ''}
            </p>
          ))}
        </InspectorPanel>
      ) : null}
    </div>
  )
}
