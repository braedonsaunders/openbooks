'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { cn } from './utils'

// Z-INDEX SCALE (single source of truth)
//
//   sidebar      : z-10
//   header       : z-20
//   sticky-bars  : z-30
//   drawer       : z-50
//   floating UI  : z-[60]   — Popover, SearchSelect dropdown, confirm dialog.
//                          Body-portaled so it always sits above the drawer
//                          it was opened from (z-50) and below toasts (z-70).
//   toast        : z-70

export type DrawerSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full'
export type DrawerSide = 'left' | 'right'

const SIZE_CLASS: Record<DrawerSize, string> = {
  sm: 'w-full sm:max-w-md',
  md: 'w-full sm:max-w-xl',
  lg: 'w-full sm:max-w-2xl',
  xl: 'w-full sm:max-w-4xl',
  '2xl': 'w-full sm:max-w-6xl',
  full: 'w-full',
}

let openDrawerCount = 0
let originalBodyOverflow: string | null = null

/**
 * Slide-in drawer for sub-entity create/edit forms and mobile flyouts.
 * Portals to body, spring slide-in, backdrop fade, Esc + click-out + scroll lock.
 * Slides from the right by default; pass `side="left"` for nav-style flyouts.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  size = 'md',
  side = 'right',
  children,
  footer,
  headerActions,
  subtabs,
  bodyClassName,
  panelClassName,
  stacked = false,
  initialFullscreen = false,
  onExitComplete,
}: {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  description?: React.ReactNode
  size?: DrawerSize
  side?: DrawerSide
  children: React.ReactNode
  footer?: React.ReactNode
  /** Primary action buttons, pinned to the top of the drawer (in the header,
   *  before the close button) so they're always reachable without scrolling. */
  headerActions?: React.ReactNode
  /** Record-detail navigation rendered directly below the title header. */
  subtabs?: React.ReactNode
  /** Override the body wrapper's classes (default: scroll + px-6 py-5 padding).
   *  Pass e.g. "overflow-hidden" for a child that manages its own layout/scroll. */
  bodyClassName?: string
  /** Optional visual treatment for the drawer panel (for record-type tinting). */
  panelClassName?: string
  /** Raise this drawer above another open drawer in a deliberate nested flow. */
  stacked?: boolean
  /** Open at viewport width. The user can still collapse the drawer. */
  initialFullscreen?: boolean
  /** Fires after the exit animation finishes — used by UrlDrawer to defer the
   *  close navigation until the slide-out has played. */
  onExitComplete?: () => void
}) {
  const t = useTranslations('common.actions')
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  // Fullscreen toggle: every flyout can expand to the full viewport (source platform
  // "expand" affordance). Width animates via the max-width transition below;
  // height is already 100%. Resets when the drawer closes so the next open
  // starts at its designed size.
  const [fullscreen, setFullscreen] = React.useState(initialFullscreen)
  React.useEffect(() => {
    if (!open) setFullscreen(initialFullscreen)
  }, [initialFullscreen, open])

  const panelRef = React.useRef<HTMLElement>(null)

  React.useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (document.querySelector('[data-ui-overlay]')) return
      if (!stacked && document.querySelector('[data-drawer-layer="nested"]')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    if (openDrawerCount === 0) originalBodyOverflow = document.body.style.overflow
    openDrawerCount += 1
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      openDrawerCount = Math.max(0, openDrawerCount - 1)
      if (openDrawerCount === 0) {
        document.body.style.overflow = originalBodyOverflow ?? ''
        originalBodyOverflow = null
      }
    }
  }, [open, onClose, stacked])

  // Focus management: on open, remember the previously focused element and move
  // focus into the dialog; trap Tab within the panel; restore focus on close.
  React.useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const focusablesSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

    // Defer the initial focus until the panel has mounted for this open cycle.
    const focusTimer = window.setTimeout(() => {
      if (!stacked && document.querySelector('[data-drawer-layer="nested"]')) return
      const panel = panelRef.current
      if (!panel) return
      const first = panel.querySelector<HTMLElement>(focusablesSelector)
      ;(first ?? panel).focus()
    }, 0)

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      if (!stacked && document.querySelector('[data-drawer-layer="nested"]')) return
      const panel = panelRef.current
      if (!panel) return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(focusablesSelector)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (focusables.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const firstEl = focusables[0]!
      const lastEl = focusables[focusables.length - 1]!
      const activeEl = document.activeElement
      if (e.shiftKey) {
        if (activeEl === firstEl || activeEl === panel || !panel.contains(activeEl)) {
          e.preventDefault()
          lastEl.focus()
        }
      } else if (activeEl === lastEl) {
        e.preventDefault()
        firstEl.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown)
      // Restore focus to the trigger if it's still in the document.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
  }, [open, stacked])

  if (typeof document === 'undefined') return null

  // The child must go absent → present for AnimatePresence to play the enter
  // animation. We mount the portal (empty) on the first client render, then add
  // the panel once `mounted` flips — otherwise a drawer that's open on initial
  // page load (e.g. deep-linked `?drawer=…`) renders at its `initial` x:100%
  // and never slides on-screen, leaving the panel + close button off the right
  // edge. See the off-screen-drawer bug.
  return createPortal(
    <AnimatePresence onExitComplete={onExitComplete}>
      {mounted && open ? (
        <div
          key="drawer"
          data-drawer-layer={stacked ? 'nested' : 'base'}
          className={cn(
            // Drawers are bottom-anchored and stop beneath the persistent app
            // header. Because this boundary lives on the shared portal layer,
            // both the panel and its backdrop leave the shell header visible
            // for every Drawer and UrlDrawer in the application. Include the
            // device safe-area inset used by AppShell on mobile.
            'fixed inset-x-0 bottom-0 [top:calc(3.5rem+env(safe-area-inset-top))]',
            stacked ? 'z-[55]' : 'z-50',
          )}
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            initial={{ x: side === 'left' ? '-100%' : '100%' }}
            animate={{ x: 0 }}
            exit={{ x: side === 'left' ? '-100%' : '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 320, mass: 0.8 }}
            className={cn(
              'absolute inset-y-0 flex flex-col overflow-hidden border-t border-slate-200 bg-white shadow-2xl transition-[max-width] duration-300 ease-in-out dark:border-slate-800 dark:bg-slate-900',
              side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
              // Full replacement, not an additional class: two sm:max-w-*
              // utilities on one element resolve by stylesheet order, not
              // class order, so stacking them makes the toggle a no-op.
              fullscreen ? 'w-full sm:max-w-[100vw]' : SIZE_CLASS[size],
              panelClassName,
            )}
          >
            {title || description || headerActions ? (
              <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
                <div className="min-w-0 space-y-0.5">
                  {title ? (
                    <h2 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                      {title}
                    </h2>
                  ) : null}
                  {description ? (
                    <p className="text-sm text-slate-500 dark:text-slate-400">{description}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {headerActions ? (
                    <div className="flex flex-wrap items-center justify-end gap-2">{headerActions}</div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setFullscreen((f) => !f)}
                    className="hidden rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 sm:block dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                    aria-label={fullscreen ? t('exitFullscreen') : t('fullscreen')}
                    title={fullscreen ? t('exitFullscreen') : t('fullscreen')}
                  >
                    {fullscreen ? (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="4 14 10 14 10 20" />
                        <polyline points="20 10 14 10 14 4" />
                        <line x1="14" y1="10" x2="21" y2="3" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </svg>
                    ) : (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="15 3 21 3 21 9" />
                        <polyline points="9 21 3 21 3 15" />
                        <line x1="21" y1="3" x2="14" y2="10" />
                        <line x1="3" y1="21" x2="10" y2="14" />
                      </svg>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                    aria-label={t('close')}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </header>
            ) : null}
            {subtabs ? (
              <div className="shrink-0 border-b border-slate-200 bg-white px-6 dark:border-slate-800 dark:bg-slate-900">
                {subtabs}
              </div>
            ) : null}
            <div
              className={cn(
                'app-scroll min-h-0 flex-1 text-slate-900 dark:text-slate-100',
                bodyClassName ?? 'overflow-y-auto px-6 py-5',
              )}
            >
              {children}
            </div>
            {footer ? (
              <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-3 dark:border-slate-800 dark:bg-slate-900/60">
                {footer}
              </footer>
            ) : null}
          </motion.aside>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}

/**
 * Client-side navigate fn supplied by the host app (Next.js) so `UrlDrawer` can
 * close by changing the URL — which re-runs the server component that owns the
 * drawer's `open` state. The old implementation used a raw `history.pushState`,
 * which updates the URL but does NOT re-run the server, so the drawer never
 * closed (the X / backdrop / Esc appeared dead). The app wires this to
 * `router.push`; we fall back to a hard navigation if no provider is mounted.
 */
export const DrawerNavigateContext = React.createContext<((href: string) => void) | null>(null)

/**
 * URL-state drawer wrapper for server-rendered pages. `open` is derived from a
 * `?drawer=…` search param on the server, so closing needs a real navigation
 * (provided via DrawerNavigateContext) — not a shallow history update.
 */
export function UrlDrawer({
  open,
  closeHref,
  title,
  description,
  size,
  children,
  footer,
  headerActions,
  subtabs,
  bodyClassName,
  panelClassName,
  stacked,
  initialFullscreen,
  contextualReturn = true,
}: {
  open: boolean
  closeHref: string
  title?: React.ReactNode
  description?: React.ReactNode
  size?: DrawerSize
  children: React.ReactNode
  footer?: React.ReactNode
  headerActions?: React.ReactNode
  subtabs?: React.ReactNode
  bodyClassName?: string
  panelClassName?: string
  stacked?: boolean
  initialFullscreen?: boolean
  /** Whether this drawer should consume nested-record URL context. Base
   * drawers set this false so only the child transaction becomes stacked. */
  contextualReturn?: boolean
}) {
  const navigate = React.useContext(DrawerNavigateContext)
  const [nestedContext, setNestedContext] = React.useState<{ closeHref: string; stacked: boolean } | null>(null)
  React.useEffect(() => {
    if (!contextualReturn) {
      setNestedContext(null)
      return
    }
    const currentParams = new URLSearchParams(window.location.search)

    // Party transaction drill-through stays on the same page. Closing the
    // child removes only its two selector params, leaving the underlying list
    // and party drawer mounted with their existing filters and tab intact.
    if (currentParams.has('partyTxn')) {
      currentParams.delete('partyTxn')
      currentParams.delete('partyTxnKind')
      const query = currentParams.toString()
      setNestedContext({
        closeHref: query ? `${window.location.pathname}?${query}` : window.location.pathname,
        stacked: true,
      })
      return
    }

    const requestedReturn = currentParams.get('drawerReturn')
    const safeReturn = requestedReturn?.startsWith('/') && !requestedReturn.startsWith('//')
      ? requestedReturn
      : null
    // A related-record host (the vendor/customer drawer underneath) receives a
    // closeHref that already preserves drawerReturn. It must remain the base
    // layer and keep its own close destination. Only the transaction drawer,
    // whose ordinary closeHref is its module list, consumes this context.
    const closeParams = new URL(closeHref, window.location.origin).searchParams
    const isRelatedRecordHost = closeParams.has('drawerReturn')
    setNestedContext(safeReturn && !isRelatedRecordHost
      ? { closeHref: safeReturn, stacked: currentParams.has('relatedParty') || currentParams.has('reportRecord') || currentParams.has('projectTxn') }
      : null)
  }, [closeHref, contextualReturn])
  const resolvedCloseHref = nestedContext?.closeHref ?? closeHref
  const resolvedStacked = stacked === true || nestedContext?.stacked === true
  // Local presence state: the URL says the drawer is open, but closing must
  // first play the slide-out. `close()` just flips local `show` to false so
  // AnimatePresence runs the exit; the actual navigation is deferred to
  // onExitComplete — otherwise navigating immediately re-renders the server
  // component, unmounts the drawer, and the exit animation never plays.
  const [show, setShow] = React.useState(open)
  React.useEffect(() => setShow(open), [open])
  function close() {
    setShow(false)
  }
  function afterExit() {
    if (typeof window === 'undefined') return
    if (navigate) navigate(resolvedCloseHref)
    else window.location.assign(resolvedCloseHref)
  }
  return (
    <Drawer
      open={show}
      onClose={close}
      onExitComplete={afterExit}
      title={title}
      description={description}
      size={size}
      footer={footer}
      headerActions={headerActions}
      subtabs={subtabs}
      bodyClassName={bodyClassName}
      panelClassName={panelClassName}
      stacked={resolvedStacked}
      initialFullscreen={initialFullscreen}
    >
      {children}
    </Drawer>
  )
}
