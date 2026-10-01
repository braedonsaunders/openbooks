'use client'

// The in-app inbox list. Rows come from the loader already formatted; this
// component owns only what a server component cannot: marking rows read and
// following a notification to the record it points at.
//
// Reading is a self-scoped write against /api/notifications (the same route
// the header bell used before the inbox moved onto its own page), followed by
// router.refresh() so the server-rendered counts and tabs re-resolve.

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { Check } from 'lucide-react'
import { PagedTable } from '../../../components/paged-table'
import { Alert, Button, cn } from '@openbooks/ui'
import { useAppAction } from '../../../lib/use-app-action'

export interface NotificationRow {
  id: string
  title: string
  body: string | null
  href: string | null
  kindLabel: string
  when: string
  read: boolean
}

function markRead(body: { ids: string[] } | { all: true }) {
  return fetchAction('/api/notifications', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function NotificationsInbox({ rows }: { rows: NotificationRow[] }) {
  const t = useTranslations('shell.notifications')
  const router = useRouter()
  const { busy, execute } = useAppAction()
  const [failure, setFailure] = useState<string | null>(null)
  // Rows the reader has just marked read: the refresh that follows is a round
  // trip, and a dot that lingers until it lands reads as a failed click.
  const [justRead, setJustRead] = useState<Record<string, true>>({})

  const read = useCallback(
    (id: string) => {
      setFailure(null)
      void execute(() => markRead({ ids: [id] }), {
        fallbackMessage: t('markFailed'),
        onRefused: (error) => setFailure(error.displayMessage(t('markFailed'))),
        onOk: () => {
          setJustRead((prev) => ({ ...prev, [id]: true }))
          router.refresh()
        },
      })
    },
    [execute, router, t],
  )

  function open(row: NotificationRow) {
    if (!row.read && !justRead[row.id]) read(row.id)
    if (row.href) router.push(row.href as never)
  }

  return (
    <div className="space-y-3">
      {failure ? <Alert variant="destructive">{failure}</Alert> : null}
      <PagedTable
        source="notifications"
        rows={rows}
        rowKey={(row) => row.id}
        empty=""
        columns={[
          {
            key: 'notification',
            header: t('title'),
            cell: (row) => {
              const unread = !row.read && !justRead[row.id]
              const body = <RowBody row={row} unread={unread} />
              return (
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      'mt-2 h-2 w-2 shrink-0 rounded-full',
                      unread ? 'bg-blue-500' : 'bg-transparent',
                    )}
                  />
                  {row.href ? (
                    <button
                      type="button"
                      onClick={() => open(row)}
                      className="block min-w-0 flex-1 text-left"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="min-w-0 flex-1">{body}</div>
                  )}
                </div>
              )
            },
          },
          {
            key: 'read',
            header: <span className="sr-only">{t('markRead')}</span>,
            align: 'right',
            cell: (row) =>
              !row.read && !justRead[row.id] ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => read(row.id)}
                  disabled={busy}
                >
                  <Check size={13} aria-hidden />
                  {t('markRead')}
                </Button>
              ) : (
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  {t('readLabel')}
                </span>
              ),
          },
        ]}
      />
    </div>
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
  const { busy, execute } = useAppAction()
  const [failure, setFailure] = useState<string | null>(null)
  if (unread <= 0) return null
  return (
    <span className="inline-flex flex-col items-end gap-1">
      {failure ? (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {failure}
        </span>
      ) : null}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setFailure(null)
          void execute(() => markRead({ all: true }), {
            fallbackMessage: t('markFailed'),
            onRefused: (error) =>
              setFailure(error.displayMessage(t('markFailed'))),
            onOk: () => router.refresh(),
          })
        }}
      >
        <Check size={15} aria-hidden />
        {t('markAllRead')}
      </Button>
    </span>
  )
}
