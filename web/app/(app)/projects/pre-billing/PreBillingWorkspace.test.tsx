import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../../testing/jsdom-env'
import { stubModules } from '../../../../testing/stub-modules'
import { unbilledProject, worksheet } from './workspace-fixtures'

await bootJsdomEnvironment({ url: 'http://localhost/projects/pre-billing', matchMediaMatches: false })
const React = await import('react')
Object.assign(globalThis, { React, __prebillingReact: React, IS_REACT_ACT_ENVIRONMENT: true })
const subscribers = new Set<() => void>()
const routes: string[] = []
Object.assign(globalThis, {
  __prebillingSubscribe: (fn: () => void) => { subscribers.add(fn); return () => subscribers.delete(fn) },
  __prebillingRoutes: routes,
})
const push = window.history.pushState.bind(window.history)
window.history.pushState = (...args) => { push(...args); for (const fn of subscribers) fn() }
window.addEventListener('popstate', () => { for (const fn of subscribers) fn() })
stubModules({ navigation: { source: `
  export function usePathname(){return '/projects/pre-billing'}
  export function useSearchParams(){const q=globalThis.__prebillingReact.useSyncExternalStore(globalThis.__prebillingSubscribe,()=>window.location.search);return new URLSearchParams(q)}
  export function useRouter(){return {push(href){globalThis.__prebillingRoutes.push(href)},refresh(){globalThis.__prebillingRoutes.push('refresh')}}}
` } })
const { createRoot } = await import('react-dom/client')
const { act } = React
const { NextIntlClientProvider } = await import('next-intl')
const { default: messages } = await import('../../../../messages/en')
const { MoneyProvider } = await import('../../../../components/money-provider')
const { BusinessDateProvider } = await import('../../../../components/business-date-provider')
const { PreBillingWorkspace } = await import('./PreBillingWorkspace')
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(props: Partial<React.ComponentProps<typeof PreBillingWorkspace>> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <MoneyProvider currency="CAD"><BusinessDateProvider today="2026-10-08">
        <PreBillingWorkspace prebills={[]} unbilled={[unbilledProject()]} projects={[]}
          selected={null} canManage={false} canCreateInvoice={false}
          customerPortalEnabled={true} approvalFlowsConfigured={true} {...props} />
      </BusinessDateProvider></MoneyProvider>
    </NextIntlClientProvider>)
    await tick()
  })
  return { host, close: async () => { await act(async () => root.unmount()); host.remove() } }
}

function button(host: ParentNode, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label)
  assert.ok(found, `button ${label}`)
  return found
}

async function click(node: HTMLElement) {
  await act(async () => { node.click(); await tick() })
}

test('view and workflow stage switches update native history without router or financial reads, including back/forward', async (t) => {
  routes.length = 0
  push(null, '', '/projects/pre-billing?keep=scope#work')
  const priorFetch = globalThis.fetch
  const reads: string[] = []
  globalThis.fetch = (async (url) => { reads.push(String(url)); throw new Error('Unexpected financial read') }) as typeof fetch
  t.after(() => { globalThis.fetch = priorFetch })
  const screen = await mount()
  t.after(screen.close)
  assert.ok(screen.host.querySelector('[role="listitem"]')?.textContent?.includes('Installation'))
  await click(button(screen.host, 'Table'))
  assert.equal(window.location.search, '?keep=scope&view=table')
  assert.equal(window.location.hash, '#work')
  assert.ok(screen.host.querySelector('tbody')?.textContent?.includes('Installation'))
  const stageTabs = screen.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')
  assert.equal(stageTabs.length, 10, 'all configured stages, including zero counts, plus All open')
  await click([...stageTabs].find((tab) => tab.textContent?.startsWith('To prebill'))!)
  assert.equal(new URLSearchParams(window.location.search).get('stage'), 'unbilled')
  await click([...stageTabs].find((tab) => tab.textContent?.startsWith('Paid'))!)
  assert.ok(screen.host.textContent?.includes('Nothing in this stage'))
  await act(async () => {
    window.history.back()
    await tick()
  })
  assert.equal(new URLSearchParams(window.location.search).get('stage'), 'unbilled')
  assert.ok(screen.host.querySelector('tbody')?.textContent?.includes('Installation'))
  await act(async () => { window.history.forward(); await tick() })
  assert.equal(new URLSearchParams(window.location.search).get('stage'), 'paid')
  assert.deepEqual(routes, [])
  assert.deepEqual(reads, [])
})

