'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select } from '@openbooks/ui'

export interface ClockProject {
  id: string
  name: string
  code: string | null
}

export interface ClockTask {
  id: string
  name: string
}

export interface ClockState {
  clockedIn: boolean
  since: string | null
  projectId: string | null
  projectName: string | null
  costCodeRef: string | null
  onBreak: boolean
}

interface QueuedEvent {
  key: string
  body: Record<string, unknown>
}

const QUEUE_KEY = 'openbooks.field-clock-queue'

function loadQueue(): QueuedEvent[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    const parsed = raw ? (JSON.parse(raw) as QueuedEvent[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function storeQueue(queue: QueuedEvent[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch {
    // A full or blocked store keeps the queue in memory for the session.
  }
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

/**
 * The clock island: one state card, one primary button, a
 * project/task/cost-code picker sheet, break and switch actions, and an
 * offline queue in localStorage that replays through the same API with
 * per-event results. Photo capture rides the native file input when the
 * org requires a photo.
 */
export function ClockControls({
  initial,
  projects,
  tasks,
  photoRequired,
  photoFolderId,
  geoHint,
  clockOutLabel,
}: {
  initial: ClockState
  projects: ClockProject[]
  tasks: ClockTask[]
  photoRequired: boolean
  photoFolderId: string | null
  geoHint: string
  clockOutLabel: string
}) {
  const t = useTranslations('timesheets')
  const [state, setState] = useState<ClockState>(initial)
  const [projectId, setProjectId] = useState(initial.projectId ?? '')
  const [taskId, setTaskId] = useState('')
  const [costCode, setCostCode] = useState(initial.costCodeRef ?? '')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [photoId, setPhotoId] = useState<string | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [queue, setQueue] = useState<QueuedEvent[]>([])
  const [replaying, setReplaying] = useState(false)
  const [search, setSearch] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setQueue(loadQueue())
  }, [])

  const refresh = useCallback(async () => {
    const res = await fetch('/api/time/clock', { credentials: 'same-origin' })
    if (!res.ok) return
    const day = (await res.json()) as { status: ClockState }
    if (day.status) {
      setState(day.status)
      setProjectId(day.status.projectId ?? '')
      setCostCode(day.status.costCodeRef ?? '')
    }
  }, [])

  const enqueue = useCallback((body: Record<string, unknown>) => {
    setQueue((prev) => {
      const next = [...prev, { key: uuid(), body }]
      storeQueue(next)
      return next
    })
  }, [])

  const send = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch('/api/time/clock', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          if (!navigator.onLine) {
            enqueue(body)
            return true
          }
          const payload = (await res.json().catch(() => null)) as { error?: string } | null
          setError(payload?.error ?? t('field.sendFailed'))
          return false
        }
        await refresh()
        return true
      } catch {
        enqueue(body)
        return true
      } finally {
        setBusy(false)
      }
    },
    [enqueue, refresh, t],
  )

  const locate = useCallback(
    (): Promise<{ lat: number; lng: number; accuracyM: number | null } | null> =>
      new Promise((resolve) => {
        if (!navigator.geolocation) {
          resolve(null)
          return
        }
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null }),
          () => resolve(null),
          { timeout: 8000, maximumAge: 60000 },
        )
      }),
    [],
  )

  const clock = useCallback(
    async (kind: 'clock_in' | 'clock_out' | 'break_start' | 'break_end' | 'switch') => {
      const geo = await locate()
      await send({
        kind,
        occurredAt: new Date().toISOString(),
        projectId: projectId || null,
        projectTaskId: taskId || null,
        costCodeRef: costCode.trim() || null,
        geo,
        photoFileId: photoId,
        clientEventId: uuid(),
      })
      setSheetOpen(false)
    },
    [locate, send, projectId, taskId, costCode, photoId],
  )

  const replay = useCallback(async () => {
    const pending = loadQueue()
    if (pending.length === 0 || replaying) return
    setReplaying(true)
    setError(null)
    try {
      const res = await fetch('/api/time/clock', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: pending.map((entry) => entry.body) }),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null
        setError(payload?.error ?? t('field.sendFailed'))
        return
      }
      const payload = (await res.json()) as { results: Array<{ error?: string }> }
      const failed = pending.filter((_, i) => payload.results[i]?.error)
      storeQueue(failed)
      setQueue(failed)
      const firstError = payload.results.find((result) => result.error)?.error
      if (firstError) setError(firstError)
      await refresh()
    } catch {
      setError(t('field.sendFailed'))
    } finally {
      setReplaying(false)
    }
  }, [replaying, refresh, t])

  const visibleProjects = search.trim()
    ? projects.filter((project) => `${project.code ?? ''} ${project.name}`.toLowerCase().includes(search.trim().toLowerCase()))
    : projects

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {state.clockedIn ? t('field.clockedInSince', { since: state.since ?? '' }) : t('field.clockedOut')}
        </p>
        {state.clockedIn ? (
          <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
            {[state.projectName, state.costCodeRef].filter(Boolean).join(' · ') || t('field.noProject')}
          </p>
        ) : null}
        {state.onBreak ? <p className="mt-1 text-sm font-medium text-amber-600">{t('field.onBreak')}</p> : null}
        <div className="mt-4 flex flex-col gap-2">
          {state.clockedIn ? (
            <>
              <Button disabled={busy} onClick={() => clock('clock_out')} className="w-full py-3 text-base">
                {busy ? t('field.working') : clockOutLabel}
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => clock(state.onBreak ? 'break_end' : 'break_start')}
                  className="flex-1"
                >
                  {state.onBreak ? t('field.endBreak') : t('field.startBreak')}
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => setSheetOpen(true)} className="flex-1">
                  {t('field.switch')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={() => (projectId ? clock('clock_in') : setSheetOpen(true))} className="w-full py-3 text-base">
                {busy ? t('field.working') : t('field.clockIn')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setSheetOpen(true)} className="w-full">
                {t('field.chooseProject')}
              </Button>
            </>
          )}
        </div>
        {photoRequired ? (
          <div className="mt-3">
            <Label htmlFor="field-clock-photo">{t('field.photoRequired')}</Label>
            <Input
              id="field-clock-photo"
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="user"
              disabled={photoBusy}
              onChange={async () => {
                const file = fileRef.current?.files?.[0]
                if (!file) {
                  setPhotoId(null)
                  return
                }
                // The capture uploads through the File Cabinet upload
                // route into the org's field-time folder; the file id
                // rides the next clock event for the service to verify.
                if (!photoFolderId) {
                  setError(t('field.photoFolderMissing'))
                  return
                }
                setPhotoBusy(true)
                setError(null)
                try {
                  const form = new FormData()
                  form.set('file', file)
                  form.set('folderId', photoFolderId)
                  const res = await fetch('/api/file-cabinet/files', {
                    method: 'POST',
                    credentials: 'same-origin',
                    body: form,
                  })
                  if (!res.ok) {
                    setError(t('field.photoUploadFailed'))
                    setPhotoId(null)
                    return
                  }
                  const payload = (await res.json()) as { file?: { id?: string } }
                  if (!payload.file?.id) {
                    setError(t('field.photoUploadFailed'))
                    setPhotoId(null)
                    return
                  }
                  setPhotoId(payload.file.id)
                } catch {
                  setError(t('field.photoUploadFailed'))
                  setPhotoId(null)
                } finally {
                  setPhotoBusy(false)
                }
              }}
            />
            {photoId ? <p className="mt-1 text-xs text-teal-700">{t('field.photoAttached')}</p> : null}
          </div>
        ) : null}
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{geoHint}</p>
      </div>

      {queue.length > 0 ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950" role="status">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            {t('field.offlineQueued', { count: queue.length })}
          </p>
          <Button variant="outline" disabled={replaying} onClick={replay} className="mt-2">
            {replaying ? t('field.replaying') : t('field.replayNow')}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {sheetOpen ? (
        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900" role="dialog" aria-label={t('field.chooseProject')}>
          <Label htmlFor="field-clock-search">{t('field.searchProjects')}</Label>
          <Input id="field-clock-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('field.searchPlaceholder')} />
          <div className="mt-3 max-h-56 space-y-1 overflow-y-auto">
            {visibleProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => setProjectId(project.id)}
                aria-pressed={projectId === project.id}
                className={
                  projectId === project.id
                    ? 'w-full rounded-lg bg-teal-50 px-3 py-2 text-left font-medium text-teal-800 dark:bg-teal-950 dark:text-teal-200'
                    : 'w-full rounded-lg px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800'
                }
              >
                {[project.code, project.name].filter(Boolean).join(' · ')}
              </button>
            ))}
          </div>
          {tasks.length > 0 ? (
            <div className="mt-3">
              <Label htmlFor="field-clock-task">{t('field.task')}</Label>
              <Select id="field-clock-task" value={taskId} onChange={(event) => setTaskId(event.target.value)}>
                <option value="">{t('field.noTask')}</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div className="mt-3">
            <Label htmlFor="field-clock-cost">{t('field.costCode')}</Label>
            <Input id="field-clock-cost" value={costCode} onChange={(event) => setCostCode(event.target.value)} placeholder={t('field.costCodePlaceholder')} />
          </div>
          <div className="mt-4 flex gap-2">
            <Button
              disabled={busy || !projectId}
              onClick={() => clock(state.clockedIn ? 'switch' : 'clock_in')}
              className="flex-1"
            >
              {state.clockedIn ? t('field.switch') : t('field.clockIn')}
            </Button>
            <Button variant="outline" onClick={() => setSheetOpen(false)} className="flex-1">
              {t('field.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
