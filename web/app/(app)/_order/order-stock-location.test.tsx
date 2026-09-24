import assert from 'node:assert/strict'
import test from 'node:test'
import '../dashboard/_dashboard-render-harness'
import {
  act,
  buttonsNamed,
  click,
  mountDashboard,
  scriptFetch,
  tick,
} from '../dashboard/_dashboard-render-harness'
import type { OrderPayload } from './OrderDrawer'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { OrderDrawer } = await import('./OrderDrawer')
const messages = (await import('../../../messages/en')).default as Record<string, unknown>

const DRAFT_ID = '77777777-7777-4777-8777-777777777777'
const LOC_1 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1'
const LOC_2 = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2'

// The order drawer must offer a line-level warehouse picker exactly when the
// choice is real (several active locations) and only on stocked rows — and
// persist the choice through the draft writer. (Was F-t07-003 pickers.)
const ITEMS = [
  { id: 'item-stocked', display_name: 'Widget', has_inventory_profile: true },
  { id: 'item-expense', display_name: 'Consulting' },
]
const LOCATIONS = [
  { id: LOC_1, code: 'WH-1' },
  { id: LOC_2, code: 'WH-2' },
]

function draftOrder(lines: Record<string, unknown>[]): OrderPayload {
  return {
    doc: {
      id: DRAFT_ID,
      status: 'draft',
      currency: 'USD',
      subsidiary_id: null,
      project_id: null,
      department_id: null,
      memo: null,
      due_date: null,
      document_date: '2026-08-01',
      updated_at: '2026-08-01T12:00:00.123456Z',
      subtotal: '100.00',
      tax_total: '0',
      total: '100.00',
      party_id: 'vendor-1',
      party_name: 'Acme Supplies',
      document_number: null,
      extra_dims: {},
    },
    lines,
    links: [],
  }
}

function stockedLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: 'item-stocked',
    account_id: 'acct-1400',
    description: 'Widget',
    quantity: '2',
    unit: 'ea',
    unit_price: '50.00',
    tax_code_id: null,
    tax_group_id: null,
    department_id: null,
    project_id: null,
    stock_location_id: LOC_1,
    extra_dims: {},
    ...overrides,
  }
}

function expenseLine(): Record<string, unknown> {
  return {
    item_id: 'item-expense',
    account_id: 'acct-6100',
    description: 'Consulting',
    quantity: '1',
    unit: 'hr',
    unit_price: '100.00',
    tax_code_id: null,
    tax_group_id: null,
    department_id: null,
    project_id: null,
    stock_location_id: null,
    extra_dims: {},
  }
}

async function mountDraft(lines: Record<string, unknown>[], stockLocations: { id: string; code: string | null }[]) {
  return mountDashboard(
    <OrderDrawer
      order={draftOrder(lines)}
      kind="purchase_order"
      parties={[{ id: 'vendor-1', display_name: 'Acme Supplies' }]}
      accounts={[]}
      items={ITEMS}
      stockLocations={stockLocations}
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

/** Warehouse selects are the selects offering a location code option. */
function warehouseSelectsIn(row: number): HTMLSelectElement[] {
  const cells = [...document.querySelectorAll(`[data-lg-row="${row}"]`)]
  return cells.flatMap((cell) =>
    [...cell.querySelectorAll('select')].filter((sel) =>
      [...sel.options].some((o) => o.text === 'WH-1' || o.text === 'WH-2'),
    ),
  ) as HTMLSelectElement[]
}

function warehouseHeader(): boolean {
  return [...document.querySelectorAll('div')].some(
    (el) => el.textContent === 'Warehouse' && el.className.includes('uppercase'),
  )
}

test('the order picker shows only for several locations and stocked rows', async (t) => {
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith('/api/flows/')) {
      return Response.json({ error: 'no flow state' }, { status: 404 })
    }
    return null
  })
  t.after(restoreFetch)

  const { unmount } = await mountDraft([stockedLine(), expenseLine()], LOCATIONS)
  t.after(unmount)
  assert.ok(warehouseHeader(), 'several locations must offer the Warehouse column')
  const stocked = warehouseSelectsIn(0)
  assert.equal(stocked.length, 1, 'the stocked row must offer exactly one warehouse picker')
  const picker = stocked[0]
  assert.ok(picker, 'the stocked row must offer the picker')
  assert.deepEqual(
    [...picker.options].map((o) => o.text),
    ['—', 'WH-1', 'WH-2'],
    'the picker must offer every active location',
  )
  assert.equal(picker.value, LOC_1, 'the stored line warehouse must hydrate the picker')
  assert.equal(warehouseSelectsIn(1).length, 0, 'a non-stocked row must get no warehouse picker')
})

test('a single location never asks a question', async (t) => {
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith('/api/flows/')) {
      return Response.json({ error: 'no flow state' }, { status: 404 })
    }
    return null
  })
  t.after(restoreFetch)
  const single = LOCATIONS[0]
  assert.ok(single, 'the fixture must offer one location')
  const { unmount } = await mountDraft([stockedLine(), expenseLine()], [single])
  t.after(unmount)
  assert.equal(warehouseHeader(), false, 'one location must render no Warehouse column')
  assert.equal(warehouseSelectsIn(0).length, 0, 'one location must render no picker even on stocked rows')
})

test('no stocked row means no warehouse column', async (t) => {
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith('/api/flows/')) {
      return Response.json({ error: 'no flow state' }, { status: 404 })
    }
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountDraft([expenseLine()], LOCATIONS)
  t.after(unmount)
  assert.equal(warehouseHeader(), false, 'expense-only lines must render no Warehouse column')
})

test('the save payload sends the picked line warehouse', async (t) => {
  const bodies: unknown[] = []
  const restoreFetch = scriptFetch((url, init) => {
    if (url.startsWith('/api/flows/')) {
      return Response.json({ error: 'no flow state' }, { status: 404 })
    }
    if (url === `/api/purchase-orders/${DRAFT_ID}` && init?.method === 'PATCH') {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ doc: { updated_at: '2026-08-01T12:00:01.123456Z' } })
    }
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountDraft([stockedLine({ stock_location_id: null }), expenseLine()], LOCATIONS)
  t.after(unmount)
  const picker = warehouseSelectsIn(0)[0]
  assert.ok(picker, 'the stocked row must offer the picker')
  await act(async () => {
    picker.value = LOC_2
    picker.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  const menu = buttonsNamed('Actions')[0]
  assert.ok(menu, 'record actions must live behind the Actions menu')
  await click(menu)
  const save = buttonsNamed('Save')[0]
  assert.ok(save, 'edit mode must offer Save')
  await click(save)
  await tick()
  assert.equal(bodies.length, 1, 'save must issue one draft PATCH')
  const lines = (bodies[0] as { lines?: { stockLocationId?: unknown }[] }).lines
  assert.ok(Array.isArray(lines) && lines.length > 0, 'the save payload must carry lines')
  const firstLine = lines[0]
  assert.ok(firstLine, 'the save payload must carry the stocked line')
  assert.equal(
    firstLine.stockLocationId,
    LOC_2,
    'the save payload must send the picked warehouse on the stocked line',
  )
})
