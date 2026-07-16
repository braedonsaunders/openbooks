'use client'

// Out-of-office delegation self-service over /api/flows/delegations. Two
// pieces:
//
//   • OutOfOfficeButton — header action opening a small drawer (delegate user
//     + from/until dates) that POSTs { toUserId, startsAt, endsAt }.
//   • DelegationBanner  — GETs my delegations on mount and, when one I GAVE
//     is currently active, renders "delegated to X until Y — End now"
//     (DELETE /api/flows/delegations?id=…).
//
// The endpoint is deployed separately: every call is wrapped and a
// 404/network failure degrades to a graceful toast (button) or renders
// nothing (banner). The two components sync through a window event so
// saving/ending updates the banner without a full reload.

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import type { DelegateOption } from './GateActions'

const CHANGED_EVENT = 'ob:delegations-changed'

interface Delegation {
  id: string
  toUserId: string
  toUserName?: string | null
  startsAt?: string | null
  endsAt?: string | null
  /** 'given' = I delegated my approvals; 'received' = someone delegated to me. */
  direction?: 'given' | 'received'
  phase?: 'active' | 'upcoming'
}

/** A delegation I gave that is in effect right now. */
function isActiveGiven(d: Delegation, now: number): boolean {
  if (d.direction && d.direction !== 'given') return false
  if (d.phase) return d.phase === 'active'
  const starts = d.startsAt ? new Date(d.startsAt).getTime() : null
  const ends = d.endsAt ? new Date(d.endsAt).getTime() : null
  if (starts !== null && starts > now) return false
  if (ends !== null && ends < now) return false
  return true
}

export function OutOfOfficeButton({ users }: { users: DelegateOption[] }) {
  const t = useTranslations('approvals.ooo')
  const tc = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toUserId, setToUserId] = useState('')
  const [from, setFrom] = useState('')
  const [until, setUntil] = useState('')

  async function save() {
    if (!toUserId || !from || !until || until < from) {
      toast.error(t('invalid'))
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/flows/delegations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toUserId,
          startsAt: new Date(`${from}T00:00:00`).toISOString(),
          endsAt: new Date(`${until}T23:59:59`).toISOString(),
        }),
      })
      if (res.status === 404) {
        toast.info(t('unavailable'))
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error ?? t('unavailable'))
      } else {
        toast.success(t('saved'))
        setOpen(false)
        setToUserId('')
        setFrom('')
        setUntil('')
        window.dispatchEvent(new Event(CHANGED_EVENT))
      }
    } catch {
      toast.info(t('unavailable'))
    }
    setBusy(false)
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('button')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t('title')}
        description={t('description')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              {tc('actions.cancel')}
            </Button>
            <Button disabled={busy} onClick={save}>
              {tc('actions.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ooo-delegate">{t('delegateTo')}</Label>
            <Select
              id="ooo-delegate"
              value={toUserId}
              onChange={(e) => setToUserId(e.target.value)}
            >
              <option value="">{t('delegatePlaceholder')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ooo-from">{t('from')}</Label>
              <Input
                id="ooo-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ooo-until">{t('until')}</Label>
              <Input
                id="ooo-until"
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </div>
          </div>
        </div>
      </Drawer>
    </>
  )
}

export function DelegationBanner({ users }: { users: DelegateOption[] }) {
  const t = useTranslations('approvals.ooo')
  const [active, setActive] = useState<Delegation | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/flows/delegations')
      if (!res.ok) return // 404 = endpoint not built yet — render nothing
      const data = (await res.json().catch(() => ({}))) as { delegations?: Delegation[] }
      const now = Date.now()
      setActive((data.delegations ?? []).find((d) => isActiveGiven(d, now)) ?? null)
    } catch {
      // network failure — banner stays hidden
    }
  }, [])

  useEffect(() => {
    void load()
    const onChanged = () => void load()
    window.addEventListener(CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(CHANGED_EVENT, onChanged)
  }, [load])

  if (!active) return null

  const name =
    active.toUserName ?? users.find((u) => u.id === active.toUserId)?.name ?? active.toUserId
  const date = active.endsAt ? String(active.endsAt).slice(0, 10) : '—'

  async function endNow() {
    if (!active) return
    setBusy(true)
    try {
      const res = await fetch(`/api/flows/delegations?id=${active.id}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.info(t('unavailable'))
      } else {
        toast.success(t('ended'))
        setActive(null)
        window.dispatchEvent(new Event(CHANGED_EVENT))
      }
    } catch {
      toast.info(t('unavailable'))
    }
    setBusy(false)
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
      <span>{t('banner', { name, date })}</span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={endNow}>
        {t('endNow')}
      </Button>
    </div>
  )
}
