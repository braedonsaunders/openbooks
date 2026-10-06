'use client'

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { VIEW_SWITCH_TRANSITION, ViewTransition } from '@openbooks/ui'

/**
 * Navigation motion for the authenticated app, built on React's
 * `<ViewTransition>` and the browser View Transitions API. The browser
 * snapshots the outgoing and incoming page and animates the snapshots on
 * the compositor, so a transition costs no layout work and no script per
 * frame. Browsers without the API navigate exactly as before, without
 * motion. The keyframes live in `app/globals.css` under "Route transitions".
 *
 * Two layers:
 * - `RouteTransition` wraps the page pane. When the PATHNAME changes the old
 *   page lifts away and the new one (or its placeholder) rises in; when a
 *   placeholder then gives way, the real page rises into its place. A switch
 *   between views of the same page — a tab, subtab or view selection, which
 *   carries `VIEW_SWITCH_TRANSITION` — animates the same way, whether it
 *   changes the address or only the page's state. Search, filter and sort
 *   updates carry no type and stay still, so typing in a list search never
 *   animates the page. Nothing animates in a background tab, where the
 *   browser would abort the transition anyway.
 * - A report sheet on the reports hub and the report paper it opens share a
 *   transition name, so the card the reader clicked grows into the report
 *   and shrinks back into its place on the way back.
 *
 * Browser back and forward need one more step. The router restores a
 * cached page synchronously inside the `popstate` event, and React opens no
 * view transition for that update, so history traversal would otherwise
 * cut. `onHistoryTraversal` opens the transition itself and replays the
 * event to the router inside it — see that listener and
 * `installHistoryTraversalTransitions`.
 */

/** Transition type a hub card attaches to the navigation it starts. */
export const REPORT_OPEN_TRANSITION = 'report-open'

// The last pathname the page pane committed. It is written after commit, so
// during the render of a navigation it still names the page being left —
// which is how a render tells a navigation from a same-page update.
let settledPathname: string | null = null
// Page placeholders currently mounted. While one is showing, the next update
// of the pane is the real page arriving in its place.
let mountedSkeletons = 0
const motionListeners = new Set<() => void>()
const subscribeMotion = (listener: () => void) => {
  motionListeners.add(listener)
  return () => {
    motionListeners.delete(listener)
  }
}
const notifyMotion = () => {
  for (const listener of motionListeners) listener()
}
const readSettled = () => settledPathname
const readSkeletonShowing = () => mountedSkeletons > 0
const readNothingOnServer = () => null
const readFalseOnServer = () => false

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
const readHidden = () => document.visibilityState === 'hidden'

/**
 * True while the tab is in the background. The browser refuses to run a view
 * transition for a hidden document, so every boundary here stands down
 * rather than start one that will be aborted — a slow page that arrives
 * while the reader is in another tab simply appears.
 */
function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribeVisibility, readHidden, readFalseOnServer)
}

/**
 * True while rendering the page a navigation is moving to. A component that
 * mounts during a navigation leaves its entrance to the route transition
 * instead of running a second one of its own.
 */
function useRouteNavigating(): boolean {
  const pathname = usePathname()
  const settled = useSyncExternalStore(subscribeMotion, readSettled, readNothingOnServer)
  return settled !== null && settled !== pathname
}

/**
 * True while the route transition owns the page's entrance: during the
 * render of a navigation, and while a placeholder is showing (the page that
 * replaces it rises in with the transition). A component that would animate
 * its own mount stands down then, or the arriving page would start
 * transparent inside the transition's snapshot.
 */
export function useRouteEntranceAnimated(): boolean {
  const navigating = useRouteNavigating()
  const revealing = useSyncExternalStore(subscribeMotion, readSkeletonShowing, readFalseOnServer)
  return navigating || revealing
}

