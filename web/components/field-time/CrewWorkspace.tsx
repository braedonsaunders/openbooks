'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../lib/api-error'

export interface CrewLine {
  id?: string
  employeePartyId: string
  employeeName?: string | null
  hours: string
  timeTypeId: string
  timeTypeName?: string | null
  projectTaskId: string
  taskName?: string | null
  costCodeRef: string
  equipmentId: string
  equipmentUnit?: string | null
  equipmentHours: string
  memo: string
}

export interface CrewOption {
  id: string
  name: string
}

const EMPTY_LINE: CrewLine = {
  employeePartyId: '',
  hours: '',
  timeTypeId: '',
  projectTaskId: '',
  costCodeRef: '',
  equipmentId: '',
  equipmentHours: '',
  memo: '',
}

/**
 * The foreman workspace: inline-editable crew rows (tab order runs down
 * each column across rows), copy-yesterday, sign-and-submit with the
 * signature dialog, and the stage actions. On the phone the rows render
 * as worker cards. Locked batches render read-only with the stage strip.
 */
export function CrewWorkspace({
  batchId,
  status,
  locked,
  initialLines,
  workers,
  timeTypes,
  tasks,
  equipment,
  equipmentOn,
  signatureRequired,
  signLabel,
  create = null,
}: {
  batchId: string
  status: string
  locked: boolean
  initialLines: CrewLine[]
  workers: CrewOption[]
  timeTypes: CrewOption[]
  tasks: CrewOption[]
  equipment: CrewOption[]
  equipmentOn: boolean
  signatureRequired: boolean
  signLabel: string
  /**
   * Unsaved-create: the loader passes pickers plus the default worked day
   * with an empty batchId, and the workspace renders the create form
   * instead of batch rows. Creating writes nothing until the explicit
   * Create posts one batch.
   */
  create?: {
    projects: CrewOption[]
    defaultWorkedOn: string
  } | null
}) {
  const t = useTranslations('timesheets')
  const [lines, setLines] = useState<CrewLine[]>(initialLines.length > 0 ? initialLines : [{ ...EMPTY_LINE }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [signOpen, setSignOpen] = useState(false)
  const [signerName, setSignerName] = useState('')
  const [reason, setReason] = useState('')

  const setLine = (index: number, patch: Partial<CrewLine>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  const act = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch(`/api/time/crew-batches/${batchId}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...extra }),
        })
        const payload = (await res.json().catch(() => null)) as { error?: string } | null
        if (!res.ok) {
          setError(payload?.error ?? t('field.sendFailed'))
          return false
        }
        setSavedAt(new Date().toLocaleTimeString())
        return true
      } catch {
        setError(t('field.sendFailed'))
        return false
      } finally {
        setBusy(false)
      }
    },
    [batchId, t],
  )

  const save = useCallback(async () => {
    const cleaned = lines
      .filter((line) => line.employeePartyId && line.hours.trim() !== '')
      .map((line) => ({
        employeePartyId: line.employeePartyId,
        hours: line.hours.trim(),
        timeTypeId: line.timeTypeId || null,
        projectTaskId: line.projectTaskId || null,
        costCodeRef: line.costCodeRef.trim() || null,
        equipmentId: line.equipmentId || null,
        equipmentHours: line.equipmentHours.trim() || null,
        memo: line.memo.trim() || null,
      }))
    const ok = await act('lines', { lines: cleaned })
    if (ok) window.location.reload()
    return ok
  }, [lines, act])

  const submit = useCallback(async () => {
    if (signatureRequired && !signerName.trim()) {
      setError(t('field.signerNameRequired'))
      return
    }
    const ok = await act('submit', { signerName: signerName.trim() || null })
    if (ok) {
      setSignOpen(false)
      window.location.reload()
    }
  }, [act, signatureRequired, signerName, t])

  const row = (line: CrewLine, index: number) => (
    <fieldset
      key={index}
      disabled={locked || busy}
      className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800 md:grid md:grid-cols-[1fr_5rem_1fr_1fr] md:gap-2"
    >
      <div>
        <Label>{t('field.worker')}</Label>
        <Select value={line.employeePartyId} onChange={(event) => setLine(index, { employeePartyId: event.target.value })}>
          <option value="">{t('field.chooseWorker')}</option>
          {workers.map((worker) => (
            <option key={worker.id} value={worker.id}>
              {worker.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>{t('field.hours')}</Label>
        <Input value={line.hours} onChange={(event) => setLine(index, { hours: event.target.value })} inputMode="decimal" placeholder="8" />
      </div>
      <div>
        <Label>{t('field.timeType')}</Label>
        <Select value={line.timeTypeId} onChange={(event) => setLine(index, { timeTypeId: event.target.value })}>
          <option value="">{t('field.noTimeType')}</option>
          {timeTypes.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>{t('field.task')}</Label>
        <Select value={line.projectTaskId} onChange={(event) => setLine(index, { projectTaskId: event.target.value })}>
          <option value="">{t('field.noTask')}</option>
          {tasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>{t('field.costCode')}</Label>
        <Input value={line.costCodeRef} onChange={(event) => setLine(index, { costCodeRef: event.target.value })} placeholder={t('field.costCodePlaceholder')} />
      </div>
      {equipmentOn ? (
        <>
          <div>
            <Label>{t('field.equipment')}</Label>
            <Select value={line.equipmentId} onChange={(event) => setLine(index, { equipmentId: event.target.value })}>
              <option value="">{t('field.noEquipment')}</option>
              {equipment.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('field.equipmentHours')}</Label>
            <Input value={line.equipmentHours} onChange={(event) => setLine(index, { equipmentHours: event.target.value })} inputMode="decimal" placeholder="4" />
          </div>
        </>
      ) : null}
      <div className="md:col-span-2">
        <Label>{t('field.memo')}</Label>
        <Input value={line.memo} onChange={(event) => setLine(index, { memo: event.target.value })} placeholder={t('field.memoPlaceholder')} />
      </div>
      {!locked ? (
        <div className="flex items-end">
          <Button
            variant="outline"
            onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
            disabled={lines.length <= 1}
          >
            {t('field.removeLine')}
          </Button>
        </div>
      ) : null}
    </fieldset>
  )

  // Unsaved-create renders the create form instead of batch rows. The branch
  // sits after every hook so both modes run the same hook order.
  if (create != null && batchId === '') {
    return <CrewCreateForm workers={workers} projects={create.projects} defaultWorkedOn={create.defaultWorkedOn} />
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium dark:bg-slate-800">{status}</span>
        {savedAt ? <span className="text-xs text-slate-500">{t('field.savedAt', { at: savedAt })}</span> : null}
      </div>

      <div className="space-y-3">{lines.map((line, index) => row(line, index))}</div>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {!locked ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}>
            {t('field.addLine')}
          </Button>
          <Button disabled={busy} onClick={save}>
            {busy ? t('field.working') : t('field.saveLines')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => (signatureRequired ? setSignOpen(true) : act('submit').then((ok) => ok && window.location.reload()))}>
            {signLabel}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {status === 'submitted' ? (
            <Button variant="outline" disabled={busy} onClick={() => act('withdraw').then((ok) => ok && window.location.reload())}>
              {t('field.withdraw')}
            </Button>
          ) : null}
          <Button disabled={busy} onClick={() => act('approve').then((ok) => ok && window.location.reload())}>
            {t('field.approveStage')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !reason.trim()}
            onClick={() => act('reject', { reason: reason.trim() }).then((ok) => ok && window.location.reload())}
          >
            {t('field.reject')}
          </Button>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('field.rejectReason')} className="max-w-xs" />
          <Button disabled={busy} onClick={() => act('post').then((ok) => ok && window.location.reload())}>
            {t('field.post')}
          </Button>
        </div>
      )}

      {signOpen ? (
        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900" role="dialog" aria-label={signLabel}>
          <Label htmlFor="crew-sign-name">{t('field.signerName')}</Label>
          <Input id="crew-sign-name" value={signerName} onChange={(event) => setSignerName(event.target.value)} placeholder={t('field.signerNamePlaceholder')} autoComplete="off" />
          <p className="mt-2 text-xs text-slate-500">{t('field.signSeals')}</p>
          <div className="mt-4 flex gap-2">
            <Button disabled={busy} onClick={submit} className="flex-1">
              {signLabel}
            </Button>
            <Button variant="outline" onClick={() => setSignOpen(false)} className="flex-1">
              {t('field.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

    </div>
  )
}

/**
 * The unsaved-create form the New Batch button opens (?new=1). Opening
 * writes nothing — the batch exists only after the explicit Create posts
 * once to /api/time/crew-batches and lands on the new batch. The server
 * names what is missing (foreman, project, worked day), and the form shows
 * that refusal instead of a parse error: the status is checked first.
 */
function CrewCreateForm({
  workers,
  projects,
  defaultWorkedOn,
}: {
  workers: CrewOption[]
  projects: CrewOption[]
  defaultWorkedOn: string
}) {
  const t = useTranslations('timesheets')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [foremanId, setForemanId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [workedOn, setWorkedOn] = useState(defaultWorkedOn)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/time/crew-batches', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          foremanPartyId: foremanId,
          projectId,
          workedOn,
          notes: notes.trim() || null,
        }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t('field.sendFailed')))
        return
      }
      const payload = (await res.json()) as { id?: string }
      if (!payload.id) {
        setError(t('field.sendFailed'))
        return
      }
      router.push(`/time/crew?batch=${encodeURIComponent(payload.id)}` as never)
      router.refresh()
    } catch {
      setError(t('field.sendFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4" role="dialog" aria-label={t('field.newBatch')}>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label>{t('field.foremanLabel')}</Label>
          <Select value={foremanId} onChange={(event) => setForemanId(event.target.value)}>
            <option value="">{t('field.chooseWorker')}</option>
            {workers.map((worker) => (
              <option key={worker.id} value={worker.id}>
                {worker.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t('field.projectLabel')}</Label>
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">{t('field.chooseProject')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t('field.workedOnLabel')}</Label>
          <Input type="date" value={workedOn} onChange={(event) => setWorkedOn(event.target.value)} />
        </div>
        <div>
          <Label>{t('field.memo')}</Label>
          <Input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t('field.memoPlaceholder')} />
        </div>
      </div>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={create}>
          {busy ? t('field.working') : tCommon('actions.create')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => router.push('/time/crew' as never)}>
          {t('field.cancel')}
        </Button>
      </div>
    </div>
  )
}
