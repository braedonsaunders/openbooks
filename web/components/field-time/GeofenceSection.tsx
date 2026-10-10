'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { MapPin } from 'lucide-react'
import { Badge, Button, Drawer, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { Field } from '@/components/field'
import { DrawerSublist, SublistAddButton, SublistEmpty, SublistLoadError } from '@/components/drawer-sublist'

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
 * one lat,lng corner per line, in the Add geofence drawer.
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
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [kind, setKind] = useState<'circle' | 'polygon'>('circle')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [radius, setRadius] = useState('100')
  const [corners, setCorners] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/time/geofences?projectId=${projectId}`, { credentials: 'same-origin' })
      // A 404 is the feature-off path (or no grant): the section hides,
      // never an empty or forbidden panel.
      if (res.status === 404 || res.status === 403) {
        setVisible(false)
        setLoaded(true)
        return
      }
      if (!res.ok) throw new Error('geofences could not be loaded')
      const payload = (await res.json()) as { geofences: GeofenceRow[] }
      setFences(payload.geofences)
      setLoadError(false)
      setLoaded(true)
    } catch {
      setLoadError(true)
      setLoaded(true)
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    Promise.resolve().then(() => {
      if (!cancelled) void reload()
    })
    return () => {
      cancelled = true
    }
  }, [reload])

  const save = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      // Blank inputs must be refused by name before numeric conversion:
      // Number('') is 0, so an unchecked conversion would persist a fence
      // at (0,0). Zero itself stays valid — only the missing string refuses.
      // Tuple members read through ?? '' because noUncheckedIndexedAccess
      // types them string|undefined.
      let body: Record<string, unknown>
      if (kind === 'circle') {
        if (lat.trim() === '' || lng.trim() === '') {
          setError(t('field.coordsRequired'))
          return
        }
        const center = { lat: Number(lat), lng: Number(lng) }
        if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {
          setError(t('field.coordsRequired'))
          return
        }
        body = { projectId, kind, center, radiusM: Number(radius), polygon: null }
      } else {
        const polygon: Array<{ lat: number; lng: number }> = []
        for (const line of corners.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
          const parts = line.split(',')
          const latText = parts[0]?.trim() ?? ''
          const lngText = parts[1]?.trim() ?? ''
          if (parts.length !== 2 || latText === '' || lngText === '') {
            setError(t('field.cornersInvalid'))
            return
          }
          const corner = { lat: Number(latText), lng: Number(lngText) }
          if (!Number.isFinite(corner.lat) || !Number.isFinite(corner.lng)) {
            setError(t('field.cornersInvalid'))
            return
          }
          polygon.push(corner)
        }
        body = { projectId, kind, center: null, radiusM: null, polygon }
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
      setAdding(false)
      setLat('')
      setLng('')
      setCorners('')
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
  const errorAlert = error ? (
    <p className="text-sm text-red-600 dark:text-red-400" role="alert">
      {error}
    </p>
  ) : null
  return (
    <DrawerSublist
      title={t('field.geofencesTitle')}
      description={t('field.geofencesHint')}
      icon={<MapPin size={16} />}
      action={canManage ? <SublistAddButton label={t('field.addGeofence')} onClick={() => { setError(null); setAdding(true) }} /> : undefined}
      alert={adding ? null : errorAlert}
    >
      {loadError ? (
        <SublistLoadError message={t('field.geofenceLoadFailed')} onRetry={() => void reload()} />
      ) : loaded && fences.length === 0 ? (
        <SublistEmpty icon={<MapPin size={22} />} text={t('field.noGeofences')} />
      ) : fences.length > 0 ? (
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t('field.shape')}</TableHead>
            <TableHead>{t('field.area')}</TableHead>
            <TableHead>{t('field.status')}</TableHead>
            {canManage ? <TableHead className="text-right" /> : null}
          </TableRow></TableHeader>
          <TableBody>
            {fences.map((fence) => (
              <TableRow key={fence.id}>
                <TableCell className="font-medium">{fence.kind === 'circle' ? t('field.circle') : t('field.polygon')}</TableCell>
                <TableCell className="text-slate-500 tabular-nums">
                  {fence.kind === 'circle'
                    ? `${fence.center?.lat ?? '–'}, ${fence.center?.lng ?? '–'} · ${fence.radiusM ?? '–'} m`
                    : `${fence.polygon?.length ?? 0} ${t('field.corners')}`}
                </TableCell>
                <TableCell>{fence.isActive ? <Badge variant="success">{t('field.activeBadge')}</Badge> : <Badge variant="secondary">{t('field.inactiveBadge')}</Badge>}</TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(fence.id)}>
                      {t('field.removeGeofence')}
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      {canManage ? (
        <Drawer
          open={adding}
          onClose={() => { if (!busy) setAdding(false) }}
          stacked
          size="md"
          title={t('field.addGeofence')}
          description={t('field.geofencesHint')}
          footer={(
            <>
              <Button variant="outline" disabled={busy} onClick={() => setAdding(false)}>{t('field.cancel')}</Button>
              <Button disabled={busy} onClick={save}>{busy ? t('field.working') : t('field.saveGeofence')}</Button>
            </>
          )}
        >
          <div className="grid gap-3">
            {errorAlert}
            <div className="flex gap-2">
              <Button variant={kind === 'circle' ? undefined : 'outline'} onClick={() => setKind('circle')}>
                {t('field.circle')}
              </Button>
              <Button variant={kind === 'polygon' ? undefined : 'outline'} onClick={() => setKind('polygon')}>
                {t('field.polygon')}
              </Button>
            </div>
            {kind === 'circle' ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Field label={t('field.latitude')}>
                    <Input value={lat} onChange={(event) => setLat(event.target.value)} inputMode="decimal" />
                  </Field>
                  <Field label={t('field.longitude')}>
                    <Input value={lng} onChange={(event) => setLng(event.target.value)} inputMode="decimal" />
                  </Field>
                  <Field label={t('field.radiusM')}>
                    <Input value={radius} onChange={(event) => setRadius(event.target.value)} inputMode="numeric" />
                  </Field>
                </div>
                <div>
                  <Button variant="outline" onClick={useLocation}>
                    {t('field.useLocation')}
                  </Button>
                </div>
              </>
            ) : (
              <Field label={t('field.cornersLabel')}>
                <textarea
                  value={corners}
                  onChange={(event) => setCorners(event.target.value)}
                  rows={4}
                  placeholder={t('field.cornersPlaceholder')}
                  className="w-full rounded-lg border border-slate-200 bg-transparent p-2 font-mono text-sm dark:border-slate-700"
                />
              </Field>
            )}
          </div>
        </Drawer>
      ) : null}
    </DrawerSublist>
  )
}
