'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label } from '@openbooks/ui'

interface KioskWorker {
  id: string
  name: string
}

const IDLE_SECONDS = 20

/**
 * The kiosk terminal: name search or a large-target PIN pad, clock
 * in/out against the kiosk's (optionally pinned) project, and an
 * auto-return to idle after twenty seconds. No app shell — this page
 * is the whole screen. Every event re-verifies the PIN.
 */
export function KioskTerminal({
  deviceToken,
  kioskName,
  projectId,
  projectName,
  pinRequired,
  workers,
  projects,
}: {
  deviceToken: string
  kioskName: string
  projectId: string | null
  projectName: string | null
  pinRequired: boolean
  workers: KioskWorker[]
  projects: { id: string; name: string }[]
}) {
  const t = useTranslations('timesheets')
  const [workerId, setWorkerId] = useState('')
  const [pin, setPin] = useState('')
  const [search, setSearch] = useState('')
  const [pickedProject, setPickedProject] = useState('')
  const [projectSearch, setProjectSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [idleIn, setIdleIn] = useState(IDLE_SECONDS)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const reset = useCallback(() => {
    setWorkerId('')
    setPin('')
    setSearch('')
    setPickedProject('')
    setProjectSearch('')
    setMessage(null)
    setError(null)
    setIdleIn(IDLE_SECONDS)
  }, [])

  useEffect(() => {
    timer.current = setInterval(() => {
      setIdleIn((prev) => {
        if (prev <= 1) {
          reset()
          return IDLE_SECONDS
        }
        return prev - 1
      })
    }, 1000)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [reset])

  const poke = useCallback(() => setIdleIn(IDLE_SECONDS), [])

  const act = useCallback(
    async (action: 'identify' | 'event', kind?: 'clock_in' | 'clock_out') => {
      if (!workerId || (pinRequired && !pin)) {
        setError(t('field.kioskNeedPin'))
        return
      }
      setBusy(true)
      setError(null)
      setMessage(null)
      try {
        const res = await fetch(`/api/time/kiosk/${deviceToken}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            action === 'identify'
              ? { action, employeePartyId: workerId, pin }
              : {
                  action,
                  employeePartyId: workerId,
                  pin,
                  kind,
                  occurredAt: new Date().toISOString(),
                  projectId: projectId ?? (pickedProject || null),
                  clientEventId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
                },
          ),
        })
        const payload = (await res.json().catch(() => null)) as { error?: string } | null
        if (!res.ok) {
          setError(payload?.error ?? t('field.sendFailed'))
          return
        }
        if (action === 'identify') {
          setMessage(t('field.kioskIdentified'))
        } else {
          setMessage(kind === 'clock_in' ? t('field.kioskClockedIn') : t('field.kioskClockedOut'))
          setTimeout(reset, 3000)
        }
      } catch {
        setError(t('field.sendFailed'))
      } finally {
        setBusy(false)
      }
    },
    [workerId, pin, pinRequired, deviceToken, projectId, pickedProject, reset, t],
  )

  const visible = search.trim()
    ? workers.filter((worker) => worker.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 8)
    : []
  const visibleProjects = !projectId && projectSearch.trim()
    ? projects.filter((project) => project.name.toLowerCase().includes(projectSearch.trim().toLowerCase())).slice(0, 8)
    : []

  const press = (digit: string) => {
    poke()
    if (pin.length < 10) setPin((prev) => prev + digit)
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 p-6" onPointerDown={poke}>
      <header className="text-center">
        <h1 className="text-2xl font-bold">{kioskName}</h1>
        <p className="text-sm text-slate-500">
          {projectName ?? t('field.kioskChooseProject')} · {t('field.kioskIdle', { seconds: idleIn })}
        </p>
      </header>

      <div>
        <Label htmlFor="kiosk-search">{t('field.kioskFindWorker')}</Label>
        <Input
          id="kiosk-search"
          value={search}
          onChange={(event) => {
            poke()
            setSearch(event.target.value)
          }}
          placeholder={t('field.kioskSearchPlaceholder')}
          autoComplete="off"
        />
        {visible.length > 0 ? (
          <div className="mt-2 space-y-1">
            {visible.map((worker) => (
              <button
                key={worker.id}
                type="button"
                onClick={() => {
                  poke()
                  setWorkerId(worker.id)
                  setSearch(worker.name)
                }}
                className={
                  workerId === worker.id
                    ? 'w-full rounded-xl bg-teal-600 px-4 py-3 text-left text-lg font-medium text-white'
                    : 'w-full rounded-xl border px-4 py-3 text-left text-lg hover:bg-slate-50'
                }
              >
                {worker.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {!projectId ? (
        <div>
          <Label htmlFor="kiosk-project">{t('field.kioskProject')}</Label>
          <Input
            id="kiosk-project"
            value={projectSearch}
            onChange={(event) => {
              poke()
              setProjectSearch(event.target.value)
            }}
            placeholder={t('field.kioskProjectPlaceholder')}
            autoComplete="off"
          />
          {visibleProjects.length > 0 ? (
            <div className="mt-2 space-y-1">
              {visibleProjects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => {
                    poke()
                    setPickedProject(project.id)
                    setProjectSearch(project.name)
                  }}
                  className={
                    pickedProject === project.id
                      ? 'w-full rounded-xl bg-teal-600 px-4 py-3 text-left text-lg font-medium text-white'
                      : 'w-full rounded-xl border px-4 py-3 text-left text-lg hover:bg-slate-50'
                  }
                >
                  {project.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {pinRequired ? (
        <div>
          <Label>{t('field.kioskPin')}</Label>
          <p className="mb-2 text-center text-3xl font-mono tracking-widest" aria-live="polite">
            {'•'.repeat(pin.length) || '–'}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  if (key === 'C') setPin('')
                  else if (key === '⌫') setPin((prev) => prev.slice(0, -1))
                  else press(key)
                }}
                className="rounded-xl border px-4 py-4 text-2xl font-semibold hover:bg-slate-50 active:bg-slate-100"
              >
                {key}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {message ? (
        <p className="rounded-xl bg-teal-50 p-4 text-center text-lg font-medium text-teal-800" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-xl bg-red-50 p-4 text-center text-lg font-medium text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-auto grid grid-cols-2 gap-3 pb-4">
        <Button disabled={busy || !workerId} onClick={() => act('event', 'clock_in')} className="py-4 text-xl">
          {t('field.clockIn')}
        </Button>
        <Button disabled={busy || !workerId} onClick={() => act('event', 'clock_out')} variant="outline" className="py-4 text-xl">
          {t('field.clockOut')}
        </Button>
      </div>
    </div>
  )
}
