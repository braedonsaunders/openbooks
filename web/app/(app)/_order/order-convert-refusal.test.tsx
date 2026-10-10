import assert from 'node:assert/strict'
import test from 'node:test'
import '../dashboard/_dashboard-render-harness'
import {
  buttonsContaining,
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

const PO_ID = '33333333-3333-4333-8333-333333333333'

// "Convert to Goods receipt" on an expense-line-only PO 422s ("line 1 is not
// stock and is billed on a two-way match, not received") and the drawer only
// toasted — no toast survives attention, and the PO just sits Approved. A
// convert refusal must pin as a record-level alert until the next action,
// carrying the server's typed reason. (Was .)
function approvedExpensePo(): OrderPayload {
  return {
    doc: {
      id: PO_ID,
      status: 'approved',
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
      document_number: 'PO-1001',
      extra_dims: {},
    },
    lines: [
      {
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
      },
    ],
    links: [],
  }
}

async function mountPo() {
  return mountDashboard(
    <OrderDrawer
      order={approvedExpensePo()}
      kind="purchase_order"
      parties={[{ id: 'vendor-1', display_name: 'Acme Supplies' }]}
      accounts={[]}
      items={[{ id: 'item-expense', display_name: 'Consulting' }]}
      stockLocations={[]}
      taxCodes={[]}
      taxGroups={[]}
      departments={[]}
      projects={[]}
      subsidiaries={[]}
      segments={[]}
      canManage
      closeHref="/purchasing"
    />,
    messages,
  )
}

test('a convert refusal pins as an alert, not only a toast', async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/purchase-orders/${PO_ID}/convert` && init?.method === 'POST') {
      return Response.json(
        { error: 'line 1 is not stock and is billed on a two-way match, not received' },
        { status: 422 },
      )
    }
    // No approval flow state for this record: the approval panels stay quiet.
    if (url.startsWith('/api/flows/')) {
      return Response.json({ error: 'no flow state' }, { status: 404 })
    }
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountPo()
  t.after(unmount)
  const menu = buttonsNamed('Actions')[0]
  assert.ok(menu, 'record actions must live behind the Actions menu')
  await click(menu)
  const convert = buttonsContaining('Convert to')[0]
  assert.ok(convert, 'an approved PO must offer its convert targets')
  await click(convert)
  await tick()
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the convert refusal must pin as an alert, not vanish with the toast')
  assert.match(
    alert.textContent ?? '',
    /line 1 is not stock/,
    "the alert must carry the server's typed reason",
  )
  const toasts = globalThis.__dashToasts ?? []
  assert.ok(
    toasts.some((toast) => toast.kind === 'error' && /line 1 is not stock/.test(toast.message)),
    'the refusal must also toast as an error',
  )
  assert.equal(
    globalThis.__dashRouter.pushes.length,
    0,
    'a refused convert must not navigate away from the PO',
  )
})

// The shared alert region itself (ActionAlert renders null when clean) is
// proven by the pinning test above: the refusal surfaces as role="alert"
// carrying the server's reason.

test('a partial conversion warns with every withheld line instead of a plain success', async (t) => {
  const BILL_ID = '44444444-4444-4444-8444-444444444444'
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/purchase-orders/${PO_ID}/convert` && init?.method === 'POST') {
      return Response.json({
        kind: 'vendor_bill',
        id: BILL_ID,
        documentNumber: 'BILL-00001',
        withheldTotal: '17692.8000',
        withheldLines: [{
          lineNumber: 1,
          itemName: 'Steel rod',
          description: 'Steel rod',
          orderedQuantity: '3648.0000',
          fulfilledQuantity: '0.0000',
          withheldQuantity: '3648.0000',
        }],
      })
    }
    if (url.startsWith('/api/flows/')) {
      return Response.json({ error: 'no flow state' }, { status: 404 })
    }
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountPo()
  t.after(unmount)
  const menu = buttonsNamed('Actions')[0]
  assert.ok(menu)
  await click(menu)
  const convert = buttonsContaining('Convert to Bill')[0]
  assert.ok(convert, 'an approved PO must offer Convert to Bill')
  await click(convert)
  await tick()
  const toasts = globalThis.__dashToasts ?? []
  assert.equal(
    toasts.filter((toast) => toast.kind === 'success').length,
    0,
    'a bill that leaves order lines open must never toast a plain success',
  )
  const warning = toasts.find((toast) => toast.kind === 'warning')
  assert.ok(warning, 'the partial conversion must warn')
  assert.match(warning.message, /BILL-00001 created for part of the order/)
  assert.match(
    warning.description ?? '',
    /Line 1 \(Steel rod\): 3648 not billed — ordered 3648, received 0/,
    'the warning names the withheld line with its quantities',
  )
  assert.deepEqual(globalThis.__dashRouter.pushes, [`/ap/bills?doc=${BILL_ID}&mode=edit`])
})

const WH_ID = '77777777-7777-4777-8777-777777777777'
const LINE_ID = '88888888-8888-4888-8888-888888888888'

function approvedStockPo(): OrderPayload {
  const po = approvedExpensePo()
  return {
    ...po,
    lines: [
      {
        ...(po.lines[0] as Record<string, unknown>),
        id: LINE_ID,
        item_id: 'item-widget',
        account_id: 'acct-1200',
        description: 'Widget',
        quantity: '10',
        unit: 'ea',
        unit_price: '2.00',
        stock_location_id: null,
      },
    ],
  } as OrderPayload
}

