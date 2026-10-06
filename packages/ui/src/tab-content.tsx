'use client'

import * as React from 'react'
import { cn } from './utils'

/**
 * Wraps tab-panel content so each tab's panel is its own subtree: changing
 * `tabKey` replaces the panel rather than reconciling one tab's fields into
 * another's.
 *
 * Usage (inside a detail page that already renders the active tab body
 * based on URL state):
 *
 *   <TabContent tabKey={active}>
 *     {active === 'overview' ? <OverviewPanel/> : null}
 *     {active === 'history'  ? <HistoryPanel/>  : null}
 *   </TabContent>
 *
 * The swap is immediate and animates nothing itself. A tab selection is a
 * view switch (see `switchView`), and the page or drawer animates it by
 * capturing the panel before and after the switch — so the new panel must
 * be in place in that same update. A panel that waited for the old one to
 * play an exit would arrive after the capture, and the switch would animate
 * two identical pictures.
 */
export function TabContent({
  tabKey,
  children,
  className,
}: {
  tabKey: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div key={tabKey} className={cn(className)}>
      {children}
    </div>
  )
}
