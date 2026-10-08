import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment, setJsdomInput } from '../../../../testing/jsdom-env'
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
const replace = window.history.replaceState.bind(window.history)
window.history.pushState = (...args) => { push(...args); for (const fn of subscribers) fn() }
window.history.replaceState = (...args) => { replace(...args); for (const fn of subscribers) fn() }
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

const stages = [
  ['unbilled', 'To pre-bill'], ['draft', 'Draft'], ['review', 'In approval'],
  ['ready', 'Ready to invoice'], ['customer', 'With customer'],
  ['invoiced', 'Invoiced'], ['sent', 'Sent'],
] as const
const stageKeys = stages.map(([key]) => key)
const stageLabels = stages.map(([, label]) => label)

function tabs(host: ParentNode) {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
}
function stageTab(host: ParentNode, stage: string) {
  const label = stages.find(([key]) => key === stage)![1]
  const found = tabs(host).find((tab) => tab.textContent?.startsWith(label))
  assert.ok(found, `workflow tab ${label}`)
  return found
}
function lanes(host: ParentNode) {
  return [...host.querySelectorAll<HTMLElement>('[role="listitem"]')]
}
function assertBoard(host: ParentNode, selected: string, labels: readonly string[] = stageLabels) {
  const columns = lanes(host)
  assert.deepEqual(columns.map((column) => column.getAttribute('aria-label')), labels)
  assert.equal(columns.filter((column) => column.getAttribute('aria-current') === 'step').length, 1)
  assert.equal(columns.find((column) => column.getAttribute('aria-current') === 'step')!.getAttribute('aria-label'), stages.find(([key]) => key === selected)![1])
  assert.equal(host.querySelector('table'), null, 'board selections retain Kanban rather than a table')
  assert.equal(tabs(host).find((tab) => tab.getAttribute('aria-selected') === 'true'), stageTab(host, selected))
}
async function search(host: ParentNode, value: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search customers, projects, worksheets"]')!
  assert.ok(input)
  await act(async () => { setJsdomInput(input, value); await tick() })
}

function populatedWorksheets() {
  return [...stageKeys.filter((stage) => stage !== 'unbilled').map((stage) => worksheet(stage)), worksheet('paid'), worksheet('void')]
}

test('every workflow selection and view round-trip retain ordered Kanban cards and matching table stage/count/amount', async (t) => {
  routes.length = 0
  push(null, '', '/projects/pre-billing')
  const screen = await mount({ prebills: populatedWorksheets() })
  t.after(screen.close)
  assert.deepEqual(tabs(screen.host).map((tab) => tab.textContent?.trim()), stageLabels.map((label) => `${label}1`))
  for (const [stage, label] of stages) {
    const columnsBeforeSelection = lanes(screen.host)
    await click(stageTab(screen.host, stage))
    assertBoard(screen.host, stage)
    lanes(screen.host).forEach((column, index) => assert.equal(column, columnsBeforeSelection[index], 'stage selection preserves its mounted Kanban column'))
    assert.equal(screen.host.querySelectorAll('[role="listitem"] article').length, 1)
    assert.equal(screen.host.querySelectorAll('[role="listitem"] button').length, 6)
    assert.ok(!screen.host.textContent?.includes('PB-paid') && !screen.host.textContent?.includes('PB-void'))
    const lane = lanes(screen.host).find((column) => column.getAttribute('aria-label') === label)!
    const laneTotal = lane.querySelector('header > span')!.textContent
    await click(button(screen.host, 'Table'))
    assert.equal(stageTab(screen.host, stage).getAttribute('aria-selected'), 'true')
    const rows = screen.host.querySelectorAll('tbody tr')
    assert.equal(rows.length, 2, 'one stage record and its complete matching total')
    assert.ok(rows[0]!.textContent?.includes(stage === 'unbilled' ? 'Installation' : `PB-${stage}`))
    assert.equal(rows[1]!.querySelectorAll('td')[1]!.textContent, laneTotal)
    assert.deepEqual(tabs(screen.host).map((tab) => tab.textContent?.trim()), stageLabels.map((name) => `${name}1`))
    await click(button(screen.host, 'Board'))
    assertBoard(screen.host, stage)
    assert.equal(screen.host.querySelectorAll('[role="listitem"] button').length, 6)
  }
  assert.deepEqual(routes, [])
})

