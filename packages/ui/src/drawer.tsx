'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { useHydrated } from './use-hydrated'
import { nextDrawerShow, shouldCommitDrawerCloseNavigation } from './drawer-nav'
import { OverlayExit } from './overlay-exit'
import { VIEW_SWITCH_TRANSITION, ViewTransition } from './view-transition'
import { cn } from './utils'

// Z-INDEX SCALE (single source of truth)
//
//   sidebar      : z-10
//   header       : z-20
//   sticky-bars  : z-30
//   drawer/modal : z-50     — Drawer, WizardShell
//   floating UI  : z-[60]   — Popover, SearchSelect dropdown, confirm dialog.
//                          Menus escape scrolling content. Native modal dropdowns
//                          remain inside their owning dialog to stay interactive.
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

const DrawerDepthContext = React.createContext(0)

// A covered sheet — one with a deeper drawer laid on it — steps back toward
// the page. Literal classes per depth so the stylesheet generator sees them.
const COVERED_CLASS: Record<number, string> = {
  0: '[body:has(>[data-drawer-depth="1"])_&]:-translate-x-4',
  1: '[body:has(>[data-drawer-depth="2"])_&]:-translate-x-4',
  2: '[body:has(>[data-drawer-depth="3"])_&]:-translate-x-4',
  3: '[body:has(>[data-drawer-depth="4"])_&]:-translate-x-4',
}

// The sheets under a right-side drawer, nearest first. Each rests a little
// further down and out from the top sheet and is turned about its top edge,
// so the visible edge widens toward the bottom like a hand-squared pile.
const UNDER_SHEETS = [
  { x: -4, y: 6, rotate: 0.2, className: 'bg-white dark:bg-slate-900' },
  { x: -7, y: 13, rotate: 0.45, className: 'bg-slate-50 dark:bg-slate-900' },
] as const

const SHEET_SPRING = { type: 'spring', damping: 32, stiffness: 320, mass: 0.8 } as const

// The sheet's leading top corner is turned down, like the hub sheets on
// hover. The fold is fixed: it does not respond to the pointer, so the sheet
// holds still while the reader works in it. The size is the fold's leg in
// pixels, kept inside the header's 24px inset so the corner never reaches
// the title.
const FOLD = 20
const FOLD_CLIP = `polygon(${FOLD}px 0, 100% 0, 100% 100%, 0 100%, 0 ${FOLD}px)`

let openDrawerCount = 0
let originalBodyOverflow: string | null = null

