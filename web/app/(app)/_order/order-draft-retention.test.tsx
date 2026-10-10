import assert from 'node:assert/strict'
import test from 'node:test'
import '../dashboard/_dashboard-render-harness'
import {
  buttonsNamed,
  click,
  mountDashboard,
  scriptFetch,
  tick,
} from '../dashboard/_dashboard-render-harness'
import type { OrderPayload } from './OrderDrawer'

const { registerHooks } = await import('node:module')

const confirmScript = { confirmResult: true, confirmCalls: [] as unknown[] }
Object.assign(globalThis, { __orderRetention: confirmScript })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/lib/confirm')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function confirmDialog(opts){const s=globalThis.__orderRetention;s.confirmCalls.push(opts);return s.confirmResult}',
      }
    }
    return next(specifier, context)
  },
})

const { OrderDrawer } = await import('./OrderDrawer')
const messages = (await import('../../../messages/en')).default as Record<string, unknown>
const { act } = await import('react')

const ORG_ID = 'org-retention-1'
const QUOTE_ID = '44444444-4444-4444-8444-444444444444'
const DRAFT_KEY = `openbooks:order-draft:${ORG_ID}:quote:${QUOTE_ID}`

function baseDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: QUOTE_ID,
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
    party_id: 'cust-1',
    party_name: 'Acme',
    document_number: 'EST-1001',
    extra_dims: {},
    status: 'draft',
    ...overrides,
  }
}

function baseLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientKey: 'line-1',
    persistedLineId: 'line-db-1',
    item_id: null,
    account_id: 'acct-4000',
    description: 'Advisory',
    quantity: '1',
    unit: 'hr',
    unit_price: '100.00',
    tax_code_id: null,
    tax_group_id: null,
    department_id: null,
    project_id: null,
    stock_location_id: null,
    extra_dims: {},
    ...overrides,
  }
}

async function mountQuote() {
  return mountDashboard(
    <OrderDrawer
      order={{ doc: baseDoc(), lines: [baseLine()], links: [] } as unknown as OrderPayload}
      kind="quote"
      orgId={ORG_ID}
      parties={[{ id: 'cust-1', display_name: 'Acme' }]}
      accounts={[{ id: 'acct-4000', display_name: 'Revenue' }]}
      items={[]}
      stockLocations={[]}
      taxCodes={[]}
      taxGroups={[]}
      departments={[]}
      projects={[]}
      subsidiaries={[]}
      segments={[]}
      canManage
      initialMode="edit"
      closeHref="/estimates"
    />,
    messages,
  )
}

function textInputs(): HTMLInputElement[] {
  return [...document.querySelectorAll('input')].filter(
    (input) => (input as HTMLInputElement).type === 'text',
  ) as HTMLInputElement[]
}

function inputByValue(value: string): HTMLInputElement | null {
  return textInputs().find((input) => input.value === value) ?? null
}

async function typeMemo(value: string) {
  // The memo is the first text input (party search, dates, then memo, then
  // the line grid) — typing anywhere else would dirty the wrong field.
  const memo = textInputs()[0]!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(memo, value)
    memo.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  await tick()
}

function retentionKey(): string | null {
  return window.sessionStorage.getItem(DRAFT_KEY)
}

