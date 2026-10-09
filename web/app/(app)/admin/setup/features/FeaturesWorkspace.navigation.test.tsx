import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../../../testing/jsdom-env'
import { stubModules } from '../../../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/admin/setup/features?tab=finance&draft=kept#features' })
stubModules({
  navigation: {
    source: "export function usePathname(){return window.location.pathname}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function useRouter(){return{push(){throw new Error('presentation must not request a server route')},replace(){},refresh(){}}}",
  },
  intl: false, authz: false, features: false,
  extra: {
    'next/link': `import React from 'react';export default function Link({href,onNavigate,onClick,children,prefetch,transitionTypes,...props}){
      return React.createElement('a',{...props,href,'data-prefetch':String(prefetch),onClick(e){e.preventDefault();onClick?.(e);let stopped=false;onNavigate?.({preventDefault(){stopped=true}});if(!stopped)globalThis.__featuresRouteStart(String(href))}},children)
    }`,
    sonner: 'export const toast={success(){},error(){}}',
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { FeaturesWorkspace } = await import('./FeaturesWorkspace')
const { ModuleHomeTabs } = await import('../../../../../components/module-home/tabs')
const { NavigationPendingBoundary, NavigationCommit } = await import('../../../../../components/page-pending')
const { navigationPendingSnapshot, finishNavigationPending } = await import('../../../../../lib/navigation-pending')
const { onRouterTransitionStart } = await import('../../../../../instrumentation-client')
Object.assign(globalThis, { __featuresRouteStart: onRouterTransitionStart })

const features = [
  { key: 'budgets', category: 'finance', group: 'planning', enabled: true },
  { key: 'inventory', category: 'inventory', group: 'items', enabled: true },
  { key: 'manufacturing', category: 'manufacturing', group: 'production', enabled: false, requiresAll: ['inventory'] },
]

test('Features tabs use immediate presentation history and preserve drafts; a genuine route still shows loading feedback', async (t) => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove(); finishNavigationPending() })
  const priorFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (async () => { fetches++; throw new Error('A presentation switch must not fetch') }) as typeof fetch
  t.after(() => { globalThis.fetch = priorFetch })
  const show = () => root.render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <NavigationPendingBoundary><NavigationCommit>
        <input aria-label="Unsaved settings draft" defaultValue="Original draft" />
        <FeaturesWorkspace features={features} />
        <ModuleHomeTabs navigation="history" placement="local" ariaLabel="Route control"
          tabs={[{ href: '/admin/setup/features?tab=finance', label: 'Feature overview' }, { href: '/admin/audit', label: 'Open audit' }]} />
      </NavigationCommit></NavigationPendingBoundary>
    </NextIntlClientProvider>,
  )
  await act(async () => show())
  const draft = host.querySelector('input[aria-label="Unsaved settings draft"]') as HTMLInputElement
  draft.value = 'Unsaved edit'
  const manufacturing = host.querySelector('a[href*="tab=manufacturing"]')!
  assert.equal(manufacturing.getAttribute('data-prefetch'), 'false')
  await act(async () => {
    manufacturing.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    show()
    await new Promise(resolve => setTimeout(resolve, 140))
  })
  assert.equal(new URLSearchParams(window.location.search).get('tab'), 'manufacturing')
  assert.equal(new URLSearchParams(window.location.search).get('draft'), 'kept')
  assert.equal(window.location.hash, '#features')
  assert.match(host.textContent ?? '', /Production and material planning/)
  assert.equal(navigationPendingSnapshot().navigation, null)
  assert.equal(host.querySelector('[data-navigation-pending]'), null)
  assert.equal(host.querySelector('input[aria-label="Unsaved settings draft"]'), draft)
  assert.equal(draft.value, 'Unsaved edit')
  assert.equal(fetches, 0)
  const back = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
  await act(async () => { window.history.back(); await back; show() })
  assert.equal(new URLSearchParams(window.location.search).get('tab'), 'finance')
  assert.match(host.textContent ?? '', /Planning/)
  assert.equal(draft.value, 'Unsaved edit')
  assert.equal(navigationPendingSnapshot().navigation, null)
  const forward = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
  await act(async () => { window.history.forward(); await forward; show() })
  assert.equal(new URLSearchParams(window.location.search).get('tab'), 'manufacturing')
  assert.equal(window.location.hash, '#features')
  assert.equal(draft.value, 'Unsaved edit')
  assert.equal(navigationPendingSnapshot().navigation, null)
  await act(async () => {
    host.querySelector('a[href="/admin/audit"]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 140)) })
  assert.equal(navigationPendingSnapshot().navigation?.href, '/admin/audit')
  assert.ok(host.querySelector('[data-navigation-pending]'), 'actual routes keep the global pending feedback')
  assert.equal(draft.value, 'Unsaved edit')
})


test('Features overflow entries use the same presentation history without global loading', async (t) => {
  window.history.replaceState({}, '', '/admin/setup/features?tab=finance&draft=kept#features')
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const width = this.hasAttribute('data-subtabs-track') ? 210
      : this.getAttribute('data-tab-measure') === 'tab' ? 110
      : this.hasAttribute('data-tab-measure') ? 80 : 0
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 32, width, height: 32, toJSON() { return {} } }
  }
  t.after(() => { window.HTMLElement.prototype.getBoundingClientRect = originalRect })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove(); finishNavigationPending() })
  const show = () => root.render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <NavigationPendingBoundary><NavigationCommit><FeaturesWorkspace features={features} /></NavigationCommit></NavigationPendingBoundary>
    </NextIntlClientProvider>,
  )
  await act(async () => show())
  const more = host.querySelector('[data-subtabs-track] button')!
  assert.ok(more, 'a narrow strip exposes the native overflow menu')
  await act(async () => more.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
  const entry = document.querySelector('a[role="menuitem"][href*="tab=manufacturing"]')!
  assert.ok(entry, 'Manufacturing remains reachable through overflow')
  assert.equal(entry.getAttribute('data-prefetch'), 'false')
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); show() })
  assert.equal(new URLSearchParams(window.location.search).get('tab'), 'manufacturing')
  assert.equal(new URLSearchParams(window.location.search).get('draft'), 'kept')
  assert.equal(window.location.hash, '#features')
  assert.equal(navigationPendingSnapshot().navigation, null)
  assert.equal(host.querySelector('[data-navigation-pending]'), null)
  assert.match(host.textContent ?? '', /Production and material planning/)
})
