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

const DRAFT_ID = '44444444-4444-4444-8444-444444444444'
const APPROVED_ID = '55555555-5555-4555-8555-555555555555'
const QUOTE_ID = '66666666-6666-4666-8666-666666666666'

// OrderDrawer runs saves, statuses, issues, deletes and converts on the
// shared action path (useAppAction + ActionAlert): a refusal pins as a
// record-level alert until the next action AND toasts, and busy always
// releases through the package's finally. (Was order-drawer-refusal pins.)
function baseDoc(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
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
    ...overrides,
  }
}

function baseLines(): Record<string, unknown>[] {
  return [
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
  ]
}

async function mountOrder(
  order: OrderPayload,
  kind: 'purchase_order' | 'quote',
  extra: { initialMode?: 'view' | 'edit'; canOverrideCredit?: boolean } = {},
) {
  return mountDashboard(
    <OrderDrawer
      order={order}
      kind={kind}
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
      canOverrideCredit={extra.canOverrideCredit}
      initialMode={extra.initialMode}
      closeHref="/purchasing"
    />,
    messages,
  )
}

function flowsQuiet(
  handler: (url: string, init?: RequestInit) => Response | null,
): (url: string, init?: RequestInit) => Response | null {
  return (url, init) => {
    // No approval flow state for these records: the approval panels stay quiet.
    if (url.startsWith('/api/flows/')) {
      return Response.json({ error: 'no flow state' }, { status: 404 })
    }
    return handler(url, init)
  }
}

async function openActions(): Promise<void> {
  const menu = buttonsNamed('Actions')[0]
  assert.ok(menu, 'record actions must live behind the Actions menu')
  await click(menu)
}

test('a refused delete pins instead of only toasting', async (t) => {
  const restoreFetch = scriptFetch(
    flowsQuiet((url, init) => {
      if (url === `/api/purchase-orders/${DRAFT_ID}` && init?.method === 'DELETE') {
        return Response.json({ error: 'line 1 is already received and cannot be deleted' }, { status: 422 })
      }
      return null
    }),
  )
  t.after(restoreFetch)
  const { unmount } = await mountOrder(
    { doc: baseDoc({ id: DRAFT_ID, status: 'draft' }), lines: baseLines(), links: [] },
    'purchase_order',
  )
  t.after(unmount)
  await openActions()
  const remove = buttonsNamed('Delete')[0]
  assert.ok(remove, 'a draft order must offer Delete')
  await click(remove)
  await tick()
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the delete refusal must pin as an alert, not vanish with the toast')
  assert.match(alert.textContent ?? '', /already received/, "the alert must carry the server's reason")
  assert.ok(buttonsNamed('Delete').length > 0, 'the draft must still be present after a refused delete')
  assert.equal(
    globalThis.__dashRouter.pushes.length,
    0,
    'a refused delete must not navigate away',
  )
})

test('a non-JSON delete refusal still pins the fallback and releases busy', async (t) => {
  const restoreFetch = scriptFetch(
    flowsQuiet((url, init) => {
      if (url === `/api/purchase-orders/${DRAFT_ID}` && init?.method === 'DELETE') {
        return new Response('<html>Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })
      }
      return null
    }),
  )
  t.after(restoreFetch)
  const { unmount } = await mountOrder(
    { doc: baseDoc({ id: DRAFT_ID, status: 'draft' }), lines: baseLines(), links: [] },
    'purchase_order',
  )
  t.after(unmount)
  await openActions()
  const remove = buttonsNamed('Delete')[0]
  assert.ok(remove, 'a draft order must offer Delete')
  await click(remove)
  await tick()
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'even a bodyless refusal must pin the fallback alert')
  assert.match(alert.textContent ?? '', /Action failed/, 'the fallback names the failed action')
  const after = buttonsNamed('Delete')[0]
  assert.ok(after, 'the delete control must still render after the refusal')
  assert.equal(after.disabled, false, 'busy must release after a bodyless refusal')
})

