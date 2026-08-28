import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary regression for admin user mutations. Role assignment and
// account activation changes are privileged state transitions: their audit
// evidence must commit in the same tenant transaction, so an audit failure
// cannot leave an unaudited role or account state behind.
const stateKey = Symbol.for('openbooks.admin-users-route-test')
interface RouteState {
  executed: string[]
  committed: string[]
  pending: string[]
  inTx: boolean
  transactionCalls: number
  failOnText?: string
  assignments: { id: string; role_id: string }[]
}

const state: RouteState = {
  executed: [],
  committed: [],
  pending: [],
  inTx: false,
  transactionCalls: 0,
  assignments: [
    {
      id: '00000000-0000-4000-8000-00000000a004',
      role_id: '00000000-0000-4000-8000-00000000a003',
    },
    {
      id: '00000000-0000-4000-8000-00000000a005',
      role_id: '00000000-0000-4000-8000-00000000a006',
    },
  ],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

/** Flatten a drizzle SQL chunk into its raw text for routing scripted replies. */
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
;(globalThis as typeof globalThis & { openbooksSqlTextAdminUsers: typeof sqlText }).openbooksSqlTextAdminUsers = sqlText

const ORG_ID = '00000000-0000-4000-8000-00000000a001'
const ACTOR_ID = '00000000-0000-4000-8000-00000000a002'
const TARGET_ID = '00000000-0000-4000-8000-00000000a003'
const ROLE_ID = '00000000-0000-4000-8000-00000000a006'
const ASSIGNMENT_ID = '00000000-0000-4000-8000-00000000a007'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.admin-users-route-test')]
      const sqlText = globalThis.openbooksSqlTextAdminUsers
      const isWrite = (text) =>
        text.includes('insert into role_assignments') ||
        text.includes('delete from role_assignments') ||
        text.includes('update users') ||
        text.includes('update auth_sessions') ||
        text.includes('insert into audit_log')
      const rowsFor = (text) => {
        if (text.includes('select id from users')) return [{ id: '${TARGET_ID}' }]
        if (text.includes('select id, key from app_roles')) return [{ id: '${ROLE_ID}', key: 'member' }]
        if (text.includes('insert into role_assignments')) return [{ id: '${ASSIGNMENT_ID}' }]
        if (text.includes('select id, role_id from role_assignments')) return state.assignments
        if (text.includes('delete from role_assignments')) return [{ id: '${ASSIGNMENT_ID}' }]
        if (text.includes('select 1') && text.includes('from role_assignments')) return [{ '?column?': 1 }]
        if (text.includes('with changed_identity')) return [{ id: '${TARGET_ID}' }]
        return []
      }
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.executed.push(text)
          if (state.failOnText && text.includes(state.failOnText)) {
            throw new Error('forced storage failure: ' + state.failOnText)
          }
          if (isWrite(text)) {
            const ledger = state.inTx ? state.pending : state.committed
            ledger.push(text)
          }
          return { rows: rowsFor(text) }
        },
        transaction: async (work) => work({}),
      }
      export async function withOrgTransaction(_orgId, work) {
        state.transactionCalls++
        if (state.inTx) return work()
        state.inTx = true
        state.pending = []
        try {
          const result = await work()
          state.committed.push(...state.pending)
          return result
        } finally {
          state.inTx = false
          state.pending = []
        }
      }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export const pool = {}
      export const env = {}
      export const schema = {}
      export function registerRequestOrgResolver() {}
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
      export async function guardPermission() {
        return { user: { orgId: '${ORG_ID}', id: '${ACTOR_ID}' } }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@/lib/api/json', 'mock:json'],
  ['../../../../lib/authz', 'mock:authz'],
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

const routeUrl = './route.ts?admin-users-route-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.executed = []
  state.committed = []
  state.pending = []
  state.inTx = false
  state.transactionCalls = 0
  state.failOnText = undefined
  state.assignments = [
    {
      id: '00000000-0000-4000-8000-00000000a004',
      role_id: '00000000-0000-4000-8000-00000000a003',
    },
    {
      id: '00000000-0000-4000-8000-00000000a005',
      role_id: '00000000-0000-4000-8000-00000000a006',
    },
  ]
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('assign commits the role assignment and its audit evidence together', async () => {
  reset()

  const response = await post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  const mutationIndex = state.committed.findIndex((text) => text.includes('insert into role_assignments'))
  const auditIndex = state.committed.findIndex((text) => text.includes('insert into audit_log'))
  assert.ok(mutationIndex >= 0, 'the role assignment committed')
  assert.ok(auditIndex > mutationIndex, 'the assignment audit committed after it in the same unit')
  assert.equal(state.transactionCalls, 1, 'the assignment used the tenant transaction primitive')
})

test('a failed assignment audit rolls back the role assignment', async () => {
  reset()
  state.failOnText = 'insert into audit_log'

  await assert.rejects(
    () => post({ action: 'assign', userId: TARGET_ID, roleId: ROLE_ID }),
    /forced storage failure/,
  )

  assert.ok(
    state.executed.some((text) => text.includes('insert into role_assignments')),
    'the assignment was attempted inside the transaction',
  )
  assert.equal(
    state.committed.some((text) => text.includes('insert into role_assignments')),
    false,
    'the role assignment did not commit without its audit evidence',
  )
  assert.equal(
    state.committed.some((text) => text.includes('insert into audit_log')),
    false,
    'the failed audit did not partially commit',
  )
})

test('set-active commits account and session revocation with audit evidence together', async () => {
  reset()

  const response = await post({ action: 'set-active', userId: TARGET_ID, isActive: false })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  const mutation = state.committed.find((text) => text.includes('with changed_identity'))
  assert.ok(mutation, 'the account state mutation committed')
  assert.match(mutation, /update users/, 'the account was deactivated')
  assert.match(mutation, /update auth_sessions/, 'sessions were revoked in the same statement')
  assert.ok(
    state.committed.some((text) => text.includes('insert into audit_log')),
    'the account mutation audit committed in the same unit',
  )
  assert.equal(state.transactionCalls, 1, 'the activation mutation used the tenant transaction primitive')
})

test('a failed set-active audit rolls back account and session changes', async () => {
  reset()
  state.failOnText = 'insert into audit_log'

  await assert.rejects(
    () => post({ action: 'set-active', userId: TARGET_ID, isActive: false }),
    /forced storage failure/,
  )

  assert.ok(
    state.executed.some((text) => text.includes('with changed_identity')),
    'the account and session mutation was attempted inside the transaction',
  )
  assert.equal(
    state.committed.some((text) => text.includes('with changed_identity')),
    false,
    'the account and session changes did not commit without audit evidence',
  )
  assert.equal(
    state.committed.some((text) => text.includes('insert into audit_log')),
    false,
    'the failed audit did not partially commit',
  )
})
