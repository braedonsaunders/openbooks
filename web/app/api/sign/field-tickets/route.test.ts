import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import React from 'react'
import test from 'node:test'

// House render guard for TSX compiled through the classic React transform.
Object.assign(globalThis, { React })

const stateKey = Symbol.for('openbooks.field-ticket-sign-gate-test')
interface RouteState {
  featureEnabled: boolean
  featureCalls: string[]
  executeCalls: number
}
const state: RouteState = { featureEnabled: false, featureCalls: [], executeCalls: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const ORG_ID = '00000000-0000-4000-8000-00000000c001'
const TICKET_ID = '00000000-0000-4000-8000-00000000c002'
const REQUEST_ID = '00000000-0000-4000-8000-00000000c003'

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.field-ticket-sign-gate-test')]
      export const db = {
        async execute() {
          state.executeCalls += 1
          if (state.executeCalls === 2) return { rows: [{ id: '${TICKET_ID}', status: 'approved', document_number: 'FT-1' }] }
          if (state.executeCalls === 4) return { rows: [{ id: '00000000-0000-4000-8000-00000000c004' }] }
          return { rows: [] }
        },
      }
      export async function withOrgTransaction(_orgId, work) { return work() }
    `,
  ],
  [
    'mock:features',
    `
      const state = globalThis[Symbol.for('openbooks.field-ticket-sign-gate-test')]
      export async function isFeatureEnabled(_orgId, key) {
        state.featureCalls.push(key)
        return state.featureEnabled
      }
    `,
  ],
  [
    'mock:token',
    `
      export function verifySigningToken() {
        return {
          orgId: '${ORG_ID}',
          ticketId: '${TICKET_ID}',
          requestId: '${REQUEST_ID}',
          expiresAt: new Date(Date.now() + 60_000),
        }
      }
      export async function validateSigningRequest() { return true }
    `,
  ],
  [
    'mock:lock',
    `export function resolveFieldTicketLockId() { return 1n }`,
  ],
  [
    'mock:file-cabinet',
    `export async function uploadAndAttach() { return { id: '00000000-0000-4000-8000-00000000c005' } }`,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/file-cabinet', 'mock:file-cabinet'],
  ['../../../../lib/field-ticket-lock', 'mock:lock'],
  ['../../../../lib/field-ticket-token', 'mock:token'],
  ['../../../../lib/features', 'mock:features'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', source: '', shortCircuit: true, url: 'mock:server-only' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?field-ticket-sign-gate-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(enabled: boolean): void {
  state.featureEnabled = enabled
  state.featureCalls = []
  state.executeCalls = 0
}

function post(): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/sign/field-tickets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: 'valid-token',
      signature: 'data:image/png;base64,iVBORw0KGgo=',
      name: 'Customer signer',
    }),
  }))
}

test('customer signing refuses a valid link when Field Tickets is disabled', async () => {
  reset(false)
  const response = await post()

  assert.equal(response.status, 404)
  assert.deepEqual(state.featureCalls, ['fieldTickets'])
  assert.equal(state.executeCalls, 0, 'the signing transaction must not start while the feature is off')
})

test('customer signing remains available when Field Tickets is enabled', async () => {
  reset(true)
  const response = await post()

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(state.featureCalls, ['fieldTickets'])
})

const pageKey = Symbol.for('openbooks.field-ticket-sign-page-test')
interface PageState {
  featureEnabled: boolean
  featureCalls: string[]
  ticket: Record<string, unknown>
}
const pageState: PageState = {
  featureEnabled: false,
  featureCalls: [],
  ticket: {
    status: 'approved',
    customerName: 'Acme Customer',
    documentNumber: 'FT-1',
    projectName: 'North Warehouse',
    memo: 'Install loading dock equipment',
    fieldTicket: { periodStart: '2026-09-01', periodEnd: '2026-09-07', period: 'weekly', signatures: {} },
    entries: [{ employee_name: 'Alex Worker', hours: '2.5' }],
    lines: [{ id: 'line-1', item_name: 'Dock plate', description: 'Dock plate', quantity: '1' }],
  },
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[pageKey] = pageState

const pageMocks = new Map<string, string>([
  ['mock:page-db', `export async function withOrgContext(_orgId, work) { return work() }`],
  ['mock:page-token', `export function verifySigningToken() { return { orgId: '${ORG_ID}', ticketId: '${TICKET_ID}', requestId: '${REQUEST_ID}' } } export async function validateSigningRequest() { return true }`],
  ['mock:page-features', `const state = globalThis[Symbol.for('openbooks.field-ticket-sign-page-test')]; export async function isFeatureEnabled(_orgId, key) { state.featureCalls.push(key); return state.featureEnabled }`],
  ['mock:page-ticket', `const state = globalThis[Symbol.for('openbooks.field-ticket-sign-page-test')]; export async function loadFieldTicket() { return state.ticket }`],
  ['mock:page-form', `const React = globalThis.React; export function SignTicketForm(props) { return React.createElement('div', { 'data-sign-ticket-form': 'true' }, props.alreadySigned ? 'Already signed' : 'Sign timesheet form') }`],
  ['mock:page-navigation', `export function notFound() { throw new Error('PAGE_NOT_FOUND') }`],
])
const pageUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:page-db'],
  ['../../../../lib/field-ticket-token', 'mock:page-token'],
  ['../../../../lib/features', 'mock:page-features'],
  ['../../../../lib/field-tickets', 'mock:page-ticket'],
  ['./SignTicketForm', 'mock:page-form'],
  ['next/navigation', 'mock:page-navigation'],
])
const pageHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = pageUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = pageMocks.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})
const { default: SignFieldTicketPage } = await import('../../../sign/field-tickets/[token]/page.tsx')
pageHooks.deregister()
const { renderToStaticMarkup } = await import('react-dom/server')

test('the public signing page refuses the token when Field Tickets is disabled', async () => {
  pageState.featureEnabled = false
  pageState.featureCalls = []
  await assert.rejects(
    SignFieldTicketPage({ params: Promise.resolve({ token: 'valid-token' }) }),
    /PAGE_NOT_FOUND/,
  )
  assert.deepEqual(pageState.featureCalls, ['fieldTickets'])
})

test('the public signing page renders ticket details and its signing form when enabled', async () => {
  pageState.featureEnabled = true
  pageState.featureCalls = []
  const page = await SignFieldTicketPage({ params: Promise.resolve({ token: 'valid-token' }) })
  const html = renderToStaticMarkup(page)
  assert.deepEqual(pageState.featureCalls, ['fieldTickets'])
  assert.match(html, /FT-1/)
  assert.match(html, /Acme Customer/)
  assert.match(html, /North Warehouse/)
  assert.match(html, /Install loading dock equipment/)
  assert.match(html, /data-sign-ticket-form="true"/)
  assert.match(html, /Sign timesheet form/)
})