test('empty and filtered-empty boards keep every applicable lane after every selection', async (t) => {
  push(null, '', '/projects/pre-billing')
  const empty = await mount({ unbilled: [] })
  try {
    for (const [stage] of stages) {
      await click(stageTab(empty.host, stage))
      assertBoard(empty.host, stage)
      assert.ok(lanes(empty.host).every((lane) => lane.querySelector('h3 span')!.textContent?.trim() === '0'))
      assert.equal(empty.host.querySelectorAll('[role="listitem"] article, [role="listitem"] button').length, 0)
    }
  } finally { await empty.close() }
  push(null, '', '/projects/pre-billing')
  const screen = await mount({ prebills: populatedWorksheets() })
  t.after(screen.close)
  await search(screen.host, 'no matching customer or project')
  for (const [stage] of stages) {
    await click(stageTab(screen.host, stage))
    assertBoard(screen.host, stage)
    assert.ok(lanes(screen.host).every((lane) => lane.querySelector('h3 span')!.textContent?.trim() === '0'))
    assert.equal(screen.host.querySelectorAll('[role="listitem"] article, [role="listitem"] button').length, 0)
    await click(button(screen.host, 'Table'))
    assert.ok(screen.host.textContent?.includes('Nothing in this stage'))
    await click(button(screen.host, 'Board'))
    assertBoard(screen.host, stage)
  }
  await search(screen.host, ' PB-review ')
  assert.equal(lanes(screen.host).find((lane) => lane.getAttribute('aria-label') === 'In approval')!.querySelector('h3 span')!.textContent?.trim(), '1')
  assert.equal(screen.host.querySelectorAll('[role="listitem"] button').length, 1)
  await click(stageTab(screen.host, 'review'))
  await click(button(screen.host, 'Table'))
  assert.ok(screen.host.querySelector('tbody')!.textContent?.includes('PB-review'))
  assert.equal(screen.host.querySelectorAll('tbody tr').length, 2)
})

test('native presentation history and keyboard selection retain search, host params and hash without financial reads', async (t) => {
  routes.length = 0
  push(null, '', '/projects/pre-billing?keep=scope#work')
  const priorFetch = globalThis.fetch
  const reads: string[] = []
  globalThis.fetch = (async (url) => { reads.push(String(url)); throw new Error('Unexpected financial read') }) as typeof fetch
  t.after(() => { globalThis.fetch = priorFetch })
  const screen = await mount({ prebills: populatedWorksheets() })
  t.after(screen.close)
  assertBoard(screen.host, 'unbilled')
  await search(screen.host, 'Installation')
  await click(button(screen.host, 'Table'))
  await click(stageTab(screen.host, 'draft'))
  await click(stageTab(screen.host, 'ready'))
  await act(async () => { window.history.back(); await tick() })
  assert.equal(new URLSearchParams(window.location.search).get('stage'), 'draft')
  assert.ok(screen.host.querySelector('tbody')!.textContent?.includes('PB-draft'))
  await act(async () => { window.history.forward(); await tick() })
  assert.equal(new URLSearchParams(window.location.search).get('stage'), 'ready')
  assert.ok(screen.host.querySelector('tbody')!.textContent?.includes('PB-ready'))
  assert.equal(new URLSearchParams(window.location.search).get('keep'), 'scope')
  assert.equal(window.location.hash, '#work')
  assert.equal(screen.host.querySelector<HTMLInputElement>('input')!.value, 'Installation')
  await click(button(screen.host, 'Board'))
  assertBoard(screen.host, 'ready')
  for (const [key, expected] of [['End', 'sent'], ['Home', 'unbilled'], ['ArrowRight', 'draft']] as const) {
    const active = tabs(screen.host).find((tab) => tab.getAttribute('aria-selected') === 'true')!
    active.focus()
    await act(async () => { active.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })); await tick() })
    assertBoard(screen.host, expected)
    assert.equal(document.activeElement, stageTab(screen.host, expected))
  }
  assert.deepEqual(routes, [])
  assert.deepEqual(reads, [])
})

test('old aggregate, closed and inapplicable deep links replace the same history entry without losing drawer identity', async () => {
  routes.length = 0
  for (const stage of ['all', 'all-open', 'all_open', 'paid', 'void', 'unknown', 'review', 'customer']) {
    push(null, '', `/projects/pre-billing?view=table&stage=${stage}&prebill=historical-worksheet&keep=scope#work`)
    const historyLength = window.history.length
    const screen = await mount({ approvalFlowsConfigured: false, customerPortalEnabled: false, prebills: [worksheet('paid'), worksheet('void')] })
    try {
      assert.equal(window.history.length, historyLength, 'normalization replaces rather than adds navigation')
      const params = new URLSearchParams(window.location.search)
      assert.equal(params.get('stage'), 'unbilled')
      assert.equal(params.get('view'), 'table')
      assert.equal(params.get('prebill'), 'historical-worksheet', 'server-resolved drawer identity is preserved')
      assert.equal(params.get('keep'), 'scope')
      assert.equal(window.location.hash, '#work')
      assert.deepEqual(tabs(screen.host).map((tab) => tab.textContent?.trim()), ['To pre-bill1', 'Draft0', 'Ready to invoice0', 'Invoiced0', 'Sent0'])
      assert.ok(!screen.host.querySelector('tbody')!.textContent?.includes('PB-paid') && !screen.host.querySelector('tbody')!.textContent?.includes('PB-void'))
      await click(button(screen.host, 'Board'))
      assertBoard(screen.host, 'unbilled', ['To pre-bill', 'Draft', 'Ready to invoice', 'Invoiced', 'Sent'])
    } finally { await screen.close() }
  }
  assert.deepEqual(routes, [], 'normalizing presentation must not fetch or resolve a new record')
})

