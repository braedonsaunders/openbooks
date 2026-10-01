import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

// Warehouse collections through the shared registered lists: the tie-out
// panel and the putaway queue render their rows with the shared table's
// search toolbar and empty states, keep the layer/control/difference tie-out
// visible, and keep the lifecycle menu and put-away action behind their
// respective grants.

await bootJsdomEnvironment({ url: 'http://localhost:4800/warehouse' })

Object.assign(globalThis, {
  __warehouseTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
stubModules({
  navigation: {
    source:
      'export function useRouter(){return globalThis.__warehouseTestRouter}' +
      'export function usePathname(){return "/warehouse"}' +
      'export function useSearchParams(){return new URLSearchParams()}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link':
      'export default function Link(p){return globalThis.React.createElement("a",{href:p.href,className:p.className},p.children)}',
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { BusinessDateProvider } = await import('../../../components/business-date-provider')
const { WarehousesPanel } = await import('./WarehousesPanel')
const { PutawayQueue } = await import('./PutawayQueue')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(t: TestContext, node: React.ReactNode): Promise<void> {
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const child of [...document.body.children]) child.remove()
  })
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-23">{node}</BusinessDateProvider>
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
}

const bodyText = () => document.body.textContent ?? ''
const searchBoxes = () =>
  [...document.querySelectorAll('input')] as HTMLInputElement[]

test('the tie-out panel lists warehouses with the shared search and tie-out footer', async (t) => {
  await mount(
    t,
    <WarehousesPanel
      rows={[
        { warehouseId: 'wh-1', code: 'WH-1', name: 'Main', status: 'active', valueLabel: '$10.00' },
        { warehouseId: 'wh-2', code: 'WH-2', name: 'Overflow', status: 'suspended', valueLabel: '$5.00' },
        { warehouseId: null, code: null, name: null, status: null, valueLabel: '$2.00' },
      ]}
      canManage
      currentParams={{}}
      layerTotalLabel="$17.00"
      controlLabel="$17.00"
      controlDrill={null}
      differenceLabel="$0.00"
      differenceIsZero
    />,
  )
  assert.match(bodyText(), /WH-1/)
  assert.match(bodyText(), /Overflow/)
  assert.match(bodyText(), /\$17\.00/)
  assert.ok(
    searchBoxes().length > 0,
    'the warehouse collection keeps the shared list search toolbar',
  )
})

test('the tie-out panel hides the lifecycle menu without the manage grant', async (t) => {
  await mount(
    t,
    <WarehousesPanel
      rows={[{ warehouseId: 'wh-1', code: 'WH-1', name: 'Main', status: 'active', valueLabel: '$10.00' }]}
      canManage={false}
      currentParams={{}}
      layerTotalLabel="$10.00"
      controlLabel="$10.00"
      controlDrill={null}
      differenceLabel="$0.00"
      differenceIsZero
    />,
  )
  assert.match(bodyText(), /WH-1/)
  assert.equal(
    document.querySelectorAll('button[aria-label*="WH-1"]').length,
    0,
    'no row lifecycle menu is offered to a reader without the manage grant',
  )
})

test('the putaway queue keeps its rows searchable with the action behind the posting grant', async (t) => {
  const row = {
    warehouseId: 'wh-1',
    warehouseCode: 'WH-1',
    stagingLocationId: 'stage-1',
    stagingCode: 'STAGE',
    itemId: 'item-1',
    itemLabel: 'Widget',
    subsidiaryId: 'sub-1',
    quantity: '3.0000',
  }
  await mount(t, <PutawayQueue rows={[row]} canPost />)
  assert.match(bodyText(), /STAGE/)
  assert.match(bodyText(), /Widget/)
  assert.ok(searchBoxes().length > 0, 'the putaway queue keeps the shared list search toolbar')
  const action = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim())
  assert.ok(action, 'the put-away action is offered with the posting grant')
})

test('the putaway queue names its empty state and offers no action without the posting grant', async (t) => {
  await mount(t, <PutawayQueue rows={[]} canPost={false} />)
  assert.ok(bodyText().length > 0, 'the queue renders its empty state instead of nothing')
  assert.equal(
    [...document.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim().length > 0).length,
    0,
    'no put-away action is offered without the posting grant',
  )
})