async function mountStockPo() {
  return mountDashboard(
    <OrderDrawer
      order={approvedStockPo()}
      kind="purchase_order"
      parties={[{ id: 'vendor-1', display_name: 'Acme Supplies' }]}
      accounts={[]}
      items={[{ id: 'item-widget', display_name: 'Widget', has_inventory_profile: true }]}
      stockLocations={[{ id: WH_ID, code: 'TACOMA-WH', subsidiaryId: null }]}
      taxCodes={[]}
      taxGroups={[]}
      departments={[]}
      projects={[]}
      subsidiaries={[]}
      segments={[]}
      canManage
      closeHref="/purchasing"
    />,
    messages,
  )
}

function warehouseRefusal() {
  return Response.json(
    {
      error: 'Purchase-order line 1 is a stocked item with no warehouse, and this organization has 1 active warehouse, so receipt cannot choose one — assign a warehouse to the line, then receive again',
      code: 'ORDER_LINE_WAREHOUSE_REQUIRED',
      details: { lineNumber: 1, activeWarehouses: 1 },
    },
    { status: 422 },
  )
}

const { act } = await import('react')

async function openConvert() {
  const menu = buttonsNamed('Actions')[0]
  assert.ok(menu, 'record actions must live behind the Actions menu')
  await click(menu)
  const convert = buttonsContaining('Convert to')[0]
  assert.ok(convert, 'an approved PO must offer its convert targets')
  await click(convert)
  await tick()
}

async function setPickerValue(picker: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(picker, value)
    picker.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  await tick()
}

test('a warehouse refusal renders the assign action and never navigates', async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/purchase-orders/${PO_ID}/convert` && init?.method === 'POST') {
      return warehouseRefusal()
    }
    if (url.startsWith('/api/flows/')) {
      return Response.json({ error: 'no flow state' }, { status: 404 })
    }
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountStockPo()
  t.after(unmount)
  await openConvert()
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the convert refusal must pin as an alert')
  assert.match(alert.textContent ?? '', /no warehouse/, "the alert must carry the server's typed reason")
  assert.deepEqual(
    globalThis.__dashRouter.pushes,
    [],
    'a refused convert must not navigate away from the PO',
  )
  const panel = document.querySelector('[aria-label="Assign warehouses to stocked lines"]')
  assert.ok(panel, 'the refusal must offer per-line warehouse assignment')
  const picker = panel.querySelector('select') as HTMLSelectElement | null
  assert.ok(picker, 'the missing line offers the entity warehouse picker')
  assert.ok(
    [...picker.options].some((option) => option.value === WH_ID && option.text === 'TACOMA-WH'),
    'the picker lists the active warehouse',
  )
})

test('assigning the warehouse then converting succeeds without re-pinning', async (t) => {
  const seen: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = []
  const restoreFetch = scriptFetch((url, init) => {
    seen.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null })
    if (url === `/api/purchase-orders/${PO_ID}/convert` && init?.method === 'POST') {
      return seen.some((request) => request.url.endsWith('/assign-warehouse') && request.method === 'POST')
        ? Response.json({ kind: 'purchase_receipt', id: 'rcpt-1', documentNumber: 'RCPT-00001' })
        : warehouseRefusal()
    }
    if (url === `/api/purchase-orders/${PO_ID}/assign-warehouse` && init?.method === 'POST') {
      return Response.json({ doc: { id: PO_ID, updated_at: '2026-08-01T12:00:01.000000Z' }, lines: [], links: [] })
    }
    if (url.startsWith('/api/flows/')) {
      return Response.json({ error: 'no flow state' }, { status: 404 })
    }
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountStockPo()
  t.after(unmount)
  await openConvert()
  assert.deepEqual(globalThis.__dashRouter.pushes, [], 'the refused convert must not navigate')
  const picker = document.querySelector('[aria-label="Assign warehouses to stocked lines"] select') as HTMLSelectElement | null
  assert.ok(picker, 'the missing line offers the picker')
  await setPickerValue(picker, WH_ID)
  const apply = buttonsNamed('Assign warehouse')[0]
  assert.ok(apply, 'the panel offers Apply per line')
  await click(apply)
  await tick()
  const post = seen.find((request) => request.url.endsWith('/assign-warehouse') && request.method === 'POST')
  assert.ok(post, 'apply posts to the assign-warehouse endpoint')
  assert.equal(post?.body?.lineId, LINE_ID)
  assert.equal(post?.body?.stockLocationId, WH_ID)
  assert.ok(typeof post?.body?.expectedUpdatedAt === 'string', 'the assignment carries the revision token')
  const toasts = globalThis.__dashToasts ?? []
  assert.ok(
    toasts.some((toast) => toast.kind === 'success'),
    'a successful assignment toasts',
  )
  const menuAgain = buttonsNamed('Actions')[0]
  assert.ok(menuAgain, 'the actions menu stays available after assigning')
  await click(menuAgain)
  const retry = buttonsContaining('Convert to')[0]
  assert.ok(retry, 'the operator converts again after assigning')
  await click(retry)
  await tick()
  assert.equal(
    globalThis.__dashRouter.pushes.length,
    1,
    'the assigned convert navigates to the created receipt',
  )
})