test('read-only unbilled rows are inert while worksheet row and action retain native server resolution', async (t) => {
  routes.length = 0
  push(null, '', '/projects/pre-billing?view=table&keep=scope')
  const screen = await mount({ prebills: [worksheet('draft')] })
  t.after(screen.close)
  const projectRow = screen.host.querySelector<HTMLTableRowElement>('tbody tr')!
  assert.equal(projectRow.getAttribute('tabindex'), null)
  assert.equal(projectRow.querySelector('button'), null, 'no Bill run action without projects.manage')
  await click(projectRow)
  await act(async () => { projectRow.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick() })
  assert.deepEqual(routes, [])
  await click(stageTab(screen.host, 'draft'))
  const worksheetRow = screen.host.querySelector<HTMLTableRowElement>('tbody tr')!
  await click(worksheetRow)
  assert.equal(routes.length, 1)
  const params = new URL(routes[0]!, 'http://localhost').searchParams
  assert.equal(params.get('prebill'), 'worksheet-draft')
  assert.equal(params.get('view'), 'table')
  assert.equal(params.get('stage'), 'draft')
  assert.equal(params.get('keep'), 'scope')
  await click(button(worksheetRow, 'Open'))
  assert.equal(routes.length, 2, 'one native navigation per action, without row propagation')
  await act(async () => { worksheetRow.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick() })
  assert.equal(routes.length, 3, 'keyboard row opening retains native resolution')
  await click(button(screen.host, 'Board'))
  await click(lanes(screen.host).find((lane) => lane.getAttribute('aria-label') === 'Draft')!.querySelector<HTMLButtonElement>('button')!)
  assert.equal(routes.length, 4)
  assert.equal(new URL(routes[3]!, 'http://localhost').searchParams.get('prebill'), 'worksheet-draft')
})

test('native Bill run keeps the selected project and edited draft across view/stage changes and old-stage normalization', async (t) => {
  routes.length = 0
  push(null, '', '/projects/pre-billing?view=table&keep=scope#work')
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
    window.history.pushState(null, '', '/projects/pre-billing?stage=draft&keep=scope#work')
    await tick()
  })
  assertBoard(screen.host, 'draft')
  await act(async () => { window.history.pushState(null, '', '/projects/pre-billing?view=table&stage=paid&keep=scope#work'); await tick() })
  assert.equal(new URLSearchParams(window.location.search).get('stage'), 'unbilled')
  assert.equal(new URLSearchParams(window.location.search).get('keep'), 'scope')
  assert.equal(window.location.hash, '#work')
  assert.equal(document.querySelector('[role="dialog"]'), dialog)
  assert.equal(notes.value, 'Review cutoff with the project manager')
  assert.deepEqual(checks.map((node) => node.checked), [true, false])
  assert.deepEqual(routes, [], 'opening a Bill run does not invent or resolve a worksheet')
  await click(button(dialog, 'Cancel'))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
  assert.equal(document.querySelector('[role="dialog"]'), null, 'native cancel semantics are unchanged')
})

test('all active cards remain available and table pagination keeps the complete matching-stage total', async (t) => {
  routes.length = 0
  push(null, '', '/projects/pre-billing?stage=invoiced')
  const screen = await mount({ unbilled: [], prebills: Array.from({ length: 15 }, (_, index) => worksheet('invoiced', { id: String(index), worksheetNumber: `PB-${index}` })) })
  t.after(screen.close)
  assertBoard(screen.host, 'invoiced')
  const invoiceLane = lanes(screen.host).find((lane) => lane.getAttribute('aria-label') === 'Invoiced')!
  assert.equal(invoiceLane.querySelectorAll('button').length, 15)
  assert.equal(invoiceLane.querySelector('h3 span')!.textContent?.trim(), '15')
  const fullTotal = invoiceLane.querySelector('header > span')!.textContent
  await click(button(screen.host, 'Table'))
  assert.equal(screen.host.querySelectorAll('tbody tr').length, 11, 'ten native page rows and complete matching-stage total')
  assert.equal(screen.host.querySelector('tbody tr:last-child td:nth-child(2)')!.textContent, fullTotal)
  await click(button(screen.host, 'Next'))
  assert.equal(screen.host.querySelectorAll('tbody tr').length, 6)
  assert.ok(screen.host.querySelector('tbody')!.textContent?.includes('PB-14'))
  assert.equal(screen.host.querySelector('tbody tr:last-child td:nth-child(2)')!.textContent, fullTotal)
  await click(button(screen.host, 'Board'))
  assertBoard(screen.host, 'invoiced')
  assert.equal(lanes(screen.host).find((lane) => lane.getAttribute('aria-label') === 'Invoiced')!.querySelectorAll('button').length, 15)
  assert.deepEqual(routes, [])
})
