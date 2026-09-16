'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

export interface TriageRow {
  id: string
  href: string
  hasProposal: boolean
  status: string
}

/**
 * The workbench's interactive layer over the server-rendered inbox:
 * changed-since-last-visit banner, keyboard triage, and bulk actions.
 *
 * The list itself stays server-rendered (same table vocabulary as every
 * other screen); this island only highlights rows by their finding link and
 * fires the same PATCH transitions the drawer uses, then refreshes. Row
 * selection is ephemeral — navigating filters clears it.
 *
 * Keys: j/k move · Enter opens · x selects · a applies (opens the drawer on
 * the proposal card) · d dismisses (opens the drawer for the reason) ·
 * s parks the finding In review.
 */
export function AgentsTriage({
  rows,
  canWrite,
  orgId,
}: {
  rows: TriageRow[]
  canWrite: boolean
  orgId: string
}) {
  const t = useTranslations('agents')
  const tc = useTranslations('continuousClose')
  const router = useRouter()
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const seenKey = `agents-last-seen-${orgId}`
  // Changed-since-last-visit baseline, read lazily per org. A first visit
  // establishes the timestamp (nothing is "new" yet); the banner only ever
  // appears once the count fetch below resolves, so server and first client
  // render agree.
  const [lastSeen, setLastSeen] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    let stored = window.localStorage.getItem(seenKey)
    if (!stored) {
      stored = new Date().toISOString()
      window.localStorage.setItem(seenKey, stored)
    }
    return stored
  })
  const [newCount, setNewCount] = useState<number | null>(null)
  // New rows reset triage position (render-adjust pattern, not an effect).
  const [prevRows, setPrevRows] = useState(rows)
  if (prevRows !== rows) {
    setPrevRows(rows)
    setCursor(0)
    setSelected(new Set())
  }

  // The "new since" count comes from the same feed with a since filter.
  useEffect(() => {
    if (!lastSeen) return
    let cancelled = false
    fetch(`/api/agents/inbox?since=${encodeURIComponent(lastSeen)}&limit=1`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body && typeof body.total === 'number') setNewCount(body.total)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [lastSeen])

  const highlighted = useRef<HTMLElement | null>(null)

  const clearHighlight = useCallback(() => {
    highlighted.current?.style.removeProperty('outline')
    highlighted.current?.style.removeProperty('outline-offset')
    highlighted.current = null
  }, [])

  const highlight = useCallback((index: number) => {
    clearHighlight()
    const row = rows[index]
    if (!row) return
    const link = document.querySelector(`a[href="${CSS.escape(row.href)}"]`)
    const tr = link?.closest('tr, [role="row"]')
    if (tr instanceof HTMLElement) {
      tr.style.outline = '2px solid var(--teal-600, #0d9488)'
      tr.style.outlineOffset = '-2px'
      highlighted.current = tr
      tr.scrollIntoView({ block: 'nearest' })
    }
  }, [clearHighlight, rows])

  const openRow = useCallback((index: number) => {
    const row = rows[index]
    if (row) router.push(row.href as never)
  }, [router, rows])

  const mutate = useCallback(async (id: string, action: 'review' | 'resolve') => {
    const response = await fetch(`/api/continuous-close/items/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (!response.ok) throw new Error()
    toast.success(tc(`feedback.${action}`))
  }, [tc])

  const bulk = useCallback(async (action: 'review' | 'resolve') => {
    const ids = [...selected]
    if (ids.length === 0 || busy) return
    setBusy(true)
    try {
      for (const id of ids) {
        try {
          await mutate(id, action)
        } catch {
          toast.error(tc('feedback.actionFailed'))
          break
        }
      }
      setSelected(new Set())
      router.refresh()
    } finally {
      setBusy(false)
    }
  }, [busy, mutate, router, selected, tc])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const current = rows
      const writable = canWrite
      const at = cursor
      if (current.length === 0) return
      const key = event.key
      if (key === 'j' || key === 'k') {
        event.preventDefault()
        const next = key === 'j' ? Math.min(current.length - 1, at + 1) : Math.max(0, at - 1)
        setCursor(next)
        highlight(next)
      } else if (key === 'Enter') {
        event.preventDefault()
        openRow(at)
      } else if (key === 'x') {
        const row = current[at]
        if (!row) return
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(row.id)) next.delete(row.id)
          else next.add(row.id)
          return next
        })
      } else if (!writable) {
        return
      } else if (key === 'a' || key === 'd') {
        // Apply and dismiss both land in the drawer: Apply needs the signed
        // proposal card, dismiss needs the reason — no second write path.
        event.preventDefault()
        openRow(at)
      } else if (key === 's') {
        // Snooze parks the finding In review (there is no time-based snooze
        // state; the hint says so).
        const row = current[at]
        if (!row || row.status !== 'open') return
        event.preventDefault()
        void mutate(row.id, 'review').then(
          () => router.refresh(),
          () => toast.error(tc('feedback.actionFailed')),
        )
      } else if (key === 'Escape') {
        setSelected(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canWrite, cursor, highlight, mutate, openRow, router, rows, tc])

  useEffect(() => {
    highlight(cursor)
    return () => clearHighlight()
  }, [clearHighlight, cursor, highlight])

  const selectedCount = selected.size

  return (
    <div className="space-y-2">
      {lastSeen && (newCount ?? 0) > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-900 dark:border-teal-900 dark:bg-teal-950/30 dark:text-teal-200">
          <span>{t('lastVisit', { date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(lastSeen)) })} · {newCount}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              window.localStorage.setItem(seenKey, new Date().toISOString())
              setLastSeen(window.localStorage.getItem(seenKey))
              setNewCount(0)
            }}
          >
            <Check size={13} />{t('markSeen')}
          </Button>
        </div>
      ) : null}
      {selectedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900">
          <span className="font-medium">{t('triage.selected', { count: selectedCount })}</span>
          {canWrite ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void bulk('review')}>
                <RotateCcw size={13} />{t('triage.review')}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void bulk('resolve')}>
                <Check size={13} />{t('triage.resolve')}
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            <X size={13} />{t('triage.clear')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('triage.hint')}</p>
      )}
    </div>
  )
}
