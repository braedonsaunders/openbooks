'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { History, Loader2 } from 'lucide-react'
import { Button, Label } from '@openbooks/ui'
import { dateTime } from '../../../lib/format'

interface Entry {
  id: string
  event: string
  actorName: string | null
  at: string
}

/** Read-only activity history for a folder or file (from the audit_log). */
export function ActivityLog({
  resourceType,
  resourceId,
}: {
  resourceType: 'folder' | 'file'
  resourceId: string
}) {
  const t = useTranslations('documents.activity')
  const commonActions = useTranslations('common.actions')
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const base = `/api/file-cabinet/${resourceType === 'folder' ? 'folders' : 'files'}/${resourceId}/activity`
    fetch(base)
      .then((r) => {
        if (!r.ok) throw new Error('activity request failed')
        return r.json()
      })
      .then((d) => {
        if (!cancelled) {
          setEntries((d.entries as Entry[]) ?? [])
          setLoadFailed(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [resourceType, resourceId, attempt])

  const label = (event: string) => {
    const key = `events.${event}`
    const translated = t(key)
    return translated === key ? event : translated
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <History className="h-4 w-4 text-slate-400 dark:text-slate-500" />
        <Label>{t('title')}</Label>
      </div>
      {loadFailed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-700 dark:text-red-300">
          <span>{t('loadFailed')}</span>
          <Button size="sm" variant="outline" onClick={() => { setEntries(null); setLoadFailed(false); setAttempt((value) => value + 1) }}>
            {commonActions('retry')}
          </Button>
        </div>
      ) : entries == null ? (
        <div className="flex items-center gap-2 py-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>
      ) : (
        <ol className="space-y-1.5">
          {entries.map((e) => (
            <li key={e.id} className="flex items-baseline gap-2 text-sm">
              <span className="text-slate-700 dark:text-slate-200">
                {e.actorName ? <span className="font-medium">{e.actorName}</span> : null}{' '}
                {label(e.event)}
              </span>
              <span className="ml-auto shrink-0 text-xs tabular-nums text-slate-400">
                {dateTime(e.at)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
