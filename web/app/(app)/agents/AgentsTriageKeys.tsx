'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'

export interface TriageKeyRow {
  id: string
  href: string
  hasProposal: boolean
  status: string
}

/**
 * The workbench's keyboard + bulk-selection layer over the server-rendered
 * inbox: changed-since-last-visit banner, j/k/a/d/s triage, and bulk
 * review/resolve. The shared list cannot host ephemeral selection or global
 * key handling, so this compact island binds to the list's row links: it
 * highlights rows by their finding href and fires the same PATCH transitions
 * the drawer uses, then refreshes. Row selection is ephemeral — navigating
 * filters clears it.
 *
 * Keys: j/k move · Enter opens · x selects · a applies (opens the drawer on
 * the proposal card) · d dismisses (opens the drawer for the reason) ·
 * s parks the finding In review.
 */
export function AgentsTriageKeys({
  rows,
  canWrite,
  orgId,
  locale,
}: {
  rows: TriageKeyRow[]
  canWrite: boolean
  orgId: string
  /** App locale for the last-visit banner date (never the browser default). */
  locale: string
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
  // Refused rows the next bulk must keep selected. A refresh rebuilds `rows`
  // (firing the render-adjust reset below), so the keep-list rides in state
  // past the refresh instead of being wiped with the stale selection.
  const [keptSelection, setKeptSelection] = useState<ReadonlySet<string> | null>(null)
  const [bulkOutcome, setBulkOutcome] = useState<{ applied: number; failures: { id: string; error: string }[] } | null>(null)
  // New rows reset triage position (render-adjust pattern, not an effect).
  // A bulk that just refused keeps its failed rows selected across the
  // refresh it triggered; every other rows change clears the selection.
  const [prevRows, setPrevRows] = useState(rows)
  if (prevRows !== rows) {
    setPrevRows(rows)
    setCursor(0)
    setSelected(keptSelection ?? new Set())
    if (keptSelection !== null) setKeptSelection(null)
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

  // A refused mutation throws the server's named reason (translated where
  // the continuous-close catalog knows the code), so every caller — single
  // key or bulk — reports what the server said, never a generic failure.
  const mutate = useCallback(async (id: string, action: 'review' | 'resolve') => {
    const response = await fetch(`/api/continuous-close/items/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (!response.ok) {
      const named = await readApiErrorMessage(response, tc('feedback.actionFailed'))
      throw new Error(
        tc.has(`feedback.errors.${named}` as never) ? tc(`feedback.errors.${named}` as never) : named,
      )
    }
    toast.success(tc(`feedback.${action}`))
  }, [tc])

  const bulk = useCallback(async (action: 'review' | 'resolve') => {
    const ids = [...selected]
    if (ids.length === 0 || busy) return
    setBusy(true)
    setBulkOutcome(null)
    try {
      // Every selected row is attempted: a refusal is recorded, never a
      // break — stopping at the first refusal leaves the tail unattempted
      // with no accounting of what landed.
      const failures: { id: string; error: string }[] = []
      for (const id of ids) {
        try {
          await mutate(id, action)
        } catch (e) {
          failures.push({ id, error: e instanceof Error ? e.message : tc('feedback.actionFailed') })
        }
      }
      if (failures.length === 0) {
        setSelected(new Set())
      } else {
        const failed = new Set(failures.map((failure) => failure.id))
        setKeptSelection(failed)
        setSelected(failed)
        setBulkOutcome({ applied: ids.length - failures.length, failures })
        toast.error(t('triage.bulkPartial', { applied: ids.length - failures.length, failed: failures.length }))
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }, [busy, mutate, router, selected, t, tc])

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
          (e: unknown) => toast.error(e instanceof Error ? e.message : tc('feedback.actionFailed')),
        )
      } else if (key === 'Escape') {
        setSelected(new Set())
        setBulkOutcome(null)
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
          <span>{t('lastVisit', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(lastSeen)) })} · {newCount}</span>
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
      {selectedCount > 0 && (
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
          <Button variant="ghost" size="sm" onClick={() => { setSelected(new Set()); setBulkOutcome(null) }}>
            <X size={13} />{t('triage.clear')}
          </Button>
        </div>
      )}
      {bulkOutcome && bulkOutcome.failures.length > 0 ? (
        <div role="alert" className="space-y-1 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <div className="font-medium">{t('triage.bulkPartial', { applied: bulkOutcome.applied, failed: bulkOutcome.failures.length })}</div>
          <ul className="list-disc space-y-0.5 pl-5">
            {bulkOutcome.failures.map((failure) => (
              <li key={failure.id}>
                <button
                  type="button"
                  className="underline underline-offset-2 hover:no-underline"
                  title={failure.id}
                  onClick={() => {
                    const index = rows.findIndex((row) => row.id === failure.id)
                    if (index >= 0) openRow(index)
                  }}
                >
                  {failure.id.slice(0, 8)}…
                </button>
                {': '}{failure.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
