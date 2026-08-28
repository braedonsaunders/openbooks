import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The format update must lock and snapshot inside its write transaction. The
// scripted database below serializes transactions like PostgreSQL row locks;
// the old route's pre-transaction db.execute snapshot is deliberately rejected
// so this test is red against that implementation.
const stateKey = Symbol.for('openbooks.payment-format-route-test')
interface AuditSnapshot {
  before: Record<string, unknown>
  after: Record<string, unknown>
}
interface RouteState {
  calls: { kind: 'db' | 'tx'; text: string }[]
  audits: AuditSnapshot[]
  format: Record<string, unknown> | null
  requestNames: string[]
  transactionNumber: number
  tail: Promise<void>
}
const state: RouteState = {
  calls: [],
  audits: [],
  format: { id: 'format-1', name: 'initial', rail: 'custom' },
  requestNames: [],
  transactionNumber: 0,
  tail: Promise.resolve(),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

/** Flatten a drizzle SQL chunk into its raw text for the scripted database. */
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextPaymentFormat = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      const state = globalThis[Symbol.for('openbooks.payment-format-route-test')]
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        const data = await request.json()
        state.requestNames.push(String(data.name))
        return { ok: true, data }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payment-format-route-test')]
      const sqlText = globalThis.openbooksSqlTextPaymentFormat
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.calls.push({ kind: 'db', text })
          throw new Error('format reads must be transaction-scoped')
        },
        async transaction(work) {
          const previous = state.tail
          let release
          state.tail = new Promise((resolve) => { release = resolve })
          await previous
          const number = state.transactionNumber++
          const tx = {
            async execute(query) {
              const text = sqlText(query)
              state.calls.push({ kind: 'tx', text })
              if (text.includes('select * from payment_formats')) {
                return { rows: state.format ? [{ ...state.format }] : [] }
              }
              if (text.includes('update payment_formats')) {
                if (!state.format) return { rows: [] }
                state.format = { ...state.format, name: state.requestNames[number] }
                return { rows: [{ ...state.format }] }
              }
              return { rows: [] }
            },
          }
          try {
            return await work(tx)
          } finally {
            release()
          }
        },
      }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:features',
    `
      export async function isFeatureEnabled() { return true }
    `,
  ],
  [
    'mock:list-params',
    `
      export function isUuid() { return true }
    `,
  ],
  [
    'mock:countries',
    `
      export function normalizeCountryCode(value) { return String(value).trim().toUpperCase() }
    `,
  ],
  [
    'mock:payment-operations',
    `
      export async function updatePaymentBankProfile() {}
    `,
  ],
  [
    'mock:scripting',
    `
      export function computeNextRunAt() { return null }
    `,
  ],
  [
    'mock:audit',
    `
      const state = globalThis[Symbol.for('openbooks.payment-format-route-test')]
      export async function auditConfigChange(_tx, _orgId, _table, _id, _action, changes) {
        state.audits.push({ before: changes.before, after: changes.after })
      }
    `,
  ],
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

const routeUrl = './route.ts?payment-format-concurrency-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const FORMAT_ID = '00000000-0000-4000-8000-000000000001'

function reset(): void {
  state.calls = []
  state.audits = []
  state.format = { id: FORMAT_ID, name: 'initial', rail: 'custom' }
  state.requestNames = []
  state.transactionNumber = 0
  state.tail = Promise.resolve()
}

function patch(name: string): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/admin/payment-operations/formats/${FORMAT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
    { params: Promise.resolve({ resource: 'formats', id: FORMAT_ID }) },
  )
}

test('concurrent format edits serialize before-state snapshots with their updates', async () => {
  reset()

  const [first, second] = await Promise.all([patch('first edit'), patch('second edit')])

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(
    state.audits.map(({ before, after }) => [before.name, after.name]),
    [
      ['initial', 'first edit'],
      ['first edit', 'second edit'],
    ],
    'each audit captures the row version immediately preceding its own update',
  )
  assert.equal(state.format?.name, 'second edit')
  assert.equal(state.calls.some(({ kind }) => kind === 'db'), false, 'no snapshot escaped the transaction')
  const lock = state.calls.find(({ text }) => text.includes('select * from payment_formats'))
  assert.ok(lock)
  assert.match(lock.text, /for update/)
})

test('a missing custom format keeps the read-only response', async () => {
  reset()
  state.format = null

  const response = await patch('ignored')

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'built-in payment formats are read-only' })
  assert.equal(state.audits.length, 0)
})
