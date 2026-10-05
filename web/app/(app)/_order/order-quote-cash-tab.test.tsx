import assert from 'node:assert/strict'
import test from 'node:test'
import '../dashboard/_dashboard-render-harness'
import {
  buttonsNamed,
  mountDashboard,
  scriptFetch,
} from '../dashboard/_dashboard-render-harness'
import type { OrderPayload } from './OrderDrawer'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { OrderDrawer } = await import('./OrderDrawer')
const messages = (await import('../../../messages/en')).default as Record<string, unknown>

const QUOTE_ID = '77777777-7777-4777-8777-777777777777'

function quoteOrder(): OrderPayload {
  return {
    doc: {
      id: QUOTE_ID,
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
      party_id: 'customer-1',
      party_name: 'Acme Corp',
      document_number: 'Q-1001',
      extra_dims: {},
      status: 'approved',
    },
    lines: [],
    links: [],
  } as unknown as OrderPayload
}

async function mountQuote(quoteToCashEnabled?: boolean) {
  return mountDashboard(
    <OrderDrawer
      order={quoteOrder()}
      kind="quote"
      parties={[{ id: 'customer-1', display_name: 'Acme Corp' }]}
      accounts={[]}
      items={[]}
      stockLocations={[]}
      taxCodes={[]}
      taxGroups={[]}
      departments={[]}
      projects={[]}
      subsidiaries={[]}
      segments={[]}
      canManage
      closeHref="/estimates"
      quoteToCashEnabled={quoteToCashEnabled}
    />,
    messages,
  )
}

test('the quote Subscription tab stays hidden while quoteToCash is off', async (t) => {
  const restoreFetch = scriptFetch(() => null)
  t.after(restoreFetch)
  const { unmount } = await mountQuote(false)
  t.after(unmount)
  assert.equal(
    buttonsNamed('Subscription').length,
    0,
    'no Subscription tab may render when the quoteToCash feature is off',
  )
})

test('the quote Subscription tab renders once quoteToCash resolves on', async (t) => {
  const restoreFetch = scriptFetch(() => null)
  t.after(restoreFetch)
  const { unmount } = await mountQuote(true)
  t.after(unmount)
  assert.equal(
    buttonsNamed('Subscription').length,
    1,
    'the Subscription tab must render when the quoteToCash feature is on',
  )
})