test('a failed save keeps the lines with the refusal shown and Retry available', async (t) => {
  window.sessionStorage.clear()
  confirmScript.confirmResult = true
  confirmScript.confirmCalls = []
  let posts = 0
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/estimates/${QUOTE_ID}` && init?.method === 'PATCH') {
      posts += 1
      return Response.json({ error: 'the server stalled mid-save' }, { status: 500 })
    }
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  const { unmount } = await mountQuote()
  t.after(unmount)
  await tick()
  await tick()
  await typeMemo('keep me')
  const menu = buttonsNamed('Actions')[0]
  assert.ok(menu, 'record actions live behind the Actions menu')
  await click(menu)
  const save = buttonsNamed('Save')[0]
  assert.ok(save, 'edit mode offers an explicit Save')
  await click(save)
  await tick()
  await tick()
  assert.equal(posts, 1)
  assert.equal(inputByValue('Advisory')?.value, 'Advisory', 'the failed save keeps the lines')
  assert.equal(inputByValue('keep me')?.value, 'keep me', 'the failed save keeps the typed header')
  assert.ok(document.querySelector('[role="alert"]'), 'the refusal pins as an alert')
  const retry = buttonsNamed('Save failed — fix and retry')[0]
  assert.ok(retry, 'the failed save offers Retry in the footer')
  await click(retry)
  await tick()
  await tick()
  assert.equal(posts, 2, 'Retry re-sends the kept draft')
})

test('reopening offers to restore the retained draft and never auto-submits', async (t) => {
  window.sessionStorage.clear()
  confirmScript.confirmResult = true
  confirmScript.confirmCalls = []
  let posts = 0
  const restoreFetch = scriptFetch((url, init) => {
    if (init?.method === 'POST' || init?.method === 'PATCH') posts += 1
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
    version: 1,
    savedAt: '2026-08-02T09:30:00.000Z',
    header: {
      partyId: 'cust-1', documentDate: '2026-08-01', dueDate: '', workCompletedOn: '',
      memo: 'restored memo', departmentId: '', projectId: '', subsidiaryId: '', extraDims: {},
    },
    rows: [{
      clientKey: 'restored-1',
      persistedLineId: '',
      itemId: '',
      accountId: 'acct-4000',
      description: 'Restored line',
      quantity: '2',
      unit: 'hr',
      unitPrice: '100.00',
      taxProfileId: '',
      departmentId: '',
      projectId: '',
      workFrom: '',
      workTo: '',
      stockLocationId: '',
      loadedPrice: null,
    }],
  }))
  const { unmount } = await mountQuote()
  t.after(unmount)
  await tick()
  await tick()
  await tick()
  assert.equal(confirmScript.confirmCalls.length, 1, 'reopening offers the restore once')
  assert.match(
    String((confirmScript.confirmCalls[0] as { message?: unknown })?.message ?? ''),
    /Restore unsaved changes from/,
    'the offer names the restore',
  )
  assert.equal(inputByValue('Restored line')?.value, 'Restored line', 'accepting fills the retained lines')
  assert.equal(inputByValue('restored memo')?.value, 'restored memo', 'accepting fills the retained header')
  assert.equal(posts, 0, 'restoring never submits')
})

test('declining the restore discards the retained draft', async (t) => {
  window.sessionStorage.clear()
  confirmScript.confirmResult = false
  confirmScript.confirmCalls = []
  const restoreFetch = scriptFetch((url) => {
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
    version: 1,
    savedAt: '2026-08-02T09:30:00.000Z',
    header: {
      partyId: 'cust-1', documentDate: '2026-08-01', dueDate: '', workCompletedOn: '',
      memo: '', departmentId: '', projectId: '', subsidiaryId: '', extraDims: {},
    },
    rows: [],
  }))
  const { unmount } = await mountQuote()
  t.after(unmount)
  await tick()
  await tick()
  await tick()
  assert.equal(confirmScript.confirmCalls.length, 1)
  assert.equal(retentionKey(), null, 'declining clears the retained draft')
  assert.equal(inputByValue('Advisory')?.value, 'Advisory', 'the pristine record lines stay')
})

test('a successful save clears the retained draft', async (t) => {
  window.sessionStorage.clear()
  confirmScript.confirmResult = true
  confirmScript.confirmCalls = []
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/estimates/${QUOTE_ID}` && init?.method === 'PATCH') {
      return Response.json({ doc: baseDoc({ memo: 'keep me' }), lines: [], links: [] })
    }
    if (url.startsWith('/api/flows/')) return Response.json({ error: 'no flow state' }, { status: 404 })
    return null
  })
  t.after(restoreFetch)
  const first = await mountQuote()
  await tick()
  await tick()
  await typeMemo('keep me')
  assert.ok(retentionKey(), 'the dirty draft is retained locally')
  const menu = buttonsNamed('Actions')[0]!
  await click(menu)
  const save = buttonsNamed('Save')[0]!
  await click(save)
  await tick()
  await tick()
  assert.equal(retentionKey(), null, 'a successful save clears the retained draft')
  first.unmount()
  await tick()
  const second = await mountQuote()
  t.after(second.unmount)
  await tick()
  await tick()
  assert.equal(confirmScript.confirmCalls.length, 0, 'no retained draft means no restore offer')
})
