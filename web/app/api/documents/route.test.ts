import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * POST /api/documents protocol boundary: idempotency-key and kind refusals
 * fire before any tenant write machinery runs.
 *
 * Only auth is doubled. The database module is REAL but untouched: with no
 * OPENBOOKS_DB_URL any execute would throw a connection error, so a clean
 * 400 here proves the refusal allocated nothing — no document, no number,
 * no lines, no audit row. Deeper behavior (replay, conflicts, audit counts,
 * atomicity) runs against a real database in route.integration.test.ts.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { can: boolean } = { can: true }
Object.assign(globalThis, { __documentCreateUnit: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../lib/authz') {
      return virtual(`export async function getAuthz() {
        return {
          user: { id: 'user-1', orgId: 'org-1', name: 'Tester', roles: [], isSuperAdmin: false },
          allowedSubsidiaryIds: null,
        }
      }
      export function can() { return globalThis.__documentCreateUnit.can }
      export function subsidiariesInScope() { return true }`)
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { POST } = await import('./route')

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://audit.local/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

const KEY = randomUUID()

test('missing idempotency key is refused before any write', async () => {
  const response = await post({ kind: 'customer_invoice' })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_idempotency_key' })
})

test('malformed idempotency keys are refused before any write', async () => {
  for (const key of ['not-a-uuid', '', '   ', '12345']) {
    const response = await post({ kind: 'customer_invoice' }, { 'Idempotency-Key': key })
    assert.equal(response.status, 400, JSON.stringify(key))
    assert.deepEqual(await response.json(), { error: 'invalid_idempotency_key' })
  }
})

test('unknown document kind is refused by name', async () => {
  for (const kind of [undefined, null, 42, 'sales_order', 'mystery_kind']) {
    const response = await post({ kind }, { 'Idempotency-Key': KEY })
    assert.equal(response.status, 400, JSON.stringify(kind))
    assert.deepEqual(await response.json(), { error: 'unknown document kind' })
  }
})

test('non-document kinds keep their own writers', async () => {
  for (const kind of ['project_charge', 'pay_run', 'journal', 'customer_payment', 'expense_report']) {
    const response = await post({ kind }, { 'Idempotency-Key': KEY })
    assert.equal(response.status, 400, JSON.stringify(kind))
    assert.deepEqual(await response.json(), { error: 'unknown document kind' })
  }
})

test('malformed JSON is refused at the boundary', async () => {
  const response = await POST(
    new Request('http://audit.local/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': KEY },
      body: '{oops',
    }),
  )
  assert.equal(response.status, 400)
})

test('missing create permission is refused before any write', async () => {
  state.can = false
  try {
    const response = await post({ kind: 'customer_invoice' }, { 'Idempotency-Key': KEY })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'missing permission: ar.create' })
  } finally {
    state.can = true
  }
})
