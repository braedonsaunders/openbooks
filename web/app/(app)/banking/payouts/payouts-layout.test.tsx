import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/banking/payouts', matchMediaMatches: false })
const route = { query: 'subsidiaryId=entity-a', replaced: '' }
Object.assign(globalThis, { __payoutLayoutRoute: route })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: `const state=globalThis.__payoutLayoutRoute;export function useRouter(){return{replace(url){state.replaced=url;state.query=url.slice(1)},refresh(){}}}export function useSearchParams(){return new URLSearchParams(state.query)}export function usePathname(){return '/banking/payouts'}` })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { PayoutsWorkspace } = await import('./sections')
import type { PayoutsWorkspaceProps } from './sections'

const strings = new Proxy({ queueTitle: 'Needs review', batchesTitle: 'Payout batches', kindLabels: { sale: 'Sale' } }, {
  get(target, key: string) { return key in target ? target[key as keyof typeof target] : key },
}) as unknown as PayoutsWorkspaceProps['strings']
const props = {
  canReconcile: false,
  tiles: [],
  queue: [{ lineId: 'line-a', batchId: 'batch-a', provider: 'Provider', externalRef: 'Review payout', settlementDate: '2026-10-01', kind: 'sale', amount: '10.00 USD' }],
  batches: [{ id: 'batch-a', provider: 'Provider', externalRef: 'Batch payout', settlementDate: '2026-10-01', netAmount: '10.00 USD', status: 'draft', statusLabel: 'Draft', unmatchedLines: 1, tied: false, accrued: false }],
  reportHref: '/reports', queueAllHref: '/banking/payouts/unmatched', strings,
  emptyTitle: 'No payouts', emptyDescription: 'Import a provider payout to review it.',
} as unknown as PayoutsWorkspaceProps

async function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = async () => act(async () => root.render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD"><PayoutsWorkspace {...props} /></MoneyProvider>
    </NextIntlClientProvider>,
  ))
  await render()
  return { host, render, async close() { await act(async () => root.unmount()); host.remove() } }
}

test('payout review and batches replace each other rather than stacking tables', async () => {
  route.query = 'subsidiaryId=entity-a'
  const view = await mount()
  try {
    assert.equal(view.host.querySelectorAll('table').length, 1, 'the review tab must show only its queue table')
    assert.ok(view.host.textContent?.includes('Review payout'))
    assert.ok(!view.host.textContent?.includes('Batch payout'))
    const batches = [...view.host.querySelectorAll('button')].find(button => button.textContent === 'Payout batches')
    assert.ok(batches, 'a separate Payout batches tab must remain reachable')
    await act(async () => batches.click())
    assert.equal(new URLSearchParams(route.replaced.slice(1)).get('subsidiaryId'), 'entity-a', 'changing tabs must retain the legal-entity filter')
    await view.render()
    assert.equal(view.host.querySelectorAll('table').length, 1, 'the batches tab must replace the queue table')
    assert.ok(view.host.textContent?.includes('Batch payout'))
    assert.ok(!view.host.textContent?.includes('Review payout'))
    route.query = 'subsidiaryId=entity-a'
    await view.render()
    assert.ok(view.host.textContent?.includes('Review payout'), 'back navigation must restore the review tab')
  } finally { await view.close() }
})

test('a payout batches deep link renders only batches and retains the view when opening a record', async () => {
  route.query = 'view=batches&subsidiaryId=entity-a'
  const view = await mount()
  try {
    assert.equal(view.host.querySelectorAll('table').length, 1)
    assert.ok(view.host.textContent?.includes('Batch payout'))
    assert.ok(!view.host.textContent?.includes('Review payout'))
    const open = [...view.host.querySelectorAll('button')].find(button => button.textContent === 'openLabel')
    assert.ok(open, 'the batch record action must remain reachable')
    await act(async () => open.click())
    const params = new URLSearchParams(route.replaced.slice(1))
    assert.equal(params.get('payout'), 'batch-a')
    assert.equal(params.get('view'), 'batches')
    assert.equal(params.get('subsidiaryId'), 'entity-a')
  } finally { await view.close() }
})
