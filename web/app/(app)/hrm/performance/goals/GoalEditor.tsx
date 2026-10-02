'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations, useFormatter } from 'next-intl'
import { Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import type { GoalDTO } from '@openbooks/engine/hrm/performance'
import {
  DirtyUrlDrawer,
  useDirtyUrlDrawer,
} from '../../../../../components/dirty-url-drawer'
import { readApiErrorMessage } from '../../../../../lib/api-error'
type Initial = {
  goal: GoalDTO
  updates: {
    progressPercent: number
    note: string | null
    recordedAt: string
  }[]
} | null
export function GoalEditor({
  initial,
  employees,
  canWrite,
  closeHref,
}: {
  initial: Initial
  employees: { value: string; label: string }[]
  canWrite: boolean
  closeHref: string
}) {
  const t = useTranslations('hrm.talentWorkspace')
  return (
    <DirtyUrlDrawer
      open
      openKey={initial?.goal.id ?? 'new'}
      closeHref={closeHref}
      title={initial?.goal.title ?? t('newGoal')}
    >
      <GoalForm
        key={initial?.goal.id ?? 'new'}
        initial={initial}
        employees={employees}
        canWrite={canWrite}
      />
    </DirtyUrlDrawer>
  )
}
function GoalForm({
  initial,
  employees,
  canWrite,
}: {
  initial: Initial
  employees: { value: string; label: string }[]
  canWrite: boolean
}) {
  const t = useTranslations('hrm.talentWorkspace'),
    fmt = useFormatter(),
    router = useRouter()
  const [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [employment, setEmployment] = useState(employees[0]?.value ?? ''),
    [due, setDue] = useState(''),
    [note, setNote] = useState(''),
    [progress, setProgress] = useState(
      String(initial?.goal.progressPercent ?? 0),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const dirty = initial
    ? note !== '' || progress !== String(initial.goal.progressPercent)
    : title !== '' ||
      description !== '' ||
      due !== '' ||
      employment !== (employees[0]?.value ?? '')
  const close = useDirtyUrlDrawer(dirty, busy)
  async function save(action = 'progress') {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        initial ? `/api/hrm/goals/${initial.goal.id}` : '/api/hrm/goals',
        {
          method: initial ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            initial
              ? {
                  action,
                  ...(action === 'progress'
                    ? { progressPercent: Number(progress), note: note || null }
                    : action === 'achieve'
                      ? {}
                      : { note }),
                }
              : {
                  title,
                  description: description || null,
                  employmentId: employment,
                  dueOn: due || null,
                },
          ),
        },
      )
      if (!response.ok) {
        setError(await readApiErrorMessage(response, t('saveFailed')))
        return
      }
      const payload = (await response.json()) as { goal?: GoalDTO }
      if (!payload.goal?.id) {
        setError(t('saveFailed'))
        return
      }
      setNote('')
      router.push('/hrm/performance/goals?goal=' + payload.goal.id)
      router.refresh()
    } catch {
      setError(t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <fieldset
        disabled={
          !canWrite || busy || (!!initial && initial.goal.status !== 'active')
        }
        className="space-y-4"
      >
        {initial ? (
          <>
            <p className="whitespace-pre-wrap text-sm">
              {initial.goal.description}
            </p>
            <div>
              <Label htmlFor="goal-progress">{t('progress')}</Label>
              <Input
                id="goal-progress"
                type="number"
                min={0}
                max={100}
                step={1}
                required
                value={progress}
                onChange={(e) => setProgress(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="goal-note">{t('progressNote')}</Label>
              <Textarea
                id="goal-note"
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <Label htmlFor="goal-employee">{t('employee')}</Label>
              <Select
                required
                id="goal-employee"
                value={employment}
                onChange={(e) => setEmployment(e.target.value)}
              >
                {employees.map((e) => (
                  <option key={e.value} value={e.value}>
                    {e.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="goal-title">{t('goalTitle')}</Label>
              <Input
                id="goal-title"
                required
                maxLength={240}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="goal-description">{t('goalDescription')}</Label>
              <Textarea
                id="goal-description"
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="goal-due">{t('due')}</Label>
              <Input
                id="goal-due"
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </div>
          </>
        )}
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit">
              {initial ? t('goalAction') : t('newGoal')}
            </Button>
            {initial && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void save('achieve')}
                >
                  {t('achieve')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!note.trim()}
                  onClick={() => void save('miss')}
                >
                  {t('miss')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!note.trim()}
                  onClick={() => void save('cancel')}
                >
                  {t('cancelGoal')}
                </Button>
              </>
            )}
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {initial && (
        <section className="space-y-2">
          <h3 className="font-medium">{t('goalHistory')}</h3>
          {initial.updates.map((update, i) => (
            <p key={i} className="text-sm">
              {update.progressPercent}% · {update.note} ·{' '}
              {fmt.dateTime(new Date(update.recordedAt), {
                dateStyle: 'medium',
              })}
            </p>
          ))}
        </section>
      )}
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => void close()}
      >
        {t('cancel')}
      </Button>
    </form>
  )
}