test('a refused void pins and keeps the order voidable', async (t) => {
  const seen: unknown[] = []
  const restoreFetch = scriptFetch(
    flowsQuiet((url, init) => {
      if (url === `/api/purchase-orders/${APPROVED_ID}` && init?.method === 'PATCH') {
        seen.push(JSON.parse(String(init?.body)))
        return Response.json({ error: 'the void window for August closed' }, { status: 422 })
      }
      return null
    }),
  )
  t.after(restoreFetch)
  const { unmount } = await mountOrder(
    { doc: baseDoc({ id: APPROVED_ID, status: 'approved' }), lines: baseLines(), links: [] },
    'purchase_order',
  )
  t.after(unmount)
  globalThis.__promptAnswers = ['entered twice, voiding one leg']
  await openActions()
  const voidButton = buttonsNamed('Void')[0]
  assert.ok(voidButton, 'an approved order must offer Void')
  await click(voidButton)
  await tick()
  assert.deepEqual(
    (seen[0] as { reason?: unknown }).reason,
    'entered twice, voiding one leg',
    'the void reason the operator typed must reach the server',
  )
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the void refusal must pin as an alert')
  assert.match(alert.textContent ?? '', /void window/, "the alert must carry the server's reason")
  const again = buttonsNamed('Void')[0]
  assert.ok(again, 'the order must stay voidable after a refused void')
  assert.equal(again.disabled, false, 'busy must release after a refused void')
})

test('a credit-limit refusal prompts for an override on the stable code', async (t) => {
  const bodies: unknown[] = []
  const restoreFetch = scriptFetch(
    flowsQuiet((url, init) => {
      if (url === `/api/estimates/${QUOTE_ID}/convert` && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init?.body)))
        if (bodies.length === 1) {
          return Response.json(
            { error: 'customer is over the credit limit', code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED' },
            { status: 422 },
          )
        }
        return Response.json({ kind: 'sales_order', id: 'so-9', documentNumber: 'SO-9' })
      }
      return null
    }),
  )
  t.after(restoreFetch)
  const { unmount } = await mountOrder(
    {
      doc: baseDoc({ id: QUOTE_ID, status: 'approved', document_number: 'Q-3' }),
      lines: baseLines(),
      links: [],
    },
    'quote',
    { canOverrideCredit: true },
  )
  t.after(unmount)
  globalThis.__promptAnswers = ['CFO exception EX-77']
  await openActions()
  const convert = buttonsContaining('Convert to')[0]
  assert.ok(convert, 'an approved quote must offer its convert targets')
  await click(convert)
  await tick()
  await tick()
  assert.equal(bodies.length, 2, 'the override reason must trigger a second convert call')
  assert.equal(
    (bodies[1] as { creditOverrideReason?: unknown }).creditOverrideReason,
    'CFO exception EX-77',
    'the second call must carry the typed override reason',
  )
  const toasts = globalThis.__dashToasts ?? []
  assert.ok(
    toasts.some((toast) => toast.kind === 'success' && /SO-9/.test(toast.message)),
    'the overridden convert must report success with the new number',
  )
  assert.equal(globalThis.__dashRouter.pushes.length, 1, 'the overridden convert must navigate once')
})

test('a refused save releases busy and stays in edit mode', async (t) => {
  const restoreFetch = scriptFetch(
    flowsQuiet((url, init) => {
      if (url === `/api/purchase-orders/${DRAFT_ID}` && init?.method === 'PATCH') {
        return Response.json({ error: 'line 1 needs an expense account' }, { status: 422 })
      }
      return null
    }),
  )
  t.after(restoreFetch)
  const { unmount } = await mountOrder(
    { doc: baseDoc({ id: DRAFT_ID, status: 'draft' }), lines: baseLines(), links: [] },
    'purchase_order',
    { initialMode: 'edit' },
  )
  t.after(unmount)
  await openActions()
  const save = buttonsNamed('Save')[0]
  assert.ok(save, 'edit mode must offer Save')
  await click(save)
  await tick()
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the save refusal must pin as an alert')
  assert.match(alert.textContent ?? '', /needs an expense account/, "the alert must carry the server's reason")
  const again = buttonsNamed('Save')[0]
  assert.ok(again, 'a refused save must stay in edit mode with values intact')
  assert.equal(again.disabled, false, 'busy must release after a refused save')
})