/**
 * Slide-in drawer for sub-entity create/edit forms and mobile flyouts.
 * Portals to body, spring slide-in, backdrop fade, Esc + click-out + scroll lock.
 * Slides from the right by default; pass `side="left"` for nav-style flyouts.
 *
 * A right-side drawer is a sheet of paper laid on a small stack, the same
 * material as the reports-hub sheets and the report paper, with its leading
 * top corner turned down. It slides in slightly askew and squares up as it
 * lands, and the sheets beneath fan out along its leading edge. A nested
 * drawer is laid on top of the stack: the covered sheet steps back so its
 * edge stays visible behind the new one. Reduced-motion users get the still
 * stack.
 *
 * `title` is required: the panel is a `role="dialog"` and screen readers
 * announce it by its heading, so a drawer cannot mount unnamed. Opening one
 * whose title resolves empty fails closed rather than shipping an unnamed
 * dialog; `web/lib/accessibility-contracts.test.ts` enforces the same
 * contract statically over every call site.
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
  /** Required accessible name for the dialog, rendered as its heading. */
  title: React.ReactNode
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
  const mounted = useHydrated()
  const parentDepth = React.useContext(DrawerDepthContext)
  const depth = stacked ? Math.max(1, parentDepth + 1) : 0
  const hasDeeperDrawer = React.useCallback(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-drawer-depth]'))
      .some(node => Number(node.dataset.drawerDepth) > depth), [depth])

  // The dialog's accessible name is its own heading: aria-labelledby points at
  // the h2 below. A drawer opened without usable title text never ships as an
  // unnamed role=dialog — it fails closed here instead.
  const hasAccessibleName =
    title !== null && title !== undefined && title !== false && !(typeof title === 'string' && !title.trim())
  if (open && !hasAccessibleName) {
    throw new Error('Drawer: a non-empty title is required so the dialog exposes an accessible name.')
  }
  const headingId = React.useId()

  // Fullscreen toggle: every flyout can expand to the full viewport (source platform
  // "expand" affordance). Width animates via the max-width transition below;
  // height is already 100%. Resets when the drawer closes so the next open
  // starts at its designed size.
  const [fullscreen, setFullscreen] = React.useState(initialFullscreen)
  // Reset when the drawer closes so the next open starts at its designed
  // size. Adjusted during render (same committed value, no extra render).
  if (!open && fullscreen !== initialFullscreen) setFullscreen(initialFullscreen)

  const panelRef = React.useRef<HTMLElement>(null)
  const reduceMotion = useReducedMotion() ?? false
  const paper = side === 'right'

  React.useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (document.querySelector('[data-ui-overlay]')) return
      if (hasDeeperDrawer()) return
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
  }, [open, onClose, stacked, hasDeeperDrawer])

  // Focus management: on open, remember the previously focused element and move
  // focus into the dialog; trap Tab within the panel; restore focus on close.
  React.useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const focusablesSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

    // Defer the initial focus until the panel has mounted for this open cycle.
    const focusTimer = window.setTimeout(() => {
      if (hasDeeperDrawer()) return
      const panel = panelRef.current
      if (!panel) return
      const first = Array.from(panel.querySelectorAll<HTMLElement>(focusablesSelector)).find(
        (el) => el.offsetParent !== null,
      )
      ;(first ?? panel).focus()
    }, 0)

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      if (hasDeeperDrawer()) return
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
      } else if (activeEl === lastEl || !panel.contains(activeEl)) {
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
  }, [open, stacked, hasDeeperDrawer])

  if (typeof document === 'undefined') return null

  // The child must go absent → present for AnimatePresence to play the enter
  // animation. We mount the portal (empty) on the first client render, then add
  // the panel once `mounted` flips — otherwise a drawer that's open on initial
  // page load (e.g. deep-linked `?drawer=…`) renders at its `initial` x:100%
  // and never slides on-screen, leaving the panel + close button off the right
  // edge. See the off-screen-drawer bug.
  return createPortal(
    <DrawerDepthContext.Provider value={depth}>
    <AnimatePresence onExitComplete={onExitComplete}>
      {mounted && open ? (
        <OverlayExit key="drawer">
        {(exiting) => (
        <div
          data-overlay-exiting={exiting || undefined}
          data-drawer-layer={stacked ? 'nested' : 'base'}
          data-drawer-depth={depth}
          style={{ zIndex: depth === 0 ? 50 : 54 + depth }}
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
          <motion.div
            data-drawer-sheaf
            initial={{ x: side === 'left' ? '-100%' : '100%', rotate: paper && !reduceMotion ? 0.6 : 0 }}
            animate={{ x: 0, rotate: 0 }}
            exit={{ x: side === 'left' ? '-100%' : '100%', rotate: paper && !reduceMotion ? 0.4 : 0 }}
            transition={SHEET_SPRING}
            // Pivots on the leading top corner, so the sheet squares up
            // beneath the app header rather than swinging into it.
            style={{ originX: 0, originY: 0 }}
            className={cn(
              // Isolated so the sheets beneath stay above the backdrop once
              // the slide settles and the transform is cleared.
              'absolute inset-y-0 isolate transition-[max-width] duration-300 ease-in-out',
              side === 'left' ? 'left-0' : 'right-0',
              // Full replacement, not an additional class: two sm:max-w-*
              // utilities on one element resolve by stylesheet order, not
              // class order, so stacking them makes the toggle a no-op.
              fullscreen ? 'w-full sm:max-w-[100vw]' : SIZE_CLASS[size],
            )}
          >
          <div
            className={cn(
              'relative h-full transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              paper && COVERED_CLASS[depth],
            )}
          >
          {paper
            ? UNDER_SHEETS.map(({ className, ...rest }, index) => (
                <motion.span
                  key={index}
                  aria-hidden
                  initial={reduceMotion ? rest : { x: 0, y: 0, rotate: 0 }}
                  animate={rest}
                  exit={reduceMotion ? rest : { x: 0, y: 0, rotate: 0, transition: { duration: 0.12 } }}
                  transition={{ ...SHEET_SPRING, delay: reduceMotion ? 0 : 0.14 + index * 0.05 }}
                  style={{ originX: 0.5, originY: 0, zIndex: -1 - index }}
                  className={cn(
                    'absolute inset-0 rounded-tl-[3px] border-t border-l border-slate-200 shadow-[-1px_0_3px_rgb(15_23_42/0.06)] dark:border-slate-700/80',
                    className,
                  )}
                />
              ))
            : null}
          {/* The top sheet. Its shadow is cast by a separate layer because
              the turned corner clips the dialog, and a clip removes the
              element's own shadow with it. */}
          <div className="relative h-full">
          {paper ? (
            <span
              aria-hidden
              className="absolute inset-0 shadow-[0_25px_50px_-12px_rgb(0_0_0/0.25),-8px_0_24px_-12px_rgb(15_23_42/0.18)]"
            />
          ) : null}
          <aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            tabIndex={-1}
            style={paper ? { clipPath: FOLD_CLIP } : undefined}
            className={cn(
              'relative flex h-full flex-col overflow-hidden border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900',
              side === 'left' ? 'border-r shadow-2xl' : 'border-l',
              panelClassName,
            )}
          >
            {paper ? (
              <>
                {/* The paper's leading edge catches a little shade, so the
                    sheet reads as a surface resting on the ones beneath. */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 left-0 z-10 w-2 bg-gradient-to-r from-slate-900/[0.035] to-transparent dark:from-black/20"
                />
                {/* The underside of the turned corner. */}
                <span
                  aria-hidden
                  style={{ width: FOLD, height: FOLD }}
                  className="pointer-events-none absolute top-0 left-0 z-20 rounded-br-[3px] bg-[linear-gradient(135deg,transparent_50%,var(--color-slate-200)_50%,var(--color-slate-100))] shadow-[1px_1px_2px_rgb(15_23_42/0.14)] dark:bg-[linear-gradient(135deg,transparent_50%,var(--color-slate-700)_50%,var(--color-slate-800))] dark:shadow-[1px_1px_2px_rgb(0_0_0/0.4)]"
                />
              </>
            ) : null}
            {title || description || headerActions ? (
              <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
                <div className="min-w-52 flex-1 space-y-0.5">
                  {title ? (
                    <h2 id={headingId} className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
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
            {/* Switching tabs inside the drawer animates the body the way a
                page change animates the page; other updates stay still. */}
            <ViewTransition default="none" update={{ [VIEW_SWITCH_TRANSITION]: 'drawer-view', default: 'none' }}>
              <div
                className={cn(
                  'app-scroll min-h-0 flex-1 text-slate-900 dark:text-slate-100',
                  bodyClassName ?? 'overflow-y-auto px-6 py-5',
                )}
              >
                {children}
              </div>
            </ViewTransition>
            {footer ? (
              <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-3 dark:border-slate-800 dark:bg-slate-900/60">
                {footer}
              </footer>
            ) : null}
          </aside>
          </div>
          </div>
          </motion.div>
        </div>
        )}
        </OverlayExit>
      ) : null}
    </AnimatePresence>
    </DrawerDepthContext.Provider>,
    document.body,
  )
}

/**
 * Client-side navigate fn supplied by the host app (Next.js) so `UrlDrawer` can
 * close by changing the URL. Overlay-only chrome (report drill, register,
 * txn flyout) is a shallow replace that must not re-run the page loader;
 * record drawers that own their `open` state on the server still push.
 * We fall back to a hard navigation if no provider is mounted.
 */
export const DrawerNavigateContext = React.createContext<((href: string) => void) | null>(null)

/**
 * URL-state drawer wrapper. `open` is derived from search params. Overlay
 * hosts (report drill) keep `open` true across target changes — pass
 * `openKey` so a new target remounts after the previous close animation.
 */
export function UrlDrawer({
  open,
  openKey,
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
  beforeClose,
  syncUrlOnClose = false,
}: {
  open: boolean
  /** Identity of the open target. Changing it while `open` stays true
   *  remounts the panel (second drill without a full page load). */
  openKey?: string
  closeHref: string
  /** Required accessible name for the dialog, rendered as its heading. */
  title: React.ReactNode
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
  /** Optional guard for unsaved edits, before navigation or exit animation. */
  beforeClose?: () => boolean | Promise<boolean>
  /** Sync the address bar the moment close begins (replaceState to the
   *  resolved close href) instead of waiting for the exit animation's
   *  deferred navigation — so a synchronous URL read at close time already
   *  matches the dismissed state. The deferred router navigation
   *  still re-runs the server after the animation; default false preserves
   *  the historic close-then-navigate timing everywhere else. */
  syncUrlOnClose?: boolean
}) {
  const navigate = React.useContext(DrawerNavigateContext)
  // Derived from the address bar (an external store) plus props. Gated on
  // hydration so the server and the first client render agree on `null`, then
  // computed during render — no effect cascade. Recomputes exactly when the
  // old effect re-ran: after hydration and when `closeHref`/`contextualReturn`
  // change.
  const hydrated = useHydrated()
  const nestedContext = React.useMemo((): { closeHref: string; stacked: boolean } | null => {
    if (!hydrated || !contextualReturn) return null
    const currentParams = new URLSearchParams(window.location.search)

    // Party transaction drill-through stays on the same page. Closing the
    // child removes only its two selector params, leaving the underlying list
    // and party drawer mounted with their existing filters and tab intact.
    if (currentParams.has('partyTxn')) {
      currentParams.delete('partyTxn')
      currentParams.delete('partyTxnKind')
      const query = currentParams.toString()
      return {
        closeHref: query ? `${window.location.pathname}?${query}` : window.location.pathname,
        stacked: true,
      }
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
    return safeReturn && !isRelatedRecordHost
      ? { closeHref: safeReturn, stacked: currentParams.has('relatedParty') || currentParams.has('reportRecord') || currentParams.has('projectTxn') }
      : null
  }, [hydrated, closeHref, contextualReturn])
  const resolvedCloseHref = nestedContext?.closeHref ?? closeHref
  const resolvedStacked = stacked === true || nestedContext?.stacked === true
  // Local presence state: the URL says the drawer is open, but closing must
  // first play the slide-out. `close()` just flips local `show` to false so
  // AnimatePresence runs the exit; the actual navigation is deferred to
  // onExitComplete — otherwise navigating immediately re-renders the server
  // component, unmounts the drawer, and the exit animation never plays.
  const [show, setShow] = React.useState(open)
  const [prevOpen, setPrevOpen] = React.useState(open)
  const [prevOpenKey, setPrevOpenKey] = React.useState(openKey)
  const urlWhenClosedRef = React.useRef<string | null>(null)
  // Mirror `open` / `openKey` during render (same committed values, no extra
  // render). A `close()`-driven `show === false` while `open` is still true
  // is untouched so the exit animation still plays — unless `openKey`
  // changed, which is a new target and must remount immediately.
  const nextShow = nextDrawerShow({ open, show, prevOpen, openKey, prevOpenKey })
  if (nextShow.show !== show) setShow(nextShow.show)
  if (nextShow.prevOpen !== prevOpen) setPrevOpen(nextShow.prevOpen)
  if (nextShow.prevOpenKey !== prevOpenKey) setPrevOpenKey(nextShow.prevOpenKey)
  async function close() {
    if (beforeClose && !(await beforeClose())) return
    if (typeof window !== 'undefined') {
      urlWhenClosedRef.current = `${window.location.pathname}${window.location.search}`
      if (syncUrlOnClose) {
        window.history.replaceState(null, '', resolvedCloseHref)
      }
    }
    setShow(false)
  }
  function afterExit() {
    if (typeof window === 'undefined') return
    const urlNow = `${window.location.pathname}${window.location.search}`
    const urlWhenClosed = urlWhenClosedRef.current ?? urlNow
    if (!shouldCommitDrawerCloseNavigation({ urlWhenClosed, urlNow, closeHref: resolvedCloseHref })) {
      return
    }
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
