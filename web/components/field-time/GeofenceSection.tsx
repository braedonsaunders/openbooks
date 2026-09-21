'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label } from '@openbooks/ui'

export interface GeofenceRow {
  id: string
  kind: 'circle' | 'polygon'
  center: { lat: number; lng: number } | null
  radiusM: number | null
  polygon: Array<{ lat: number; lng: number }> | null
  isActive: boolean
}

/**
 * Project geofences, rehomed onto the project page: one circle and one
 * polygon per project, never two sources of truth. Circles edit as
 * center + radius with a use-my-location shortcut; polygons edit as
 * one lat,lng corner per line.
 */
export function GeofenceSection({
  projectId,
  initial,
  canManage,
}: {
  projectId: string
  initial: GeofenceRow[]
  canManage: boolean
}) {
  const t = useTranslations('timesheets')
  const [fences, setFences] = useState<GeofenceRow[]>(initial)
  const [visible, setVisible] = useState(true)
  const [kind, setKind] = useState<'circle' | 'polygon'>('circle')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [radius, setRadius] = useState('100')
  const [corners, setCorners] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const res = await fetch(`/api/time/geofences?projectId=${projectId}`, { credentials: 'same-origin' })
    // A 404 is the feature-off path (or no grant): the section hides,
    // never an empty or forbidden panel.
    if (res.status === 404 || res.status === 403) {
      setVisible(false)
      return
    }
    if (!res.ok) return
    const payload = (await res.json()) as { geofences: GeofenceRow[] }
    setFences(payload.geofences)
  }, [projectId])

  // Mount load through a promise chain (approval-actions precedent):
  // state settles in the continuation, never synchronously in the body.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/time/geofences?projectId=${projectId}`, { credentials: 'same-origin' })
      .then((res) => {
        if (res.status === 404 || res.status === 403) {
          if (!cancelled) setVisible(false)
          return null
        }
        return res.ok ? res.json() : null
      })
      .then((payload: { geofences: GeofenceRow[] } | null) => {
        if (!cancelled && payload) setFences(payload.geofences)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId])

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const body =
        kind === 'circle'
          ? {
              projectId,
              kind,
              center: { lat: Number(lat), lng: Number(lng) },
              radiusM: Number(radius),
              polygon: null,
            }
          : {
              projectId,
              kind,
              center: null,
              radiusM: null,
              polygon: corners
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const [a, b] = line.split(',').map((part) => Number(part.trim()))
                  return { lat: a, lng: b }
                }),
            }
      const res = await fetch('/api/time/geofences', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        setError(payload?.error ?? t('field.sendFailed'))
        return
      }
      await reload()
    } catch {
      setError(t('field.sendFailed'))
    } finally {
      setBusy(false)
    }
  }, [kind, lat, lng, radius, corners, projectId, reload, t])

  const remove = useCallback(
    async (id: string) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch('/api/time/geofences', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id }),
        })
        const payload = (await res.json().catch(() => null)) as { error?: string } | null
        if (!res.ok) {
          setError(payload?.error ?? t('field.sendFailed'))
          return
        }
        await reload()
      } catch {
        setError(t('field.sendFailed'))
      } finally {
        setBusy(false)
      }
    },
    [reload, t],
  )

  const useLocation = useCallback(() => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        setLat(String(pos.coords.latitude))
        setLng(String(pos.coords.longitude))
      },
      () => setError(t('field.locationDenied')),
      { timeout: 8000 },
    )
  }, [t])

  if (!visible) return null
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('field.geofencesTitle')}</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('field.geofencesHint')}</p>
      </div>
      {fences.length === 0 ? <p className="text-sm text-slate-500">{t('field.noGeofences')}</p> : null}
      <ul className="space-y-2">
        {fences.map((fence) => (
          <li key={fence.id} className="flex items-center gap-2 rounded-lg border border-slate-100 p-3 text-sm dark:border-slate-800">
            <span className="font-medium">{fence.kind === 'circle' ? t('field.circle') : t('field.polygon')}</span>
            <span className="text-slate-500">
              {fence.kind === 'circle'
                ? `${fence.center?.lat ?? '–'}, ${fence.center?.lng ?? '–'} · ${fence.radiusM ?? '–'} m`
                : `${fence.polygon?.length ?? 0} ${t('field.corners')}`}
            </span>
            {!fence.isActive ? <span className="text-xs text-slate-400">{t('field.inactive')}</span> : null}
            {canManage ? (
              <Button variant="outline" disabled={busy} onClick={() => remove(fence.id)} className="ml-auto">
                {t('field.removeGeofence')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
      <div className="grid gap-2 rounded-lg border border-slate-100 p-3 dark:border-slate-800">
        <div className="flex gap-2">
          <Button variant={kind === 'circle' ? undefined : 'outline'} onClick={() => setKind('circle')}>
            {t('field.circle')}
          </Button>
          <Button variant={kind === 'polygon' ? undefined : 'outline'} onClick={() => setKind('polygon')}>
            {t('field.polygon')}
          </Button>
        </div>
        {kind === 'circle' ? (
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label>{t('field.latitude')}</Label>
              <Input value={lat} onChange={(event) => setLat(event.target.value)} inputMode="decimal" />
            </div>
            <div>
              <Label>{t('field.longitude')}</Label>
              <Input value={lng} onChange={(event) => setLng(event.target.value)} inputMode="decimal" />
            </div>
            <div>
              <Label>{t('field.radiusM')}</Label>
              <Input value={radius} onChange={(event) => setRadius(event.target.value)} inputMode="numeric" />
            </div>
          </div>
        ) : (
          <div>
            <Label>{t('field.cornersLabel')}</Label>
            <textarea
              value={corners}
              onChange={(event) => setCorners(event.target.value)}
              rows={4}
              placeholder={t('field.cornersPlaceholder')}
              className="w-full rounded-lg border border-slate-200 bg-transparent p-2 font-mono text-sm dark:border-slate-700"
            />
          </div>
        )}
        <div className="flex gap-2">
          {kind === 'circle' ? (
            <Button variant="outline" onClick={useLocation}>
              {t('field.useLocation')}
            </Button>
          ) : null}
          <Button disabled={busy} onClick={save}>
            {busy ? t('field.working') : t('field.saveGeofence')}
          </Button>
        </div>
      </div>
      ) : null}
      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
