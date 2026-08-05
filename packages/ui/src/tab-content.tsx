'use client'

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { cn } from './utils'

/**
 * Wraps tab-panel content so swapping between tabs crossfades the outgoing
 * panel out and the incoming panel in. The `tabKey` prop is the
 * discriminator — when it changes, AnimatePresence runs the exit/enter
 * choreography.
 *
 * Usage (inside a detail page that already renders the active tab body
 * based on URL state):
 *
 *   <TabContent tabKey={active}>
 *     {active === 'overview' ? <OverviewPanel/> : null}
 *     {active === 'history'  ? <HistoryPanel/>  : null}
 *   </TabContent>
 *
 * Reduced-motion users get an instant swap.
 */
export function TabContent({
  tabKey,
  children,
  className,
  duration = 0.18,
}: {
  tabKey: string
  children: React.ReactNode
  className?: string
  duration?: number
}) {
  const reduce = useReducedMotion()
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={tabKey}
        initial={reduce ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 1 } : { opacity: 0, y: -2 }}
        transition={{ duration, ease: [0.22, 0.61, 0.36, 1] }}
        className={cn(className)}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
