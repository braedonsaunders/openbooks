'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select } from '@openbooks/ui';
import { chunkArray, readApiErrorMessage } from "../../lib/api-error";
import { isUuid } from "../../lib/list-params";

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

function loadQueue(ownerKey: string): {
  events: QueuedEvent[];
  storageFailed: boolean;
} {
  if (typeof window === 'undefined') return { events: [], storageFailed: false };
  try {
    const raw = localStorage.getItem(`${QUEUE_KEY}.${ownerKey}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (entry) =>
          !entry ||
          typeof entry.key !== "string" ||
          entry.body?.ownerKey !== ownerKey,
      )
    ) {
      return { events: [], storageFailed: true };
    }
    return { events: parsed, storageFailed: false };
  } catch {
    return { events: [], storageFailed: true };
  }
}

function hasLegacyQueue(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return !!raw && raw !== "[]";
  } catch {
    return false;
  }
}

function exportLegacyQueue() {
  const raw = localStorage.getItem(QUEUE_KEY);
  if (!raw) return;
  const url = URL.createObjectURL(
    new Blob([raw], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "unassigned-clock-events.json";
  link.click();
  URL.revokeObjectURL(url);
}

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * The clock island: one state card, one primary button, a
 * project/task/cost-code picker sheet, break and switch actions, and an
 * offline queue in localStorage that replays through the same API with
 * per-event results. Photo capture rides the native file input when the
 * org requires a photo.
 */
export function ClockControls({
  ownerKey,
  initial,
  projects,
  tasks,
  photoRequired,
  photoFolderId,
  geoHint,
  clockOutLabel,
}: {
  ownerKey: string;
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
  const [loaded, setLoaded] = useState({ events: [] as QueuedEvent[], storageFailed: false });
  const [ready, setReady] = useState(false);
  const [queue, setQueue] = useState<QueuedEvent[]>([]);
  const queueRef = useRef(queue);
  const replayingRef = useRef(false);
  const [storageFailed, setStorageFailed] = useState(loaded.storageFailed);
  const [legacyQueue, setLegacyQueue] = useState(false)
  const [replaying, setReplaying] = useState(false)
  const [stale, setStale] = useState(false)
  const [search, setSearch] = useState('')
  useEffect(() => {
    let mounted = true
    queueMicrotask(() => {
      if (!mounted) return
      const stored = loadQueue(ownerKey)
      queueRef.current = stored.events
      setLoaded(stored)
      setQueue(stored.events)
      setStorageFailed(stored.storageFailed)
      setLegacyQueue(hasLegacyQueue())
      setReady(true)
    })
    return () => { mounted = false }
  }, [ownerKey])

  const fileRef = useRef<HTMLInputElement>(null)

  // Refresh reports whether today's state could be re-read. A POST that is
  // known-recorded must never be re-enqueued merely because this GET failed,
  // so callers branch on the boolean instead of throwing.
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/time/clock', { credentials: 'same-origin' })
      if (!res.ok) return false
      const day = (await res.json()) as { status: ClockState }
      if (day.status) {
        setState(day.status)
        setProjectId(day.status.projectId ?? '')
        setCostCode(day.status.costCodeRef ?? '')
      }
      return true
    } catch {
      return false
    }
  }, [])

  const commitQueue = useCallback(
    (next: QueuedEvent[]) => {
      queueRef.current = next;
      setQueue(next);
      try {
        // Never overwrite a stored queue that could not be read or validated.
        if (loaded.storageFailed) {
          setStorageFailed(true);
          return;
        }
        localStorage.setItem(`${QUEUE_KEY}.${ownerKey}`, JSON.stringify(next));
        setStorageFailed(false);
      } catch {
        setStorageFailed(true);
      }
    },
    [ownerKey, loaded.storageFailed],
  );

  const enqueue = useCallback((body: Record<string, unknown>) => {
    commitQueue([...queueRef.current, { key: String(body.clientEventId), body }])
  }, [commitQueue])

  const send = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      setBusy(true)
      setError(null)
      setStale(false)
      try {
        let res: Response
        try {
          res = await fetch('/api/time/clock', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        } catch {
          // POST transport is uncertain — the event may never have reached
          // the server, so the offline queue owns it.
          enqueue(body)
          return true
        }
        if (!res.ok) {
          // A server failure can arrive after commit; retry the same offline
          // id instead of issuing a second event with a new id.
          if (res.status >= 500) enqueue(body)
          setError(await readApiErrorMessage(res, t('field.sendFailed')))
          return res.status >= 500
        }
        // The POST is known-recorded from here: a refresh failure below
        // raises the stale notice and never re-enqueues this event.
        setStale(!(await refresh()))
        return true
      } finally {
        setBusy(false)
      }
    },
    [enqueue, refresh, t],
  )

  const retryRefresh = useCallback(async () => {
    setBusy(true)
    try {
      setStale(!(await refresh()))
    } finally {
      setBusy(false)
    }
  }, [refresh])

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
      const geo = await locate();
      const sent = await send({
        ownerKey,
        kind,
        occurredAt: new Date().toISOString(),
        projectId: projectId || null,
        projectTaskId: taskId || null,
        costCodeRef: costCode.trim() || null,
        geo,
        photoFileId: photoId,
        clientEventId: uuid(),
      });
      if (sent) setSheetOpen(false)
    },
    [ownerKey, locate, send, projectId, taskId, costCode, photoId],
  )

  const replay = useCallback(async () => {
    const pending = [...queueRef.current]
    if (pending.length === 0 || replayingRef.current) return
    replayingRef.current = true
    setReplaying(true)
    setError(null)
    setStale(false)
    try {
      for (const batch of chunkArray(pending, 200)) {
        const res = await fetch('/api/time/clock', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ownerKey,
            events: batch.map((entry) => entry.body),
          }),
        })
        if (!res.ok) {
          setError(await readApiErrorMessage(res, t('field.sendFailed')))
          return
        }
        const payload = (await res.json()) as {
          results?: Array<{ eventId?: string; error?: string }>
        }
        const results = Array.isArray(payload.results) ? payload.results : []
        // Only an explicit recording acknowledges an event. Missing results,
        // refusals and events added during this request remain pending.
        const acknowledged = new Set(
          batch
            .filter(
              (_, index) =>
                isUuid(results[index]?.eventId) && !results[index]?.error,
            )
            .map((entry) => entry.key),
        )
        commitQueue(
          queueRef.current.filter((entry) => !acknowledged.has(entry.key)),
        )
        if (acknowledged.size !== batch.length) {
          setError(
            results.find((result) => result?.error)?.error ??
              t('field.sendFailed'),
          )
          return
        }
      }
      setStale(!(await refresh()))
    } catch {
      setError(t('field.sendFailed'))
    } finally {
      replayingRef.current = false
      setReplaying(false)
    }
  }, [ownerKey, commitQueue, refresh, t])

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
        {state.onBreak ? (
          <p className="mt-1 text-sm font-medium text-amber-600">
            {t('field.onBreak')}
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-2">
          {state.clockedIn ? (
            <>
              <Button disabled={busy || !ready} onClick={() => clock('clock_out')} className="w-full py-3 text-base">
                {busy ? t('field.working') : clockOutLabel}
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={busy || !ready}
                  onClick={() => clock(state.onBreak ? 'break_end' : 'break_start')}
                  className="flex-1"
                >
                  {state.onBreak ? t('field.endBreak') : t('field.startBreak')}
                </Button>
                <Button variant="outline" disabled={busy || !ready} onClick={() => setSheetOpen(true)} className="flex-1">
                  {t('field.switch')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button disabled={busy || !ready} onClick={() =>
                  projectId ? clock('clock_in') : setSheetOpen(true)} className="w-full py-3 text-base">
                {busy ? t('field.working') : t('field.clockIn')}
              </Button>
              <Button variant="outline" disabled={busy || !ready} onClick={() => setSheetOpen(true)} className="w-full">
                {t('field.chooseProject')}
              </Button>
            </>
          )}
        </div>
        {photoRequired ? (
          <div className="mt-3">
            <Label htmlFor="field-clock-photo">
              {t('field.photoRequired')}
            </Label>
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
            {photoId ? (
              <p className="mt-1 text-xs text-teal-700">
                {t('field.photoAttached')}
              </p>
            ) : null}
          </div>
        ) : null}
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          {geoHint}
        </p>
      </div>

      {legacyQueue ? (
        <div role="alert" className="rounded-xl border border-amber-300 p-4">
          <p>{t("field.legacyQueue")}</p>
          <Button
            variant="outline"
            onClick={() => {
              try {
                exportLegacyQueue();
              } catch {
                setError(t("field.sendFailed"));
              }
            }}
          >
            {t("field.exportLegacyQueue")}
          </Button>
        </div>
      ) : null}
      {storageFailed ? <p role="alert">{t("field.storageFailed")}</p> : null}
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

      {stale ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950" role="status">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            {t('field.staleState')}
          </p>
          <Button variant="outline" disabled={busy || !ready} onClick={retryRefresh} className="mt-2">
            {t('field.refreshNow')}
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
          <Label htmlFor="field-clock-search">
            {t('field.searchProjects')}
          </Label>
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
              disabled={busy || !ready || !projectId}
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
