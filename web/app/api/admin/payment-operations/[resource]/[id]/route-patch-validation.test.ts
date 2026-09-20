import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// PATCH on payment-operations config must enforce the same value domains as
// POST: POST coerces mandate status to pending/active/suspended/revoked/expired
// and schedule action to submit_for_approval/create_draft, but PATCH wrote both
// fields raw. payment_mandates.status and payment_schedules.action are plain
// text columns with no CHECK constraint, so PATCH could store values the rest
// of the app never matches (e.g. status 'Active' never equals the 'active' the
// direct-debit builder requires, silently dropping the mandate reference from
// payment files).

const stateKey = Symbol.for('openbooks.payment-patch-validation-test')
interface RouteState {
  updates: string[]
}
const state: RouteState = { updates: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextPaymentPatch = sqlText

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
      const state = globalThis[Symbol.for('openbooks.payment-patch-validation-test')]
      const sqlText = globalThis.openbooksSqlTextPaymentPatch
      const executor = {
        async execute(query) {
          const text = sqlText(query)
          if (text.includes('update payment_mandates')) state.updates.push('mandates')
          if (text.includes('update payment_schedules')) state.updates.push('schedules')
          if (text.includes('select * from payment_mandates')) {
            return { rows: [{ id: 'mandate-1', status: 'active' }] }
          }
          if (text.includes('select cron, timezone')) {
            return { rows: [{ cron: '0 9 * * *', timezone: 'UTC' }] }
          }
          if (text.includes('select * from payment_schedules')) {
            return { rows: [{ id: 'schedule-1' }] }
          }
          return { rows: [{ id: 'row-1' }] }
        },
      }
      export const db = {
        ...executor,
        async transaction(work) { return work(executor) },
      }
    `,
  ],
  ['mock:authz', `export async function guardPermission() { return { user: { orgId: 'org-1', id: 'user-1' } } }`],
  ['mock:features', `export async function isFeatureEnabled() { return true }`],
  ['mock:list-params', `export function isUuid() { return true }`],
  ['mock:countries', `export function normalizeCountryCode(value) { return String(value).trim().toUpperCase() }`],
  ['mock:payment-operations', `export async function updatePaymentBankProfile() {}`],
  ['mock:scripting', `export function computeNextRunAt() { return new Date('2026-01-01T09:00:00Z') }`],
  ['mock:audit', `export async function auditConfigChange() {}`],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@openbooks/engine/src/payments/operations.ts', 'mock:payment-operations'],
  ['@openbooks/engine/src/scripting/scripting.ts', 'mock:scripting'],
  ['../../../../../../lib/authz', 'mock:authz'],
  ['../../../../../../lib/features', 'mock:features'],
  ['../../../../../../lib/list-params', 'mock:list-params'],
  ['../../../../../../lib/countries', 'mock:countries'],
  ['../../_lib', 'mock:audit'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
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

const routeUrl = './route.ts?payment-patch-validation'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const MANDATE_ID = '00000000-0000-4000-8000-000000000001'
const SCHEDULE_ID = '00000000-0000-4000-8000-000000000002'

function patch(resource: string, id: string, body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/admin/payment-operations/${resource}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ resource, id }) },
  )
}

test('mandate PATCH refuses a status outside the POST value domain', async () => {
  state.updates = []
  const response = await patch('mandates', MANDATE_ID, { status: 'bogus' })
  assert.equal(response.status, 400)
  assert.match(String((await response.json()).error), /status/)
  assert.deepEqual(state.updates, [], 'no mandate write may run for an invalid status')
})

test('mandate PATCH refuses a wrong-case status POST would never store', async () => {
  state.updates = []
  const response = await patch('mandates', MANDATE_ID, { status: 'Active' })
  assert.equal(response.status, 400)
  assert.deepEqual(state.updates, [], 'no mandate write may run for a wrong-case status')
})

test('mandate PATCH still accepts every POST status', async () => {
  for (const status of ['pending', 'active', 'suspended', 'revoked', 'expired']) {
    state.updates = []
    const response = await patch('mandates', MANDATE_ID, { status })
    assert.equal(response.status, 200, `status ${status} must stay accepted`)
    assert.deepEqual(state.updates, ['mandates'])
  }
})

test('schedule PATCH refuses an action outside the POST value domain', async () => {
  state.updates = []
  const response = await patch('schedules', SCHEDULE_ID, { action: 'auto_pay' })
  assert.equal(response.status, 400)
  assert.match(String((await response.json()).error), /action/)
  assert.deepEqual(state.updates, [], 'no schedule write may run for an invalid action')
})

test('schedule PATCH still accepts both POST actions', async () => {
  for (const action of ['create_draft', 'submit_for_approval']) {
    state.updates = []
    const response = await patch('schedules', SCHEDULE_ID, { action })
    assert.equal(response.status, 200, `action ${action} must stay accepted`)
    assert.deepEqual(state.updates, ['schedules'])
  }
})
