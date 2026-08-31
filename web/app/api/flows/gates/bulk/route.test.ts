import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

interface RouteState {
  authz: { user: { id: string; orgId: string } } | Response
  gates: Map<string, { status: string }>
  loadCalls: Array<{ gateId: string; orgId: string }>
  decideCalls: Array<Record<string, unknown>>
}

const stateKey = Symbol.for('openbooks.bulk-gates-route-test')
const routeState: RouteState = {
  authz: { user: { id: 'user-1', orgId: 'org-1' } },
  gates: new Map(),
  loadCalls: [],
  decideCalls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        try {
          return { ok: true, data: await request.json() }
        } catch {
          return { ok: false, response: new Response(JSON.stringify({ error: 'invalid request body' }), { status: 400 }) }
        }
      }
    `,
  ],
  [
    'mock:flows',
    `
      const state = globalThis[Symbol.for('openbooks.bulk-gates-route-test')]
      export async function decideGate(args) {
        state.decideCalls.push(args)
        return { ok: true, resumed: null, runStatus: 'waiting' }
      }
    `,
  ],
  [
    'mock:list-params',
    `
      export function isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      }
    `,
  ],
  [
    'mock:flows-lib',
    `
      const state = globalThis[Symbol.for('openbooks.bulk-gates-route-test')]
      export async function requireFlowsSession() { return state.authz }
      export async function loadGateHeader(gateId, orgId) {
        state.loadCalls.push({ gateId, orgId })
        return state.gates.get(gateId) ?? null
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/flows/index.ts', 'mock:flows'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['../../_lib', 'mock:flows-lib'],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { shortCircuit: true, url: mocked }
    return nextResolve(specifier)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?bulk-gates-boundary-test'
const { MAX_BULK_ITEMS, POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  routeState.authz = { user: { id: 'user-1', orgId: 'org-1' } }
  routeState.gates.clear()
  routeState.loadCalls.length = 0
  routeState.decideCalls.length = 0
}

function gateId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/flows/gates/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

test('rejects a bulk request above the cap before any per-item database work', async () => {
  reset()
  const items = Array.from({ length: MAX_BULK_ITEMS + 1 }, (_, index) => ({ gateId: gateId(index + 1) }))

  const response = await post({ items, decision: 'approved' })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: `too many items (max ${MAX_BULK_ITEMS})` })
  assert.deepEqual(routeState.loadCalls, [])
  assert.deepEqual(routeState.decideCalls, [])
})

test('processes a request at the cap and preserves result order', async () => {
  reset()
  const items = Array.from({ length: MAX_BULK_ITEMS }, (_, index) => ({ gateId: gateId(index + 1) }))
  for (const item of items) routeState.gates.set(item.gateId, { status: 'pending' })

  const response = await post({ items, decision: 'rejected', comment: 'batch review' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    results: items.map(() => ({ ok: true })),
  })
  assert.equal(routeState.loadCalls.length, MAX_BULK_ITEMS)
  assert.equal(routeState.decideCalls.length, MAX_BULK_ITEMS)
  assert.deepEqual(routeState.decideCalls[0], {
    gateId: gateId(1),
    decision: 'rejected',
    userId: 'user-1',
    comment: 'batch review',
  })
  assert.deepEqual(routeState.decideCalls.at(-1), {
    gateId: gateId(MAX_BULK_ITEMS),
    decision: 'rejected',
    userId: 'user-1',
    comment: 'batch review',
  })
})

test('invalid gate IDs fail individually without reaching the database', async () => {
  reset()

  const response = await post({
    items: [{ gateId: 'not-a-uuid' }, {}],
    decision: 'approved',
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    results: [
      { ok: false, error: 'invalid gateId' },
      { ok: false, error: 'invalid item' },
    ],
  })
  assert.deepEqual(routeState.loadCalls, [])
  assert.deepEqual(routeState.decideCalls, [])
})
