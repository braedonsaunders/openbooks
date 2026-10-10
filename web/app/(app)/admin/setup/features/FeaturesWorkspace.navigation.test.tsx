import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../../../testing/jsdom-env'
import { stubModules } from '../../../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/admin/setup/features?tab=finance&draft=kept#features' })
const reactUrl = import.meta.resolve('react')
let navigationHref = window.location.href
const navigationListeners = new Set<() => void>()
const navigationStore = {
  subscribe(listener: () => void) { navigationListeners.add(listener); return () => { navigationListeners.delete(listener) } },
  getSnapshot() { return navigationHref },
}
Object.assign(globalThis, { __featuresNavigationStore: navigationStore })
stubModules({
  navigation: {
    source: `import {useSyncExternalStore,useMemo} from ${JSON.stringify(reactUrl)};
      function useUrl(){const store=globalThis.__featuresNavigationStore;const href=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);return useMemo(()=>new URL(href),[href])}
      export function usePathname(){return useUrl().pathname}
      export function useSearchParams(){const search=useUrl().search;return useMemo(()=>new URLSearchParams(search),[search])}
      export function useRouter(){return{push(){throw new Error('presentation must not request a server route')},replace(){},refresh(){}}}`,
  },
  intl: false, authz: false, features: false,
  extra: {
    'next/link': `import React from ${JSON.stringify(reactUrl)};export default function Link({href,onNavigate,onClick,children,prefetch,transitionTypes,...props}){
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

/** Model the installed Next history boundary, including its internal-write bypass.
 * URL hooks observe router restoration, not arbitrary reads of window.location. */
function installNextHistoryBoundary() {
  const originalPush = window.history.pushState
  const originalReplace = window.history.replaceState
  const tree = { segment: 'features' }
  const writes: unknown[] = []
  const restore = (url: string | URL) => {
    navigationHref = new URL(url, window.location.href).href
    navigationListeners.forEach((listener) => listener())
  }
  originalReplace.call(window.history, { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: tree }, '',
    '/admin/setup/features?tab=finance&draft=kept#features')
  restore(window.location.href)
  window.history.pushState = function (data, unused, url) {
    writes.push(data)
    if (data?.__NA || data?._N) return originalPush.call(this, data, unused, url)
    const state = { ...data, __NA: this.state?.__NA, __PRIVATE_NEXTJS_INTERNALS_TREE: this.state?.__PRIVATE_NEXTJS_INTERNALS_TREE }
    if (url) restore(url)
    return originalPush.call(this, state, unused, url)
  }
  const traverse = (event: PopStateEvent) => {
    if (event.state?.__NA) restore(window.location.href)
  }
  window.addEventListener('popstate', traverse)
  return { writes, tree, dispose() { window.history.pushState = originalPush; window.removeEventListener('popstate', traverse) } }
}

test('Features tabs use immediate presentation history and preserve drafts; a genuine route still shows loading feedback', async (t) => {
  const history = installNextHistoryBoundary()
  t.after(() => history.dispose())
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
    await new Promise(resolve => setTimeout(resolve, 140))
  })
  assert.deepEqual(history.writes, [null], 'presentation writes let Next restore its URL observers')
  assert.equal(window.history.state.__NA, true, 'Next preserves its app-router marker')
  assert.deepEqual(window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE, history.tree)
  assert.equal(new URLSearchParams(window.location.search).get('tab'), 'manufacturing')
  assert.equal(new URLSearchParams(window.location.search).get('draft'), 'kept')
  assert.equal(window.location.hash, '#features')
  assert.match(host.textContent ?? '', /Production and material planning/)
  assert.equal(host.querySelector('a[href*="tab=manufacturing"]')?.getAttribute('aria-current'), 'page')
  assert.equal(host.querySelector('a[href*="tab=finance"]')?.getAttribute('aria-current'), null)
  assert.equal(navigationPendingSnapshot().navigation, null)
  assert.equal(host.querySelector('[data-navigation-pending]'), null)
  assert.equal(host.querySelector('input[aria-label="Unsaved settings draft"]'), draft)
  assert.equal(draft.value, 'Unsaved edit')
  assert.equal(fetches, 0)
  const back = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
  await act(async () => { window.history.back(); await back })
  assert.equal(new URLSearchParams(window.location.search).get('tab'), 'finance')
  assert.match(host.textContent ?? '', /Planning/)
  assert.equal(host.querySelector('a[href*="tab=finance"]')?.getAttribute('aria-current'), 'page')
  assert.equal(draft.value, 'Unsaved edit')
  assert.equal(navigationPendingSnapshot().navigation, null)
  const forward = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
  await act(async () => { window.history.forward(); await forward })
  assert.equal(new URLSearchParams(window.location.search).get('tab'), 'manufacturing')
  assert.equal(window.location.hash, '#features')
  assert.match(host.textContent ?? '', /Production and material planning/)
  assert.equal(host.querySelector('a[href*="tab=manufacturing"]')?.getAttribute('aria-current'), 'page')
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
  const history = installNextHistoryBoundary()
  t.after(() => history.dispose())
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
  await act(async () => { entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(history.writes, [null])
  assert.equal(new URLSearchParams(window.location.search).get('tab'), 'manufacturing')
  assert.equal(new URLSearchParams(window.location.search).get('draft'), 'kept')
  assert.equal(window.location.hash, '#features')
  assert.equal(navigationPendingSnapshot().navigation, null)
  assert.equal(host.querySelector('[data-navigation-pending]'), null)
  assert.match(host.textContent ?? '', /Production and material planning/)
  assert.match(host.querySelector('[data-subtabs-track] button')?.textContent ?? '', /Manufacturing/)
})
