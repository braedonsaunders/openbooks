import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

interface RouteState {
  authz: { user: { id: string; orgId: string }; allowedSubsidiaryIds: Set<string> | null } | Response
  gates: Map<string, { status: string; subsidiary_id: string | null }>
  loadCalls: Array<{ gateId: string; orgId: string }>
  decideCalls: Array<Record<string, unknown>>
  decideResults: Map<string, { ok: boolean; error?: string; throwError?: string }>
}

const stateKey = Symbol.for('openbooks.bulk-gates-route-test')
const routeState: RouteState = {
  authz: { user: { id: 'user-1', orgId: 'org-1' }, allowedSubsidiaryIds: null },
  gates: new Map(),
  loadCalls: [],
  decideCalls: [],
  decideResults: new Map(),
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
        if (state.decideResults.has(args.gateId)) {
          const staged = state.decideResults.get(args.gateId)
          if (staged.throwError) throw new Error(staged.throwError)
          return staged
        }
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
  [
    'mock:authz',
    `
      export function guardSubsidiaryScope(authz, subsidiaryId) {
        if (authz.allowedSubsidiaryIds !== null &&
            (subsidiaryId === null || subsidiaryId === undefined ||
             !authz.allowedSubsidiaryIds.has(subsidiaryId))) {
          return new Response(JSON.stringify({ error: 'approval not found' }), { status: 404 })
        }
        return null
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/flows/index.ts', 'mock:flows'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['../../_lib', 'mock:flows-lib'],
  ['../../../../../lib/authz', 'mock:authz'],
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

function reset(allowedSubsidiaryIds: Set<string> | null = null): void {
  routeState.authz = { user: { id: 'user-1', orgId: 'org-1' }, allowedSubsidiaryIds }
  routeState.gates.clear()
  routeState.loadCalls.length = 0
  routeState.decideCalls.length = 0
  routeState.decideResults.clear()
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
  for (const item of items) routeState.gates.set(item.gateId, { status: 'pending', subsidiary_id: null })

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
    allowedSubsidiaryIds: null,
    comment: 'batch review',
  })
  assert.deepEqual(routeState.decideCalls.at(-1), {
    gateId: gateId(MAX_BULK_ITEMS),
    decision: 'rejected',
    userId: 'user-1',
    allowedSubsidiaryIds: null,
    comment: 'batch review',
  })
})

test('a restricted approver cannot bulk-decide a gate for another subsidiary', async () => {
  reset(new Set(['11111111-1111-4111-8111-111111111111']))
  const id = gateId(1)
  routeState.gates.set(id, { status: 'pending', subsidiary_id: '22222222-2222-4222-8222-222222222222' })

  const response = await post({ items: [{ gateId: id }], decision: 'approved' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { results: [{ ok: false, error: 'approval not found' }] })
  assert.deepEqual(routeState.decideCalls, [])
})

test('an in-scope bulk decision carries the subsidiary scope into the engine', async () => {
  const subsidiary = '22222222-2222-4222-8222-222222222222'
  reset(new Set([subsidiary]))
  const id = gateId(1)
  routeState.gates.set(id, { status: 'pending', subsidiary_id: subsidiary })

  const response = await post({ items: [{ gateId: id }], decision: 'approved' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { results: [{ ok: true }] })
  assert.deepEqual(routeState.decideCalls, [
    {
      gateId: id,
      decision: 'approved',
      userId: 'user-1',
      allowedSubsidiaryIds: new Set([subsidiary]),
      comment: undefined,
    },
  ])
})

test('a recorded-but-incomplete decision is reported per item, never as ok:true', async () => {
  reset()
  const failedId = gateId(1)
  const okId = gateId(2)
  routeState.gates.set(failedId, { status: 'pending', subsidiary_id: null })
  routeState.gates.set(okId, { status: 'pending', subsidiary_id: null })
  routeState.decideResults.set(failedId, {
    ok: false,
    decision: 'approved',
    resumed: 'approve',
    runId: '00000000-0000-4000-8000-000000000031',
    runStatus: 'failed',
    decisionRecorded: true,
    error: 'decision approved recorded but release failed: boom. Run 00000000-0000-4000-8000-000000000031 is marked failed; fix the cause, then retry the failed run via retryFlowRun.',
  })

  const response = await post({ items: [{ gateId: failedId }, { gateId: okId }], decision: 'approved' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    results: [
      { ok: false, error: 'decision approved recorded but release failed: boom. Run 00000000-0000-4000-8000-000000000031 is marked failed; fix the cause, then retry the failed run via retryFlowRun.' },
      { ok: true },
    ],
  })
  assert.equal(routeState.decideCalls.length, 2, 'one failure never aborts the rest')
})

test('a thrown release failure is reported per item, never as ok:true', async () => {
  reset()
  const failedId = gateId(1)
  const okId = gateId(2)
  routeState.gates.set(failedId, { status: 'pending', subsidiary_id: null })
  routeState.gates.set(okId, { status: 'pending', subsidiary_id: null })
  routeState.decideResults.set(failedId, {
    ok: false,
    throwError: 'approval release failed: boom. The decision to approve was not recorded and the approval is still pending — retry your decision.',
  })

  const response = await post({ items: [{ gateId: failedId }, { gateId: okId }], decision: 'approved' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    results: [
      { ok: false, error: 'approval release failed: boom. The decision to approve was not recorded and the approval is still pending — retry your decision.' },
      { ok: true },
    ],
  })
  assert.equal(routeState.decideCalls.length, 2, 'one failure never aborts the rest')
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
