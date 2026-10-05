import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'
import { stubModules } from '../testing/stub-modules.ts'

/**
 * Browser back and forward reach the route transition before the router.
 * These tests drive the real listener against a stand-in router (a
 * `popstate` listener that renders the restored page, as the App Router
 * does) and a recording `document.startViewTransition`, and assert what the
 * reader would see: the sheet and paper share a name across the swap, the
 * names never outlive the transition, same-page history is left alone, and a
 * guard that refuses the traversal is never held behind an animation.
 */

await bootJsdomEnvironment({ url: 'http://localhost/reports/pnl' })
// History traversal globals the preset does not copy from the window.
for (const key of ['history', 'location', 'PopStateEvent'] as const) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) Object.assign(globalThis, { [key]: window[key] })
}
stubModules({
  navigation: { source: 'export function usePathname(){return globalThis.__routePathname}export function useRouter(){return {}}export function useSearchParams(){return new URLSearchParams()}' },
  intl: false,
  authz: false,
  features: false,
})

type Recorded = {
  types: string[]
  before: Record<string, string>
  after: Record<string, string>
  skipped: boolean
  finished: Promise<void>
}
const transitions: Recorded[] = []

/** Every element's inline transition name, keyed by a readable label. */
function names(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const element of document.querySelectorAll<HTMLElement>('[style]')) {
    const name = element.style.getPropertyValue('view-transition-name')
    if (!name) continue
    const label = element.hasAttribute('data-report-paper') ? 'paper'
      : element.hasAttribute('data-report-sheet') ? 'sheet'
        : element.hasAttribute('data-route-pane') ? 'pane' : element.tagName
    out[label] = `${name} .${element.style.getPropertyValue('view-transition-class')}`
  }
  return out
}

Object.assign(document, {
  startViewTransition({ update, types }: { update: () => Promise<void> | void; types?: string[] }) {
    let ready!: () => void
    const recorded: Recorded = { types: [...(types ?? [])], before: names(), after: {}, skipped: false, finished: Promise.resolve() }
    const transition = {
      ready: new Promise<void>((resolve) => { ready = resolve }),
      finished: Promise.resolve(),
      skipTransition() { recorded.skipped = true },
    }
    recorded.finished = transition.finished = Promise.resolve()
      .then(update)
      .then(() => {
        recorded.after = names()
        ready()
      })
    transitions.push(recorded)
    return transition
  },
})

const React = await import('react')
// The stand-in router renders synchronously inside `popstate`, as the App
// Router does on a cached traversal, rather than inside `act`.
Object.assign(globalThis, { React, __routePathname: '/reports/pnl', IS_REACT_ACT_ENVIRONMENT: false })
const { flushSync } = await import('react-dom')
const { createRoot } = await import('react-dom/client')
const {
  RouteTransition,
  installHistoryTraversalTransitions,
  openReportSheet,
} = await import('./route-transitions')

installHistoryTraversalTransitions()

const SHEET = 'report-sheet-pnl'
const ROUTER_STATE = { __NA: true }
const pages: Record<string, () => React.ReactNode> = {
  '/reports': () => React.createElement('div', { 'data-report-sheet': SHEET }, 'Profit & Loss'),
  '/reports/pnl': () => React.createElement('article', { 'data-report-paper': '' }, 'Profit & Loss report'),
  '/reports/budget': () => React.createElement('article', { 'data-report-paper': '' }, 'Budget report'),
}
const container = document.createElement('main')
document.body.append(container)
const root = createRoot(container)
function show(pathname: string) {
  Object.assign(globalThis, { __routePathname: pathname })
  flushSync(() => root.render(React.createElement(RouteTransition, null, pages[pathname]!())))
}

// The stand-in router: restores whatever entry the browser moved to.
let routerSaw = 0
window.addEventListener('popstate', () => {
  routerSaw++
  show(location.pathname)
})

async function traverse(to: string) {
  history.replaceState(ROUTER_STATE, '', to)
  window.dispatchEvent(new PopStateEvent('popstate', { state: ROUTER_STATE }))
  await Promise.all(transitions.map((transition) => transition.finished))
}

test('back from a report returns its paper into the sheet it was opened from', async () => {
  show('/reports')
  openReportSheet('/reports/pnl', SHEET)
  show('/reports/pnl')
  transitions.length = 0
  routerSaw = 0

  await traverse('/reports')

  assert.equal(transitions.length, 1, 'one transition carries the traversal')
  assert.equal(routerSaw, 1, 'the router restores the entry exactly once')
  const [transition] = transitions
  assert.deepEqual(transition!.types, [], 'returning is not an opening')
  assert.deepEqual(transition!.before, { pane: 'route-pane .route-change', paper: `${SHEET} .report-sheet` })
  assert.deepEqual(transition!.after, { pane: 'route-pane .route-change', sheet: `${SHEET} .report-sheet` })
  assert.deepEqual(names(), {}, 'no transition name outlives the transition')
})

test('forward onto that report grows the sheet again, as an opening', async () => {
  transitions.length = 0

  await traverse('/reports/pnl')

  const [transition] = transitions
  assert.deepEqual(transition!.types, ['report-open'])
  assert.deepEqual(transition!.before, { pane: 'route-pane .route-recede', sheet: `${SHEET} .report-sheet` })
  assert.deepEqual(transition!.after, { pane: 'route-pane .route-recede', paper: `${SHEET} .report-sheet` })
  assert.deepEqual(names(), {})
})

test('a report reached another way moves with the page and claims no sheet', async () => {
  show('/reports/budget')
  transitions.length = 0

  await traverse('/reports')

  const [transition] = transitions
  assert.deepEqual(transition!.before, { pane: 'route-pane .route-change' })
  assert.deepEqual(transition!.after, { pane: 'route-pane .route-change' })
})

test('history within one page is left to the router and never animates', async () => {
  transitions.length = 0
  routerSaw = 0

  history.replaceState(ROUTER_STATE, '', '/reports?q=cash')
  window.dispatchEvent(new PopStateEvent('popstate', { state: ROUTER_STATE }))

  assert.equal(transitions.length, 0)
  assert.equal(routerSaw, 1, 'the router receives the original event')
})

test('a traversal in a background tab is left to the router, which the browser would refuse to animate', async () => {
  show('/reports/pnl')
  transitions.length = 0
  routerSaw = 0
  const original = document.visibilityState
  // An own property shadows the prototype getter until it is deleted.
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  try {
    await traverse('/reports')
  } finally {
    delete (document as { visibilityState?: unknown }).visibilityState
  }

  assert.equal(transitions.length, 0, 'no transition is opened for a hidden document')
  assert.equal(routerSaw, 1, 'the router receives the original event')
  assert.equal(document.visibilityState, original, 'the stand-in visibility is removed')
})

test('a guard that refuses the traversal skips the transition instead of holding the screen', async () => {
  show('/reports/pnl')
  transitions.length = 0
  routerSaw = 0
  // The unsaved-draft guard: put the entry back, stop the router, ask first.
  const guard = (event: PopStateEvent) => {
    history.pushState(ROUTER_STATE, '', '/reports/pnl')
    event.stopImmediatePropagation()
  }
  window.addEventListener('popstate', guard, true)
  try {
    const started = Date.now()
    await traverse('/reports')
    assert.ok(Date.now() - started < 500, 'the refusal is not delayed by the settle wait')
  } finally {
    window.removeEventListener('popstate', guard, true)
  }

  assert.equal(routerSaw, 0, 'the router never restored the refused entry')
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0]!.skipped, true, 'the transition is skipped, not played')
  assert.deepEqual(names(), {}, 'the departing page keeps no transition names')
})
