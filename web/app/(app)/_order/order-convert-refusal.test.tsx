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
// carrying the server's typed reason. (Was F-t03-001.)
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