export function RouteTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const navigating = useRouteNavigating()
  const revealing = useSyncExternalStore(subscribeMotion, readSkeletonShowing, readFalseOnServer)
  const hidden = useDocumentHidden()
  useEffect(() => {
    if (settledPathname === pathname) return
    settledPathname = pathname
    notifyMotion()
  }, [pathname])
  // A navigation moves the old page out and the new one (or its
  // placeholder) in; once a placeholder is showing, the page that replaces
  // it rises into place. A view switch on the same page moves like a
  // navigation. Any other update of the pane stays still.
  const update = hidden
    ? 'none'
    : navigating
      ? { [REPORT_OPEN_TRANSITION]: 'route-recede', default: 'route-change' }
      : revealing ? 'route-reveal' : { [VIEW_SWITCH_TRANSITION]: 'route-change', default: 'none' }
  return (
    <ViewTransition default="none" update={update}>
      {/* One box for the pane, so the page is captured as a single layer;
          it keeps the main column's flex sizing for the page inside. */}
      <div data-route-pane className="flex min-h-0 flex-1 flex-col">{children}</div>
    </ViewTransition>
  )
}

/**
 * Wraps the page placeholder. It steps aside quickly when the page arrives,
 * and while it is mounted the pane knows the next update is that arrival.
 */
export function SkeletonTransition({ children }: { children: ReactNode }) {
  const hidden = useDocumentHidden()
  useEffect(() => {
    mountedSkeletons++
    notifyMotion()
    return () => {
      mountedSkeletons--
      notifyMotion()
    }
  }, [])
  return (
    <ViewTransition exit={hidden ? 'none' : 'skeleton-out'} default="none">
      {children}
    </ViewTransition>
  )
}

// Hub sheet → report path, recorded when a sheet is opened, so the report
// paper can take the opened sheet's transition name when it mounts.
const openedSheets = new Map<string, string>()

function pathOf(href: string) {
  return href.split(/[?#]/)[0]!
}

/** A stable view-transition name for one hub sheet (a valid CSS identifier). */
export function reportSheetName(key: string) {
  let hash = 2166136261
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619)
  return `report-sheet-${(hash >>> 0).toString(36)}`
}

/** Record that the sheet named `name` is opening the report at `href`. */
export function openReportSheet(href: string, name: string) {
  openedSheets.set(pathOf(href), name)
}

/** The shared element of the sheet-to-paper morph, on either side. */
export function ReportSheetTransition({ name, children }: { name: string; children: ReactNode }) {
  const hidden = useDocumentHidden()
  return (
    <ViewTransition name={name} share={hidden ? 'none' : 'report-sheet'} default="none">
      {children}
    </ViewTransition>
  )
}

/**
 * Wraps a report's paper. When the reader arrived from a hub sheet, the
 * paper takes that sheet's name for as long as it is mounted, so it grows
 * out of the sheet and returns into it on the way back. Reached any other
 * way, the paper carries no name and moves with the page.
 */
export function ReportPaperTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [name] = useState(() => openedSheets.get(pathname))
  return name ? <ReportSheetTransition name={name}>{children}</ReportSheetTransition> : children
}

/** Resolves once the page pane has committed `pathname`, or after `limit` ms. */
function paneSettled(pathname: string, limit: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      motionListeners.delete(check)
      resolve()
    }
    const check = () => {
      if (settledPathname === pathname) done()
    }
    const timer = setTimeout(done, limit)
    motionListeners.add(check)
    check()
  })
}

let replayingTraversal = false

/**
 * Animates browser back and forward like an in-app navigation.
 *
 * The router answers `popstate` by restoring the cached page synchronously,
 * which React applies without a view transition. This listener runs first,
 * holds the event back, names the departing page's pane and report sheet so
 * the browser snapshots them, and opens the transition. Inside it the same
 * event is replayed to the router; once the restored page has committed, the
 * arriving pane and sheet take the same names, and the browser animates
 * between the two.
 *
 * Left entirely to the router: a history entry it did not create, a page
 * outside the app pane, a traversal within one page (search and filter
 * history, which never animates), a traversal the browser is already
 * animating itself (a swipe gesture), and browsers without the API. When a
 * listener refuses the replayed traversal — the unsaved-draft guard puts the
 * entry back and asks first — the transition is skipped at once, so the
 * guard's question is never held behind an animation.
 */
