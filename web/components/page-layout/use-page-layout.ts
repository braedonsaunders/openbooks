'use client'

import { useEffect, useRef, useState } from 'react'
import type { PageLayoutPrefs } from '@openbooks/schema'
import { mergePageLayouts, orderPanels } from '../../lib/page-layout-shared'
import { readApiErrorMessage } from '../../lib/api-error'

export type PageLayoutSaveState = 'saved' | 'saving' | 'error'

/** The server's current layout as carried by a 409 conflict response. */
type PageLayoutConflictCurrent = {
  layout?: PageLayoutPrefs
  revision?: string | null
} | null

/**
 * Per-user show/hide/reorder state for a customizable surface (page panels,
 * roster rows, cockpit sections…). Optimistic local state persisted to
 * user_page_layouts through /api/me/page-layout — `page` must be on that
 * route's whitelist. `defaultOrder` is the product order; keys the saved pref
 * predates append to it (new items ship visible).
 *
 * Saves are serialized and coalesced: rapid toggles merge into one pending
 * state and commit in order, so an older whole-layout write can never win
 * over a newer one. Every save carries the server's revision token — a 409
 * merges the latest local state onto the server's current layout (union of
 * hides) and retries once instead of dropping either tab's edits. Failures
 * keep the unsaved changes pending with the server's named message in
 * `saveError` (never a silent rollback); `retry` re-sends them.
 */
export function usePageLayout(page: string, initial: PageLayoutPrefs, defaultOrder: readonly string[]) {
  const [prefs, setPrefs] = useState<PageLayoutPrefs>(initial)
  const [saveState, setSaveState] = useState<PageLayoutSaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)

  const prefsRef = useRef(initial)
  /** Latest local state not yet committed (null when nothing is pending). */
  const pendingRef = useRef<PageLayoutPrefs | null>(null)
  /** Exact server revision token backing the next save (null = no row yet). */
  const revisionRef = useRef<string | null>(null)
  const pumpingRef = useRef(false)
  /** Resolves once the mount-time revision read settles (success or fail). */
  const readyRef = useRef<Promise<void> | null>(null)

  // Learn the current server revision (and layout, when this tab has no
  // local edits yet) so the first save carries a live token. A failed read
  // is not fatal: the first save then 409s and reconciles via `current`.
  useEffect(() => {
    let cancelled = false
    readyRef.current = (async () => {
      try {
        const res = await fetch(`/api/me/page-layout?page=${encodeURIComponent(page)}`)
        if (!res.ok) return
        const body = (await res.json()) as {
          layout?: PageLayoutPrefs
          revision?: string | null
        }
        if (cancelled) return
        revisionRef.current = typeof body.revision === 'string' ? body.revision : null
        if (pendingRef.current === null && body.layout && typeof body.layout === 'object') {
          prefsRef.current = body.layout
          setPrefs(body.layout)
        }
      } catch {
        // Offline on load: stay on the server-rendered base; the first save
        // reconciles through the 409 path.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [page])

  const pump = async () => {
    if (pumpingRef.current) return
    pumpingRef.current = true
    setSaveState('saving')
    setSaveError(null)
    try {
      await readyRef.current
      let retries = 1
      while (pendingRef.current !== null) {
        const snapshot = pendingRef.current
        pendingRef.current = null
        let res: Response
        try {
          res = await fetch('/api/me/page-layout', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page, layout: snapshot, expectedRevision: revisionRef.current }),
          })
        } catch {
          pendingRef.current = pendingRef.current ?? snapshot
          setSaveState('error')
          setSaveError('could not save the layout — check your connection and retry')
          return
        }
        if (res.status === 409) {
          let current: PageLayoutConflictCurrent = null
          try {
            current = ((await res.json()) as { current?: PageLayoutConflictCurrent }).current ?? null
          } catch {
            current = null
          }
          const latest = pendingRef.current ?? snapshot
          if (!current || retries <= 0) {
            pendingRef.current = latest
            if (current) revisionRef.current = typeof current.revision === 'string' ? current.revision : null
            setSaveState('error')
            setSaveError(
              'this layout changed elsewhere — your latest changes are kept and unsaved; retry to save them',
            )
            return
          }
          retries -= 1
          revisionRef.current = typeof current.revision === 'string' ? current.revision : null
          const merged = mergePageLayouts(current.layout ?? {}, latest)
          prefsRef.current = merged
          setPrefs(merged)
          pendingRef.current = merged
          continue
        }
        if (!res.ok) {
          pendingRef.current = pendingRef.current ?? snapshot
          setSaveState('error')
          setSaveError(await readApiErrorMessage(res, 'could not save the layout'))
          return
        }
        const body = (await res.json()) as { revision?: string | null }
        revisionRef.current = typeof body.revision === 'string' ? body.revision : null
      }
      setSaveState('saved')
      setSaveError(null)
    } finally {
      pumpingRef.current = false
    }
  }

  const save = (next: PageLayoutPrefs) => {
    prefsRef.current = next
    setPrefs(next)
    pendingRef.current = next
    void pump()
  }
  const retry = () => {
    if (pendingRef.current === null) pendingRef.current = prefsRef.current
    void pump()
  }
  const toggle = (key: string) => {
    const nextHidden = new Set(prefsRef.current.hidden ?? [])
    if (nextHidden.has(key)) nextHidden.delete(key)
    else nextHidden.add(key)
    const order = orderPanels(defaultOrder, prefsRef.current)
    save({ order, hidden: [...nextHidden] })
  }
  const move = (key: string, dir: -1 | 1) => {
    const order = orderPanels(defaultOrder, prefsRef.current)
    const i = order.indexOf(key)
    const j = i + dir
    if (i < 0 || j < 0 || j >= order.length) return
    const next = [...order]
    next[i] = next[j]!
    next[j] = key
    save({ order: next, hidden: prefsRef.current.hidden ?? [] })
  }
  const reset = () => save({})

  const order = orderPanels(defaultOrder, prefs)
  const hidden = new Set(prefs.hidden ?? [])
  const visible = order.filter((k) => !hidden.has(k))

  return { prefs, order, hidden, visible, toggle, move, reset, saveState, saveError, retry }
}
