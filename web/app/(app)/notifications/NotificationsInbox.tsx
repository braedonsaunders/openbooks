'use client'

// The in-app inbox list. Rows come from the loader already formatted; this
// component owns only what a server component cannot: marking rows read and
// following a notification to the record it points at.
//
// Reading is a self-scoped write against /api/notifications (the same route
// the header bell used before the inbox moved onto its own page), followed by
// router.refresh() so the server-rendered counts and tabs re-resolve.

import { useCallback, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { cn } from '@openbooks/ui'

export interface NotificationRow {
  id: string
  title: string
  body: string | null
  href: string | null
  kindLabel: string
  when: string
  read: boolean
}

async function markRead(body: { ids: string[] } | { all: true }): Promise<void> {
  await fetch('/api/notifications', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function NotificationsInbox({ rows }: { rows: NotificationRow[] }) {
  const t = useTranslations('shell.notifications')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Rows the reader has just marked read: the refresh that follows is a round
  // trip, and a dot that lingers until it lands reads as a failed click.
  const [justRead, setJustRead] = useState<Record<string, true>>({})

  const read = useCallback(
    (id: string) => {
      setJustRead((prev) => ({ ...prev, [id]: true }))
      startTransition(async () => {
        await markRead({ ids: [id] })
        router.refresh()
      })
    },
    [router],
  )

  function open(row: NotificationRow) {
    if (!row.read && !justRead[row.id]) read(row.id)
    if (row.href) router.push(row.href as never)
  }

  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
      {rows.map((row) => {
        const unread = !row.read && !justRead[row.id]
        const clickable = Boolean(row.href)
        return (
          <li key={row.id} className="flex items-start gap-3 px-4 py-3">
            <span
              aria-hidden
              className={cn(
                'mt-2 h-2 w-2 shrink-0 rounded-full',
                unread ? 'bg-blue-500' : 'bg-transparent',
              )}
            />
            <div className="min-w-0 flex-1">
              {clickable ? (
                <button
                  type="button"
                  onClick={() => open(row)}
                  className="block w-full text-left"
                >
                  <RowBody row={row} unread={unread} />
                </button>
              ) : (
                <RowBody row={row} unread={unread} />
              )}
            </div>
            {unread ? (
              <button
                type="button"
                onClick={() => read(row.id)}
                disabled={pending}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                <Check size={13} aria-hidden />
                {t('markRead')}
              </button>
            ) : (
              <span className="shrink-0 px-2 py-1 text-xs text-slate-400 dark:text-slate-500">
                {t('readLabel')}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function RowBody({ row, unread }: { row: NotificationRow; unread: boolean }) {
  return (
    <>
      <span
        className={cn(
          'block text-sm text-slate-900 dark:text-slate-100',
          unread && 'font-medium',
        )}
      >
        {row.title}
      </span>
      {row.body ? (
        <span className="mt-0.5 block text-sm text-slate-600 dark:text-slate-400">{row.body}</span>
      ) : null}
      <span className="mt-1 flex items-center gap-2 text-[11px] text-slate-400 dark:text-slate-500">
        <span>{row.kindLabel}</span>
        <span aria-hidden>·</span>
        <span>{row.when}</span>
      </span>
    </>
  )
}

/** Header action: clears every unread row in the org for the signed-in user. */
export function NotificationsMarkAllRead({ unread }: { unread: number }) {
  const t = useTranslations('shell.notifications')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  if (unread <= 0) return null
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await markRead({ all: true })
          router.refresh()
        })
      }
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      <Check size={15} aria-hidden />
      {t('markAllRead')}
    </button>
  )
}
