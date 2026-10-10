import assert from 'node:assert/strict'
import test from 'node:test'
import '../dashboard/_dashboard-render-harness'
import {
  mountDashboard,
  scriptFetch,
  tick,
} from '../dashboard/_dashboard-render-harness'
import type { OrderPayload } from './OrderDrawer'

// The draft footer must total the live grid lines — the same per-line
// amount and tax the cells render — instead of the saved document totals,
// which are still zero on a draft that was never saved.
const { OrderDrawer } = await import('./OrderDrawer')
const messages = (await import('../../../messages/en')).default as Record<string, unknown>

const DRAFT_ID = '77777777-7777-4777-8777-777777777777'
const GST_ID = '88888888-8888-4888-8888-888888888888'

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
    document_number: 'PO-1001',
    extra_dims: {},
    ...overrides,
  }
}

test('an unsaved PO draft footers the live lines, not the zero saved totals', async (t) => {
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountDashboard(
    <OrderDrawer
      order={{
        doc: baseDoc({ id: DRAFT_ID, status: 'draft' }),
        lines: [
          {
            item_id: null,
            account_id: 'acct-6100',
            description: 'Widgets',
            quantity: '4',
            unit: 'ea',
            unit_price: '85.00',
            tax_code_id: GST_ID,
            tax_group_id: null,
            department_id: null,
            project_id: null,
            stock_location_id: null,
            extra_dims: {},
          },
        ],
        links: [],
      } as unknown as OrderPayload}
      kind="purchase_order"
      parties={[{ id: 'vendor-1', display_name: 'Acme Supplies' }]}
      accounts={[]}
      items={[]}
      stockLocations={[]}
      taxCodes={[{ id: GST_ID, code: 'GST', name: 'GST', tax_components: [{ taxCodeId: GST_ID, sequence: 1, ratePercent: '5' }] }]}
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
  t.after(unmount)
  await tick()
  await tick()
  const body = document.body.textContent ?? ''
  assert.match(body, /Subtotal[^·]*340\.00/, 'the footer subtotals the live 4 × 85.00 line')
  assert.match(body, /Tax[^·]*17\.00/, 'the footer taxes the live line at 5% GST')
  assert.match(body, /Total[^·]*357\.00/, 'the footer totals the live line with tax')
  assert.ok(
    body.includes('Subtotal CA$340.00 · Tax CA$17.00 · Total CA$357.00'),
    'the footer shows the live totals instead of the unsaved zeros',
  )
})
