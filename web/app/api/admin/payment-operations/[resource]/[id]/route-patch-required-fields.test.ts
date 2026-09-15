import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// POST /api/admin/payment-operations/formats requires a non-empty name and a
// non-empty formatterScript, but PATCH stored blanks: name '' via
// coalesce('', name) and formatterScript '' via ('' || null) = NULL. A blanked
// name corrupts the format's display/file contract, and a nulled script breaks
// the next payment run — renderPaymentFile throws PaymentError("custom payment
// format has no formatter script") for custom rails with no script.

const stateKey = Symbol.for('openbooks.payment-format-blank-test')
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextPaymentBlank = sqlText

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
      const state = globalThis[Symbol.for('openbooks.payment-format-blank-test')]
      const sqlText = globalThis.openbooksSqlTextPaymentBlank
      const executor = {
        async execute(query) {
          const text = sqlText(query)
          if (text.includes('update payment_formats')) state.updates.push('formats')
          if (text.includes('from payment_formats')) {
            return { rows: [{ id: 'format-1', name: 'Bank file', rail: 'custom', formatter_script: 'return {}' }] }
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
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/payment-operations.ts', 'mock:payment-operations'],
  ['@openbooks/engine/src/scripting.ts', 'mock:scripting'],
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

const routeUrl = './route.ts?payment-format-blank-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const FORMAT_ID = '00000000-0000-4000-8000-000000000003'

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/admin/payment-operations/formats/${FORMAT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ resource: 'formats', id: FORMAT_ID }) },
  )
}

test('format PATCH refuses to null the formatter script with a blank value', async () => {
  state.updates = []
  const response = await patch({ formatterScript: '   ' })
  assert.equal(response.status, 400)
  assert.match(String((await response.json()).error), /formatterScript/)
  assert.deepEqual(state.updates, [], 'no format write may run for a blank script')
})

test('format PATCH refuses a blank name POST would reject', async () => {
  state.updates = []
  const response = await patch({ name: '   ' })
  assert.equal(response.status, 400)
  assert.match(String((await response.json()).error), /name/)
  assert.deepEqual(state.updates, [], 'no format write may run for a blank name')
})

test('format PATCH still accepts a real script and a real name', async () => {
  state.updates = []
  const response = await patch({ name: 'Updated file', formatterScript: 'return { filename: "a", content: "b" }' })
  assert.equal(response.status, 200)
  assert.deepEqual(state.updates, ['formats'])
})
