'use client'

// Header notifications bell — the in-app inbox (`notifications` table: flow
// notify actions, gate assignment/reminder/escalation, delegation). A badge
// shows the unread count; the dropdown lists the latest entries. Light
// polling only (refresh on open + a 60s interval) — no sockets.

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Bell } from 'lucide-react'
import { Popover, cn } from '@openbooks/ui'

interface NotificationItem {
  id: string
  kind: string
  title: string
  body: string | null
  href: string | null
  readAt: string | null
  createdAt: string
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function NotificationsBell() {
  const t = useTranslations('shell.notifications')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications')
      if (!res.ok) return
      const data = await res.json()
      setItems(Array.isArray(data.items) ? data.items : [])
      setUnread(typeof data.unread === 'number' ? data.unread : 0)
    } catch {
      // transient — the next poll retries
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 60_000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  async function markRead(ids: string[] | 'all') {
    await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids === 'all' ? { all: true } : { ids }),
    }).catch(() => {})
    void refresh()
  }

  function openItem(n: NotificationItem) {
    setOpen(false)
    if (!n.readAt) void markRead([n.id])
    if (n.href) router.push(n.href)
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-80"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={t('ariaLabel')}
          aria-expanded={open}
          aria-haspopup="menu"
          className="relative grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Bell size={17} />
          {unread > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
      }
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2.5 dark:border-slate-800">
        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('title')}</span>
        {unread > 0 ? (
          <button
            type="button"
            onClick={() => void markRead('all')}
            className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            {t('markAllRead')}
          </button>
        ) : null}
      </div>
      <div className="max-h-96 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            {t('empty')}
          </p>
        ) : (
          items.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => openItem(n)}
              className={cn(
                'flex w-full flex-col gap-0.5 border-b border-slate-50 px-3 py-2.5 text-left last:border-b-0 hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/60',
                !n.readAt && 'bg-slate-50/70 dark:bg-slate-800/40',
              )}
            >
              <span className="flex items-start gap-2">
                <span
                  className={cn(
                    'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                    n.readAt ? 'bg-transparent' : 'bg-blue-500',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block truncate text-sm text-slate-900 dark:text-slate-100',
                      !n.readAt && 'font-medium',
                    )}
                  >
                    {n.title}
                  </span>
                  {n.body ? (
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {n.body}
                    </span>
                  ) : null}
                  <span className="block text-[11px] text-slate-400 dark:text-slate-500">
                    {timeLabel(n.createdAt)}
                  </span>
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </Popover>
  )
}
