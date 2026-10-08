import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'
import { stubModules } from '../testing/stub-modules.ts'

await bootJsdomEnvironment({ url: 'http://localhost/projects/pre-billing?view=board' })
stubModules({
  navigation: { source: 'export function usePathname(){return globalThis.__pendingPath}export function useSearchParams(){return new URLSearchParams(globalThis.__pendingSearch)}' },
  extra: { 'next-intl': 'export function useTranslations(){return key=>key=== "loading" ? "Loading…" : key}' },
  authz: false,
  features: false,
})
const React = await import('react')
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true, __pendingPath: '/projects/pre-billing', __pendingSearch: 'view=board' })
const { createRoot } = await import('react-dom/client')
const { act } = React
const { NavigationPendingBoundary, NavigationCommit, NavigationRefusalSettled, PagePending } = await import('./page-pending.tsx')
const { beginNavigationPending, finishNavigationPending, navigationPendingSnapshot, commitNavigationHref } = await import('../lib/navigation-pending.ts')
const { onRouterTransitionStart } = await import('../instrumentation-client.ts')
const content = document.createElement('main')
document.body.append(content)
const root = createRoot(content)
let page = React.createElement('input', { defaultValue: 'Unsaved worksheet' })
function show(child: React.ReactNode = page) {
  root.render(React.createElement(NavigationPendingBoundary, null, React.createElement(NavigationCommit, null, child)))
}
async function waitForFeedback() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)) })
}

test('same-route server navigation shows the native logo while preserving content, draft and focus, then ends at commit', async () => {
  await act(async () => show())
  const input = content.querySelector('input')!
  input.focus()
  await act(async () => onRouterTransitionStart('/projects/pre-billing?stage=approved'))
  await waitForFeedback()
  assert.equal(content.querySelectorAll('[data-navigation-pending]').length, 1)
  assert.ok(content.querySelector('[data-navigation-pending] svg .brand-stroke-loop'))
  assert.equal(content.querySelector('[role="status"]')?.textContent, 'Loading…')
  assert.equal(content.querySelector('input'), input)
  assert.equal(input.value, 'Unsaved worksheet')
  assert.equal(document.activeElement, input)
  Object.assign(globalThis, { __pendingSearch: 'stage=approved' })
  await act(async () => show())
  assert.equal(content.querySelector('[data-navigation-pending]'), null)
  assert.equal(navigationPendingSnapshot().navigation, null)
})

test('fast commits and presentation history never hold the page; a newer navigation supersedes an earlier feedback timer', async () => {
  await act(async () => beginNavigationPending('/projects/pre-billing?stage=paid'))
  Object.assign(globalThis, { __pendingSearch: 'stage=paid' })
  await act(async () => show())
  await waitForFeedback()
  assert.equal(content.querySelector('[data-navigation-pending]'), null)
  // Native history is intentionally not an instrumentation event.
  window.history.pushState(null, '', '/projects/pre-billing?view=table')
  Object.assign(globalThis, { __pendingSearch: 'view=table' })
  await act(async () => show())
  assert.equal(navigationPendingSnapshot().navigation, null)
  await act(async () => beginNavigationPending('/projects/pre-billing?stage=approved'))
  const first = navigationPendingSnapshot().navigation!.sequence
  await act(async () => beginNavigationPending('/projects/pre-billing?stage=draft'))
  assert.ok(navigationPendingSnapshot().navigation!.sequence > first)
  await waitForFeedback()
  assert.equal(content.querySelectorAll('[data-navigation-pending]').length, 1)
  // A navigation back to the committed address cancels a stale destination.
  await act(async () => beginNavigationPending('/projects/pre-billing?view=table'))
  assert.equal(content.querySelector('[data-navigation-pending]'), null)
})

test('streaming fallback renders one logo; a same-address refusal clears navigation and preserves the recovery surface', async () => {
  await act(async () => beginNavigationPending('/projects/pre-billing?stage=paid'))
  await waitForFeedback()
  await act(async () => root.render(React.createElement(NavigationPendingBoundary, null, React.createElement(PagePending))))
  assert.equal(content.querySelectorAll('[data-page-pending]').length, 1)
  assert.equal(content.querySelectorAll('[data-navigation-pending]').length, 0)
  assert.equal(content.querySelectorAll('[role="status"]').length, 1)
  await act(async () => show(React.createElement(React.Fragment, null, React.createElement(NavigationRefusalSettled), React.createElement('button', null, 'Retry'))))
  assert.equal(navigationPendingSnapshot().navigation, null)
  assert.equal(navigationPendingSnapshot().fallbacks, 0)
  assert.equal(content.querySelector('[data-page-pending]'), null)
  assert.equal(content.querySelector('button')?.textContent, 'Retry')
})

test('history traversal uses the committed address even when the browser URL has already moved; hash and external destinations remain immediate', async () => {
  await act(async () => { finishNavigationPending(); commitNavigationHref('/projects/pre-billing?view=table') })
  window.history.replaceState(null, '', '/dashboard')
  await act(async () => beginNavigationPending('/dashboard'))
  assert.equal(navigationPendingSnapshot().navigation?.href, '/dashboard')
  Object.assign(globalThis, { __pendingPath: '/dashboard', __pendingSearch: '' })
  await act(async () => show())
  assert.equal(navigationPendingSnapshot().navigation, null)
  await act(async () => beginNavigationPending('/dashboard#summary'))
  assert.equal(navigationPendingSnapshot().navigation, null)
  await act(async () => beginNavigationPending('https://example.com'))
  assert.equal(navigationPendingSnapshot().navigation, null)
  await act(async () => root.unmount())
})
