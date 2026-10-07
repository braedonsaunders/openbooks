/**
 * The browser abandons a view transition when it cannot run it: the window
 * or viewport changed size mid-animation, or the tab was hidden. The page
 * update itself has already applied; only the animation is dropped. React
 * recognises these aborts and stays silent, but it matches the browser's
 * exact wording, and Chrome now appends the reason ("Transition was aborted
 * because of invalid state. Viewport size changed"). React then reports the
 * abort as a recoverable error, which the framework raises as an uncaught
 * error — an alarming overlay in development and a console error in
 * production, for an animation that was merely skipped.
 *
 * This filter recognises the same aborts by prefix and drops only those.
 * Every other error, including any other `InvalidStateError`, still reaches
 * the error handlers.
 */

const BENIGN_ABORT_PREFIXES = [
  'Transition was aborted because of invalid state',
  'Skipping view transition because viewport size changed',
  'Skipping view transition because document visibility state has become hidden',
  'View transition was skipped because document visibility state is hidden',
] as const

/** True for a view transition the browser skipped or aborted for layout or visibility. */
export function isBenignViewTransitionAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { name, message } = error as { name?: unknown; message?: unknown }
  return (
    name === 'InvalidStateError' &&
    typeof message === 'string' &&
    BENIGN_ABORT_PREFIXES.some((prefix) => message.startsWith(prefix))
  )
}

// A development hot reload installs again; the previous listener is
// replaced rather than stacked.
const ABORT_FILTER = Symbol.for('openbooks.view-transition-abort-filter')

/**
 * Stops the reported error event for a benign view transition abort before
 * any other listener sees it. Installed from `instrumentation-client.ts`, so
 * it is in place before the app hydrates. A capturing listener on the window
 * runs ahead of the window's other listeners for an event dispatched at it.
 */
export function installViewTransitionAbortFilter(target: EventTarget = window) {
  const registry = target as unknown as Record<symbol, ((event: Event) => void) | undefined>
  const previous = registry[ABORT_FILTER]
  if (previous) target.removeEventListener('error', previous, true)
  const filter = (event: Event) => {
    if (!isBenignViewTransitionAbort((event as ErrorEvent).error)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  registry[ABORT_FILTER] = filter
  target.addEventListener('error', filter, true)
}
