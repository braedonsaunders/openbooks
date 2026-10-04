'use client'

import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from './utils'

export type DisclosureSectionProps = {
  /** Section heading, always visible. */
  title: React.ReactNode
  /**
   * One-line description of the current state, shown beside the heading while
   * the section is collapsed (for example "Per-order posting · USD"), so the
   * reader knows what the hidden settings resolve to without opening them.
   */
  summary?: React.ReactNode
  /** Initial state when uncontrolled. Advanced depth starts collapsed. */
  defaultOpen?: boolean
  /** Controlled state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * Content that needs attention (a validation error or an unmapped value)
   * must never hide behind a collapsed heading: when true the section is
   * forced open and cannot be collapsed.
   */
  forceOpen?: boolean
  className?: string
  children: React.ReactNode
}

/**
 * Progressive disclosure for secondary and advanced settings. The everyday
 * path stays visible; depth is one deliberate click away and summarizes itself
 * while closed.
 */
export function DisclosureSection({
  title,
  summary,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  forceOpen = false,
  className,
  children,
}: DisclosureSectionProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = forceOpen || (controlledOpen ?? uncontrolledOpen)
  const panelId = React.useId()
  const toggle = () => {
    if (forceOpen) return
    const next = !open
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  return (
    <section className={cn('border-t border-border pt-3', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-disabled={forceOpen || undefined}
        onClick={toggle}
        className={cn(
          'flex w-full items-center gap-2 rounded-sm text-left text-sm font-medium text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          forceOpen && 'cursor-default',
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span>{title}</span>
        {!open && summary ? (
          <span className="ml-2 truncate text-xs font-normal text-muted-foreground">{summary}</span>
        ) : null}
      </button>
      <div id={panelId} hidden={!open} className="pt-3">
        {children}
      </div>
    </section>
  )
}
