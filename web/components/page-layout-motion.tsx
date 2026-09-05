'use client'

/**
 * Tiny client-side motion wrappers used by the (otherwise server) page
 * layouts. We keep these in their own file so server components can mark
 * just the header / body regions as interactive without forcing the whole
 * layout tree into a Client Component.
 */

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { cn } from '@openbooks/ui'

export function FadeInHeader({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      data-page-motion
      initial={reduce ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }}
      className={cn(className)}
    >
      {children}
    </motion.div>
  )
}

export function FadeInBody({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      data-page-motion
      initial={reduce ? false : { opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: 0.05, ease: [0.22, 0.61, 0.36, 1] }}
      className={cn('h-full', className)}
    >
      {children}
    </motion.div>
  )
}
