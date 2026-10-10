'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { OverlayExit } from './overlay-exit'
import { cn } from './utils'
import { useHydrated } from './use-hydrated'

/**
 * Lets an overlay launched from inside a popover outlive the popover's menu.
 *
 * A menu item may open a drawer (a quote's Award, a drop-ship assessment).
 * That drawer belongs to the item's component, so it lives in the popover's
 * React subtree while its DOM is portaled to the document body. Without
 * retention the first press inside the drawer reads as an outside click, the
 * popover closes, and its content unmounts the drawer before the press
 * becomes a click. An open drawer instead retains the popover: the menu
 * closes and hides, its content stays mounted, and the drawer releases it
 * once it has finished closing.
 */
export interface PopoverRetention {
  /** Close the menu but keep its content mounted. Returns the release. */
  retain: () => () => void
}

const PopoverRetentionContext = React.createContext<PopoverRetention | null>(null)

/** The nearest enclosing popover's retention, or null outside any popover. */
export function usePopoverRetention(): PopoverRetention | null {
  return React.useContext(PopoverRetentionContext)
}

/**
 * Portal-based popover that escapes any overflow-hidden ancestor.
 *
 * Use this for header/sidebar dropdowns (tenant switcher, notifications,
 * global search results, profile menu). The trigger button stays in its
 * normal position; the floating panel is rendered into <body> at a fixed
 * position computed from the button's bounding rect.
 */
export function Popover({
  trigger,
  open,
  onOpenChange,
  align = 'end',
  side = 'bottom',
  className,
  children,
}: {
  trigger: React.ReactElement
  open: boolean
  onOpenChange: (open: boolean) => void
  align?: 'start' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
  children: React.ReactNode
}) {
  const triggerRef = React.useRef<HTMLDivElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const [rect, setRect] = React.useState<{
    top: number
    left: number
    width: number
    height: number
  } | null>(null)
  const mounted = useHydrated()
  const [retainCount, setRetainCount] = React.useState(0)
  const onOpenChangeRef = React.useRef(onOpenChange)
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])
  const retention = React.useMemo<PopoverRetention>(() => ({
    retain() {
      setRetainCount((count) => count + 1)
      onOpenChangeRef.current(false)
      let released = false
      return () => {
        if (released) return
        released = true
        setRetainCount((count) => Math.max(0, count - 1))
      }
    },
  }), [])
  // Closed but retained: the panel stays mounted for the overlay it launched,
  // hidden and inert, and no longer counts as an open overlay for Escape.
  const retainedOnly = !open && retainCount > 0

  React.useEffect(() => {
    if (!open) return
    const t = triggerRef.current?.firstElementChild as HTMLElement | null
    if (!t) return
    function measure() {
      const r = t!.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open])

  React.useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      // Nested UI overlays (select menus, context menus, child popovers) are
      // portaled siblings in <body>, not DOM descendants of this panel. Treat
      // them as inside so interacting with a nested control does not unmount
      // its owner before the selection click completes.
      if (target instanceof Element && target.closest('[data-ui-overlay]')) return
      onOpenChange(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onOpenChange(false)
    }
    // Defer so the click that opened it doesn't immediately close.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onClick)
      document.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  return (
    <>
      <div ref={triggerRef} className="contents">
        {trigger}
      </div>
      {mounted && rect && typeof document !== 'undefined'
        ? createPortal(
            <AnimatePresence>
              {open || retainCount > 0 ? (
                <OverlayExit key="panel">
                {(exiting) => (
                <motion.div
                  ref={panelRef}
                  data-ui-overlay={retainedOnly ? undefined : true}
                  data-overlay-exiting={exiting || undefined}
                  data-popover-retained={retainedOnly || undefined}
                  aria-hidden={retainedOnly || undefined}
                  inert={retainedOnly || undefined}
                  initial={{
                    opacity: 0,
                    x: side === 'right' ? -4 : side === 'left' ? 4 : 0,
                    y: side === 'bottom' ? -4 : side === 'top' ? 4 : 0,
                    scale: 0.97,
                  }}
                  animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                  exit={{
                    opacity: 0,
                    x: side === 'right' ? -4 : side === 'left' ? 4 : 0,
                    y: side === 'bottom' ? -4 : side === 'top' ? 4 : 0,
                    scale: 0.97,
                  }}
                  transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                  className={cn(
                    'fixed z-[60] min-w-[12rem] origin-top rounded-md border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900',
                    className,
                  )}
                  style={{
                    display: retainedOnly ? 'none' : undefined,
                    top:
                      side === 'bottom'
                        ? rect.top + rect.height + 4
                        : (side === 'left' || side === 'right') && align === 'start'
                          ? rect.top
                          : undefined,
                    bottom:
                      side === 'top'
                        ? window.innerHeight - rect.top + 4
                        : (side === 'left' || side === 'right') && align === 'end'
                          ? window.innerHeight - (rect.top + rect.height)
                          : undefined,
                    left:
                      side === 'right'
                        ? rect.left + rect.width + 4
                        : (side === 'top' || side === 'bottom') && align === 'start'
                          ? rect.left
                          : undefined,
                    right:
                      side === 'left'
                        ? window.innerWidth - rect.left + 4
                        : (side === 'top' || side === 'bottom') && align === 'end'
                          ? window.innerWidth - (rect.left + rect.width)
                          : undefined,
                  }}
                  role="dialog"
                >
                  <PopoverRetentionContext.Provider value={retention}>
                    {children}
                  </PopoverRetentionContext.Provider>
                </motion.div>
                )}
                </OverlayExit>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  )
}
