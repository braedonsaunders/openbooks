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
const { act } = await import('react')

const PO_ID = '33333333-3333-4333-8333-333333333333'
const LINE_ID = '88888888-8888-4888-8888-888888888888'
const WH_ID = '77777777-7777-4777-8777-777777777777'

function approvedStockPo(): OrderPayload {
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
      subtotal: '20.00',
      tax_total: '0',
      total: '20.00',
      party_id: 'vendor-1',
      party_name: 'Acme Supplies',
      document_number: 'PO-1001',
      extra_dims: {},
    },
    lines: [
      {
        id: LINE_ID,
        item_id: 'item-widget',
        account_id: 'acct-1200',
        description: 'Widget',
        quantity: '10',
        quantity_fulfilled: '0',
        quantity_cancelled: '0',
        unit: 'ea',
        unit_price: '2.00',
        tax_code_id: null,
        tax_group_id: null,
        department_id: null,
        project_id: null,
        stock_location_id: null,
        extra_dims: {},
      },
    ],
    links: [],
  } as unknown as OrderPayload
}

function prefillOk(stockLocationId: string | null = WH_ID) {
  return Response.json({
    receiptDate: '2026-08-01',
    lines: [{
      sourceLineId: LINE_ID,
      lineNumber: 1,
      description: 'Widget',
      unit: 'ea',
      unitPrice: '2.00',
      remaining: '10',
      stockLocationId,
    }],
  })
}

async function mountPo() {
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

function dialog(): HTMLElement | null {
  // The drawer itself is a dialog: scope to the receipt form's labelled shell.
  return document.querySelector('[aria-label="Receive goods"]')
}

async function openReceiptForm() {
  const menu = buttonsNamed('Actions')[0]
  assert.ok(menu, 'record actions must live behind the Actions menu')
  await click(menu)
  const convert = buttonsContaining('Convert to')[0]
  assert.ok(convert, 'an approved PO must offer its convert targets')
  await click(convert)
  await tick()
  await tick()
  assert.ok(dialog(), 'Convert to Goods receipt opens the receipt form, not a blind receive')
}

async function setQty(value: string) {
  const input = dialog()?.querySelector('[aria-label="Receive qty 1"]') as HTMLInputElement | null
  assert.ok(input, 'the form offers a quantity per line')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  await tick()
}

async function clickFormSave() {
  const save = [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === 'Save')
  assert.ok(save, 'the form saves explicitly')
  await click(save as HTMLButtonElement)
  await tick()
  await tick()
}

test('the receipt form opens prefilled from the order', async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/purchase-orders/${PO_ID}/receive` && (init?.method ?? 'GET') === 'GET') return prefillOk()
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountPo()
  t.after(unmount)
  await openReceiptForm()
  const date = dialog()?.querySelector('#receipt-date') as HTMLInputElement | null
  assert.ok(date, 'the receipt date is editable')
  assert.equal(date.value, '2026-08-01', 'the date defaults to today in the business calendar')
  const qty = dialog()?.querySelector('[aria-label="Receive qty 1"]') as HTMLInputElement | null
  assert.equal(qty?.value, '10', 'each line prefills its remaining quantity')
  assert.match(dialog()?.textContent ?? '', /10 ea remaining/, 'the form shows what is left to receive')
  assert.match(dialog()?.textContent ?? '', /TACOMA-WH/, 'the line warehouse defaults per the entity default')
})

test('a partial receipt posts only the entered quantity with one idempotency key', async (t) => {
  const posts: { key: string | null; body: Record<string, unknown> }[] = []
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/purchase-orders/${PO_ID}/receive` && (init?.method ?? 'GET') === 'GET') return prefillOk()
    if (url === `/api/purchase-orders/${PO_ID}/receive` && init?.method === 'POST') {
      posts.push({
        key: (init.headers as Record<string, string>)?.['Idempotency-Key'] ?? new Headers(init.headers).get('Idempotency-Key'),
        body: JSON.parse(init.body as string) as Record<string, unknown>,
      })
      return Response.json({ kind: 'purchase_receipt', id: 'rcpt-1', documentNumber: 'RCPT-00001' })
    }
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountPo()
  t.after(unmount)
  await openReceiptForm()
  await setQty('4')
  await clickFormSave()
  assert.equal(posts.length, 1, 'one explicit save posts once')
  assert.deepEqual(posts[0]!.body, {
    receiptDate: '2026-08-01',
    lines: [{ sourceLineId: LINE_ID, quantity: '4' }],
  })
  assert.ok(posts[0]!.key, 'the save carries an idempotency key so a retry never double-receives')
  assert.deepEqual(globalThis.__dashRouter.pushes, ['/inventory'])
})

