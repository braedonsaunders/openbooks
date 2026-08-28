import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite: waiver revocation and its mandatory audit evidence
// must commit as one unit. The scripted database fake keeps writes pending
// until the transaction callback succeeds, so an audit failure proves the
// waiver update was rolled back rather than merely observing two calls.
const stateKey = Symbol.for('openbooks.compliance-waiver-route-test')
interface RouteState {
  calls: Array<{ kind: 'execute' | 'tx-execute'; text: string }>
  committed: string[]
  pending: string[]
  waiverAvailable: boolean
  revoked: boolean
  failAudit: boolean
}

const routeState: RouteState = {
  calls: [],
  committed: [],
  pending: [],
  waiverAvailable: true,
  revoked: false,
  failAudit: false,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL chunk into raw text for the scripted database fake. */
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksComplianceWaiverSqlText = sqlText

const WAIVER_ID = '00000000-0000-4000-8000-00000000c001'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.compliance-waiver-route-test')]
      const sqlText = globalThis.openbooksComplianceWaiverSqlText
      const execute = async (kind, query) => {
        const text = sqlText(query)
        state.calls.push({ kind, text })

        if (text.includes('update compliance_waivers')) {
          if (!state.waiverAvailable || state.revoked) return { rows: [] }
          state.pending.push(text)
          return { rows: [{ id: '${WAIVER_ID}' }] }
        }
        if (text.includes('insert into audit_log')) {
          if (state.failAudit) throw new Error('forced audit failure')
          state.pending.push(text)
          return { rows: [] }
        }
        throw new Error('unexpected database query: ' + text)
      }
      export const db = {
        execute: (query) => execute('execute', query),
        async transaction(work) {
          state.pending = []
          try {
            const result = await work({ execute: (query) => execute('tx-execute', query) })
            state.committed.push(...state.pending)
            if (state.pending.some((text) => text.includes('update compliance_waivers'))) {
              state.revoked = true
            }
            return result
          } finally {
            state.pending = []
          }
        },
      }
    `,
  ],
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
    'mock:authz',
    `
      export async function guardPermission(permission) {
        if (permission !== 'compliance.waive') throw new Error('unexpected permission: ' + permission)
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    'mock:compliance',
    `
      export async function guardComplianceFeature() { return null }
    `,
  ],
  ['mock:list-params', `export function isUuid(value) { return value === '${WAIVER_ID}' }`],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@/lib/api/json', 'mock:json'],
  ['@/lib/authz', 'mock:authz'],
  ['@/lib/compliance', 'mock:compliance'],
  ['@/lib/list-params', 'mock:list-params'],
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

const routeUrl = './route.ts?compliance-waiver-revocation-test'
const { DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  routeState.calls.length = 0
  routeState.committed.length = 0
  routeState.pending.length = 0
  routeState.waiverAvailable = true
  routeState.revoked = false
  routeState.failAudit = false
}

function revoke(reason = 'documented policy exception'): Promise<Response> {
  return DELETE(
    new Request(`http://openbooks.test/api/compliance/waivers/${WAIVER_ID}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    }),
    { params: Promise.resolve({ id: WAIVER_ID }) },
  )
}

test('revocation and its audit evidence commit in one transaction', async () => {
  reset()

  const response = await revoke()

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: WAIVER_ID })
  assert.equal(routeState.calls.every((call) => call.kind === 'tx-execute'), true)
  assert.deepEqual(routeState.committed.map((text) => text.includes('update compliance_waivers') ? 'update' : 'audit'), [
    'update',
    'audit',
  ])
  assert.equal(routeState.revoked, true)
})

test('an audit failure rolls back the waiver revocation', async () => {
  reset()
  routeState.failAudit = true

  await assert.rejects(() => revoke(), /forced audit failure/)

  assert.equal(routeState.calls.length, 2, 'both writes were attempted inside the transaction')
  assert.equal(routeState.calls.every((call) => call.kind === 'tx-execute'), true)
  assert.equal(routeState.committed.length, 0, 'the waiver update did not commit without evidence')
  assert.equal(routeState.revoked, false, 'the waiver remains active after the failed transaction')
})

test('an already-revoked waiver does not append another audit event', async () => {
  reset()
  routeState.revoked = true

  const response = await revoke()

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found or already revoked' })
  assert.equal(routeState.calls.length, 1)
  assert.equal(routeState.committed.length, 0)
})