test('read-only unbilled rows are inert while worksheet row and action opens retain server resolution', async (t) => {
  routes.length = 0
  push(null, '', '/projects/pre-billing?view=table')
  const screen = await mount({ prebills: [worksheet('draft')] })
  t.after(screen.close)
  const rows = screen.host.querySelectorAll<HTMLTableRowElement>('tbody tr')
  assert.equal(rows[0]!.getAttribute('tabindex'), null)
  assert.equal(rows[0]!.querySelector('button'), null, 'no Bill run action without projects.manage')
  await click(rows[0]!)
  assert.deepEqual(routes, [])
  await click(rows[1]!)
  assert.equal(routes.length, 1)
  assert.equal(new URL(routes[0]!, 'http://localhost').searchParams.get('prebill'), 'worksheet-draft')
  assert.equal(new URL(routes[0]!, 'http://localhost').searchParams.get('view'), 'table')
  await click(button(rows[1]!, 'Open'))
  assert.equal(routes.length, 2, 'one navigation per action, without row propagation')
})

test('unbilled table action opens the native Bill run with that project selected and retains drawer drafts on presentation changes', async (t) => {
  routes.length = 0
  push(null, '', '/projects/pre-billing?view=table')
  const screen = await mount({ canManage: true, unbilled: [unbilledProject(), unbilledProject({ projectId: 'project-2', projectName: 'Maintenance' })] })
  t.after(screen.close)
  await click(button(screen.host.querySelector('tbody tr')!, 'Bill run'))
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  assert.ok(dialog)
  const checks = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  assert.deepEqual(checks.map((node) => node.checked), [true, false])
  const notes = dialog.querySelector<HTMLTextAreaElement>('#bill-run-notes')!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(notes, 'Review cutoff with the project manager')
    notes.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
    window.history.pushState(null, '', '/projects/pre-billing?stage=unbilled')
    await tick()
  })
  assert.equal(document.querySelector('[role="dialog"]'), dialog)
  assert.equal(notes.value, 'Review cutoff with the project manager')
  assert.equal(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true)
  assert.deepEqual(routes, [], 'opening a Bill run does not invent or resolve a worksheet')
  await click(button(dialog, 'Cancel'))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
  assert.equal(document.querySelector('[role="dialog"]'), null)
})

test('closed board card cap has truthful full count and Show all reaches complete paginated table', async (t) => {
  routes.length = 0
  push(null, '', '/projects/pre-billing?stage=void')
  const screen = await mount({ unbilled: [], prebills: Array.from({ length: 15 }, (_, index) => worksheet('void', { id: String(index), worksheetNumber: `PB-${index}` })) })
  t.after(screen.close)
  const lane = screen.host.querySelector('[role="listitem"]')!
  assert.equal(lane.querySelectorAll('button').length, 13, '12 cards plus Show all')
  assert.ok(lane.textContent?.includes('latest 12 of 15'))
  await click(button(lane, 'Show all 15'))
  assert.equal(new URLSearchParams(window.location.search).get('stage'), 'void')
  assert.equal(new URLSearchParams(window.location.search).get('view'), 'table')
  assert.equal(screen.host.querySelectorAll('tbody tr').length, 11, '10 rows plus matching-work total')
  await click(button(screen.host, 'Next'))
  assert.ok(screen.host.querySelector('tbody')?.textContent?.includes('PB-14'))
  assert.deepEqual(routes, [])
})
