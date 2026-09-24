import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * Pay-run adjustment boundary: every adjustment mutation runs through the
 * one permission-gated engine helper — never direct SQL — and replays
 * address the same rows through the Idempotency-Key header, never a stored
 * field or a second row.
 *
 * The wizard's own double-click guard, header transport, and busy/key
 * rotation are client behaviours of the 3050-line RunWizard (whose
 * drawers are not separately importable); the safety property they
 * protect — no duplicate adjustment writes — is held here, at the
 * boundary that refuses the second write.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const EMPLOYEE = '22222222-2222-4222-8222-222222222222'
const COMPONENT = '33333333-3333-4333-8333-333333333333'
const KEY_ONE = '44444444-4444-4444-8444-444444444444'
const KEY_TWO = '55555555-5555-4555-8555-555555555555'

const adjustKey = Symbol.for('openbooks.payrun-adjustment-route-test')
const adjustState: { granted: Set<string>; mutations: unknown[]; conflictNext: boolean; queries: string[] } = {
  granted: new Set(),
  mutations: [],
  conflictNext: false,
  queries: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[adjustKey] = adjustState

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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksAdjustSqlText = sqlText

const dbUrl = import.meta.resolve('@openbooks/engine/src/platform/db.ts')
const runAdjustmentsUrl = import.meta.resolve('@openbooks/engine/src/payroll/run-adjustments.ts')

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      import { NextResponse } from 'next/server'
      const state = globalThis[Symbol.for('openbooks.payrun-adjustment-route-test')]
      export async function guardFeaturePermission(permission) {
        if (!state.granted.has(permission)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
        return { user: { orgId: 'org-1', id: 'user-1' }, permissions: state.granted, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:authz',
    'export function guardSubsidiaryScope() { return null }',
  ],
  [
    'mock:db',
    `
      export * from '${dbUrl}'
      const state = globalThis[Symbol.for('openbooks.payrun-adjustment-route-test')]
      const sqlText = globalThis.openbooksAdjustSqlText
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.queries.push(text)
          if (text.includes('from pay_runs r')) return { rows: [{ subsidiaryId: null }] }
          throw new Error('adjustment paths must not issue SQL: ' + text.slice(0, 120))
        },
      }
      export async function withOrgTransaction(orgId, fn) { return fn() }
    `,
  ],
  [
    'mock:run-adjustments',
    `
      export * from '${runAdjustmentsUrl}'
      const state = globalThis[Symbol.for('openbooks.payrun-adjustment-route-test')]
      export async function mutatePayRunAdjustment(input) {
        state.mutations.push(input)
        if (state.conflictNext) {
          state.conflictNext = false
          const { PayRunAdjustmentIdempotencyConflict } = await import('${runAdjustmentsUrl}')
          throw new PayRunAdjustmentIdempotencyConflict('changed-payload')
        }
        return { ok: true }
      }
    `,
  ],
])

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`
const mockUrls = new Map<string, string>([
  ['../../../../../lib/feature-gates', mockUrl('feature-gates')],
  ['../../../../../lib/authz', mockUrl('authz')],
  ['@openbooks/engine/src/platform/db.ts', mockUrl('db')],
  ['@openbooks/engine/src/payroll/run-adjustments.ts', mockUrl('run-adjustments')],
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
    const parsed = new URL(url)
    const name = parsed.searchParams.get('mock')
    const source = name ? mockSources.get(`mock:${name}`) : undefined
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const adjustRouteUrl = '../app/api/payroll/runs/[id]/route.ts?payrun-adjustment-route'
const { POST } = (await import(adjustRouteUrl)) as typeof import('../app/api/payroll/runs/[id]/route.ts')
hooks.deregister()

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: RUN_ID }) },
  )
}

function asPayrollRunner() {
  adjustState.granted = new Set(['payroll.run'])
  adjustState.mutations = []
  adjustState.conflictNext = false
  adjustState.queries = []
}

function addBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'add-adjustment',
    employeePartyId: EMPLOYEE,
    componentId: COMPONENT,
    amount: '100.00',
    ...overrides,
  }
}

test('adjustment mutations demand the payroll.run gate before dispatch', async () => {
  adjustState.granted = new Set(['payroll.read'])
  adjustState.mutations = []

  const response = await post(addBody(), { 'Idempotency-Key': KEY_ONE })

  assert.equal(response.status, 403)
  assert.deepEqual(adjustState.mutations, [], 'the engine boundary must not run for an ungated caller')
})

test('every adjustment action reaches the one engine boundary with its scope', async () => {
  asPayrollRunner()
  const cases: Array<{ body: Record<string, unknown>; action: string }> = [
    { body: addBody(), action: 'add' },
    { body: { action: 'delete-adjustment', adjustmentId: KEY_ONE }, action: 'delete' },
    { body: { action: 'exclude-employee', employeePartyId: EMPLOYEE }, action: 'exclude' },
    { body: { action: 'include-employee', employeePartyId: EMPLOYEE }, action: 'include' },
  ]
  for (const { body, action } of cases) {
    const response = await post(body, { 'Idempotency-Key': KEY_ONE })
    assert.equal(response.status, 200, `${body.action} must succeed`)
    const call = adjustState.mutations.at(-1) as {
      orgId: string
      documentId: string
      actorId: string
      mutation: { action: string }
    }
    assert.equal(call.orgId, 'org-1')
    assert.equal(call.documentId, RUN_ID)
    assert.equal(call.actorId, 'user-1')
    assert.equal(call.mutation.action, action)
  }
  assert.ok(
    adjustState.queries.every((text) => text.includes('from pay_runs r')),
    'adjustment paths issue no SQL beyond the ownership check',
  )
})

test('a malformed idempotency key is refused before any write', async () => {
  asPayrollRunner()

  const response = await post(addBody(), { 'Idempotency-Key': 'not-a-key' })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_idempotency_key' })
  assert.deepEqual(adjustState.mutations, [], 'no adjustment may be written for a malformed key')
})

test('a conflicting idempotency key maps to 409, never a second row', async () => {
  asPayrollRunner()
  adjustState.conflictNext = true

  const response = await post(addBody(), { 'Idempotency-Key': KEY_ONE })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'invalid_idempotency_key' })
})

test('the idempotency key travels in the header, never a body field', async () => {
  asPayrollRunner()
  await post(addBody(), { 'Idempotency-Key': KEY_ONE })
  const viaHeader = adjustState.mutations.at(-1) as { mutation: { idempotencyKey?: string } }
  assert.equal(viaHeader.mutation.idempotencyKey, KEY_ONE)

  adjustState.mutations = []
  await post({ ...addBody(), idempotencyKey: KEY_TWO })
  const viaBody = adjustState.mutations.at(-1) as { mutation: { idempotencyKey?: string } }
  assert.equal(
    viaBody.mutation.idempotencyKey,
    undefined,
    'a body idempotencyKey field must not reach the engine — the header carries it',
  )
})