function onHistoryTraversal(event: PopStateEvent) {
  if (replayingTraversal || event.hasUAVisualTransition) return
  const state: unknown = event.state
  if (!state || typeof state !== 'object' || !('__NA' in state)) return
  if (!document.querySelector('[data-route-pane]') || document.visibilityState === 'hidden') return
  if (settledPathname === null || settledPathname === location.pathname) return
  event.stopImmediatePropagation()

  const named: HTMLElement[] = []
  const name = (element: Element | null | undefined, transitionName: string, transitionClass: string) => {
    if (!(element instanceof HTMLElement)) return
    element.style.setProperty('view-transition-name', transitionName)
    element.style.setProperty('view-transition-class', transitionClass)
    named.push(element)
  }
  const clear = () => {
    for (const element of named.splice(0)) {
      element.style.removeProperty('view-transition-name')
      element.style.removeProperty('view-transition-class')
    }
  }
  const sheet = (sheetName: string) => document.querySelector(`[data-report-sheet="${CSS.escape(sheetName)}"]`)
  const paper = () => document.querySelector('[data-report-paper]')

  // Forward onto a report opened from this hub grows its sheet again; back
  // from such a report returns the paper to its sheet.
  const destination = location.pathname
  const openingName = openedSheets.get(destination)
  const opening = openingName !== undefined && sheet(openingName) !== null
  const returningName = openedSheets.get(settledPathname)
  const paneClass = opening ? 'route-recede' : 'route-change'

  name(document.querySelector('[data-route-pane]'), 'route-pane', paneClass)
  if (opening) name(sheet(openingName), openingName, 'report-sheet')
  else if (returningName) name(paper(), returningName, 'report-sheet')

  const transition = document.startViewTransition({
    types: opening ? [REPORT_OPEN_TRANSITION] : [],
    update: async () => {
      replayingTraversal = true
      try {
        window.dispatchEvent(new PopStateEvent('popstate', { state }))
      } finally {
        replayingTraversal = false
      }
      if (location.pathname !== destination) {
        clear()
        transition.skipTransition()
        return
      }
      // A restored page that must refetch is shown when it arrives; the limit
      // keeps the old snapshot from holding the screen in the meantime.
      await paneSettled(destination, 1500)
      clear()
      name(document.querySelector('[data-route-pane]'), 'route-pane', paneClass)
      if (opening) name(paper(), openingName, 'report-sheet')
      else if (returningName) name(sheet(returningName), returningName, 'report-sheet')
    },
  })
  // A skipped transition rejects `ready`; that is an outcome, not an error.
  transition.ready.catch(() => {})
  transition.finished.then(clear, clear)
}

// Listeners on `window` run in the order they were added, and this one has
// to see `popstate` before the router does, so it is installed from
// `instrumentation-client.ts`, which runs before the app hydrates. A
// development hot reload installs again; the previous instance's listener
// is replaced rather than left to intercept the replay.
const TRAVERSAL_LISTENER = Symbol.for('openbooks.route-transitions.history-traversal')

export function installHistoryTraversalTransitions() {
  if (typeof window === 'undefined' || typeof document.startViewTransition !== 'function') return
  const registry = window as unknown as Record<symbol, ((event: PopStateEvent) => void) | undefined>
  const previous = registry[TRAVERSAL_LISTENER]
  if (previous) window.removeEventListener('popstate', previous, true)
  registry[TRAVERSAL_LISTENER] = onHistoryTraversal
  window.addEventListener('popstate', onHistoryTraversal, true)
}
