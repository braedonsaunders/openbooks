import assert from 'node:assert/strict'
import test from 'node:test'
import '../dashboard/_dashboard-render-harness'
import {
  act,
  mountDashboard,
  scriptFetch,
  tick,
} from '../dashboard/_dashboard-render-harness'
import type { OrderPayload } from './OrderDrawer'

// A purchase line costs: picking an item must default unit price from the
// item's purchase cost (default_cost), never from its sales rate — and with
// no recorded cost the price stays blank for the operator instead of
// inheriting the sell price.
const { OrderDrawer } = await import('./OrderDrawer')
const messages = (await import('../../../messages/en')).default as Record<string, unknown>

globalThis.Event = window.Event as typeof Event

const DRAFT_ID = '99999999-9999-4999-8999-999999999999'
const WIDGET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function baseDoc(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    currency: 'CAD',
    subsidiary_id: null,
    project_id: null,
    department_id: null,
    memo: null,
    due_date: null,
    document_date: '2026-08-01',
    updated_at: '2026-08-01T12:00:00.123456Z',
    subtotal: '0',
    tax_total: '0',
    total: '0',
    party_id: 'vendor-1',
    party_name: 'Acme Supplies',
    document_number: 'PO-1002',
    extra_dims: {},
    ...overrides,
  }
}

function mountPo(items: Record<string, unknown>[], lines: Record<string, unknown>[] = []) {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
  return mountDashboard(
    <OrderDrawer
      order={{ doc: baseDoc({ id: DRAFT_ID, status: 'draft' }), lines, links: [] } as unknown as OrderPayload}
      kind="purchase_order"
      parties={[{ id: 'vendor-1', display_name: 'Acme Supplies' }]}
      accounts={[{ id: 'acct-6100', number: '6100', name: 'Supplies' }]}
      items={items as never}
      stockLocations={[]}
      taxCodes={[]}
      taxGroups={[]}
      departments={[]}
      projects={[]}
      subsidiaries={[]}
      segments={[]}
      canManage
      initialMode="edit"
      closeHref="/purchasing"
    />,
    messages,
  )
}

function rowInputs(row: number): HTMLInputElement[] {
  const cell = document.querySelector(`[data-lg-row="${row}"]`)
  assert.ok(cell, `grid row ${row} renders`)
  return [...cell.parentElement!.querySelectorAll('input')] as HTMLInputElement[]
}

async function pickFirstRowItem(label: string) {
  const firstCell = document.querySelector('[data-lg-row="0"]')
  assert.ok(firstCell, 'the first grid row renders')
  const trigger = firstCell.querySelector('button')
  assert.ok(trigger, 'the item cell offers a picker')
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
  const option = [...document.querySelectorAll('[role="option"]')].find((o) => (o.textContent ?? '').includes(label))
  assert.ok(option, `the ${label} option renders`)
  await act(async () => {
    (option as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    ;(option as HTMLElement).dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    ;(option as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
}

test('a PO line defaults unit price from purchase cost, not the sales rate', async (t) => {
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountPo([
    { id: WIDGET_ID, code: 'W', name: 'Widget', default_rate: '110.50', default_cost: '85.00', income_account_id: null, expense_account_id: 'acct-6100', tax_code_id: null, unit: 'ea' },
  ])
  t.after(unmount)
  await tick()
  await tick()
  await pickFirstRowItem('Widget')
  const values = rowInputs(0).map((input) => input.value)
  assert.ok(values.includes('85'), `the line prices from purchase cost (inputs: ${JSON.stringify(values)})`)
  assert.ok(!values.some((value) => value.startsWith('110')), 'the sales rate never seeds the vendor cost')
})

test('a PO line with no recorded cost keeps a blank price', async (t) => {
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountPo([
    { id: WIDGET_ID, code: 'W', name: 'Widget', default_rate: '110.50', default_cost: null, income_account_id: null, expense_account_id: 'acct-6100', tax_code_id: null, unit: 'ea' },
  ])
  t.after(unmount)
  await tick()
  await tick()
  await pickFirstRowItem('Widget')
  const values = rowInputs(0).map((input) => input.value)
  assert.ok(!values.some((value) => value.startsWith('110')), `no cost on file means no sell-price fallback (inputs: ${JSON.stringify(values)})`)
})