test('over-receiving is refused in the form without posting', async (t) => {
  let posted = 0
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/purchase-orders/${PO_ID}/receive` && (init?.method ?? 'GET') === 'GET') return prefillOk()
    if (url === `/api/purchase-orders/${PO_ID}/receive` && init?.method === 'POST') {
      posted += 1
      return Response.json({ kind: 'purchase_receipt', id: 'rcpt-1', documentNumber: 'RCPT-00001' })
    }
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountPo()
  t.after(unmount)
  await openReceiptForm()
  await setQty('99')
  await clickFormSave()
  assert.equal(posted, 0, 'an over-receipt never posts')
  assert.match(dialog()?.textContent ?? '', /exceeds the 10 remaining/, 'the form names the ceiling')
  assert.deepEqual(globalThis.__dashRouter.pushes, [], 'a refused save never navigates')
})

test('a failed save keeps the form state and retries with the same key', async (t) => {
  const keys: (string | null)[] = []
  let attempts = 0
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/purchase-orders/${PO_ID}/receive` && (init?.method ?? 'GET') === 'GET') return prefillOk(null)
    if (url === `/api/purchase-orders/${PO_ID}/receive` && init?.method === 'POST') {
      attempts += 1
      keys.push(new Headers(init.headers).get('Idempotency-Key'))
      if (attempts === 1) {
        return Response.json({ error: 'line 1 is not stock and is billed on a two-way match, not received' }, { status: 422 })
      }
      return Response.json({ kind: 'purchase_receipt', id: 'rcpt-1', documentNumber: 'RCPT-00001' })
    }
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountPo()
  t.after(unmount)
  await openReceiptForm()
  await setQty('4')
  await clickFormSave()
  assert.match(dialog()?.textContent ?? '', /line 1 is not stock/, 'the refusal shows in the form')
  const qty = dialog()?.querySelector('[aria-label="Receive qty 1"]') as HTMLInputElement | null
  assert.equal(qty?.value, '4', 'the failed save keeps the entered quantities')
  await clickFormSave()
  assert.equal(keys.length, 2, 'retry posts again')
  assert.equal(keys[0], keys[1], 'the retry reuses the key, so a committed first save replays instead of doubling')
  assert.ok(keys[0], 'the key is always present')
  assert.deepEqual(globalThis.__dashRouter.pushes, ['/inventory'])
})

test('a failed prefill offers retry instead of a dead form', async (t) => {
  let loads = 0
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/purchase-orders/${PO_ID}/receive` && (init?.method ?? 'GET') === 'GET') {
      loads += 1
      return loads === 1 ? Response.json({ error: 'stalled' }, { status: 500 }) : prefillOk()
    }
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountPo()
  t.after(unmount)
  await openReceiptForm()
  assert.match(dialog()?.textContent ?? '', /could not be loaded/, 'the failed prefill says so')
  const retry = [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('retry'))
  assert.ok(retry, 'the failed prefill offers retry')
  await click(retry as HTMLButtonElement)
  await tick()
  await tick()
  assert.equal((dialog()?.querySelector('[aria-label="Receive qty 1"]') as HTMLInputElement | null)?.value, '10')
})
