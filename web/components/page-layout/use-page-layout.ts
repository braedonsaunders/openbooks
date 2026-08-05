'use client'

import { useState } from 'react'
import type { PageLayoutPrefs } from '@openbooks/schema'
import { orderPanels } from '../../lib/page-layout-shared'

/**
 * Per-user show/hide/reorder state for a customizable surface (page panels,
 * roster rows, cockpit sections…). Optimistic local state persisted to
 * user_page_layouts through /api/me/page-layout — `page` must be on that
 * route's whitelist. `defaultOrder` is the product order; keys the saved pref
 * predates append to it (new items ship visible).
 */
export function usePageLayout(page: string, initial: PageLayoutPrefs, defaultOrder: readonly string[]) {
  const [prefs, setPrefs] = useState<PageLayoutPrefs>(initial)

  const order = orderPanels(defaultOrder, prefs)
  const hidden = new Set(prefs.hidden ?? [])
  const visible = order.filter((k) => !hidden.has(k))

  const save = (next: PageLayoutPrefs) => {
    setPrefs(next)
    void fetch('/api/me/page-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, layout: next }),
    })
  }
  const toggle = (key: string) => {
    const nextHidden = new Set(prefs.hidden ?? [])
    if (nextHidden.has(key)) nextHidden.delete(key)
    else nextHidden.add(key)
    save({ order, hidden: [...nextHidden] })
  }
  const move = (key: string, dir: -1 | 1) => {
    const i = order.indexOf(key)
    const j = i + dir
    if (i < 0 || j < 0 || j >= order.length) return
    const next = [...order]
    next[i] = next[j]!
    next[j] = key
    save({ order: next, hidden: prefs.hidden ?? [] })
  }
  const reset = () => save({})

  return { prefs, order, hidden, visible, toggle, move, reset }
}
